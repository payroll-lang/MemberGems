/**
 * AppStore.gs — reading, creating and repricing an exercise application.
 *
 * Shared by the employee, admin and fund partner APIs so all three see exactly
 * the same numbers. Every line carries both its option count and the shares it
 * converts to, because the two differ by the plan's multiplier.
 */


const AppStore = (function () {


  function byId(appId) {
    const key = Util.trim(appId);
    if (!key) return null;
    return Repo.find(T.APPLICATIONS, a => Util.trim(a.AppID) === key);
  }


  function require(appId) {
    const app = byId(appId);
    if (!app) throw new Error('Application ' + appId + ' was not found.');
    return app;
  }


  function linesOf(appId) {
    const key = Util.trim(appId);
    return Repo.filter(T.APP_LINES, l => Util.trim(l.AppID) === key)
      .filter(l => Util.num(l.OptionsExercised, 0) > 0);
  }


  /* ---------------- tax payments ---------------- */


  /** Every tax remittance recorded against an application, in order. */
  function taxPaymentsOf(appId) {
    const key = Util.trim(appId);
    return Repo.filter(T.TAX_PAYMENTS, r => Util.trim(r.AppID) === key)
      .sort((a, b) => Util.num(a.Seq, 0) - Util.num(b.Seq, 0));
  }


  function taxPaidTotal(appId) {
    return Math.round(taxPaymentsOf(appId)
      .reduce((a, r) => a + Util.num(r.Amount, 0), 0) * 100) / 100;
  }


  function nextTaxSeq(appId) {
    const rows = taxPaymentsOf(appId);
    return rows.length ? Util.num(rows[rows.length - 1].Seq, rows.length) + 1 : 1;
  }


  /** Keep the aggregate on the application row in step with the rows. */
  function refreshTaxTotals(app) {
    const rows = taxPaymentsOf(app.AppID);
    const total = Math.round(rows.reduce((a, r) => a + Util.num(r.Amount, 0), 0) * 100) / 100;
    const last = rows.length ? rows[rows.length - 1] : null;
    Repo.update(T.APPLICATIONS, app._row, {
      TaxPaidAmount: total,
      TaxPaymentCount: rows.length,
      // The single-value columns keep the LATEST entry, so anything reading
      // the old shape still sees something sensible.
      TaxPaymentUTR: last ? Util.trim(last.UTR) : '',
      TaxPaymentDate: last ? Util.dateKey(last.PaymentDate) : '',
      TaxPaymentAmount: total,
      TaxPaymentBank: last ? Util.trim(last.Bank) : '',
      TaxProofFileId: last ? Util.trim(last.ProofFileId) : '',
      UpdatedAt: Util.stamp()
    });
    return { total: total, count: rows.length };
  }


  function partnerRequestOf(appId) {
    const key = Util.trim(appId);
    const rows = Repo.filter(T.PARTNER_REQUESTS, r => Util.trim(r.AppID) === key);
    return rows.length ? rows[rows.length - 1] : null;
  }


  /**
   * Statuses that mean an application is still in play.
   *
   * A function, not a const: Apps Script concatenates the project's files in an
   * order it does not promise, so anything evaluated while this file loads
   * cannot reach `STATUS` in Config.gs. Reading it inside a call is safe,
   * because by then every file has loaded.
   */
  function liveStatuses() {
    return [STATUS.DRAFT, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.SENT_BACK];
  }


  /** Every application this participant has in this window, oldest first. */
  function allInWindow(employeeId, windowId) {
    const empKey = Util.trim(employeeId).toUpperCase();
    const win = Util.windowKey(windowId);
    return Repo.filter(T.APPLICATIONS, a =>
      Util.trim(a.EmployeeID).toUpperCase() === empKey &&
      Util.windowKey(a.WindowID) === win)
      // By actual time, and by row order when two share a timestamp. Sorting
      // these as text ordered them by weekday name — see Util.timeMs.
      .sort((a, b) => Util.timeMs(a.CreatedAt) - Util.timeMs(b.CreatedAt) ||
        Util.num(a._row, 0) - Util.num(b._row, 0));
  }


  /** The one still in play, if any. There is never more than one. */
  function activeInWindow(employeeId, windowId) {
    return allInWindow(employeeId, windowId)
      .filter(a => liveStatuses().indexOf(Util.trim(a.Status)) >= 0)[0] || null;
  }


  /**
   * The application a participant is working on in this window.
   *
   * One at a time: while an application is Draft, Submitted, Under Review or
   * Sent Back, that is the one they get. A second is only possible once the
   * first has been APPROVED - by which point the options it consumed have
   * been committed and the rest of the balance is free again. That is what
   * stops two applications pledging the same vested options.
   *
   * With create=false this returns the most recent application so the
   * dashboard can show an approved one; with create=true it mints the next.
   */
  function forWindow(employeeId, windowId, create) {
    const empKey = Util.trim(employeeId).toUpperCase();
    const win = Util.windowKey(windowId);
    const mine = allInWindow(empKey, win);
    const active = mine.filter(a => liveStatuses().indexOf(Util.trim(a.Status)) >= 0)[0];
    if (active) return active;
    if (!create) return mine.length ? mine[mine.length - 1] : null;


    // Nothing in play. A repeat is allowed only after an approval.
    const approved = mine.filter(a => Util.trim(a.Status) === STATUS.APPROVED);
    const seq = mine.length + 1;
    const base = 'APP-' + win.replace('-', '') + '-' + empKey.replace(/[^A-Z0-9]/g, '');
    const appId = seq > 1 ? base + '-' + seq : base;
    const w = Repo.find(T.WINDOWS, r => Util.windowKey(r.WindowID) === win);
    const emp = Domain.employee(employeeId);


    // Pre-fill the applicant block from the master so the participant only has
    // to correct it, not retype it.
    Repo.append(T.APPLICATIONS, {
      AppID: appId,
      WindowID: win,
      EmployeeID: Util.trim(emp.EmployeeID),
      Status: STATUS.DRAFT,
      Stage: 'options',
      ExercisePrice: cfgNum('EXERCISE_PRICE', 1),
      TaxRatePercent: Util.num(emp.TaxRatePercent, 0),
      TaxMode: '',
      PANNumber: Util.trim(emp.PAN),
      ApplicantDesignation: Util.trim(emp.Designation),
      ApplicantAddress: Util.trim(emp.Address),
      ApplicantNationality: Util.trim(emp.Nationality) || 'Indian',
      ApplicantMobile: Util.trim(emp.Mobile),
      // Prefill the demat block from what the ESOP team already holds.
      // The participant still has to confirm it and attach a CML - this
      // saves the typing, it does not skip the check.
      DematDPName: Util.trim(emp.DematDPName),
      DematDPId: Util.trim(emp.DematDPId),
      DematClientId: Util.trim(emp.DematClientId),
      DematAccountName: Util.trim(emp.DematAccountName) || Util.trim(emp.Name),
      DematAccountType: Util.trim(emp.DematAccountType),
      TaxDueDate: w ? Util.dateKey(w.TaxDueDate) : '',
      ReviewOptions: REVIEW.PENDING,
      ReviewDemat: REVIEW.PENDING,
      ReviewExercisePayment: REVIEW.PENDING,
      ReviewTaxPayment: REVIEW.PENDING,
      ReviewNotice: REVIEW.PENDING,
      CreatedAt: Util.stamp(),
      UpdatedAt: Util.stamp()
    });
    audit(employeeId, ROLE.EMPLOYEE, 'APP_CREATED', appId,
      win + (approved.length ? ' (repeat after ' + approved.length + ' approved)' : ''));
    return require(appId);
  }


  /** Replace the option lines and recompute every derived amount. */
  function setLines(app, validatedLines) {
    const appId = Util.trim(app.AppID);
    Repo.filter(T.APP_LINES, l => Util.trim(l.AppID) === appId)
      .sort((a, b) => b._row - a._row)
      .forEach(l => Repo.deleteRow(T.APP_LINES, l._row));


    const fmv = Util.num(app.FMVValue, 0) || null;
    const priced = Domain.price(validatedLines, fmv, Util.num(app.TaxRatePercent, 0),
      { employeeId: Util.trim(app.EmployeeID), appId: appId });


    Repo.appendAll(T.APP_LINES, priced.lines.map(l => ({
      LineID: Util.uid('L-'),
      AppID: appId,
      GrantID: l.grantId,
      PlanName: l.planName,
      Multiplier: l.multiplier,
      OptionsExercised: l.options,
      SharesAllotted: l.shares,
      ExercisePrice: l.exercisePrice,
      LineExerciseAmount: l.lineExerciseAmount,
      PerquisitePerShare: l.perquisitePerShare,
      LinePerquisite: l.linePerquisite,
      UpdatedAt: Util.stamp()
    })));


    Repo.update(T.APPLICATIONS, app._row, {
      TotalOptions: priced.totalOptions,
      TotalShares: priced.totalShares,
      ExerciseAmount: priced.exerciseAmount,
      PerquisiteAmount: priced.perquisiteAmount,
      TaxAmount: priced.taxAmount,
      TaxMethod: priced.taxMethod,
      TaxBreakdown: priced.taxBreakdown ? JSON.stringify(priced.taxBreakdown) : '',
      UpdatedAt: Util.stamp()
    });
    return priced;
  }


  /**
   * Recompute perquisite and tax from the FMV and rate now on the row. Called
   * after the exercise payment date fixes the FMV, and after an admin changes
   * the employee's tax rate or corrects a share price.
   */
  function reprice(app) {
    const appId = Util.trim(app.AppID);
    const rows = linesOf(appId);
    if (!rows.length) return null;


    // Re-read the multiplier from the GRANT, not from the line.
    //
    // The line keeps a copy of the multiplier as it stood when the options were
    // saved, which is right for an approved application — it must always show
    // the figures it was approved on. But while an application is still open, a
    // correction to the grant master has to flow through, or a mis-keyed
    // multiplier stays wrong for as long as the draft lives.
    const grantsById = {};
    Repo.findByColumn(T.GRANTS, 'EmployeeID', Util.trim(app.EmployeeID))
      .forEach(g => { grantsById[Util.trim(g.GrantID)] = g; });


    const lines = rows.map(function (l) {
      const gid = Util.trim(l.GrantID);
      const g = grantsById[gid] || {};
      const options = Util.num(l.OptionsExercised, 0);
      const multiplier = Util.num(g.Multiplier, Util.num(l.Multiplier, 1)) || 1;
      const price = Util.num(g.ExercisePrice, Util.num(l.ExercisePrice, cfgNum('EXERCISE_PRICE', 1)))
        || cfgNum('EXERCISE_PRICE', 1);
      return {
        grantId: gid,
        planName: Util.trim(g.PlanName) || Util.trim(l.PlanName),
        multiplier: multiplier,
        options: options,
        shares: Domain.shares(options, multiplier),
        exercisePrice: price,
        lineExerciseAmount: Math.round(options * price * 100) / 100
      };
    });


    const fresh = require(appId);
    const fmv = Util.num(fresh.FMVValue, 0) || null;
    const priced = Domain.price(lines, fmv, Util.num(fresh.TaxRatePercent, 0),
      { employeeId: Util.trim(fresh.EmployeeID), appId: appId });


    rows.forEach(function (row) {
      const match = priced.lines.filter(p => p.grantId === Util.trim(row.GrantID))[0];
      if (!match) return;
      Repo.update(T.APP_LINES, row._row, {
        SharesAllotted: match.shares,
        PerquisitePerShare: match.perquisitePerShare,
        LinePerquisite: match.linePerquisite,
        UpdatedAt: Util.stamp()
      });
    });


    Repo.update(T.APPLICATIONS, fresh._row, {
      TotalOptions: priced.totalOptions,
      TotalShares: priced.totalShares,
      ExerciseAmount: priced.exerciseAmount,
      PerquisiteAmount: priced.perquisiteAmount,
      TaxAmount: priced.taxAmount,
      TaxMethod: priced.taxMethod,
      TaxBreakdown: priced.taxBreakdown ? JSON.stringify(priced.taxBreakdown) : '',
      UpdatedAt: Util.stamp()
    });


    const pr = partnerRequestOf(appId);
    if (pr && Util.trim(pr.Status) === PARTNER_STATUS.ASSIGNED) {
      Repo.update(T.PARTNER_REQUESTS, pr._row, { TaxAmount: priced.taxAmount });
    }
    return priced;
  }


  /** Which sections are complete, and what the employee still has to do. */
  function progress(app) {
    const a = app;
    const taxMode = Util.trim(a.TaxMode);
    const pr = partnerRequestOf(a.AppID);


    const done = {
      options: Util.num(a.TotalOptions, 0) > 0,
      // The notice's section A has to be complete, not just the demat block.
      demat: !!(Util.trim(a.DematDPId) && Util.trim(a.DematClientId) &&
        Util.trim(a.CMLFileId) && Util.trim(a.PANFileId) && Util.trim(a.PANNumber) &&
        Util.trim(a.ApplicantAddress) && Util.trim(a.ApplicantNationality) &&
        Util.trim(a.ApplicantMobile)),
      exercise: !!(Util.trim(a.ExercisePaymentUTR) && Util.trim(a.ExercisePaymentDate) &&
        Util.trim(a.ExerciseProofFileId) && Util.num(a.FMVValue, 0) > 0),
      tax: false,
      notice: !!Util.trim(a.NoticeSignedAt),
      submit: [STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.APPROVED].indexOf(Util.trim(a.Status)) >= 0
    };


    // The tax may be settled across several remittances, so what matters is
    // whether the TOTAL has reached the amount due - to within a rupee, to
    // absorb rounding.
    const due = Util.num(a.TaxAmount, 0);
    const paid = taxPaidTotal(a.AppID);
    if (taxMode === TAX_MODE.SELF) {
      done.tax = due > 0 && paid + 1 >= due;
    } else if (taxMode === TAX_MODE.PARTNER) {
      // A partner pays in one go; its entry lands in TaxPayments as well.
      done.tax = !!(pr && [PARTNER_STATUS.PAID, PARTNER_STATUS.VERIFIED].indexOf(Util.trim(pr.Status)) >= 0) &&
        paid + 1 >= due;
    }
    // A nil tax can be the RIGHT answer: someone whose income for the year stays
    // within the tax-free limit owes nothing on an exercise. That is only
    // believable when the figure was worked out from their own income (a nil
    // from a missing rate is not), and only once the payment date has pinned
    // the price. Without this the step could never be completed.
    if (!done.tax && Util.trim(a.TaxMethod) === 'Sheet' && due === 0 && Util.num(a.FMVValue, 0) > 0) {
      done.tax = true;
    }


    let stage = 'submit';
    for (let i = 0; i < STAGES.length; i++) {
      const k = STAGES[i].key;
      if (k === 'submit') break;
      if (!done[k]) { stage = k; break; }
    }
    const pending = STAGES.filter(s => s.key !== 'submit' && !done[s.key]).map(s => s.label);


    return { done: done, stage: stage, pendingLabels: pending, complete: pending.length === 0 };
  }


  /**
   * A provisional perquisite and tax for an application that is not yet
   * priced, using the latest price on record.
   *
   * Returns null once FMVValue is set — from that point the real figure
   * exists and nothing should be shown alongside it.
   */
  function indicativeFor(a, lines, emp) {
    if (Util.num(a.FMVValue, 0) > 0) return null;
    const latest = Domain.latestFmv();
    if (!latest) return null;


    const rate = Util.num(a.TaxRatePercent, emp ? Util.num(emp.TaxRatePercent, 0) : 0);
    const priced = Domain.price(lines.map(function (l) {
      return {
        grantId: l.grantId,
        options: l.options,
        shares: l.shares,
        multiplier: l.multiplier,
        exercisePrice: l.exercisePrice,
        lineExerciseAmount: l.lineExerciseAmount
      };
    }), latest.fmv, rate, { employeeId: Util.trim(a.EmployeeID), appId: Util.trim(a.AppID) });


    return {
      fmv: latest.fmv,
      fmvDate: latest.date,
      prettyFmvDate: Util.prettyDate(latest.date),
      perquisiteAmount: priced.perquisiteAmount,
      taxRatePercent: priced.taxRatePercent,
      taxAmount: priced.taxAmount,
      taxMethod: priced.taxMethod,
      taxEffectivePercent: priced.taxEffectivePercent,
      taxBreakdown: priced.taxBreakdown
    };
  }


  /**
   * The tax rate to quote for an application, as a percentage of its perquisite.
   * A flat-rate application has the rate it was priced at; one worked out from
   * the participant's year-to-date position has no single rate, so this is what
   * the tax actually comes to as a share of the perquisite. Printed on the
   * notice and in emails, where a stale flat rate would sit beside a figure it
   * did not produce.
   */
  function effectiveRate(a) {
    const perq = Util.num(a.PerquisiteAmount, 0);
    if (Util.trim(a.TaxMethod) === 'Sheet' && perq > 0) {
      return Math.round(Util.num(a.TaxAmount, 0) / perq * 10000) / 100;
    }
    return Util.num(a.TaxRatePercent, 0);
  }


  function parseBreakdown(v) {
    const s = Util.trim(v);
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }


  /** Everything a screen needs about one application. */
  function view(app, options) {
    const opts = options || {};
    const a = app;
    const appId = Util.trim(a.AppID);
    const emp = Repo.findOne(T.EMPLOYEES, 'EmployeeID', Util.trim(a.EmployeeID));
    const win = Repo.find(T.WINDOWS, w => Util.windowKey(w.WindowID) === Util.windowKey(a.WindowID));


    const grantsById = {};
    Repo.findByColumn(T.GRANTS, 'EmployeeID', Util.trim(a.EmployeeID))
      .forEach(g => { grantsById[Util.trim(g.GrantID)] = g; });


    const lines = linesOf(appId).map(function (l) {
      const g = grantsById[Util.trim(l.GrantID)] || {};
      return {
        grantId: Util.trim(l.GrantID),
        planName: Util.trim(l.PlanName) || Util.trim(g.PlanName),
        multiplier: Util.num(l.Multiplier, Util.num(g.Multiplier, 1)) || 1,
        grantDate: Util.dateKey(g.GrantDate),
        prettyGrantDate: Util.prettyDate(g.GrantDate),
        options: Util.num(l.OptionsExercised, 0),
        shares: Util.num(l.SharesAllotted, 0),
        exercisePrice: Util.num(l.ExercisePrice, 0),
        lineExerciseAmount: Util.num(l.LineExerciseAmount, 0),
        perquisitePerShare: Util.num(l.PerquisitePerShare, 0),
        linePerquisite: Util.num(l.LinePerquisite, 0)
      };
    });


    const pr = partnerRequestOf(appId);
    const prog = progress(a);


    const out = {
      appId: appId,
      windowId: Util.windowKey(a.WindowID),
      windowLabel: win ? Util.monthLabel(win.Label) : Util.windowKey(a.WindowID),
      windowCloseDate: win ? Util.dateKey(win.CloseDate) : '',
      prettyWindowCloseDate: win ? Util.prettyDate(win.CloseDate) : '',
      employeeId: Util.trim(a.EmployeeID),
      employeeName: emp ? Util.trim(emp.Name) : '',
      employmentStatus: emp ? (Util.trim(emp.EmploymentStatus) || 'Active') : '',
      status: Util.trim(a.Status),
      stage: prog.stage,
      done: prog.done,
      pendingLabels: prog.pendingLabels,
      complete: prog.complete,


      lines: lines,
      totalOptions: Util.num(a.TotalOptions, 0),
      totalShares: Util.num(a.TotalShares, 0),
      exercisePrice: Util.num(a.ExercisePrice, cfgNum('EXERCISE_PRICE', 1)),
      exerciseAmount: Util.num(a.ExerciseAmount, 0),


      fmvDate: Util.dateKey(a.FMVDate),
      prettyFmvDate: Util.prettyDate(a.FMVDate),
      fmvValue: Util.num(a.FMVValue, 0),
      perquisiteAmount: Util.num(a.PerquisiteAmount, 0),
      taxRatePercent: Util.num(a.TaxRatePercent, 0),
      taxAmount: Util.num(a.TaxAmount, 0),
      // 'Sheet' = worked out from the participant's year-to-date position,
      // 'Flat' = a percentage of the perquisite. The breakdown holds every
      // step, so the screen can explain the figure.
      taxMethod: Util.trim(a.TaxMethod),
      taxBreakdown: parseBreakdown(a.TaxBreakdown),
      taxEffectivePercent: Util.num(a.PerquisiteAmount, 0) > 0
        ? Math.round(Util.num(a.TaxAmount, 0) / Util.num(a.PerquisiteAmount, 0) * 10000) / 100 : 0,
      taxDueDate: Util.dateKey(a.TaxDueDate),
      prettyTaxDueDate: Util.prettyDate(a.TaxDueDate),


      // Before the exercise amount is paid there is no FMV that applies yet,
      // so the stored perquisite and tax are legitimately zero — but showing
      // a participant "tax: nil" while they decide reads as a broken figure
      // and understates what they are taking on. This prices the same lines
      // at the most recent close on record and is labelled as indicative.
      // It is never written to the sheet: the binding figure is set by the
      // day before payment, and only reprice() may set it.
      indicative: indicativeFor(a, lines, emp),


      // Which of these the ESOP team already had, so the screen can say so.
      prefilled: emp ? {
        pan: !!Util.trim(emp.PAN),
        address: !!Util.trim(emp.Address),
        mobile: !!Util.trim(emp.Mobile),
        demat: !!(Util.trim(emp.DematDPId) && Util.trim(emp.DematClientId))
      } : { pan: false, address: false, mobile: false, demat: false },


      applicant: {
        designation: Util.trim(a.ApplicantDesignation),
        address: Util.trim(a.ApplicantAddress),
        nationality: Util.trim(a.ApplicantNationality),
        mobile: Util.trim(a.ApplicantMobile),
        email: emp ? Domain.emailFor(emp) : ''
      },


      demat: {
        dpName: Util.trim(a.DematDPName),
        dpId: Util.trim(a.DematDPId),
        clientId: Util.trim(a.DematClientId),
        accountName: Util.trim(a.DematAccountName),
        accountType: Util.trim(a.DematAccountType),
        pan: Util.trim(a.PANNumber),
        cml: Files.meta(a.CMLFileId),
        panCard: Files.meta(a.PANFileId),
        // Set to the partner's name when the shares are going to an account
        // the participant holds with that partner, keyed in by the partner.
        // Blank means the participant supplied it themselves.
        source: Util.trim(a.DematSource)
      },


      exercisePayment: {
        utr: Util.trim(a.ExercisePaymentUTR),
        date: Util.dateKey(a.ExercisePaymentDate),
        prettyDate: Util.prettyDate(a.ExercisePaymentDate),
        amount: Util.num(a.ExercisePaymentAmount, 0),
        bank: Util.trim(a.ExercisePaymentBank),
        proof: Files.meta(a.ExerciseProofFileId)
      },


      tax: {
        mode: Util.trim(a.TaxMode),
        fundPartnerName: Util.trim(a.FundPartnerName),
        due: Util.num(a.TaxAmount, 0),
        paidTotal: taxPaidTotal(appId),
        remaining: Math.max(0, Math.round((Util.num(a.TaxAmount, 0) - taxPaidTotal(appId)) * 100) / 100),
        payments: taxPaymentsOf(appId).map(function (r) {
          return {
            paymentId: Util.trim(r.PaymentID),
            seq: Util.num(r.Seq, 0),
            paidBy: Util.trim(r.PaidBy),
            fundPartnerName: Util.trim(r.FundPartnerName),
            utr: Util.trim(r.UTR),
            date: Util.dateKey(r.PaymentDate),
            prettyDate: Util.prettyDate(r.PaymentDate),
            amount: Util.num(r.Amount, 0),
            bank: Util.trim(r.Bank),
            proof: Files.meta(r.ProofFileId),
            enteredBy: Util.trim(r.EnteredBy),
            enteredAt: Util.trim(r.EnteredAt)
          };
        }),
        utr: Util.trim(a.TaxPaymentUTR),
        date: Util.dateKey(a.TaxPaymentDate),
        prettyDate: Util.prettyDate(a.TaxPaymentDate),
        amount: Util.num(a.TaxPaymentAmount, 0),
        bank: Util.trim(a.TaxPaymentBank),
        proof: Files.meta(a.TaxProofFileId),
        partnerRequest: pr ? {
          requestId: Util.trim(pr.RequestID),
          partner: Util.trim(pr.FundPartnerName),
          status: Util.trim(pr.Status),
          amount: Util.num(pr.TaxAmount, 0),
          utr: Util.trim(pr.PaymentUTR),
          date: Util.dateKey(pr.PaymentDate),
          prettyDate: Util.prettyDate(pr.PaymentDate),
          paidAmount: Util.num(pr.PaymentAmount, 0),
          bank: Util.trim(pr.PaymentBank),
          proof: Files.meta(pr.ProofFileId),
          fedBy: Util.trim(pr.FedBy),
          fedAt: Util.prettyStamp(pr.FedAt),
          remarks: Util.trim(pr.Remarks)
        } : null
      },


      notice: {
        signatureName: Util.trim(a.NoticeSignatureName),
        signedAt: Util.prettyStamp(a.NoticeSignedAt),
        place: Util.trim(a.NoticePlace),
        pdf: Files.meta(a.NoticeFileId)
      },


      review: {
        options: Util.trim(a.ReviewOptions) || REVIEW.PENDING,
        demat: Util.trim(a.ReviewDemat) || REVIEW.PENDING,
        exercisePayment: Util.trim(a.ReviewExercisePayment) || REVIEW.PENDING,
        taxPayment: Util.trim(a.ReviewTaxPayment) || REVIEW.PENDING,
        notice: Util.trim(a.ReviewNotice) || REVIEW.PENDING,
        remarks: Util.trim(a.AdminRemarks),
        reviewedBy: Util.trim(a.ReviewedBy),
        reviewedAt: Util.prettyStamp(a.ReviewedAt)
      },


      folderId: Util.trim(a.FolderId),
      // Every timestamp column reads back as a Date, so these go through
      // prettyStamp rather than trim — otherwise the screen shows a raw
      // JavaScript date string.
      createdAt: Util.prettyStamp(a.CreatedAt),
      updatedAt: Util.prettyStamp(a.UpdatedAt),
      submittedAt: Util.prettyStamp(a.SubmittedAt),
      approvedAt: Util.prettyStamp(a.ApprovedAt),
      editable: isEditableByEmployee(a)
    };


    if (opts.includeEmployee && emp) out.employee = Domain.employeeView(emp);
    return out;
  }


  function isEditableByEmployee(app) {
    const s = Util.trim(app.Status);
    return s === STATUS.DRAFT || s === STATUS.SENT_BACK;
  }


  function assertEditable(app) {
    if (!isEditableByEmployee(app)) {
      throw new Error('Application ' + Util.trim(app.AppID) + ' is ' + Util.trim(app.Status).toLowerCase() +
        ' and can no longer be edited. Contact the ESOP team if something needs to change.');
    }
  }


  /** Clear a section's verdict when the employee edits it, so it is re-checked. */
  function touchSection(app, sectionField) {
    const patch = { UpdatedAt: Util.stamp() };
    patch[sectionField] = REVIEW.PENDING;
    Repo.update(T.APPLICATIONS, app._row, patch);
  }


  return {
    byId: byId,
    require: require,
    linesOf: linesOf,
    taxPaymentsOf: taxPaymentsOf,
    taxPaidTotal: taxPaidTotal,
    nextTaxSeq: nextTaxSeq,
    refreshTaxTotals: refreshTaxTotals,
    allInWindow: allInWindow,
    activeInWindow: activeInWindow,
    partnerRequestOf: partnerRequestOf,
    forWindow: forWindow,
    setLines: setLines,
    reprice: reprice,
    effectiveRate: effectiveRate,
    progress: progress,
    view: view,
    isEditableByEmployee: isEditableByEmployee,
    assertEditable: assertEditable,
    touchSection: touchSection
  };
})();


