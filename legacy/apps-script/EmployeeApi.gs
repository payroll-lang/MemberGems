/**
 * EmployeeApi.gs — the participant's side of the portal.
 *
 * Every function takes a verified session (Api.gs does the verifying) and may
 * be called at any stage: a save never requires the previous section to be
 * finished. Completeness is enforced once, at submit.
 *
 * Grants are presented rolled up from the report's tranche rows, because the
 * decision "how many options do I exercise" is made per grant.
 */


const EmployeeApi = (function () {


  function assertEmployee(session) {
    if (session.role !== ROLE.EMPLOYEE) throw new Error('This screen is for plan participants.');
  }


  /**
   * Guard on every action that changes an application. A blocked participant
   * can still sign in and see their position - they simply cannot exercise.
   */
  function requireNotBlocked(session) {
    const emp = Domain.employee(session.userId);
    const bar = Domain.accessBar(emp);
    if (bar) {
      throw new Error(bar + ' Please contact the ESOP team if you believe this is a mistake.');
    }
    return emp;
  }


  function myApp(session, create) {
    const win = Domain.currentWindow();
    return AppStore.forWindow(session.userId, Util.windowKey(win.WindowID), !!create);
  }


  /**
   * Every step after the first needs an application already in play.
   *
   * Only saveOptions may create one - otherwise a stray click on a later
   * step, after an application has been approved, would mint an empty new
   * one behind the participant's back.
   */
  function requireActiveApp(session) {
    const win = Domain.currentWindow();
    const app = AppStore.activeInWindow(session.userId, Util.windowKey(win.WindowID));
    if (!app) {
      const previous = AppStore.forWindow(session.userId, Util.windowKey(win.WindowID), false);
      if (previous && Util.trim(previous.Status) === STATUS.APPROVED) {
        throw new Error('Application ' + Util.trim(previous.AppID) + ' has been approved. ' +
          'To exercise more options this window, start again at step 1 - the options you did ' +
          'not use are back in your available balance.');
      }
      throw new Error('Start by recording the options you wish to exercise in step 1.');
    }
    return app;
  }


  /** Everything the participant dashboard renders, in one call. */
  function dashboard(session) {
    assertEmployee(session);
    const emp = Domain.employee(session.userId);
    const win = Domain.currentWindow();
    const winState = Domain.windowState(win);
    const app = myApp(session, false);


    // An application in play is left out of the balance it is measured
    // against — otherwise entering 500 options would drop the available
    // balance by 500 and the participant could never edit the figure upward.
    //
    // Only a LIVE application, though. A settled one has genuinely consumed
    // its options: leaving an approved application out handed those options
    // straight back, so an approved 500 still showed as available and could
    // have been exercised a second time in the same window.
    const live = AppStore.activeInWindow(session.userId, Util.windowKey(win.WindowID));
    const grants = Domain.grantsFor(session.userId, live ? Util.trim(live.AppID) : '');
    const latest = Domain.latestFmv();


    const totals = grants.reduce(function (acc, g) {
      acc.granted += g.totalGranted;
      acc.vested += g.vestedOptions;
      acc.unvested += g.unvestedOptions;
      acc.exercised += g.exercisedOptions;
      acc.available += g.availableOptions;
      acc.exercisable += g.exercisableOptions;
      acc.exercisableShares += g.exercisableShares;
      acc.vestedShares += g.vestedShares;
      acc.stranded += Math.max(0, g.availableOptions - g.exercisableOptions);
      return acc;
    }, {
      granted: 0, vested: 0, unvested: 0, exercised: 0,
      available: 0, exercisable: 0, exercisableShares: 0, vestedShares: 0, stranded: 0
    });


    // Indicative only: what the exercisable balance is worth at the latest
    // price on record. The figure that actually applies is fixed later, by the
    // date the exercise amount is paid.
    const fmv = latest ? latest.fmv : 0;
    const indicative = grants.reduce(function (a, g) {
      return a + Math.max(0, g.exercisableShares * fmv - g.exercisableOptions * g.exercisePrice);
    }, 0);


    const history = Repo.filter(T.APPLICATIONS,
      a => Util.trim(a.EmployeeID).toUpperCase() === Util.trim(session.userId).toUpperCase())
      .sort((a, b) => Util.windowKey(b.WindowID).localeCompare(Util.windowKey(a.WindowID)) ||
        Util.timeMs(b.CreatedAt) - Util.timeMs(a.CreatedAt))
      .map(a => ({
        appId: Util.trim(a.AppID),
        windowId: Util.windowKey(a.WindowID),
        status: Util.trim(a.Status),
        totalOptions: Util.num(a.TotalOptions, 0),
        totalShares: Util.num(a.TotalShares, 0),
        exerciseAmount: Util.num(a.ExerciseAmount, 0),
        taxAmount: Util.num(a.TaxAmount, 0),
        // Prettified, not trimmed: Sheets hands these back as Date objects,
        // and trimming one produces "Tue Sep 08 2026 20:59:18 GMT+0530
        // (India Standard Time)" on screen.
        submittedAt: Util.prettyStamp(a.SubmittedAt),
        updatedAt: Util.prettyStamp(a.UpdatedAt)
      }));


    // Blocked, or not yet enabled for the portal — either way they can look
    // but not act, and are told which it is.
    const bar = Domain.accessBar(emp);


    // The window belongs to the enabled group. For anyone not on that list it
    // is not open at all — not merely open with the buttons refusing — so
    // every step, quote and save is shut the same way a closed window shuts
    // them, and nothing has to remember to check separately.
    const enabled = Domain.isEnabled(emp);
    const windowOpen = winState.open && enabled;
    const windowReason = enabled ? winState.reason
      : 'The exercise window is open to a limited group of participants at the moment. ' +
        'The ESOP team will write to you when it opens to you.';


    return {
      blocked: !!bar,
      blockedReason: bar,
      employee: Domain.employeeView(emp),
      window: {
        windowId: Util.windowKey(win.WindowID),
        label: Util.monthLabel(win.Label),
        openDate: Util.dateKey(win.OpenDate),
        closeDate: Util.dateKey(win.CloseDate),
        prettyOpenDate: Util.prettyDate(win.OpenDate),
        prettyCloseDate: Util.prettyDate(win.CloseDate),
        taxDueDate: Util.dateKey(win.TaxDueDate),
        prettyTaxDueDate: Util.prettyDate(win.TaxDueDate),
        isOpen: windowOpen,
        reason: windowReason
      },
      grants: grants,
      totals: totals,
      indicativeGain: Math.round(indicative * 100) / 100,
      latestFmv: latest,
      lotSize: Domain.lotSize(),
      lotScope: Domain.lotScope(),
      exercisePrice: cfgNum('EXERCISE_PRICE', 1),
      // Only the partners still taking new business.
      fundPartners: Partners.activeNames(),
      paymentReference: Domain.paymentReference(emp),
      bankDetails: {
        exercise: cfg('COMPANY_BANK_DETAILS'),
        tax: cfg('TAX_BANK_DETAILS')
      },
      application: app ? AppStore.view(app) : null,
      // A repeat is offered only once the previous one is approved.
      applicationsThisWindow: AppStore.allInWindow(session.userId, Util.windowKey(win.WindowID)).length,
      canStartAnother: windowOpen && !bar &&
        !AppStore.activeInWindow(session.userId, Util.windowKey(win.WindowID)) &&
        totals.exercisable > 0,
      history: history,
      stages: STAGES
    };
  }


  /** Live figures for the options form, saving nothing. */
  function quote(session, lines) {
    assertEmployee(session);
    const emp = Domain.employee(session.userId);
    // The application in play, not merely the most recent one. After an
    // approval there is none, and a quote for the repeat application being
    // started must use the latest price — not the FMV already fixed against
    // the approved one.
    const app = AppStore.activeInWindow(session.userId, Util.windowKey(Domain.currentWindow().WindowID));
    const validated = Domain.validateLines(session.userId, lines, app ? Util.trim(app.AppID) : '');


    const fixed = app && Util.num(app.FMVValue, 0) > 0;
    const source = fixed
      ? { fmv: Util.num(app.FMVValue), date: Util.dateKey(app.FMVDate), fixed: true }
      : (function () {
        const l = Domain.latestFmv();
        return l ? { fmv: l.fmv, date: l.date, fixed: false } : null;
      })();


    const priced = Domain.price(validated, source ? source.fmv : null, Util.num(emp.TaxRatePercent, 0),
      { employeeId: session.userId, appId: app ? Util.trim(app.AppID) : '' });
    return {
      taxMethod: priced.taxMethod,
      taxEffectivePercent: priced.taxEffectivePercent,
      taxBreakdown: priced.taxBreakdown,
      totalOptions: priced.totalOptions,
      totalShares: priced.totalShares,
      exerciseAmount: priced.exerciseAmount,
      perquisiteAmount: priced.perquisiteAmount,
      taxRatePercent: priced.taxRatePercent,
      taxAmount: priced.taxAmount,
      fmv: source ? source.fmv : null,
      fmvDate: source ? source.date : '',
      fmvFixed: source ? source.fixed : false,
      lines: priced.lines
    };
  }


  /* ---------------- 1. options ---------------- */


  function saveOptions(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = myApp(session, true);
    AppStore.assertEditable(app);


    // Once the exercise amount is paid the FMV is pinned to the trading day
    // before that payment, and the perquisite and tax follow from it. Change
    // the option count now and the amount paid no longer matches the options
    // it paid for — and one application would end up carrying two FMVs from
    // two different dates. So the options are settled at payment.
    //
    // The one exception is a payment the ESOP team has sent back: they are
    // asking for that payment to be corrected, so the options may be
    // corrected too. In that case the pinned FMV is dropped, and recording
    // the payment again pins a new one against the whole application.
    const paidAlready = Util.num(app.FMVValue, 0) > 0 || !!Util.trim(app.ExercisePaymentUTR);
    const paymentSentBack = Util.trim(app.ReviewExercisePayment) === REVIEW.BACK;
    if (paidAlready && !paymentSentBack) {
      throw new Error('The exercise amount for ' + Util.trim(app.AppID) + ' has already been paid, ' +
        'so the options are now fixed. The fair market value is set by the trading day before that ' +
        'payment and has to apply to the whole application. To change the number of options, ask ' +
        'the ESOP team to send the exercise payment back to you — this step then opens again.');
    }
    if (paidAlready && paymentSentBack) {
      // Cleared BEFORE the lines are priced, so the new options are not
      // valued at the old day's FMV.
      Repo.update(T.APPLICATIONS, app._row, {
        FMVValue: '', FMVDate: '', UpdatedAt: Util.stamp()
      });
      app.FMVValue = '';
      app.FMVDate = '';
    }


    const validated = Domain.validateLines(session.userId, payload.lines, Util.trim(app.AppID));
    const priced = AppStore.setLines(app, validated);
    AppStore.touchSection(AppStore.require(app.AppID), 'ReviewOptions');


    const emp = Domain.employee(session.userId);
    // Only when it does not exist yet. Calling this unconditionally cost a
    // Drive round trip on every save of step 1, for a folder that is not
    // needed until something is uploaded in step 2.
    if (!Util.trim(app.FolderId)) Files.applicationFolder(AppStore.require(app.AppID), emp);


    audit(session.userId, session.role, 'OPTIONS_SAVED', app.AppID,
      priced.totalOptions + ' options → ' + priced.totalShares + ' shares across ' + priced.lines.length + ' grant(s)');


    if (!payload.silent) {
      Mailer.send('options_saved', Auth.notificationEmailFor(session._user), {
        name: Util.trim(emp.Name),
        appId: Util.trim(app.AppID),
        windowLabel: Util.monthLabel(Domain.currentWindow().Label),
        totalOptions: priced.totalOptions,
        totalShares: priced.totalShares,
        exerciseAmount: priced.exerciseAmount,
        paymentReference: Domain.paymentReference(emp)
      });
    }


    return ok('Saved. ' + Util.count(priced.totalOptions) + ' options → ' +
      Util.count(priced.totalShares) + ' equity shares; exercise amount payable is ' +
      Util.inr(priced.exerciseAmount) + '.', session);
  }


  /* ---------------- 2. applicant details, demat & PAN ---------------- */


  /**
   * Section A of the notice plus the demat block. Partial saves are allowed;
   * `finalise` runs the full validation.
   */
  function saveDemat(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = requireActiveApp(session);
    AppStore.assertEditable(app);
    const emp = Domain.employee(session.userId);
    const folder = Files.applicationFolder(app, emp);


    const patch = { UpdatedAt: Util.stamp() };


    if (payload.designation !== undefined) patch.ApplicantDesignation = Util.trim(payload.designation);
    if (payload.address !== undefined) patch.ApplicantAddress = Util.trim(payload.address);
    if (payload.nationality !== undefined) patch.ApplicantNationality = Util.trim(payload.nationality);
    if (payload.mobile !== undefined) patch.ApplicantMobile = Util.trim(payload.mobile);


    // Once a fund partner has set the allotment account, the participant's
    // own demat fields are no longer what the shares follow — the account is
    // held with the partner and only they can change it. Accepting an edit
    // here would silently redirect the allotment.
    const partnerHeld = Util.trim(app.DematSource);
    if (!partnerHeld) {
      if (payload.dematDPName !== undefined) patch.DematDPName = Util.trim(payload.dematDPName);
      if (payload.dematAccountName !== undefined) patch.DematAccountName = Util.trim(payload.dematAccountName);
      if (payload.dematDPId !== undefined) patch.DematDPId = Util.trim(payload.dematDPId).toUpperCase();
      if (payload.dematClientId !== undefined) patch.DematClientId = Util.trim(payload.dematClientId).toUpperCase();
      if (payload.dematAccountType !== undefined) patch.DematAccountType = Util.trim(payload.dematAccountType).toUpperCase();
    }
    // PAN is the participant's own either way.
    if (payload.pan !== undefined) patch.PANNumber = Util.trim(payload.pan).toUpperCase();


    // Everything in this section is mandatory before it can be submitted.
    // Problems are collected and reported together rather than thrown one at
    // a time: being told about a missing field, fixing it, and only then
    // being told about the next one is what makes a form feel broken.
    const problems = [];
    const guard = function (fn) {
      try { fn(); } catch (e) { problems.push(e.message); }
    };


    if (payload.finalise) {
      const pick = (k, f) => (patch[k] !== undefined ? patch[k] : Util.trim(app[k] || (f ? emp[f] : '')));


      const address = pick('ApplicantAddress', 'Address');
      if (address.length < 12) {
        problems.push('Enter your full postal address — it appears on the exercise notice.');
      } else {
        patch.ApplicantAddress = address;
      }
      patch.ApplicantNationality = pick('ApplicantNationality', 'Nationality') || 'Indian';
      guard(function () {
        patch.ApplicantMobile = Domain.validateMobile(pick('ApplicantMobile', 'Mobile'));
      });
      patch.ApplicantDesignation = pick('ApplicantDesignation', 'Designation');
      if (!patch.ApplicantDesignation) problems.push('Enter your designation.');


      guard(function () {
        const dm = Domain.validateDemat({
          dematDPName: pick('DematDPName'),
          dematAccountName: pick('DematAccountName'),
          dematDPId: pick('DematDPId'),
          dematClientId: pick('DematClientId'),
          dematAccountType: pick('DematAccountType', 'DematAccountType')
        });
        patch.DematDPId = dm.dpId;
        patch.DematClientId = dm.clientId;
        patch.DematAccountType = dm.accountType;
      });
      guard(function () {
        patch.PANNumber = Domain.validatePan(pick('PANNumber', 'PAN'));
      });
    }


    if (payload.cmlFile) patch.CMLFileId = Files.save(folder, 'CML', payload.cmlFile).fileId;
    if (payload.panFile) patch.PANFileId = Files.save(folder, 'PAN', payload.panFile).fileId;


    if (payload.finalise) {
      if (!(patch.CMLFileId || Util.trim(app.CMLFileId))) {
        problems.push('Upload your client master report (CML) from your broker or depository participant.');
      }
      if (!(patch.PANFileId || Util.trim(app.PANFileId))) {
        problems.push('Upload a scan or photograph of your PAN card.');
      }
      if (problems.length) {
        // Any file that did upload is still saved below, so nothing they
        // supplied is lost by the refusal — but the section stays open.
        Repo.update(T.APPLICATIONS, app._row, patch);
        throw new Error(problems.length === 1 ? problems[0]
          : 'These are still needed before this section can be submitted:\n• ' + problems.join('\n• '));
      }
    }


    Repo.update(T.APPLICATIONS, app._row, patch);
    AppStore.touchSection(AppStore.require(app.AppID), 'ReviewDemat');


    // Carry validated details back onto the master so they are pre-filled next window.
    if (payload.finalise) {
      const empPatch = { UpdatedAt: Util.stamp() };
      if (patch.PANNumber && Util.trim(emp.PAN) !== patch.PANNumber) empPatch.PAN = patch.PANNumber;
      if (patch.ApplicantAddress && Util.trim(emp.Address) !== patch.ApplicantAddress) empPatch.Address = patch.ApplicantAddress;
      if (patch.ApplicantMobile && Util.trim(emp.Mobile) !== patch.ApplicantMobile) empPatch.Mobile = patch.ApplicantMobile;
      if (patch.ApplicantNationality && Util.trim(emp.Nationality) !== patch.ApplicantNationality) empPatch.Nationality = patch.ApplicantNationality;
      // Remember the demat account too, so a second window - or a later
      // year - starts from what they already confirmed.
      [['DematDPName', 'DematDPName'], ['DematDPId', 'DematDPId'],
       ['DematClientId', 'DematClientId'], ['DematAccountName', 'DematAccountName'],
       ['DematAccountType', 'DematAccountType']]
        .forEach(function (pair) {
          const v = patch[pair[0]];
          if (v && Util.trim(emp[pair[1]]) !== v) empPatch[pair[1]] = v;
        });
      if (Object.keys(empPatch).length > 1) Repo.update(T.EMPLOYEES, emp._row, empPatch);
    }


    audit(session.userId, session.role, payload.finalise ? 'DEMAT_SUBMITTED' : 'DEMAT_SAVED', app.AppID, '');


    if (payload.finalise) {
      const fresh = AppStore.require(app.AppID);
      Mailer.send('demat_saved', Auth.notificationEmailFor(session._user), {
        name: Util.trim(emp.Name),
        appId: Util.trim(app.AppID),
        dpName: Util.trim(fresh.DematDPName),
        dpId: Util.trim(fresh.DematDPId),
        clientId: Util.trim(fresh.DematClientId),
        pan: Util.trim(fresh.PANNumber)
      });
    }


    return ok(payload.finalise
      ? 'Details submitted. Shares will be credited to this demat account, so check the identifiers once more.'
      : 'Saved. You can come back and finish this section later.', session);
  }


  /* ---------------- 3. exercise payment ---------------- */


  /**
   * Recording the payment date fixes the FMV, and therefore the perquisite and
   * the tax: FMV is (open + close) / 2 of the trading day before that date.
   */
  function saveExercisePayment(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = requireActiveApp(session);
    AppStore.assertEditable(app);
    if (Util.num(app.TotalOptions, 0) <= 0) {
      throw new Error('Record the options you wish to exercise before entering the payment.');
    }
    const emp = Domain.employee(session.userId);
    const folder = Files.applicationFolder(app, emp);


    const patch = { UpdatedAt: Util.stamp() };
    if (payload.utr !== undefined) patch.ExercisePaymentUTR = Util.trim(payload.utr).toUpperCase();
    if (payload.bank !== undefined) patch.ExercisePaymentBank = Util.trim(payload.bank);
    if (payload.amount !== undefined) patch.ExercisePaymentAmount = Util.num(payload.amount, 0);


    let repriceNeeded = false;
    if (payload.paymentDate !== undefined && Util.trim(payload.paymentDate)) {
      const paid = Domain.validatePaymentDate(payload.paymentDate, 'exercise payment');
      const fmv = Domain.fmvForPaymentDate(paid);
      patch.ExercisePaymentDate = Util.dateKey(paid);
      patch.FMVDate = fmv.date;
      patch.FMVValue = fmv.fmv;
      patch.TaxDueDate = Util.dateKey(Domain.taxDueDateFor(paid));
      repriceNeeded = true;
    }


    if (payload.proofFile) {
      patch.ExerciseProofFileId = Files.save(folder, 'Exercise payment proof', payload.proofFile).fileId;
    }


    if (payload.finalise) {
      patch.ExercisePaymentUTR = Domain.validateUtr(
        patch.ExercisePaymentUTR !== undefined ? patch.ExercisePaymentUTR : app.ExercisePaymentUTR);
      const dateVal = patch.ExercisePaymentDate || Util.dateKey(app.ExercisePaymentDate);
      if (!dateVal) throw new Error('Enter the date on which you transferred the exercise amount.');
      if (!(patch.ExerciseProofFileId || Util.trim(app.ExerciseProofFileId))) {
        throw new Error('Upload the payment advice or bank statement showing this transfer.');
      }
      const expected = Util.num(app.ExerciseAmount, 0);
      const entered = patch.ExercisePaymentAmount !== undefined
        ? patch.ExercisePaymentAmount : Util.num(app.ExercisePaymentAmount, 0);
      if (!entered) {
        patch.ExercisePaymentAmount = expected;
      } else if (Math.abs(entered - expected) > 1) {
        throw new Error('The amount you entered (' + Util.inr(entered) + ') does not match the exercise amount due (' +
          Util.inr(expected) + '). Correct the amount, or adjust the options you are exercising.');
      }
    }


    Repo.update(T.APPLICATIONS, app._row, patch);
    if (repriceNeeded) AppStore.reprice(AppStore.require(app.AppID));
    AppStore.touchSection(AppStore.require(app.AppID), 'ReviewExercisePayment');


    const fresh = AppStore.require(app.AppID);
    audit(session.userId, session.role,
      payload.finalise ? 'EXERCISE_PAYMENT_SUBMITTED' : 'EXERCISE_PAYMENT_SAVED',
      app.AppID, 'utr ' + Util.trim(fresh.ExercisePaymentUTR) + ' fmv ' + Util.num(fresh.FMVValue, 0));


    if (payload.finalise) {
      Mailer.send('exercise_payment_received', Auth.notificationEmailFor(session._user), {
        name: Util.trim(emp.Name),
        appId: Util.trim(fresh.AppID),
        totalOptions: Util.num(fresh.TotalOptions, 0),
        totalShares: Util.num(fresh.TotalShares, 0),
        exerciseAmount: Util.num(fresh.ExerciseAmount, 0),
        utr: Util.trim(fresh.ExercisePaymentUTR),
        paymentDate: Util.prettyDate(fresh.ExercisePaymentDate),
        fmvDate: Util.prettyDate(fresh.FMVDate),
        fmv: Util.num(fresh.FMVValue, 0),
        perquisite: Util.num(fresh.PerquisiteAmount, 0),
        taxRate: AppStore.effectiveRate(fresh),
        tax: Util.num(fresh.TaxAmount, 0),
        taxDueDate: Util.prettyDate(fresh.TaxDueDate)
      });
    }


    return ok(repriceNeeded
      ? 'Saved. FMV of ' + Util.inr2(fresh.FMVValue) + ' applied from ' + Util.prettyDate(fresh.FMVDate) +
        ' — perquisite ' + Util.inr(fresh.PerquisiteAmount) + ' on ' + Util.count(fresh.TotalShares) +
        ' shares, tax payable ' + Util.inr(fresh.TaxAmount) + ' by ' + Util.prettyDate(fresh.TaxDueDate) + '.'
      : 'Saved.', session);
  }


  /* ---------------- 4. tax payment ---------------- */


  function chooseTaxMode(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = requireActiveApp(session);
    AppStore.assertEditable(app);
    if (Util.num(app.TaxAmount, 0) <= 0) {
      throw new Error('Your tax amount is not fixed yet. Record the exercise payment first — the FMV depends on its date.');
    }


    const mode = Util.trim(payload.mode);
    if ([TAX_MODE.SELF, TAX_MODE.PARTNER].indexOf(mode) < 0) throw new Error('Choose how the tax will be paid.');


    const emp = Domain.employee(session.userId);
    const patch = { TaxMode: mode, UpdatedAt: Util.stamp() };


    if (mode === TAX_MODE.SELF) {
      patch.FundPartnerName = '';
      const pr = AppStore.partnerRequestOf(app.AppID);
      if (pr && Util.trim(pr.Status) === PARTNER_STATUS.ASSIGNED) {
        Repo.update(T.PARTNER_REQUESTS, pr._row, {
          Status: 'Withdrawn',
          Remarks: 'Participant chose to pay the tax directly on ' + Util.stamp()
        });
      }
      // Paying it themselves means the shares go to their own demat account
      // again, so put back what the partner's entry displaced. Without this
      // they would be left holding the partner's identifiers.
      if (Util.trim(app.DematSource)) {
        patch.DematSource = '';
        patch.DematDPName = pr ? Util.trim(pr.EmployeeDPName) : '';
        patch.DematDPId = pr ? Util.trim(pr.EmployeeDPId) : '';
        patch.DematClientId = pr ? Util.trim(pr.EmployeeClientId) : '';
        patch.DematAccountType = pr ? Util.trim(pr.EmployeeAccountType) : '';
        patch.DematAccountName = pr ? Util.trim(pr.EmployeeAccountName) : '';
        // And their own CML, which the partner's displaced. Blank means they
        // have to attach it again — which is right: the file on the
        // application evidences the account the shares go to, and that has
        // just changed back.
        patch.CMLFileId = pr ? Util.trim(pr.EmployeeCMLFileId) : '';
        // Where the shares go has changed again, so it needs re-checking.
        patch.ReviewDemat = REVIEW.PENDING;
      }
      Repo.update(T.APPLICATIONS, app._row, patch);
      audit(session.userId, session.role, 'TAX_MODE_SELF', app.AppID, '');
      return ok('You will pay the tax directly. Transfer ' + Util.inr(app.TaxAmount) +
        ' and upload the UTR and payment date below by ' + Util.prettyDate(app.TaxDueDate) + '.', session);
    }


    // Must be a partner on record and still taking new business.
    const partner = Partners.requireSelectable(payload.fundPartnerName).name;


    // Checked before anything is written. Without an active login for this
    // partner nobody can enter the demat account or feed the payment — yet
    // the participant used to be told the partner "has been notified", which
    // is the worst kind of failure because they then stop chasing it.
    if (!Partners.logins(partner).length) {
      throw new Error(partner + ' is not set up in the portal yet, so they cannot act on this. ' +
        'Please contact the ESOP team, or choose to pay the tax yourself for now.');
    }


    patch.FundPartnerName = partner;
    patch.TaxPaymentUTR = '';
    patch.TaxPaymentDate = '';
    patch.TaxPaymentAmount = '';
    patch.TaxPaymentBank = '';
    Repo.update(T.APPLICATIONS, app._row, patch);


    const existing = AppStore.partnerRequestOf(app.AppID);
    const requestId = existing && Util.trim(existing.Status) === PARTNER_STATUS.ASSIGNED
      ? Util.trim(existing.RequestID) : Util.uid('FP-');


    const row = {
      RequestID: requestId,
      AppID: Util.trim(app.AppID),
      EmployeeID: Util.trim(app.EmployeeID),
      FundPartnerName: partner,
      TaxAmount: Util.num(app.TaxAmount, 0),
      Status: PARTNER_STATUS.ASSIGNED,
      AssignedAt: Util.stamp(),
      Remarks: ''
    };
    if (existing && Util.trim(existing.RequestID) === requestId) {
      Repo.update(T.PARTNER_REQUESTS, existing._row, row);
    } else {
      Repo.append(T.PARTNER_REQUESTS, row);
    }


    audit(session.userId, session.role, 'TAX_MODE_PARTNER', app.AppID, partner);


    Mailer.send('partner_assigned_employee', Auth.notificationEmailFor(session._user), {
      name: Util.trim(emp.Name),
      appId: Util.trim(app.AppID),
      partner: partner,
      tax: Util.num(app.TaxAmount, 0),
      taxDueDate: Util.prettyDate(app.TaxDueDate)
    });


    // Everyone on record for the partner — the contact addresses the ESOP
    // team keeps as well as their portal logins. One mail, so a relationship
    // manager and the operations desk see the same thing.
    Mailer.send('partner_assigned_partner', Partners.notifyEmails(partner).join(','), {
      partner: partner,
      requestId: requestId,
      appId: Util.trim(app.AppID),
      employeeName: Util.trim(emp.Name),
      employeeId: Util.trim(emp.EmployeeID),
      totalOptions: Util.num(app.TotalOptions, 0),
      totalShares: Util.num(app.TotalShares, 0),
      perquisite: Util.num(app.PerquisiteAmount, 0),
      tax: Util.num(app.TaxAmount, 0),
      taxDueDate: Util.prettyDate(app.TaxDueDate)
    });


    return ok(partner + ' has been notified and will enter the demat account and payment details. ' +
      'You will be emailed when they do.', session);
  }


  /**
   * Record one tax remittance.
   *
   * The tax may be settled in instalments - 2L against one UTR now, 3L against
   * another later - so this appends a row rather than overwriting a single set
   * of fields. The section is complete when the TOTAL reaches the amount due.
   * Each entry carries its own proof, and each proof is filed separately so a
   * second upload cannot replace the first.
   */
  function addTaxPayment(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = requireActiveApp(session);
    AppStore.assertEditable(app);


    if (Util.trim(app.TaxMode) !== TAX_MODE.SELF) {
      throw new Error('You have chosen to route the tax through ' +
        (Util.trim(app.FundPartnerName) || 'a fund partner') +
        '. Switch to paying it yourself if you would rather record your own payments.');
    }
    const due = Util.num(app.TaxAmount, 0);
    if (due <= 0) {
      throw new Error('Your tax amount is not fixed yet. Record the exercise payment first.');
    }


    const utr = Domain.validateUtr(payload.utr);
    const paidOn = Domain.validatePaymentDate(payload.paymentDate, 'tax payment');
    const amount = Util.num(payload.amount, 0);
    if (amount <= 0) throw new Error('Enter the amount you paid against this UTR.');


    const already = AppStore.taxPaidTotal(app.AppID);
    const remaining = Math.round((due - already) * 100) / 100;
    if (remaining <= 0) {
      throw new Error('The full tax of ' + Util.inr(due) + ' is already recorded. ' +
        'Remove an entry first if one of them is wrong.');
    }
    if (amount > remaining + 1) {
      throw new Error('That is more than is outstanding. ' + Util.inr(due) + ' is due, ' +
        Util.inr(already) + ' is already recorded, so ' + Util.inr(remaining) + ' remains. ' +
        'Enter ' + Util.inr(remaining) + ' or less.');
    }


    // Refuse a UTR already recorded on this application - almost always a
    // double submission rather than two genuine transfers.
    const duplicate = AppStore.taxPaymentsOf(app.AppID)
      .filter(r => Util.trim(r.UTR).toUpperCase() === utr)[0];
    if (duplicate) {
      throw new Error('UTR ' + utr + ' is already recorded against this application, for ' +
        Util.inr(duplicate.Amount) + ' on ' + Util.prettyDate(duplicate.PaymentDate) + '.');
    }


    if (!payload.proofFile) {
      throw new Error('Upload the payment advice or bank statement for this transfer.');
    }


    const emp = Domain.employee(session.userId);
    const folder = Files.applicationFolder(app, emp);
    const seq = AppStore.nextTaxSeq(app.AppID);
    const saved = Files.save(folder, 'Tax payment proof ' + seq, payload.proofFile);


    Repo.append(T.TAX_PAYMENTS, {
      PaymentID: Util.uid('TP-'),
      AppID: Util.trim(app.AppID),
      EmployeeID: Util.trim(app.EmployeeID),
      Seq: seq,
      PaidBy: TAX_MODE.SELF,
      FundPartnerName: '',
      UTR: utr,
      PaymentDate: Util.dateKey(paidOn),
      Amount: Math.round(amount * 100) / 100,
      Bank: Util.trim(payload.bank),
      ProofFileId: saved.fileId,
      EnteredBy: session.userId,
      EnteredAt: Util.stamp(),
      Remarks: ''
    });


    const totals = AppStore.refreshTaxTotals(AppStore.require(app.AppID));
    AppStore.touchSection(AppStore.require(app.AppID), 'ReviewTaxPayment');


    // A payment after the due date is recorded, not refused - the admin has to
    // be able to see that it was late.
    const dueDate = Util.startOfDay(app.TaxDueDate);
    if (dueDate && paidOn.getTime() > dueDate.getTime()) {
      const fresh = AppStore.require(app.AppID);
      Repo.update(T.APPLICATIONS, fresh._row, {
        AdminRemarks: Util.trim(fresh.AdminRemarks) + (Util.trim(fresh.AdminRemarks) ? '\n' : '') +
          '[system] Tax entry ' + seq + ' of ' + Util.inr(amount) + ' paid ' +
          Util.prettyDate(paidOn) + ', after the due date of ' + Util.prettyDate(dueDate) + '.'
      });
    }


    audit(session.userId, session.role, 'TAX_PAYMENT_ADDED', app.AppID,
      'entry ' + seq + ' utr ' + utr + ' ' + Util.inr(amount) +
      ' (total ' + Util.inr(totals.total) + ' of ' + Util.inr(due) + ')');


    const settled = totals.total + 1 >= due;
    if (settled) {
      Mailer.send('tax_payment_received', Auth.notificationEmailFor(session._user), {
        name: Util.trim(emp.Name),
        appId: Util.trim(app.AppID),
        amount: totals.total,
        utr: totals.count > 1 ? totals.count + ' payments' : utr,
        paymentDate: Util.prettyDate(paidOn)
      });
    }


    return ok(settled
      ? 'Tax fully recorded — ' + Util.inr(totals.total) + ' across ' + totals.count +
        ' payment' + (totals.count === 1 ? '' : 's') + '. Next: sign the exercise notice.'
      : Util.inr(amount) + ' recorded. ' + Util.inr(Math.max(0, due - totals.total)) +
        ' of ' + Util.inr(due) + ' still to pay.', session);
  }


  /** Remove a tax entry that was keyed wrongly, while the section is still editable. */
  function deleteTaxPayment(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = requireActiveApp(session);
    AppStore.assertEditable(app);


    if (Util.trim(app.ReviewTaxPayment) === REVIEW.OK) {
      throw new Error('The ESOP team has already verified your tax payments, so they can no longer be changed.');
    }


    const id = Util.trim(payload.paymentId);
    const row = AppStore.taxPaymentsOf(app.AppID).filter(r => Util.trim(r.PaymentID) === id)[0];
    if (!row) throw new Error('That tax payment is not on this application.');
    if (Util.trim(row.PaidBy) !== TAX_MODE.SELF) {
      throw new Error('That payment was recorded by ' + (Util.trim(row.FundPartnerName) || 'a fund partner') +
        ', so only the ESOP team can change it.');
    }


    try {
      if (Util.trim(row.ProofFileId)) DriveApp.getFileById(Util.trim(row.ProofFileId)).setTrashed(true);
    } catch (e) { /* the row matters more than the file */ }


    Repo.deleteRow(T.TAX_PAYMENTS, row._row);
    const totals = AppStore.refreshTaxTotals(AppStore.require(app.AppID));
    AppStore.touchSection(AppStore.require(app.AppID), 'ReviewTaxPayment');


    audit(session.userId, session.role, 'TAX_PAYMENT_REMOVED', app.AppID,
      'utr ' + Util.trim(row.UTR) + ' ' + Util.inr(row.Amount));


    const due = Util.num(app.TaxAmount, 0);
    return ok('Removed. ' + Util.inr(Math.max(0, due - totals.total)) + ' of ' +
      Util.inr(due) + ' still to pay.', session);
  }


  /* ---------------- 5. exercise notice ---------------- */


  /**
   * One of the participant's own applications, in full, by reference.
   *
   * The dashboard only ever carries the one in play, so a second exercise in
   * the same window left the first unreadable — the row was in the list with
   * nothing behind it. This is what makes those rows openable.
   *
   * The ownership check is the whole security of it: an application reference
   * is guessable (APP-202609-PW4872-2), so the row is matched against the
   * signed-in participant and refused otherwise.
   */
  function applicationById(session, payload) {
    assertEmployee(session);
    const id = Util.trim(payload.appId);
    if (!id) throw new Error('Which application?');


    const app = AppStore.require(id);
    if (Util.trim(app.EmployeeID).toUpperCase() !== Util.trim(session.userId).toUpperCase()) {
      throw new Error('That application is not on your record.');
    }


    const view = AppStore.view(app);
    // The notice as it was signed, so a past exercise can be read back in
    // full rather than summarised.
    view.noticeHtml = '';
    try {
      const lines = AppStore.linesOf(id);
      if (lines.length) {
        view.noticeHtml = Notice.bodyHtml(app, Domain.employee(app.EmployeeID), lines);
      }
    } catch (e) {
      console.warn('notice could not be rendered for ' + id + ': ' + e.message);
    }
    return view;
  }


  function getNotice(session) {
    assertEmployee(session);
    const app = myApp(session, false);
    if (!app) throw new Error('Start an application before viewing the exercise notice.');
    const emp = Domain.employee(session.userId);
    const lines = AppStore.linesOf(app.AppID);
    if (!lines.length) throw new Error('Record the options you wish to exercise before viewing the notice.');
    return {
      html: Notice.bodyHtml(app, emp, lines),
      signed: !!Util.trim(app.NoticeSignedAt),
      signatureName: Util.trim(app.NoticeSignatureName),
      signedAt: Util.prettyStamp(app.NoticeSignedAt),
      place: Util.trim(app.NoticePlace),
      expectedName: Util.trim(emp.Name),
      pdf: Files.meta(app.NoticeFileId)
    };
  }


  /**
   * Sign by typing the name of record, a place, and ticking the declaration.
   * The name must match the employee master, so a signature cannot be entered
   * casually or on someone else's behalf.
   */
  function signNotice(session, payload) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = myApp(session, false);
    if (!app) throw new Error('Start an application first.');
    AppStore.assertEditable(app);


    const emp = Domain.employee(session.userId);
    const lines = AppStore.linesOf(app.AppID);
    if (!lines.length) throw new Error('Record the options you wish to exercise before signing.');


    const prog = AppStore.progress(app);
    if (!prog.done.demat) {
      throw new Error('Complete your applicant, demat and PAN details before signing — they appear in section A of the notice.');
    }
    if (!prog.done.exercise) {
      throw new Error('Record the exercise payment before signing — the notice states the amount paid and its UTR.');
    }
    if (!payload.accepted) throw new Error('Tick the declaration to sign the notice.');


    const place = Util.trim(payload.place);
    if (!place) throw new Error('Enter the place at which you are signing.');


    const typed = Util.trim(payload.signatureName);
    const expected = Util.trim(emp.Name);
    const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
    if (!typed) throw new Error('Type your name to sign.');


    // The signature has to be the participant's own name, but it does not
    // have to be the whole registered string. People sign with their first
    // name, and a record carrying a middle name or an initial made a correct
    // signature look wrong. So: the first name must match, and any further
    // words must appear in the registered name, in order. The full printed
    // name still comes from the record — this is only what they sign as.
    const parts = expected.split(/\s+/).filter(Boolean);
    const typedParts = typed.split(/\s+/).filter(Boolean);
    // NOT called `ok`: that name is the response helper used at the end of this
    // function, and a local of the same name hid it — every signature failed
    // with "ok is not a function".
    let nameMatches = parts.length > 0 && typedParts.length > 0 &&
      norm(typedParts[0]) === norm(parts[0]);
    if (nameMatches) {
      let at = 1;
      for (let i = 1; i < typedParts.length && nameMatches; i++) {
        while (at < parts.length && norm(parts[at]) !== norm(typedParts[i])) at++;
        if (at >= parts.length) nameMatches = false; else at++;
      }
    }
    if (!nameMatches) {
      throw new Error('Sign with your own name as it appears on your record — "' +
        (parts[0] || expected) + '" on its own is enough, or the full name "' + expected + '".');
    }


    const signedAt = Util.stamp();
    Repo.update(T.APPLICATIONS, app._row, {
      NoticeSignatureName: typed,
      NoticeSignedAt: signedAt,
      NoticePlace: place,
      ReviewNotice: REVIEW.PENDING,
      UpdatedAt: signedAt
    });


    const fresh = AppStore.require(app.AppID);
    let pdfId = '';
    try {
      pdfId = Notice.generatePdf(fresh, emp, AppStore.linesOf(app.AppID));
      Repo.update(T.APPLICATIONS, fresh._row, { NoticeFileId: pdfId });
    } catch (e) {
      console.error('notice pdf failed: ' + e);
    }


    audit(session.userId, session.role, 'NOTICE_SIGNED', app.AppID, 'as "' + typed + '" at ' + place);


    Mailer.send('notice_signed', Auth.notificationEmailFor(session._user), {
      name: Util.trim(emp.Name),
      appId: Util.trim(app.AppID),
      signatureName: typed,
      signedAt: signedAt,
      totalOptions: Util.num(fresh.TotalOptions, 0),
      totalShares: Util.num(fresh.TotalShares, 0)
    }, pdfId ? { attachFileIds: [pdfId] } : {});


    return ok('Notice signed and filed. A copy has been emailed to you.', session);
  }


  /* ---------------- 6. submit ---------------- */


  function submit(session) {
    assertEmployee(session);
    requireNotBlocked(session);
    requireOpenWindow();
    const app = myApp(session, false);
    if (!app) throw new Error('There is nothing to submit yet.');
    AppStore.assertEditable(app);


    const prog = AppStore.progress(app);
    if (!prog.complete) {
      throw new Error('Still to finish before you can submit: ' + prog.pendingLabels.join(', ') + '.');
    }


    // A section the ESOP team sent back stays marked until it is changed —
    // editing it is what clears the mark. Resubmitting without touching it
    // would put the same refused material back in front of them.
    const stillBack = [
      ['options', app.ReviewOptions], ['demat and PAN', app.ReviewDemat],
      ['exercise payment', app.ReviewExercisePayment], ['tax payment', app.ReviewTaxPayment],
      ['exercise notice', app.ReviewNotice]
    ].filter(r => Util.trim(r[1]) === REVIEW.BACK).map(r => r[0]);
    if (stillBack.length) {
      throw new Error('The ESOP team sent these back and they have not been corrected yet: ' +
        stillBack.join(', ') + '. Correct and save each one, then submit again.');
    }


    // Re-validate against live balances: the vesting report may have been
    // re-synced while this application sat in draft.
    const lines = AppStore.linesOf(app.AppID).map(l => ({
      grantId: Util.trim(l.GrantID), options: Util.num(l.OptionsExercised, 0)
    }));
    Domain.validateLines(session.userId, lines, Util.trim(app.AppID));


    const emp = Domain.employee(session.userId);
    const submittedAt = Util.stamp();
    Repo.update(T.APPLICATIONS, app._row, {
      Status: STATUS.SUBMITTED,
      SubmittedAt: submittedAt,
      UpdatedAt: submittedAt
    });


    const fresh = AppStore.require(app.AppID);
    audit(session.userId, session.role, 'APP_SUBMITTED', app.AppID,
      Util.num(fresh.TotalOptions, 0) + ' options / ' + Util.num(fresh.TotalShares, 0) + ' shares');


    const payload = {
      name: Util.trim(emp.Name),
      employeeName: Util.trim(emp.Name),
      employeeId: Util.trim(emp.EmployeeID),
      appId: Util.trim(fresh.AppID),
      windowLabel: Util.monthLabel(Domain.currentWindow().Label),
      totalOptions: Util.num(fresh.TotalOptions, 0),
      totalShares: Util.num(fresh.TotalShares, 0),
      exerciseAmount: Util.num(fresh.ExerciseAmount, 0),
      perquisite: Util.num(fresh.PerquisiteAmount, 0),
      tax: Util.num(fresh.TaxAmount, 0),
      taxMode: Util.trim(fresh.TaxMode) === TAX_MODE.PARTNER
        ? Util.trim(fresh.FundPartnerName) : 'Paid directly by the participant'
    };
    Mailer.send('application_submitted_employee', Auth.notificationEmailFor(session._user), payload);
    Mailer.sendToAdmins('application_submitted_admin', payload);


    return ok('Application submitted for verification. You will be emailed once the ESOP team has reviewed it.', session);
  }


  /* ---------------- shared ---------------- */


  function requireOpenWindow() {
    const st = Domain.windowState(Domain.currentWindow());
    if (!st.open) throw new Error(st.reason + ' Applications can only be edited while a window is open.');
  }


  /** Mutations return the refreshed dashboard, so one round trip updates the
   *  whole screen and the client never holds stale numbers. */
  function ok(message, session) {
    return { ok: true, message: message, dashboard: dashboard(session) };
  }


  return {
    dashboard: dashboard,
    quote: quote,
    saveOptions: saveOptions,
    saveDemat: saveDemat,
    saveExercisePayment: saveExercisePayment,
    chooseTaxMode: chooseTaxMode,
    addTaxPayment: addTaxPayment,
    deleteTaxPayment: deleteTaxPayment,
    getNotice: getNotice,
    applicationById: applicationById,
    signNotice: signNotice,
    submit: submit
  };
})();


