/**
 * Tax.gs — the tax on an ESOP exercise.
 *
 * WHAT IT DOES
 * A flat percentage of the perquisite is a fair estimate for most people and a
 * wrong answer for anyone near a surcharge limit: tax is charged on a whole
 * year's income, so an exercise that pushes someone over ₹50 lakh, ₹1 crore or
 * ₹2 crore changes the tax on income they had ALREADY earned. This module
 * works the tax out from the participant's own year-to-date position, which
 * payroll supplies once a cycle as the "tax sheet".
 *
 * THE METHOD (agreed with the ESOP team)
 *   1. Take payroll's projected taxable income for the year, before this
 *      exercise (plus any exercise approved since payroll's as-on date).
 *   2. Work out the full-year tax with and without the perquisite. Each is
 *      slab tax, less rebate, plus surcharge (with marginal relief), plus cess.
 *   3. The difference is the whole extra tax the exercise causes. Split it:
 *        · tax on the perquisite itself            — collected now
 *        · surcharge on that tax                    — collected now
 *        · extra surcharge on income ALREADY EARNED — collected now
 *        · extra surcharge on FUTURE income         — left to payroll, because
 *          the employee may have left by then
 *      "Earned" and "future" come from payroll's own split of the year's gross.
 *   4. Cess is added to what is collected now.
 *
 * WHERE THE RULES LIVE
 * Slabs, surcharge bands, rebate and cess are rows on the TaxSlabs,
 * TaxSurcharge and TaxRules tabs, so a change in the Finance Act is an edit to
 * a cell, not a code change. The defaults below are the rules for tax year
 * 2026-27 (Income-tax Act 2025, section 202 and Part I-B of the First
 * Schedule) and are written onto those tabs on first setup.
 *
 * WHEN IT STEPS ASIDE
 * Anyone without a usable tax-sheet row gets the old flat percentage, marked as
 * an estimate: no row, no regime, no income on record, or a row whose own
 * figures do not reconcile with payroll's total tax.
 */


