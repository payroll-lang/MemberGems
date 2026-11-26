/**
 * Domain.gs — the rules of the scheme, in one place.
 *
 *   available options   the report's own `Vested` figure. It is ALREADY net of
 *                       exercised, exercise-pending and cancelled — verified
 *                       against Granted = Unvested + Vested + Exercised +
 *                       ExercisesPending + UnvestedCancelled + VestedCancelled
 *                       across every row of the export. Do not subtract again.
 *                       The portal deducts only what it has itself committed
 *                       since the report's "as on" date.
 *   shares              options × the grant's Multiplier (3.6 or 1)
 *   exercise amount     options × ₹1  (per the exercise notice)
 *   perquisite          (FMV × shares) − exercise amount
 *   tax                 perquisite × the employee's TaxRatePercent
 *   lot                 10 options. 10 × 3.6 = 36, so a whole lot always
 *                       converts to a whole number of shares.
 *   FMV                 (open + close) / 2 of the trading day BEFORE the day
 *                       the exercise amount was paid
 *   window              day 1 to day 30 of each month
 *   tax due             the 25th; if exercise was paid after the 25th, the
 *                       25th of the following month
 */


const Domain = (function () {


  /* ================= exercise window ================= */


  function windowIdFor(date) {
    return Utilities.formatDate(Util.startOfDay(date || new Date()), Util.tz(), 'yyyy-MM');
  }


  function ensureWindow(date) {
    const d = Util.startOfDay(date || new Date());
    const id = windowIdFor(d);
    let w = Repo.find(T.WINDOWS, r => Util.windowKey(r.WindowID) === id);
    if (w) return w;


    const openDay = Math.max(1, cfgNum('WINDOW_OPEN_DAY', 1));
    const closeDay = cfgNum('WINDOW_CLOSE_DAY', 30);
    const lastDay = Util.lastDayOfMonth(d.getFullYear(), d.getMonth());
    const open = new Date(d.getFullYear(), d.getMonth(), Math.min(openDay, lastDay));
    const close = new Date(d.getFullYear(), d.getMonth(), Math.min(closeDay, lastDay));


    Repo.append(T.WINDOWS, {
      WindowID: id,
      Label: Utilities.formatDate(d, Util.tz(), 'MMMM yyyy'),
      OpenDate: Util.dateKey(open),
      CloseDate: Util.dateKey(close),
      TaxDueDate: Util.dateKey(taxDueDateFor(close)),
      Status: 'Open',
      CreatedAt: Util.stamp(),
      Remarks: 'Created automatically'
    });


    w = Repo.find(T.WINDOWS, r => Util.windowKey(r.WindowID) === id);
    if (!w) {
      // Should be impossible now that WindowID is compared canonically. If it
      // ever happens again, say so plainly rather than handing back null and
      // letting the caller fail on a missing OpenDate.
      throw new Error('The ' + id + ' exercise window could not be read back after being created. ' +
        'Check the Windows tab for a malformed WindowID, then run repairWindows() from the editor.');
    }
    return w;
  }


  function currentWindow() {
    return ensureWindow(new Date());
  }


  function windowState(w) {
    const today = Util.startOfDay(new Date());
    const open = Util.startOfDay(w.OpenDate);
    const close = Util.startOfDay(w.CloseDate);
    if (Util.trim(w.Status).toLowerCase() === 'closed') {
      return { open: false, reason: 'The ' + Util.monthLabel(w.Label) + ' exercise window has been closed by the ESOP team.' };
    }
    if (today.getTime() < open.getTime()) {
      return { open: false, reason: 'The ' + Util.monthLabel(w.Label) + ' window opens on ' + Util.prettyDate(open) + '.' };
    }
    if (today.getTime() > close.getTime()) {
      return { open: false, reason: 'The ' + Util.monthLabel(w.Label) + ' window closed on ' + Util.prettyDate(close) + '.' };
    }
    return {
      open: true,
      reason: 'Open until ' + Util.prettyDate(close) + ' · ' +
        Math.max(0, Math.round((close - today) / 86400000)) + ' days left'
    };
  }


  function taxDueDateFor(referenceDate) {
    const d = Util.startOfDay(referenceDate || new Date());
    const dueDay = cfgNum('TAX_DUE_DAY', 25);
    if (d.getDate() <= dueDay) {
      const last = Util.lastDayOfMonth(d.getFullYear(), d.getMonth());
      return new Date(d.getFullYear(), d.getMonth(), Math.min(dueDay, last));
    }
    const nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const lastNext = Util.lastDayOfMonth(nm.getFullYear(), nm.getMonth());
    return new Date(nm.getFullYear(), nm.getMonth(), Math.min(dueDay, lastNext));
  }


  /* ================= FMV ================= */


  /**
   * FMV for an exercise paid on `paymentDate`: the most recent FMV row
   * STRICTLY BEFORE that date. Walking back covers weekends and holidays,
   * for which no row exists.
   */
  function fmvForPaymentDate(paymentDate) {
    const pay = Util.startOfDay(paymentDate);
    if (!pay) throw new Error('Enter the date on which you paid the exercise amount.');


    const prior = fmvRows().filter(r => r.date.getTime() < pay.getTime());
    if (!prior.length) {
      throw new Error('No PWL share price is on record for any trading day before ' +
        Util.prettyDate(pay) + '. The ESOP team needs to load it before this exercise can be priced.');
    }
    const r = prior[0];
    return {
      date: Util.dateKey(r.date),
      prettyDate: Util.prettyDate(r.date),
      open: r.open,
      close: r.close,
      fmv: r.fmv,
      source: r.source
    };
  }


  function fmvRows() {
    return Repo.objects(T.FMV)
      .map(function (r) {
        const open = Util.num(r.OpenPrice, NaN);
        const close = Util.num(r.ClosePrice, NaN);
        const stated = Util.num(r.FMV, NaN);
        const usable = (!isNaN(open) && !isNaN(close) && open > 0 && close > 0)
          ? (open + close) / 2
          : stated;
        return {
          date: Util.startOfDay(r.Date),
          open: isNaN(open) ? null : open,
          close: isNaN(close) ? null : close,
          fmv: Math.round(usable * 100) / 100,
          source: Util.trim(r.Source)
        };
      })
      .filter(r => r.date && r.fmv > 0)
      .sort((a, b) => b.date - a.date);
  }


  function latestFmv() {
    const rows = fmvRows();
    if (!rows.length) return null;
    const r = rows[0];
    return {
      date: Util.dateKey(r.date), prettyDate: Util.prettyDate(r.date),
      fmv: r.fmv, open: r.open, close: r.close, source: r.source
    };
  }


  function upsertFmv(dateInput, open, close, source, actorId) {
    const d = Util.startOfDay(Util.toDate(dateInput));
    if (!d) throw new Error('Enter a valid date.');
    const o = Util.num(open, NaN), c = Util.num(close, NaN);
    if (isNaN(o) || o <= 0 || isNaN(c) || c <= 0) {
      throw new Error('Enter both the opening and closing price as positive numbers.');
    }
    const key = Util.dateKey(d);
    const fmv = Math.round(((o + c) / 2) * 100) / 100;
    const existing = Repo.find(T.FMV, r => Util.dateKey(r.Date) === key);
    const row = {
      Date: key, OpenPrice: o, ClosePrice: c, FMV: fmv,
      Source: Util.trim(source) || 'Manual entry',
      EnteredBy: actorId || '', EnteredAt: Util.stamp()
    };
    if (existing) Repo.update(T.FMV, existing._row, row);
    else Repo.append(T.FMV, row);
    audit(actorId, ROLE.ADMIN, 'FMV_SET', '', key + ' open ' + o + ' close ' + c + ' fmv ' + fmv);
    return { ok: true, date: key, fmv: fmv, open: o, close: c };
  }


  /* ================= lots and share granularity ================= */


  function lotSize() {
    const n = cfgNum('OPTION_LOT_SIZE', 10);
    return n > 0 ? n : 10;
  }


  function lotScope() {
    return Util.trim(cfg('LOT_SCOPE')).toLowerCase() === 'total' ? 'total' : 'grant';
  }


  /**
   * The smallest whole number of options that converts to a whole number of
   * shares at this multiplier. 3.6 = 18/5, so 5 options → 18 shares; at a
   * multiplier of 1 it is simply 1. A lot of 10 is a multiple of 5, which is
   * why a whole lot never produces a fractional share.
   */
  function shareGranularity(multiplier) {
    const m = Util.num(multiplier, 1) || 1;
    for (let k = 1; k <= 1000; k++) {
      const v = k * m;
      if (Math.abs(v - Math.round(v)) < 1e-9) return k;
    }
    return 1;
  }


  /** The step a single grant's quantity must be a multiple of. */
  function stepFor(multiplier) {
    if (lotScope() === 'total') return shareGranularity(multiplier);
    // A lot exists to stop a fractional share: 3.6 shares per option means
    // options must come in fives for the shares to be whole, and a lot of ten
    // is the register's round number above that. At a whole-number multiplier
    // (ESOP Plan 2025 is 1 to 1) nothing can come out fractional, so seven
    // options are seven shares and there is nothing for a lot to protect.
    if (shareGranularity(multiplier) === 1) return 1;
    return lotSize();
  }


  function shares(options, multiplier) {
    return Math.round(Util.num(options) * Util.num(multiplier, 1) * 1e6) / 1e6;
  }


  /* ================= grants ================= */


  /**
   * Grant-level view of what an employee may exercise.
   *
   * The report is authoritative for VestedOptions. On top of that the portal
   * deducts what it has itself committed and the report cannot yet know about:
   * every live application, plus any application approved AFTER the report's
   * "as on" date.
   */
  function grantsFor(employeeId, excludeAppId) {
    const empKey = Util.trim(employeeId).toUpperCase();
    // Grants runs to thousands of rows; read only this participant's.
    const grants = Repo.findByColumn(T.GRANTS, 'EmployeeID', empKey);
    if (!grants.length) return [];


    const apps = Repo.filter(T.APPLICATIONS, a =>
      Util.trim(a.EmployeeID).toUpperCase() === empKey &&
      Util.trim(a.AppID) !== Util.trim(excludeAppId || ''));


    // Which applications still hold options against the balance?
    //
    // A live application always holds. An approved one is the awkward case:
    // eventually the vesting report itself reflects the exercise and holding
    // it here as well would double-deduct — but until it does, releasing the
    // hold hands the same options back to be exercised twice.
    //
    // Comparing the approval date against the report's "as on" date is not a
    // safe test of that, because re-syncing the report moves "as on" forward
    // whether or not the source system has processed the exercise. So an
    // approval in the CURRENT window always holds: within the live window the
    // report has almost certainly not caught up, and the cost of being wrong
    // in that direction is a balance that reads low for a few days, against
    // the cost in the other direction of options being exercised twice.
    const thisWindow = Util.windowKey(windowIdFor(new Date()));
    const holdIds = {};
    apps.forEach(function (a) {
      const status = Util.trim(a.Status);
      if (status === STATUS.REJECTED) return;
      if (status === STATUS.APPROVED) {
        const approvedAt = Util.toDate(a.ApprovedAt) || Util.toDate(a.ReviewedAt);
        holdIds[Util.trim(a.AppID)] = {
          approved: true,
          approvedAt: approvedAt,
          currentWindow: Util.windowKey(a.WindowID) === thisWindow
        };
      } else {
        // A Draft or Sent Back application from a window that has since
        // closed can never be finished — applications are only editable while
        // their window is open — yet it used to keep its options pledged for
        // ever, so a participant's balance stayed reduced by something
        // abandoned a month or a year ago. Those no longer hold anything.
        // Submitted and Under Review are different: they are waiting on the
        // ESOP team, not the participant, and still genuinely claim options.
        const abandoned = [STATUS.DRAFT, STATUS.SENT_BACK].indexOf(status) >= 0 &&
          Util.windowKey(a.WindowID) < thisWindow;
        if (abandoned) return;
        holdIds[Util.trim(a.AppID)] = { approved: false };
      }
    });


    const ids = Object.keys(holdIds);
    const committed = {};
    if (ids.length) {
      Repo.filter(T.APP_LINES, l => ids.indexOf(Util.trim(l.AppID)) >= 0).forEach(function (l) {
        committed[Util.trim(l.GrantID)] = (committed[Util.trim(l.GrantID)] || 0) +
          Util.num(l.OptionsExercised, 0);
        committed['__by_app__' + Util.trim(l.AppID) + '__' + Util.trim(l.GrantID)] =
          Util.num(l.OptionsExercised, 0);
      });
    }


    const defaultPrice = cfgNum('EXERCISE_PRICE', 1);


    return grants.map(function (g) {
      const gid = Util.trim(g.GrantID);
      const reportAsOn = Util.toDate(g.ReportAsOn);
      const multiplier = Util.num(g.Multiplier, 1) || 1;
      const vested = Util.num(g.VestedOptions, 0);


      // Sum the holds that this grant's report figure cannot already know about.
      let pledged = 0;
      ids.forEach(function (appId) {
        const hold = holdIds[appId];
        const qty = Util.num(committed['__by_app__' + appId + '__' + gid], 0);
        if (!qty) return;
        if (!hold.approved) { pledged += qty; return; }
        // Approved in the window that is open now — the report cannot be
        // trusted to have absorbed it yet, whatever its "as on" date says.
        if (hold.currentWindow) { pledged += qty; return; }
        if (!reportAsOn || !hold.approvedAt) { pledged += qty; return; }
        if (hold.approvedAt.getTime() > reportAsOn.getTime()) pledged += qty;
      });


      const available = Math.max(0, Math.round((vested - pledged) * 1e6) / 1e6);
      const step = stepFor(multiplier);
      const exercisable = Math.floor((available + 1e-9) / step) * step;


      let tranches = [];
      try {
        const raw = Util.trim(g.TrancheDetail);
        if (raw) tranches = JSON.parse(raw);
      } catch (e) { tranches = []; }


      return {
        grantId: gid,
        employeeId: Util.trim(g.EmployeeID),
        planName: Util.trim(g.PlanName),
        multiplier: multiplier,
        grantDate: Util.dateKey(g.GrantDate),
        prettyGrantDate: Util.prettyDate(g.GrantDate),
        grantStatus: Util.trim(g.GrantStatus),
        typeOfVesting: Util.trim(g.TypeOfVesting),
        exercisePrice: Util.num(g.ExercisePrice, defaultPrice) || defaultPrice,


        totalGranted: Util.num(g.TotalGranted, 0),
        unvestedOptions: Util.num(g.UnvestedOptions, 0),
        vestedOptions: vested,
        exercisedOptions: Util.num(g.ExercisedOptions, 0),
        exercisePendingOptions: Util.num(g.ExercisePendingOptions, 0),
        cancelledOptions: Util.num(g.CancelledOptions, 0),


        pledgedElsewhere: Math.round(pledged * 1e6) / 1e6,
        availableOptions: available,
        exercisableOptions: exercisable,
        step: step,


        // What the employee actually receives, and pays.
        exercisableShares: shares(exercisable, multiplier),
        vestedShares: shares(vested, multiplier),
        unvestedShares: shares(Util.num(g.UnvestedOptions, 0), multiplier),
        exerciseAmountIfAll: Math.round(exercisable * (Util.num(g.ExercisePrice, defaultPrice) || defaultPrice) * 100) / 100,


        trancheCount: Util.num(g.TrancheCount, 0),
        vestedTrancheCount: Util.num(g.VestedTrancheCount, 0),
        nextVestDate: Util.dateKey(g.NextVestDate),
        prettyNextVestDate: Util.prettyDate(g.NextVestDate),
        tranches: tranches,
        reportAsOn: Util.dateKey(g.ReportAsOn)
      };
    }).sort(function (a, b) {
      if (b.exercisableOptions !== a.exercisableOptions) return b.exercisableOptions - a.exercisableOptions;
      return String(a.grantDate).localeCompare(String(b.grantDate));
    });
  }


  /* ================= validation ================= */


  /**
   * Validate {grantId, options} entries against the lot rule and availability.
   * Returns priced lines. Messages name the nearest valid quantities so the
   * employee can act on them without guessing.
   */
  function validateLines(employeeId, lines, appId) {
    const lot = lotSize();
    const scope = lotScope();
    const grants = grantsFor(employeeId, appId);
    const byId = {};
    grants.forEach(g => { byId[g.grantId] = g; });


    const out = [];
    (lines || []).forEach(function (l) {
      const gid = Util.trim(l.grantId);
      const n = Util.num(l.options, 0);
      if (!gid || n === 0) return;


      const g = byId[gid];
      if (!g) throw new Error('Grant ' + gid + ' is not on your record.');
      if (n < 0) throw new Error('Enter a positive number of options for grant ' + gid + '.');


      if (g.exercisableOptions <= 0) {
        throw new Error('Grant ' + gid + ' has ' + Util.count(g.availableOptions) +
          ' vested options, which is less than one lot of ' + lot +
          '. It cannot be exercised on its own' +
          (scope === 'grant' ? '.' : ' unless combined with another grant.'));
      }


      const step = g.step;
      if (Math.abs(n / step - Math.round(n / step)) > 1e-9) {
        const lower = Math.floor(n / step) * step;
        const upper = lower + step;
        throw new Error('For grant ' + gid + ', options must be in multiples of ' + step +
          '. You entered ' + Util.count(n) + ' — use ' + Util.count(lower) + ' or ' + Util.count(upper) + '.' +
          (step !== lot ? ' (A multiple of ' + step + ' is what converts to a whole number of shares at a multiplier of ' + g.multiplier + '.)' : ''));
      }


      if (n > g.exercisableOptions + 1e-9) {
        throw new Error('Grant ' + gid + ' has ' + Util.count(g.exercisableOptions) +
          ' options available to exercise' +
          (g.pledgedElsewhere ? ' (' + Util.count(g.pledgedElsewhere) + ' are already committed on another application)' : '') +
          '. You entered ' + Util.count(n) + '.');
      }


      const sh = shares(n, g.multiplier);
      if (Math.abs(sh - Math.round(sh)) > 1e-6) {
        throw new Error('For grant ' + gid + ', ' + Util.count(n) + ' options convert to ' + sh +
          ' shares, which is not a whole number. Use a multiple of ' + shareGranularity(g.multiplier) + '.');
      }


      out.push({
        grantId: gid,
        planName: g.planName,
        multiplier: g.multiplier,
        options: n,
        shares: Math.round(sh),
        exercisePrice: g.exercisePrice,
        lineExerciseAmount: Math.round(n * g.exercisePrice * 100) / 100
      });
    });


    if (!out.length) {
      throw new Error('Enter the number of options you wish to exercise on at least one grant.');
    }


    // Under 'total' scope the grand total is what must be a whole lot.
    if (scope === 'total') {
      const total = out.reduce((a, l) => a + l.options, 0);
      if (Math.abs(total / lot - Math.round(total / lot)) > 1e-9) {
        const lower = Math.floor(total / lot) * lot;
        throw new Error('Your total across all grants must be a multiple of ' + lot +
          '. You have entered ' + Util.count(total) + ' — adjust to ' + Util.count(lower) +
          ' or ' + Util.count(lower + lot) + '.');
      }
    }


    return out;
  }


  /**
   * The money.
   *   exercise amount = options × ₹1
   *   perquisite      = (FMV × shares) − exercise amount
   * `fmvValue` may be null before the exercise payment date is recorded, in
   * which case the perquisite is reported as zero rather than guessed.
   */
  /**
   * Price a set of option lines.
   *
   * `taxRatePercent` is the flat fallback. When `ctx` ({employeeId, appId}) is
   * given and the participant has a usable row in the tax sheet, the tax is
   * worked out from their year-to-date position instead (see Tax.gs) and the
   * flat rate is only the fallback. The steps come back as `taxBreakdown`.
   */
  function price(lines, fmvValue, taxRatePercent, ctx) {
    const fmv = (fmvValue === null || fmvValue === undefined) ? null : Util.num(fmvValue);


    let totalOptions = 0, totalShares = 0, exerciseAmount = 0, perquisite = 0;
    const priced = lines.map(function (l) {
      const opts = Util.num(l.options, 0);
      const mult = Util.num(l.multiplier, 1) || 1;
      const sh = l.shares !== undefined ? Util.num(l.shares) : shares(opts, mult);
      const lineAmount = l.lineExerciseAmount !== undefined
        ? Util.num(l.lineExerciseAmount)
        : Math.round(opts * Util.num(l.exercisePrice, 1) * 100) / 100;


      const linePerq = fmv === null ? 0 : Math.max(0, Math.round((fmv * sh - lineAmount) * 100) / 100);
      const perShare = fmv === null || sh === 0 ? 0 : Math.round((linePerq / sh) * 100) / 100;


      totalOptions += opts;
      totalShares += sh;
      exerciseAmount += lineAmount;
      perquisite += linePerq;


      return Object.assign({}, l, {
        shares: sh,
        lineExerciseAmount: lineAmount,
        perquisitePerShare: perShare,
        linePerquisite: linePerq
      });
    });


    const rate = Util.num(taxRatePercent, 0);
    const perq = Math.round(perquisite * 100) / 100;
    let tax = { amount: Math.round(perquisite * rate) / 100, method: perq > 0 ? 'Flat' : 'None', breakdown: null, effectivePercent: rate };
    if (ctx && ctx.employeeId && perq > 0) tax = Tax.forExercise(ctx.employeeId, ctx.appId || '', perq, rate);
    return {
      lines: priced,
      totalOptions: Math.round(totalOptions * 1e6) / 1e6,
      totalShares: Math.round(totalShares),
      exerciseAmount: Math.round(exerciseAmount * 100) / 100,
      perquisiteAmount: perq,
      taxRatePercent: rate,
      taxAmount: tax.amount,
      taxMethod: tax.method,
      taxEffectivePercent: tax.effectivePercent,
      taxBreakdown: tax.breakdown
    };
  }


  /* ================= employee record ================= */


  function employee(employeeId) {
    const key = Util.trim(employeeId).toUpperCase();
    const e = Repo.findOne(T.EMPLOYEES, 'EmployeeID', key);
    if (!e) throw new Error('Your employee record is not set up in the portal yet. Please contact the ESOP team.');
    return e;
  }


  /**
   * Is this participant barred from exercising?
   * Their record and balances stay intact — they simply cannot start or edit
   * an application while the flag is set.
   */
  function isBlocked(e) {
    const v = Util.trim(e.Blocked).toLowerCase();
    return v === 'true' || v === 'yes' || v === 'y' || v === '1';
  }


  function blockReason(e) {
    return Util.trim(e.BlockedReason) ||
      'Your participation has been put on hold by the ESOP team.';
  }


  /**
   * The enabled list: who may use the portal at all.
   *
   * Blank — the normal state — means everyone on the vesting report. Put
   * employee IDs in ELIGIBLE_EMPLOYEE_IDS and only those may sign in and
   * exercise, which is how a rollout starts with a handful of people rather
   * than sixteen hundred. It is the opposite end of the same control as the
   * block list: this one says who is in, that one says who is out, and being
   * on the block list wins.
   *
   * Read once per execution: this is consulted in loops over every
   * participant.
   */
  var _enabledSet = undefined;


  function enabledSet() {
    if (_enabledSet !== undefined) return _enabledSet;
    const raw = Util.trim(cfg('ELIGIBLE_EMPLOYEE_IDS'));
    if (!raw) { _enabledSet = null; return null; }          // null = everyone
    const set = {};
    let n = 0;
    raw.split(/[\s,;]+/).forEach(function (x) {
      const id = Util.trim(x).toUpperCase();
      if (id) { set[id] = true; n++; }
    });
    _enabledSet = n ? set : null;
    return _enabledSet;
  }


  function enabledIds() {
    const set = enabledSet();
    return set ? Object.keys(set) : [];
  }


  /** True when this participant may use the portal (list empty = everyone). */
  function isEnabled(e) {
    const set = enabledSet();
    if (!set) return true;
    return !!set[Util.trim(e.EmployeeID).toUpperCase()];
  }


  /**
   * Why this participant cannot act, or '' when they can. One place, so the
   * dashboard, every save and the login and invite runs all agree.
   */
  function accessBar(e) {
    if (isBlocked(e)) return blockReason(e);
    if (!isEnabled(e)) {
      return 'The portal is open to a limited group at the moment. The ESOP team will ' +
        'write to you when it is open to you.';
    }
    return '';
  }


  /** The address of record: an explicit override, else the report's own. */
  function emailFor(e) {
    return Util.trim(e.EmailOverride) || Util.trim(e.AccessEmail) || Util.trim(e.SecondaryEmail);
  }


  function employeeView(e) {
    return {
      employeeId: Util.trim(e.EmployeeID),
      name: Util.trim(e.Name),
      designation: Util.trim(e.Designation),
      email: emailFor(e),
      accessEmail: Util.trim(e.AccessEmail),
      secondaryEmail: Util.trim(e.SecondaryEmail),
      mobile: Util.trim(e.Mobile),
      address: Util.trim(e.Address),
      nationality: Util.trim(e.Nationality) || 'Indian',
      pan: Util.trim(e.PAN),
      demat: {
        dpName: Util.trim(e.DematDPName),
        dpId: Util.trim(e.DematDPId),
        clientId: Util.trim(e.DematClientId),
        accountName: Util.trim(e.DematAccountName),
        accountType: Util.trim(e.DematAccountType)
      },
      employmentStatus: Util.trim(e.EmploymentStatus) || 'Active',
      separationDate: Util.dateKey(e.SeparationDate),
      prettySeparationDate: Util.prettyDate(e.SeparationDate),
      ctc: Util.num(e.CTC, 0),
      taxRatePercent: Util.num(e.TaxRatePercent, 0),
      blocked: isBlocked(e),
      blockedReason: isBlocked(e) ? blockReason(e) : '',
      driveFolderId: Util.trim(e.DriveFolderId)
    };
  }


  /** The bank reference line the notice asks employees to quote. */
  function paymentReference(e) {
    return String(cfg('PAYMENT_REFERENCE_FORMAT'))
      .replace(/\{EMPLOYEE_ID\}/g, Util.trim(e.EmployeeID))
      .replace(/\{NAME\}/g, Util.trim(e.Name));
  }


  /* ================= field validation ================= */


  function validatePan(pan) {
    const p = Util.trim(pan).toUpperCase();
    if (!p) throw new Error('Enter your PAN.');
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) {
      throw new Error('That PAN does not look right. The format is five letters, four digits, one letter — for example ABCDE1234F.');
    }
    return p;
  }


  function validateUtr(utr) {
    const u = Util.trim(utr).toUpperCase();
    if (!u) throw new Error('Enter the UTR / reference number of the transfer.');
    if (u.length < 6) throw new Error('That UTR looks too short. Copy it exactly as it appears in your bank statement.');
    if (!/^[A-Z0-9\-\/]+$/.test(u)) throw new Error('A UTR contains only letters, digits, hyphens and slashes.');
    return u;
  }


  function validateMobile(mobile) {
    const m = Util.trim(mobile).replace(/[\s\-()]/g, '');
    if (!m) throw new Error('Enter your mobile number.');
    const digits = m.replace(/^\+?91/, '');
    if (!/^[6-9][0-9]{9}$/.test(digits)) {
      throw new Error('Enter a 10-digit Indian mobile number, or include the country code for an overseas number.');
    }
    return digits;
  }


  function validatePaymentDate(dateInput, label) {
    const d = Util.startOfDay(Util.toDate(dateInput));
    if (!d) throw new Error('Enter the date of the ' + label + '.');
    const today = Util.startOfDay(new Date());
    if (d.getTime() > today.getTime()) throw new Error('The ' + label + ' date cannot be in the future.');
    if (d.getTime() < Util.addDays(today, -400).getTime()) {
      throw new Error('That ' + label + ' date is more than a year old. Please check it.');
    }
    return d;
  }


  /**
   * Check the demat block.
   *
   * The two depositories number their accounts differently, so the stated
   * account type decides which shape to insist on:
   *
   *   NSDL   DP ID is 8 characters beginning "IN", client ID is 8 digits
   *   CDSL   a 16-digit BO ID, held here as 8 + 8
   *
   * When no type is given the shape is inferred, so a prefilled record from
   * before this field existed still validates.
   */
  function validateDemat(d) {
    const dpId = Util.trim(d.dematDPId).toUpperCase();
    const clientId = Util.trim(d.dematClientId).toUpperCase();
    const type = Util.trim(d.dematAccountType).toUpperCase();


    if (!Util.trim(d.dematDPName)) throw new Error('Enter the name of your depository participant.');
    if (!Util.trim(d.dematAccountName)) {
      throw new Error('Enter the demat account holder name, exactly as it appears on the CML.');
    }
    if (!dpId) throw new Error('Enter your DP ID.');
    if (!clientId) throw new Error('Enter your client ID.');
    if (type && DEMAT_TYPES.indexOf(type) < 0) {
      throw new Error('Choose whether the account is with NSDL or CDSL.');
    }


    const looksNsdl = /^IN[A-Z0-9]{6}/.test(clientId);
    const looksCdsl = /^[0-9]{8}/.test(clientId);


    if (type === 'NSDL' && !looksNsdl) {
      throw new Error('For an NSDL account the DP ID is 8 characters beginning "IN" (for example IN300123) ' +
        'and the client ID is 8 digits. Check both, or switch the account type to CDSL.');
    }
    if (type === 'CDSL' && !looksCdsl) {
      throw new Error('For a CDSL account the 16-digit BO ID splits into an 8-digit DP ID and an ' +
        '8-digit client ID. Check both, or switch the account type to NSDL.');
    }
    if (!type && !looksNsdl && !looksCdsl) {
      throw new Error('Check your demat identifiers. NSDL accounts are an 8-character DP ID starting ' +
        '"IN" plus an 8-digit client ID; CDSL accounts are 16 digits split 8 and 8.');
    }


    return {
      dpId: dpId,
      clientId: clientId,
      accountType: type || (looksNsdl ? 'NSDL' : 'CDSL')
    };
  }


  return {
    windowIdFor: windowIdFor,
    ensureWindow: ensureWindow,
    currentWindow: currentWindow,
    windowState: windowState,
    taxDueDateFor: taxDueDateFor,


    fmvForPaymentDate: fmvForPaymentDate,
    latestFmv: latestFmv,
    upsertFmv: upsertFmv,


    lotSize: lotSize,
    lotScope: lotScope,
    shareGranularity: shareGranularity,
    stepFor: stepFor,
    shares: shares,


    grantsFor: grantsFor,
    validateLines: validateLines,
    price: price,


    employee: employee,
    employeeView: employeeView,
    emailFor: emailFor,
    isBlocked: isBlocked,
    blockReason: blockReason,
    isEnabled: isEnabled,
    enabledIds: enabledIds,
    accessBar: accessBar,
    paymentReference: paymentReference,


    validatePan: validatePan,
    validateUtr: validateUtr,
    validateMobile: validateMobile,
    validatePaymentDate: validatePaymentDate,
    validateDemat: validateDemat
  };
})();


