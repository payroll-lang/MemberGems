/**
 * GrantSync.gs — turns the "Vest wise Report" export into the portal's
 * Grants and Employees masters.
 *
 * The export is per TRANCHE (21k rows, 47 columns, ~5.3 tranches per grant).
 * Employees decide at GRANT level, so this rolls tranches up to one row per
 * grant and keeps the per-tranche breakdown as JSON on that row.
 *
 * Facts this relies on, verified against the 08-Sep-2026 export:
 *   · headings sit on row 4; rows 1-2 carry "... as on Sep 08, 2026"
 *   · Granted = Unvested + Vested + Exercised + ExercisesPending +
 *     UnvestedCancelled + VestedCancelled — exact on all 21,235 rows, so
 *     `Vested` is ALREADY the exercisable balance
 *   · Grant IDs are globally unique (never shared between employees)
 *   · Multiplier, Plan Name, Grant Date and Exercise Price never vary within
 *     one grant
 *   · `Access Email ID` is populated on every vested row, and already holds a
 *     personal address for separated staff
 *
 * Only grants with something outstanding (unvested + vested > 0) are written,
 * which keeps the Grants tab at a few thousand rows instead of every grant
 * ever made.
 */


const GrantSync = (function () {


  const CHUNK = 4000;   // rows per getValues call


  /* ---------------- source ---------------- */


  function sourceSheet() {
    const extId = Util.trim(cfg('GRANT_SOURCE_SPREADSHEET_ID'));
    const tabName = Util.trim(cfg('GRANT_SOURCE_TAB')) || T.GRANT_IMPORT;


    if (extId) {
      let ss;
      try {
        ss = SpreadsheetApp.openById(extId);
      } catch (e) {
        throw new Error('GRANT_SOURCE_SPREADSHEET_ID in Settings is not a spreadsheet this account can open.');
      }
      const sh = ss.getSheetByName(tabName) ||
        (ss.getSheets().length === 1 ? ss.getSheets()[0] : null);
      if (!sh) {
        throw new Error('Tab "' + tabName + '" was not found in the source spreadsheet. Its tabs are: ' +
          ss.getSheets().map(s => s.getName()).join(', '));
      }
      return sh;
    }


    const sh = Repo.book().getSheetByName(tabName);
    if (!sh) {
      throw new Error('No tab named "' + tabName + '" in this workbook. Either paste the export into a tab ' +
        'of that name, or put the export in its own file and set GRANT_SOURCE_SPREADSHEET_ID in Settings.');
    }
    return sh;
  }


  /** Find the heading row, and the report's "as on" date from above it. */
  function locateHeader(sh) {
    const probeRows = Math.min(12, sh.getLastRow());
    if (!probeRows) throw new Error('The report tab is empty.');
    const cols = Math.max(sh.getLastColumn(), 1);
    const top = sh.getRange(1, 1, probeRows, cols).getValues();


    const configured = cfgNum('REPORT_HEADER_ROW', 4);
    const candidates = [];
    if (configured >= 1 && configured <= probeRows) candidates.push(configured);
    for (let i = 1; i <= probeRows; i++) if (candidates.indexOf(i) < 0) candidates.push(i);


    let headerRow = 0;
    for (let c = 0; c < candidates.length; c++) {
      const slugs = top[candidates[c] - 1].map(Util.slug);
      if (slugs.indexOf('planname') >= 0 && slugs.indexOf('employeeid') >= 0) {
        headerRow = candidates[c];
        break;
      }
    }
    if (!headerRow) {
      throw new Error('Could not find the heading row. Looked in the first ' + probeRows +
        ' rows for one containing both "Plan Name" and "Employee ID".');
    }


    // "Vest wise Report of Physics Wallah as on Sep 08, 2026"
    let asOn = null;
    for (let r = 0; r < headerRow - 1 && !asOn; r++) {
      for (let c = 0; c < top[r].length && !asOn; c++) {
        const m = String(top[r][c] || '').match(/as on\s+([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/i);
        if (m) asOn = Util.toDate(m[1]);
      }
    }


    return { headerRow: headerRow, headers: top[headerRow - 1].map(x => Util.trim(x)), asOn: asOn };
  }


  /** Resolve REPORT_COLUMNS aliases to indexes. */
  function mapColumns(headers) {
    const slugs = headers.map(Util.slug);
    const idx = {}, missing = [];
    Object.keys(REPORT_COLUMNS).forEach(function (key) {
      const aliases = REPORT_COLUMNS[key];
      for (let i = 0; i < aliases.length; i++) {
        const at = slugs.indexOf(Util.slug(aliases[i]));
        if (at >= 0) { idx[key] = at; return; }
      }
      missing.push(key + ' (' + aliases[0] + ')');
    });
    const REQUIRED = ['employeeId', 'grantId', 'vested', 'unvested', 'multiplier', 'planName'];
    const lacking = REQUIRED.filter(k => idx[k] === undefined);
    if (lacking.length) {
      throw new Error('The report is missing column(s) the portal needs: ' +
        lacking.map(k => REPORT_COLUMNS[k][0]).join(', ') + '.');
    }
    return { idx: idx, missing: missing };
  }


  /* ---------------- helpers ---------------- */


  /** The report writes 0 or "-" where there is no date. */
  function reportDate(v) {
    if (v === 0 || v === '0' || v === '-' || v === '' || v === null || v === undefined) return null;
    return Util.toDate(v);
  }


  function reportText(v) {
    const s = Util.trim(v);
    return (s === '-' || s === '0') ? '' : s;
  }


  function round6(n) { return Math.round(Util.num(n) * 1e6) / 1e6; }


  /* ---------------- the sync ---------------- */


  function run(options, actorId) {
    const opts = options || {};
    const sh = sourceSheet();
    const loc = locateHeader(sh);
    const map = mapColumns(loc.headers);
    const idx = map.idx;


    const plans = allowedPlans();
    const statuses = allowedGrantStatuses();   // null = accept every status
    const defaultMultiplier = cfgNum('DEFAULT_MULTIPLIER', 1) || 1;
    const multiplierDefaulted = {};
    const prefillSeen = {};
    const asOn = loc.asOn || new Date();
    const syncedAt = Util.stamp();


    const firstDataRow = loc.headerRow + 1;
    const lastRow = sh.getLastRow();
    const nCols = loc.headers.length;
    if (lastRow < firstDataRow) throw new Error('The report has headings but no data rows.');


    const g = {};                 // GrantID -> accumulator
    const employees = {};         // EmployeeID -> report-sourced fields
    const warnings = [];
    const stats = {
      rowsRead: 0, rowsUsed: 0,
      skippedPlan: 0, skippedStatus: 0, skippedNoId: 0,
      plansSeen: {}, statusesSkipped: {}
    };


    for (let start = firstDataRow; start <= lastRow; start += CHUNK) {
      const count = Math.min(CHUNK, lastRow - start + 1);
      const values = sh.getRange(start, 1, count, nCols).getValues();


      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        stats.rowsRead++;


        const empId = Util.trim(row[idx.employeeId]).toUpperCase();
        const grantId = Util.trim(row[idx.grantId]);
        if (!empId || !grantId || grantId === '-') { stats.skippedNoId++; continue; }


        const planName = Util.trim(row[idx.planName]);
        stats.plansSeen[planName] = (stats.plansSeen[planName] || 0) + 1;
        if (plans.indexOf(planName) < 0) { stats.skippedPlan++; continue; }


        const grantStatus = idx.grantStatus === undefined ? 'Accepted' : Util.trim(row[idx.grantStatus]);
        if (statuses && statuses.indexOf(grantStatus) < 0) {
          stats.skippedStatus++;
          stats.statusesSkipped[grantStatus] = (stats.statusesSkipped[grantStatus] || 0) + 1;
          continue;
        }


        stats.rowsUsed++;


        // The report leaves Multiplier blank on some plans — every Test Plan row,
        // for instance. Fall back to DEFAULT_MULTIPLIER rather than dropping the
        // grant, and say so once per grant so it is never a silent assumption.
        // A multiplier that is present but nonsense is still refused: guessing
        // there would be worse than stopping.
        const rawMultiplier = Util.trim(row[idx.multiplier]);
        let multiplier = Util.num(rawMultiplier, NaN);
        if (!rawMultiplier || rawMultiplier === '-') {
          multiplier = defaultMultiplier;
          if (!multiplierDefaulted[grantId]) {
            multiplierDefaulted[grantId] = true;
            warnings.push('Grant ' + grantId + ' (' + empId + ', ' + planName +
              '): the report has no Multiplier, so ' + defaultMultiplier +
              ' was used — one option to ' + defaultMultiplier + ' share(s).');
          }
        } else if (isNaN(multiplier) || multiplier <= 0) {
          warnings.push('Grant ' + grantId + ' (' + empId + '): multiplier "' +
            rawMultiplier + '" is not a positive number — the grant was skipped.');
          continue;
        }


        let acc = g[grantId];
        if (!acc) {
          acc = g[grantId] = {
            grantId: grantId,
            employeeId: empId,
            planName: planName,
            multiplier: multiplier,
            grantDate: reportDate(idx.grantDate === undefined ? null : row[idx.grantDate]),
            exercisePrice: idx.exercisePrice === undefined ? cfgNum('EXERCISE_PRICE', 1)
              : (Util.num(row[idx.exercisePrice], 0) || cfgNum('EXERCISE_PRICE', 1)),
            typeOfVesting: idx.typeOfVesting === undefined ? '' : reportText(row[idx.typeOfVesting]),
            grantStatus: grantStatus,
            expiryDate: reportDate(idx.expiryDate === undefined ? null : row[idx.expiryDate]),
            granted: 0, unvested: 0, vested: 0, exercised: 0, pending: 0, cancelled: 0,
            tranches: []
          };
        } else {
          if (acc.employeeId !== empId) {
            warnings.push('Grant ' + grantId + ' appears against both ' + acc.employeeId + ' and ' +
              empId + '. The first was kept.');
            continue;
          }
          if (Math.abs(acc.multiplier - multiplier) > 1e-9) {
            warnings.push('Grant ' + grantId + ' has two different multipliers (' + acc.multiplier +
              ' and ' + multiplier + '). ' + acc.multiplier + ' was kept — check the report.');
          }
        }


        const vested = Util.num(row[idx.vested], 0);
        const unvested = Util.num(row[idx.unvested], 0);
        const exercised = idx.exercised === undefined ? 0 : Util.num(row[idx.exercised], 0);
        const pending = idx.exercisePending === undefined ? 0 : Util.num(row[idx.exercisePending], 0);
        const cancelled =
          (idx.unvestedCancelled === undefined ? 0 : Util.num(row[idx.unvestedCancelled], 0)) +
          (idx.vestedCancelled === undefined ? 0 : Util.num(row[idx.vestedCancelled], 0));


        acc.granted += idx.granted === undefined ? 0 : Util.num(row[idx.granted], 0);
        acc.unvested += unvested;
        acc.vested += vested;
        acc.exercised += exercised;
        acc.pending += pending;
        acc.cancelled += cancelled;


        const vestDate = reportDate(idx.vestDate === undefined ? null : row[idx.vestDate]);
        const actualVestDate = reportDate(idx.actualVestDate === undefined ? null : row[idx.actualVestDate]);
        acc.tranches.push({
          id: idx.trancheId === undefined ? '' : Util.trim(row[idx.trancheId]),
          vd: Util.dateKey(vestDate),
          avd: Util.dateKey(actualVestDate),
          v: round6(vested),
          u: round6(unvested),
          e: round6(exercised),
          p: round6(pending)
        });


        if (!employees[empId]) {
          // Optional prefill columns. First non-blank value wins across
          // this participant's rows; a blank is simply not carried.
          const prefill = {};
          [['pan', 'PAN'], ['mobile', 'Mobile'], ['address', 'Address'],
           ['nationality', 'Nationality'],
           ['dematAccountType', 'DematAccountType'],
           ['dematDPName', 'DematDPName'], ['dematDPId', 'DematDPId'],
           ['dematClientId', 'DematClientId'],
           ['dematAccountName', 'DematAccountName']].forEach(function (pair) {
            if (idx[pair[0]] === undefined) return;
            const v = reportText(row[idx[pair[0]]]);
            if (v) prefill[pair[1]] = v;
          });
          if (Object.keys(prefill).length) prefillSeen[empId] = true;


          employees[empId] = Object.assign(prefill, {
            EmployeeID: empId,
            Name: idx.employeeName === undefined ? '' : reportText(row[idx.employeeName]),
            Designation: idx.designation === undefined ? '' : reportText(row[idx.designation]),
            StakeholderCategory: idx.category === undefined ? '' : reportText(row[idx.category]),
            AccessEmail: idx.accessEmail === undefined ? '' : reportText(row[idx.accessEmail]),
            SecondaryEmail: idx.secondaryEmail === undefined ? '' : reportText(row[idx.secondaryEmail]),
            EmploymentStatus: idx.awardeeStatus === undefined ? 'Active' :
              (reportText(row[idx.awardeeStatus]) || 'Active'),
            SeparationDate: Util.dateKey(reportDate(idx.separationDate === undefined ? null : row[idx.separationDate])),
            ResignationDate: Util.dateKey(reportDate(idx.resignationDate === undefined ? null : row[idx.resignationDate]))
          });
        }
      }
    }


    /* ---- build the grant rows ---- */


    const grantRows = [];
    let outstandingSkipped = 0;
    Object.keys(g).forEach(function (grantId) {
      const a = g[grantId];
      const outstanding = round6(a.unvested + a.vested);
      if (outstanding <= 0) { outstandingSkipped++; return; }   // nothing left to act on


      a.tranches.sort((x, y) => String(x.vd).localeCompare(String(y.vd)));
      const todayKey = Util.dateKey(new Date());
      const future = a.tranches.filter(t => t.u > 0 && t.vd && t.vd > todayKey);
      const vestedTranches = a.tranches.filter(t => t.v > 0).length;


      grantRows.push({
        GrantID: a.grantId,
        EmployeeID: a.employeeId,
        PlanName: a.planName,
        Multiplier: a.multiplier,
        GrantDate: Util.dateKey(a.grantDate),
        ExercisePrice: a.exercisePrice,
        TypeOfVesting: a.typeOfVesting,
        GrantStatus: a.grantStatus,
        TotalGranted: round6(a.granted),
        UnvestedOptions: round6(a.unvested),
        VestedOptions: round6(a.vested),
        ExercisedOptions: round6(a.exercised),
        ExercisePendingOptions: round6(a.pending),
        CancelledOptions: round6(a.cancelled),
        TrancheCount: a.tranches.length,
        VestedTrancheCount: vestedTranches,
        NextVestDate: future.length ? future[0].vd : '',
        LastVestDate: a.tranches.length ? a.tranches[a.tranches.length - 1].vd : '',
        ExpiryDate: Util.dateKey(a.expiryDate),
        TrancheDetail: JSON.stringify(a.tranches),
        ReportAsOn: Util.dateKey(asOn),
        LastSyncedAt: syncedAt
      });
    });


    grantRows.sort(function (x, y) {
      return String(x.EmployeeID).localeCompare(String(y.EmployeeID)) ||
        String(x.GrantDate).localeCompare(String(y.GrantDate));
    });


    // Only employees who still hold one of these grants.
    const keptEmployees = {};
    grantRows.forEach(r => { keptEmployees[r.EmployeeID] = employees[r.EmployeeID]; });


    const summary = {
      reportAsOn: Util.dateKey(asOn),
      headerRow: loc.headerRow,
      rowsRead: stats.rowsRead,
      rowsUsed: stats.rowsUsed,
      skippedPlan: stats.skippedPlan,
      skippedStatus: stats.skippedStatus,
      skippedNoId: stats.skippedNoId,
      statusesSkipped: stats.statusesSkipped,
      plansSeen: stats.plansSeen,
      grantStatusesAllowed: statuses || ['(all)'],
      grantsWithDefaultedMultiplier: Object.keys(multiplierDefaulted).length,
      grantsFullyClosed: outstandingSkipped,
      grantRows: grantRows.length,
      employees: Object.keys(keptEmployees).length,
      prefillColumnsFound: ['pan', 'mobile', 'address', 'nationality',
        'dematAccountType', 'dematDPName', 'dematDPId', 'dematClientId',
        'dematAccountName'].filter(k => idx[k] !== undefined)
        .map(k => REPORT_COLUMNS[k][0]),
      participantsWithPrefills: Object.keys(prefillSeen).length,
      unmatchedColumns: map.missing,
      warnings: warnings
    };


    /* ---- exercisable preview, so the effect of the lot rule is visible ---- */
    const lot = Domain.lotSize();
    let totVested = 0, totExercisable = 0, lockedGrants = 0;
    const byEmp = {};
    grantRows.forEach(function (r) {
      const step = Domain.stepFor(r.Multiplier);
      const ex = Math.floor((r.VestedOptions + 1e-9) / step) * step;
      totVested += r.VestedOptions;
      totExercisable += ex;
      if (r.VestedOptions > 0 && ex === 0) lockedGrants++;
      byEmp[r.EmployeeID] = (byEmp[r.EmployeeID] || 0) + ex;
    });
    summary.preview = {
      lotSize: lot,
      lotScope: Domain.lotScope(),
      vestedOptions: round6(totVested),
      exercisableOptions: round6(totExercisable),
      strandedBelowOneLot: round6(totVested - totExercisable),
      grantsUnderOneLot: lockedGrants,
      employeesWithSomething: Object.keys(byEmp).filter(k => byEmp[k] > 0).length,
      employeesWithNothing: Object.keys(byEmp).filter(k => byEmp[k] <= 0).length
    };


    if (opts.dryRun) {
      summary.dryRun = true;
      summary.sample = grantRows.slice(0, 12).map(function (r) {
        const step = Domain.stepFor(r.Multiplier);
        const ex = Math.floor((r.VestedOptions + 1e-9) / step) * step;
        return {
          grantId: r.GrantID, employeeId: r.EmployeeID, plan: r.PlanName,
          multiplier: r.Multiplier, vested: r.VestedOptions,
          exercisable: ex, shares: Math.round(ex * r.Multiplier),
          tranches: r.TrancheCount, nextVest: r.NextVestDate
        };
      });
      return summary;
    }


    if (!grantRows.length) {
      throw new Error('No grants with anything outstanding were found. Plans seen in the report: ' +
        Object.keys(stats.plansSeen).join(', ') + '. ALLOWED_PLANS is set to: ' + plans.join(', ') + '.');
    }


    /* ---- write ---- */
    Repo.replaceAll(T.GRANTS, grantRows);
    const empStats = upsertEmployees(keptEmployees);
    summary.employeesCreated = empStats.created;
    summary.employeesUpdated = empStats.updated;
    summary.employeesMissingTaxRate = empStats.missingRate;
    summary.employeesMissingEmail = empStats.missingEmail;


    audit(actorId, ROLE.ADMIN, 'GRANTS_SYNCED', '',
      grantRows.length + ' grants, ' + summary.employees + ' employees, report as on ' +
      summary.reportAsOn + ', ' + warnings.length + ' warning(s)');


    summary.message = grantRows.length + ' grants synced for ' + summary.employees +
      ' participants (report as on ' + summary.reportAsOn + ').';
    return summary;
  }


  /**
   * Merge report-sourced fields into Employees, leaving anything the ESOP team
   * or the participant maintains alone: CTC, tax rate, PAN, address,
   * nationality, mobile, email override, Drive folder, remarks.
   */
  /** Report columns that prefill the master but must never blank it. */
  const PREFILL_FIELDS = ['PAN', 'Mobile', 'Address', 'Nationality',
    'DematAccountType', 'DematDPName', 'DematDPId', 'DematClientId',
    'DematAccountName'];


  function upsertEmployees(map) {
    const existing = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { existing[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    const toAppend = [];
    let updated = 0, missingRate = 0, missingEmail = 0;


    Object.keys(map).forEach(function (id) {
      const src = map[id];
      if (!src) return;
      const row = existing[id];
      const email = Util.trim(src.AccessEmail) || Util.trim(src.SecondaryEmail);
      if (!email) missingEmail++;


      if (!row) {
        toAppend.push(Object.assign({ Nationality: 'Indian' }, src, {
          Remarks: 'Created by grant sync',
          UpdatedAt: Util.stamp()
        }));
        missingRate++;   // a new row can have no tax rate yet
        return;
      }


      const patch = {};


      // Authoritative from the report: always brought into line, because the
      // register is the source of truth for who someone is.
      ['Name', 'Designation', 'StakeholderCategory', 'AccessEmail', 'SecondaryEmail',
        'EmploymentStatus', 'SeparationDate', 'ResignationDate'].forEach(function (f) {
        const v = src[f] === undefined ? '' : src[f];
        if (Util.trim(row[f]) !== Util.trim(v)) patch[f] = v;
      });


      // Prefills: written only when the report actually carries a value. A
      // blank leaves what is already on record, so next month's refresh - which
      // will not have these columns at all - cannot wipe them, and neither can
      // a row the ESOP team left empty on purpose.
      PREFILL_FIELDS.forEach(function (f) {
        const v = Util.trim(src[f]);
        if (v && Util.trim(row[f]) !== v) patch[f] = v;
      });
      if (Object.keys(patch).length) {
        patch.UpdatedAt = Util.stamp();
        Repo.update(T.EMPLOYEES, row._row, patch);
        updated++;
      }
      if (!Util.num(row.TaxRatePercent, 0)) missingRate++;
    });


    if (toAppend.length) Repo.appendAll(T.EMPLOYEES, toAppend);
    return { created: toAppend.length, updated: updated, missingRate: missingRate, missingEmail: missingEmail };
  }


  /* ---------------- participant details tab ---------------- */


  /**
   * Locate the participant-details tab.
   *
   * Looked for in DETAILS_SOURCE_SPREADSHEET_ID if set, otherwise in the
   * vesting report's own file, otherwise in this workbook. Returns null when
   * there is no such tab, which is not an error - the feature is optional.
   */
  function detailsSheet() {
    const tabName = Util.trim(cfg('DETAILS_SOURCE_TAB'));
    if (!tabName) return null;


    const candidates = [];
    const explicit = Util.trim(cfg('DETAILS_SOURCE_SPREADSHEET_ID'));
    const grantFile = Util.trim(cfg('GRANT_SOURCE_SPREADSHEET_ID'));
    if (explicit) candidates.push(explicit);
    if (grantFile && grantFile !== explicit) candidates.push(grantFile);


    for (let i = 0; i < candidates.length; i++) {
      try {
        const sh = SpreadsheetApp.openById(candidates[i]).getSheetByName(tabName);
        if (sh) return sh;
      } catch (e) { /* try the next place */ }
    }
    return Repo.book().getSheetByName(tabName) || null;
  }


  /**
   * Merge the participant-details tab into the Employees master.
   *
   * One row per participant, headings on row 1, in any order. Only the employee
   * ID is required; every other column is optional and a BLANK CELL LEAVES
   * WHATEVER IS ALREADY ON RECORD. That is what makes this safe to re-run and
   * safe to fill in gradually - you can add ten participants' demat details
   * this week and ten more next week without disturbing anything.
   *
   * Recognised headings (any of the aliases in REPORT_COLUMNS):
   *   Employee ID · PAN · Mobile · Address · Nationality ·
   *   Demat Account Type · Depository Participant Name · DP ID ·
   *   Client ID · Demat Account Holder Name
   */
  function syncDetails(actorId) {
    const sh = detailsSheet();
    if (!sh) {
      return {
        found: false,
        message: 'No participant-details tab found. Create a tab named "' +
          Util.trim(cfg('DETAILS_SOURCE_TAB')) + '" with a heading row, or clear ' +
          'DETAILS_SOURCE_TAB in Settings to switch this off.'
      };
    }


    const lastRow = sh.getLastRow();
    const lastCol = Math.max(sh.getLastColumn(), 1);
    if (lastRow < 2) {
      return { found: true, rows: 0, updated: 0, unchanged: 0, skipped: [], warnings: [],
        message: 'The "' + sh.getName() + '" tab has headings but no rows.' };
    }


    const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
    const slugs = values[0].map(Util.slug);


    const WANTED = {
      employeeId: 'EmployeeID',
      pan: 'PAN',
      mobile: 'Mobile',
      address: 'Address',
      nationality: 'Nationality',
      dematAccountType: 'DematAccountType',
      dematDPName: 'DematDPName',
      dematDPId: 'DematDPId',
      dematClientId: 'DematClientId',
      dematAccountName: 'DematAccountName'
    };


    const col = {};
    Object.keys(WANTED).forEach(function (key) {
      const aliases = REPORT_COLUMNS[key] || [];
      for (let i = 0; i < aliases.length; i++) {
        const at = slugs.indexOf(Util.slug(aliases[i]));
        if (at >= 0) { col[key] = at; return; }
      }
    });


    if (col.employeeId === undefined) {
      throw new Error('The "' + sh.getName() + '" tab needs a column headed "Employee ID". ' +
        'Its headings are: ' + values[0].filter(Boolean).join(', '));
    }
    const carried = Object.keys(col).filter(k => k !== 'employeeId');
    if (!carried.length) {
      throw new Error('The "' + sh.getName() + '" tab has an Employee ID column but nothing to load. ' +
        'Add at least one of: PAN, Mobile, Address, Nationality, Demat Account Type, ' +
        'Depository Participant Name, DP ID, Client ID, Demat Account Holder Name.');
    }


    const byId = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { byId[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    let updated = 0, unchanged = 0, rows = 0;
    const skipped = [], warnings = [];


    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const id = Util.trim(row[col.employeeId]).toUpperCase();
      if (!id) continue;
      rows++;


      const emp = byId[id];
      if (!emp) { skipped.push(id + ' - no participant record'); continue; }


      const patch = {};
      carried.forEach(function (key) {
        let v = Util.trim(row[col[key]]);
        if (!v || v === '-') return;                 // blank leaves it alone


        if (key === 'pan') {
          try { v = Domain.validatePan(v); }
          catch (e) { warnings.push(id + ': ' + e.message + ' PAN not set.'); return; }
        }
        if (key === 'mobile') {
          try { v = Domain.validateMobile(v); }
          catch (e) { warnings.push(id + ': ' + e.message + ' Mobile not set.'); return; }
        }
        if (key === 'dematAccountType') {
          v = v.toUpperCase();
          if (DEMAT_TYPES.indexOf(v) < 0) {
            warnings.push(id + ': account type "' + v + '" is neither NSDL nor CDSL. Not set.');
            return;
          }
        }
        if (key === 'dematDPId' || key === 'dematClientId') v = v.toUpperCase();


        if (Util.trim(emp[WANTED[key]]) !== v) patch[WANTED[key]] = v;
      });


      // Complain about the identifier shapes only once both are present.
      const dpId = patch.DematDPId || Util.trim(emp.DematDPId);
      const clientId = patch.DematClientId || Util.trim(emp.DematClientId);
      if (dpId && clientId) {
        try {
          Domain.validateDemat({
            dematDPName: patch.DematDPName || Util.trim(emp.DematDPName) || 'unknown',
            dematAccountName: patch.DematAccountName || Util.trim(emp.DematAccountName) || Util.trim(emp.Name),
            dematDPId: dpId,
            dematClientId: clientId,
            dematAccountType: patch.DematAccountType || Util.trim(emp.DematAccountType)
          });
        } catch (e) {
          warnings.push(id + ': ' + e.message + ' Stored anyway - the participant will confirm it.');
        }
      }


      if (!Object.keys(patch).length) { unchanged++; continue; }
      patch.UpdatedAt = Util.stamp();
      Repo.update(T.EMPLOYEES, emp._row, patch);
      updated++;
    }


    audit(actorId || 'editor', ROLE.ADMIN, 'DETAILS_SYNCED', '',
      sh.getName() + ': ' + updated + ' updated, ' + unchanged + ' unchanged, ' +
      skipped.length + ' skipped');


    return {
      found: true, tab: sh.getName(), rows: rows,
      columns: carried.map(k => REPORT_COLUMNS[k][0]),
      updated: updated, unchanged: unchanged, skipped: skipped, warnings: warnings,
      message: updated + ' participant record(s) updated from "' + sh.getName() + '"' +
        (unchanged ? ', ' + unchanged + ' already matched' : '') +
        (skipped.length ? ', ' + skipped.length + ' not recognised' : '') + '.'
    };
  }


  return { run: run, syncDetails: syncDetails };
})();




/**
 * Check the report without writing anything, from the editor.
 * Prints what a sync would do, including how the multiple-of-10 rule lands.
 */
function checkGrantReport() {
  const s = GrantSync.run({ dryRun: true }, 'editor');
  const p = s.preview;
  const report = [
    'REPORT',
    '  as on                 ' + s.reportAsOn,
    '  heading row           ' + s.headerRow,
    '  rows read             ' + s.rowsRead,
    '  rows used             ' + s.rowsUsed,
    '  skipped, wrong plan   ' + s.skippedPlan,
    '  skipped, not accepted ' + s.skippedStatus + '  ' + JSON.stringify(s.statusesSkipped),
    '  plans seen            ' + JSON.stringify(s.plansSeen),
    '',
    'WOULD WRITE',
    '  grant rows            ' + s.grantRows,
    '  participants          ' + s.employees,
    '  fully closed grants skipped ' + s.grantsFullyClosed,
    '  multiplier assumed on ' + s.grantsWithDefaultedMultiplier +
      ' grant(s)  (report left it blank; used ' + cfgNum('DEFAULT_MULTIPLIER', 1) + ')',
    '',
    'LOT RULE (' + p.lotSize + ' options, scope "' + p.lotScope + '")',
    '  vested options        ' + p.vestedOptions,
    '  exercisable           ' + p.exercisableOptions,
    '  stranded under a lot  ' + p.strandedBelowOneLot,
    '  grants under one lot  ' + p.grantsUnderOneLot,
    '  participants with something ' + p.employeesWithSomething,
    '  participants with nothing   ' + p.employeesWithNothing,
    '',
    'SAMPLE',
    s.sample.map(x => '  ' + [x.grantId, x.employeeId, x.plan, 'x' + x.multiplier,
      'vested ' + x.vested, 'exercisable ' + x.exercisable, x.shares + ' shares',
      x.tranches + ' tranches', x.nextVest ? 'next ' + x.nextVest : ''].join('  ')).join('\n'),
    '',
    'PREFILL COLUMNS FOUND: ' + (s.prefillColumnsFound.join(', ') || 'none') +
      '  (' + s.participantsWithPrefills + ' participant(s) carried a value)',
    'WARNINGS (' + s.warnings.length + '):',
    s.warnings.slice(0, 20).map(w => '  ' + w).join('\n') || '  none'
  ].join('\n');
  console.log(report);
  return report;
}


/**
 * Load PAN, mobile, address and demat details from the participant-details tab.
 *
 * Safe to run as often as you like: a blank cell never wipes what is already on
 * record, so you can fill the tab in gradually.
 */
function syncParticipantDetails() {
  const r = GrantSync.syncDetails('editor');
  if (!r.found) {
    console.log(r.message);
    return r.message;
  }
  const report = [
    r.message,
    '  tab            ' + r.tab,
    '  rows read      ' + r.rows,
    '  columns found  ' + (r.columns.join(', ') || 'none'),
    '  updated        ' + r.updated,
    '  unchanged      ' + r.unchanged,
    '',
    'not recognised (' + r.skipped.length + '):',
    r.skipped.slice(0, 30).map(x => '  ' + x).join('\n') || '  none',
    '',
    'warnings (' + r.warnings.length + '):',
    r.warnings.slice(0, 30).map(x => '  ' + x).join('\n') || '  none'
  ].join('\n');
  console.log(report);
  return report;
}


/** Run the sync for real, from the editor. */
function syncGrantReport() {
  const s = GrantSync.run({}, 'editor');
  const report = s.message +
    '\n  participants created ' + s.employeesCreated +
    '\n  participants updated ' + s.employeesUpdated +
    '\n  without a tax rate   ' + s.employeesMissingTaxRate +
    '\n  without an email     ' + s.employeesMissingEmail +
    '\n  exercisable options  ' + s.preview.exercisableOptions +
    ' of ' + s.preview.vestedOptions + ' vested' +
    '\n  participants able to exercise ' + s.preview.employeesWithSomething +
    ', unable ' + s.preview.employeesWithNothing +
    '\n  warnings (' + s.warnings.length + '):\n' +
    (s.warnings.slice(0, 20).map(w => '    ' + w).join('\n') || '    none');
  console.log(report);
  return report;
}