const Tax = (function () {


  const REGIMES = ['New', 'Old'];


  /* ================= the rules, as shipped ================= */


  const DEFAULT_SLABS = [
    // Regime, income above, rate %
    ['New', 0, 0], ['New', 400000, 5], ['New', 800000, 10], ['New', 1200000, 15],
    ['New', 1600000, 20], ['New', 2000000, 25], ['New', 2400000, 30],
    ['Old', 0, 0], ['Old', 250000, 5], ['Old', 500000, 20], ['Old', 1000000, 30]
  ];


  // The new regime has no 37% band: surcharge is capped at 25% for income
  // taxed under section 202. The old regime keeps 37% above ₹5 crore.
  const DEFAULT_SURCHARGE = [
    ['New', 5000000, 10], ['New', 10000000, 15], ['New', 20000000, 25],
    ['Old', 5000000, 10], ['Old', 10000000, 15], ['Old', 20000000, 25], ['Old', 50000000, 37]
  ];


  const DEFAULT_RULES = [
    // Regime, rule, value
    ['New', 'CessPercent', 4], ['Old', 'CessPercent', 4],
    ['New', 'RoundIncomeTo', 10], ['Old', 'RoundIncomeTo', 10],
    // Rebate: nil tax up to the limit; in the new regime, just above the limit
    // the tax cannot exceed the income over it.
    ['New', 'RebateIncomeLimit', 1200000], ['Old', 'RebateIncomeLimit', 500000],
    ['New', 'RebateMaxAmount', 60000], ['Old', 'RebateMaxAmount', 12500],
    ['New', 'RebateMarginalRelief', 'TRUE'], ['Old', 'RebateMarginalRelief', 'FALSE'],
    // Surcharge marginal relief: tax plus surcharge above a threshold may not
    // exceed the tax at the threshold plus the income over it.
    ['New', 'SurchargeMarginalRelief', 'TRUE'], ['Old', 'SurchargeMarginalRelief', 'TRUE']
  ];


  const DEFAULT_NOTES = {
    slabs: 'Rate applies to income above this amount, up to the next row',
    surcharge: 'Surcharge on the tax, for total income above this amount',
    rules: ''
  };


  /* ================= reading the tables ================= */


  let _tables = null;


  // The rules change once a year, but they are read on every keystroke in the
  // options box. Five minutes in the shared cache keeps that off the sheet; an
  // edit to a rules tab therefore shows within five minutes, or at once after
  // a tax-sheet load or createWorkbook, both of which clear it.
  const CACHE_KEY = 'tax:tables:v1';
  const CACHE_SECONDS = 300;


  function normRegime(v) {
    const s = Util.trim(v).toLowerCase();
    if (s.indexOf('new') === 0) return 'New';
    if (s.indexOf('old') === 0) return 'Old';
    return '';
  }


  function truthy(v) {
    return ['true', 'yes', 'y', '1'].indexOf(Util.trim(v).toLowerCase()) >= 0;
  }


  function buildTables(slabRows, surRows, ruleRows) {
    const out = { New: { slabs: [], surcharge: [], rules: {} }, Old: { slabs: [], surcharge: [], rules: {} } };
    slabRows.forEach(function (r) {
      const g = normRegime(r.regime); if (!g) return;
      out[g].slabs.push({ above: Util.num(r.above, 0), rate: Util.num(r.rate, 0) });
    });
    surRows.forEach(function (r) {
      const g = normRegime(r.regime); if (!g) return;
      out[g].surcharge.push({ above: Util.num(r.above, 0), rate: Util.num(r.rate, 0) });
    });
    ruleRows.forEach(function (r) {
      const g = normRegime(r.regime); if (!g) return;
      out[g].rules[Util.trim(r.rule)] = r.value;
    });
    REGIMES.forEach(function (g) {
      out[g].slabs.sort((a, b) => a.above - b.above);
      out[g].surcharge.sort((a, b) => a.above - b.above);
    });
    return out;
  }


  /** The tables as configured, or the shipped defaults if the tabs are empty or absent. */
  function tables() {
    if (_tables) return _tables;
    try {
      const hit = CacheService.getScriptCache().get(CACHE_KEY);
      if (hit) { _tables = JSON.parse(hit); return _tables; }
    } catch (e) { /* the cache is a convenience, never a dependency */ }
    let slabs = [], sur = [], rules = [];
    try {
      slabs = Repo.objects(T.TAX_SLABS).map(r => ({ regime: r.Regime, above: r.AboveAmount, rate: r.RatePercent }));
      sur = Repo.objects(T.TAX_SURCHARGE).map(r => ({ regime: r.Regime, above: r.AboveAmount, rate: r.RatePercent }));
      rules = Repo.objects(T.TAX_RULES).map(r => ({ regime: r.Regime, rule: r.Rule, value: r.Value }));
    } catch (e) { /* tabs not created yet: fall through to the defaults */ }
    const built = buildTables(
      slabs.length ? slabs : DEFAULT_SLABS.map(r => ({ regime: r[0], above: r[1], rate: r[2] })),
      sur.length ? sur : DEFAULT_SURCHARGE.map(r => ({ regime: r[0], above: r[1], rate: r[2] })),
      rules.length ? rules : DEFAULT_RULES.map(r => ({ regime: r[0], rule: r[1], value: r[2] })));
    // A regime whose slab rows were deleted would compute zero tax for
    // everyone on it. Better to fall back to the shipped slabs than to be wrong.
    REGIMES.forEach(function (g) {
      if (!built[g].slabs.length) {
        built[g].slabs = DEFAULT_SLABS.filter(r => r[0] === g).map(r => ({ above: r[1], rate: r[2] }));
      }
    });
    _tables = built;
    try { CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(built), CACHE_SECONDS); } catch (e) { /* ignore */ }
    return built;
  }


  function resetCache() {
    _tables = null;
    try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) { /* ignore */ }
  }


  /** Write the shipped rules onto the tabs the first time, never over an edit. */
  function seedIfEmpty() {
    const seeded = [];
    [T.TAX_SLABS, T.TAX_SURCHARGE, T.TAX_RULES].forEach(n => Repo.invalidate(n));
    if (!Repo.objects(T.TAX_SLABS).length) {
      Repo.appendAll(T.TAX_SLABS, DEFAULT_SLABS.map(r =>
        ({ Regime: r[0], AboveAmount: r[1], RatePercent: r[2], Note: DEFAULT_NOTES.slabs })));
      seeded.push(T.TAX_SLABS);
    }
    if (!Repo.objects(T.TAX_SURCHARGE).length) {
      Repo.appendAll(T.TAX_SURCHARGE, DEFAULT_SURCHARGE.map(r =>
        ({ Regime: r[0], AboveAmount: r[1], RatePercent: r[2], Note: DEFAULT_NOTES.surcharge })));
      seeded.push(T.TAX_SURCHARGE);
    }
    if (!Repo.objects(T.TAX_RULES).length) {
      Repo.appendAll(T.TAX_RULES, DEFAULT_RULES.map(r =>
        ({ Regime: r[0], Rule: r[1], Value: r[2], Note: RULE_NOTES[r[1]] || '' })));
      seeded.push(T.TAX_RULES);
    }
    resetCache();
    return seeded;
  }


  const RULE_NOTES = {
    CessPercent: 'Health and education cess, charged on tax plus surcharge. No marginal relief on cess',
    RoundIncomeTo: 'Taxable income is rounded UP to the next multiple of this, as payroll does',
    RebateIncomeLimit: 'Income up to this gets the rebate (nil tax for most people)',
    RebateMaxAmount: 'The largest rebate',
    RebateMarginalRelief: 'TRUE: just above the limit, tax cannot exceed the income over the limit',
    SurchargeMarginalRelief: 'TRUE: tax plus surcharge above a threshold cannot exceed the tax at the threshold plus the income over it'
  };


  /* ================= the annual tax ================= */


  function ruleNum(rg, name, dflt) {
    const v = rg.rules[name];
    return v === undefined || v === '' ? dflt : Util.num(v, dflt);
  }


  function ceilTo(x, step) {
    return step > 1 ? Math.ceil(x / step - 1e-9) * step : Math.round(x);
  }


  function slabTax(rg, x) {
    const s = rg.slabs;
    let tax = 0;
    for (let i = 0; i < s.length; i++) {
      const lo = s[i].above;
      const hi = i + 1 < s.length ? s[i + 1].above : Infinity;
      if (x > lo) tax += (Math.min(x, hi) - lo) * s[i].rate / 100;
    }
    return tax;
  }


  /** Tax after the rebate, before surcharge. */
  function afterRebate(rg, x) {
    const base = slabTax(rg, x);
    const limit = ruleNum(rg, 'RebateIncomeLimit', 0);
    const max = ruleNum(rg, 'RebateMaxAmount', 0);
    if (limit <= 0) return { base: base, after: base, rebate: 0 };
    let after = base;
    if (x <= limit) after = base - Math.min(base, max);
    else if (truthy(rg.rules.RebateMarginalRelief === undefined ? 'FALSE' : rg.rules.RebateMarginalRelief)) {
      after = Math.min(base, x - limit);
    }
    return { base: base, after: after, rebate: base - after };
  }


  /** The surcharge band income falls in: { rate, above } — rate 0 below the first band. */
  function band(rg, x) {
    let hit = { rate: 0, above: 0 };
    rg.surcharge.forEach(function (b) { if (x > b.above) hit = { rate: b.rate, above: b.above }; });
    return hit;
  }


  /**
   * The whole year's tax on a taxable income, with every step kept so it can be
   * shown to the participant.
   */
  function annual(regime, income) {
    const rg = tables()[regime];
    if (!rg) throw new Error('Unknown tax regime "' + regime + '".');
    const x = ceilTo(Math.max(0, income), ruleNum(rg, 'RoundIncomeTo', 10));
    const ar = afterRebate(rg, x);
    const b = band(rg, x);


    let raw = ar.after * b.rate / 100;
    let sur = raw;
    if (b.rate > 0 && truthy(rg.rules.SurchargeMarginalRelief === undefined ? 'TRUE' : rg.rules.SurchargeMarginalRelief)) {
      // Tax plus surcharge may not exceed the tax at the threshold (surcharge
      // included, at the band below) plus the income above the threshold.
      const below = band(rg, b.above);
      const atThreshold = afterRebate(rg, b.above).after * (1 + below.rate / 100);
      sur = Math.max(0, Math.min(raw, atThreshold + (x - b.above) - ar.after));
    }
    const cessPct = ruleNum(rg, 'CessPercent', 4);
    const surR = Math.round(sur);
    const afterR = Math.round(ar.after);
    const cess = Math.round((afterR + surR) * cessPct / 100);
    return {
      income: x, base: Math.round(ar.base), rebate: Math.round(ar.rebate), tax: afterR,
      surchargeRate: b.rate, surchargeFrom: b.above, surchargeRaw: Math.round(raw),
      surcharge: surR, marginalRelief: Math.max(0, Math.round(raw) - surR),
      cessPercent: cessPct, cess: cess, total: afterR + surR + cess
    };
  }


  /* ================= the tax sheet ================= */


  function rowFor(employeeId) {
    try { return Repo.findOne(T.TAX_SHEET, 'EmployeeID', Util.trim(employeeId).toUpperCase()); }
    catch (e) { return null; }
  }


  /** Flags that make a row untrustworthy: those people get the flat rate instead. */
  const BLOCKING = ['NO_REGIME', 'NO_INCOME', 'MISMATCH'];


  function usable(row) {
    if (!row) return { ok: false, why: 'No row for this participant in the tax sheet' };
    const regime = normRegime(row.Regime);
    if (!regime) return { ok: false, why: 'Payroll shows no tax regime for this participant' };
    const flags = Util.trim(row.Flags).split(/[,\s]+/).filter(Boolean);
    const stop = flags.filter(f => BLOCKING.indexOf(f) >= 0)[0];
    if (stop === 'NO_INCOME') return { ok: false, why: 'Payroll shows no taxable income on record for this participant' };
    if (stop === 'MISMATCH') return { ok: false, why: 'Payroll’s own tax figure for this participant does not reconcile, so it was not relied on' };
    if (stop) return { ok: false, why: 'The tax-sheet row is flagged ' + stop };
    return { ok: true, regime: regime };
  }


  /** Perquisite from exercises approved after payroll's as-on date. */
  function approvedSince(employeeId, asOn, exceptAppId) {
    const cut = asOn ? Util.startOfDay(asOn).getTime() + 86400000 : 0;
    let sum = 0;
    const ids = [];
    Repo.filter(T.APPLICATIONS, function (a) {
      return Util.trim(a.EmployeeID).toUpperCase() === Util.trim(employeeId).toUpperCase() &&
        Util.trim(a.Status) === STATUS.APPROVED && Util.trim(a.AppID) !== Util.trim(exceptAppId);
    }).forEach(function (a) {
      const when = Util.toDate(a.ApprovedAt);
      if (when && when.getTime() >= cut) { sum += Util.num(a.PerquisiteAmount, 0); ids.push(Util.trim(a.AppID)); }
    });
    return { amount: Math.round(sum * 100) / 100, appIds: ids };
  }


  /* ================= the tax on one exercise ================= */


  function flat(perquisite, flatRate, why) {
    const amount = Math.round(perquisite * flatRate) / 100;
    return {
      amount: amount, method: 'Flat', effectivePercent: flatRate,
      breakdown: { v: 1, method: 'Flat', reason: why, ratePercent: flatRate, perquisite: perquisite, collect: amount }
    };
  }


  /**
   * The tax to collect at exercise for a perquisite of `perquisite` rupees.
   * `flatRate` is the percentage to fall back on.
   */
  function forExercise(employeeId, appId, perquisite, flatRate) {
    const P = Math.round(Util.num(perquisite, 0) * 100) / 100;
    if (P <= 0) return { amount: 0, method: 'None', effectivePercent: 0, breakdown: null };


    const row = rowFor(employeeId);
    const ok = usable(row);
    if (!ok.ok) return flat(P, Util.num(flatRate, 0), ok.why);


    const regime = ok.regime;
    const asOn = Util.toDate(row.AsOn);
    const prior = approvedSince(employeeId, asOn, appId);


    const x0 = Util.num(row.NetTaxable, 0) + prior.amount;
    const projected = Util.num(row.RemainingMonths, 0) <= 0 ? 0 : Math.max(0, Util.num(row.ProjectedGross, 0));
    // Earned so far = everything in the year's gross that is not still to come.
    // That includes perquisites already taxed — they are income already earned.
    const earned = Math.max(0, Util.num(row.TotalGross, 0) - Util.num(row.ProjectedGross, 0)) + prior.amount;
    const share = earned + projected > 0 ? earned / (earned + projected) : 1;


    const before = annual(regime, x0);
    const after = annual(regime, x0 + P);


    const dBase = after.tax - before.tax;                  // slab tax the perquisite adds
    const dSur = after.surcharge - before.surcharge;       // surcharge it adds, after marginal relief
    const own = Math.max(0, Math.min(after.surchargeRate * dBase / 100, dSur));
    const cliff = Math.max(0, dSur - own);                 // surcharge on tax already owed
    const cliffNow = cliff * share;
    const cessPct = after.cessPercent;


    const pre = dBase + own + cliffNow;
    const whole = after.total - before.total;
    const collect = Math.min(Math.max(0, whole), Math.round(pre * (1 + cessPct / 100)));


    return {
      amount: collect, method: 'Sheet', effectivePercent: Math.round(collect / P * 10000) / 100,
      breakdown: {
        v: 1, method: 'Sheet', regime: regime, asOn: Util.dateKey(asOn),
        perquisite: P, priorPerquisite: prior.amount, priorApps: prior.appIds,
        incomeBefore: before.income, incomeAfter: after.income,
        earned: Math.round(earned), future: Math.round(projected), earnedShare: Math.round(share * 10000) / 10000,
        taxBefore: before.tax, taxAfter: after.tax, dBase: dBase,
        surchargeRate: after.surchargeRate, surchargeBefore: before.surcharge, surchargeAfter: after.surcharge,
        surchargeRaw: after.surchargeRaw, marginalRelief: after.marginalRelief, rebateAfter: after.rebate,
        ownSurcharge: Math.round(own), cliff: Math.round(cliff), cliffNow: Math.round(cliffNow),
        cliffLater: Math.round(cliff - cliffNow), cessPercent: cessPct,
        totalBefore: before.total, totalAfter: after.total, whole: whole,
        collect: collect, left: Math.max(0, whole - collect),
        tdsToDate: Util.num(row.TDSToDate, 0), outsideTax: Util.num(row.OutsideTax, 0),
        remainingMonths: Util.num(row.RemainingMonths, 0)
      }
    };
  }


  /* ================= loading the sheet ================= */


  const SHEET_FIELDS = ['employeeId', 'regime', 'netTaxable', 'totalGross', 'projectedGross',
    'totalTax', 'previousTds', 'outsideTax', 'tdsToDate', 'remainingMonths'];


  /**
   * Replace the TaxSheet tab with the rows sent, keeping only participants.
   * Every row is checked against the rules before it is trusted: the tax this
   * module works out from payroll's taxable income must equal payroll's own
   * total tax, otherwise the row is flagged and the flat rate is used.
   */
  function load(session, payload) {
    const asOn = Util.toDate(payload.asOn);
    if (!asOn) throw new Error('Enter the date payroll was processed up to (the “as on” date of this report).');
    // Before anything is read: the tabs arrive with createWorkbook, and loading
    // into a tab that is not there would fail halfway with a less helpful message.
    if (!Repo.book().getSheetByName(T.TAX_SHEET)) {
      throw new Error('The tax tabs do not exist in the workbook yet. Open the Apps Script editor, run ' +
        'createWorkbook once, then load the tax sheet again.');
    }
    const rows = payload.rows || [];
    if (!rows.length) throw new Error('No rows were received.');


    const participants = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { participants[Util.trim(e.EmployeeID).toUpperCase()] = true; });


    resetCache();
    const out = [];
    const flagged = { NO_REGIME: [], NO_INCOME: [], MISMATCH: [], NEG_MONTHS: [], OVER_DEDUCTED: [] };
    const seen = {};
    let skippedNotParticipant = 0, duplicates = 0;


    rows.forEach(function (r) {
      const id = Util.trim(r.employeeId).toUpperCase();
      if (!id || !participants[id]) { skippedNotParticipant++; return; }
      if (seen[id]) { duplicates++; return; }
      seen[id] = true;


      const regime = normRegime(r.regime);
      const net = Util.num(r.netTaxable, 0);
      const flags = [];
      let engineTotal = '';
      if (!regime) flags.push('NO_REGIME');
      if (net <= 0) flags.push('NO_INCOME');
      if (regime && net > 0) {
        engineTotal = annual(regime, net).total;
        // Within ₹5: payroll rounds each line slightly differently.
        if (Math.abs(engineTotal - Util.num(r.totalTax, 0)) > 5) flags.push('MISMATCH');
      }
      if (Util.num(r.remainingMonths, 0) < 0) flags.push('NEG_MONTHS');
      if (Util.num(r.tdsToDate, 0) + Util.num(r.outsideTax, 0) + Util.num(r.previousTds, 0) > Util.num(r.totalTax, 0) &&
          Util.num(r.totalTax, 0) > 0) flags.push('OVER_DEDUCTED');
      flags.forEach(f => flagged[f].push(id));


      out.push({
        EmployeeID: id, Regime: regime || Util.trim(r.regime), NetTaxable: net,
        TotalGross: Util.num(r.totalGross, 0), ProjectedGross: Util.num(r.projectedGross, 0),
        TotalTax: Util.num(r.totalTax, 0), PreviousTDS: Util.num(r.previousTds, 0),
        OutsideTax: Util.num(r.outsideTax, 0), TDSToDate: Util.num(r.tdsToDate, 0),
        RemainingMonths: Math.max(0, Util.num(r.remainingMonths, 0)),
        AsOn: Util.dateKey(asOn), LoadedAt: Util.stamp(), LoadedBy: session.userId,
        Flags: flags.join(','), EngineTotal: engineTotal
      });
    });


    if (!out.length) {
      throw new Error('None of the ' + rows.length + ' rows belong to a participant on the portal, so nothing was loaded. ' +
        'Check the file is the right report and that participants have been synced.');
    }


    Repo.replaceAll(T.TAX_SHEET, out);
    resetCache();


    const withoutRow = Object.keys(participants).filter(id => !seen[id]).length;
    const repriced = repriceOpenApplications();
    audit(session.userId, session.role, 'TAX_SHEET_LOADED', '',
      out.length + ' participants as on ' + Util.dateKey(asOn) + ', ' +
      Object.keys(flagged).map(k => k + ' ' + flagged[k].length).join(', ') + ', ' + repriced + ' applications repriced');


    return {
      ok: true,
      message: out.length + ' participants’ tax rows loaded, as on ' + Util.prettyDate(asOn) + '. ' +
        repriced + ' open application' + (repriced === 1 ? '' : 's') + ' repriced.',
      loaded: out.length, received: rows.length, notParticipants: skippedNotParticipant, duplicates: duplicates,
      participantsWithoutRow: withoutRow, repriced: repriced,
      flagged: Object.keys(flagged).reduce(function (a, k) {
        a[k] = { count: flagged[k].length, ids: flagged[k].slice(0, 60) }; return a;
      }, {})
    };
  }


  /** Re-work the tax on every application still open, from the new sheet. */
  function repriceOpenApplications() {
    let n = 0;
    Repo.filter(T.APPLICATIONS, a =>
      [STATUS.APPROVED, STATUS.REJECTED].indexOf(Util.trim(a.Status)) < 0).forEach(function (a) {
      try { AppStore.reprice(AppStore.require(a.AppID)); n++; }
      catch (e) { console.warn('reprice ' + a.AppID + ': ' + e.message); }
    });
    return n;
  }


  function status() {
    let rows = [];
    try { rows = Repo.objects(T.TAX_SHEET); } catch (e) { rows = []; }
    if (!rows.length) return { loaded: false, rows: 0 };
    const flags = {};
    rows.forEach(function (r) {
      Util.trim(r.Flags).split(',').filter(Boolean).forEach(f => { flags[f] = (flags[f] || 0) + 1; });
    });
    return {
      loaded: true, rows: rows.length, asOn: Util.dateKey(rows[0].AsOn),
      prettyAsOn: Util.prettyDate(rows[0].AsOn), loadedAt: Util.prettyStamp(rows[0].LoadedAt),
      loadedBy: Util.trim(rows[0].LoadedBy), flags: flags
    };
  }


  /** Which participants the loaded sheet can price: { EMPLOYEEID: true }. */
  function covered() {
    const out = {};
    try {
      Repo.objects(T.TAX_SHEET).forEach(function (r) {
        if (usable(r).ok) out[Util.trim(r.EmployeeID).toUpperCase()] = true;
      });
    } catch (e) { /* no tab yet: nobody is covered */ }
    return out;
  }


  /**
   * The same picture the loader showed when it finished, rebuilt from what is
   * stored: who is flagged and why. The loader's own result box disappears when
   * it is closed; this does not.
   */
  function report() {
    const st = status();
    if (!st.loaded) return { status: st };
    const rows = Repo.objects(T.TAX_SHEET);
    const flagged = {};
    rows.forEach(function (r) {
      Util.trim(r.Flags).split(',').filter(Boolean).forEach(function (f) {
        (flagged[f] = flagged[f] || []).push(Util.trim(r.EmployeeID));
      });
    });
    const participants = Repo.objects(T.EMPLOYEES).length;
    return {
      status: st, participants: participants, withoutRow: Math.max(0, participants - rows.length),
      flagged: Object.keys(flagged).reduce(function (a, k) {
        a[k] = { count: flagged[k].length, ids: flagged[k].slice(0, 300) }; return a;
      }, {})
    };
  }


  return {
    report: report,
    covered: covered,
    annual: annual, forExercise: forExercise, load: load, status: status,
    seedIfEmpty: seedIfEmpty, resetCache: resetCache, tables: tables,
    repriceOpenApplications: repriceOpenApplications, SHEET_FIELDS: SHEET_FIELDS
  };
})();


