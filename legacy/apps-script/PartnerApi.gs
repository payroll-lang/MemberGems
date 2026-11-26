/**
 * PartnerApi.gs — the fund partner's side.
 *
 * A partner login sees only the requests routed to that partner — but for
 * those it sees the whole picture, because of how the funding actually works:
 *
 *   1. the participant opens a demat account WITH the partner
 *   2. the exercised shares are allotted into that account
 *   3. the partner funds the perquisite tax against those shares
 *   4. when the participant later asks the partner to sell, enough is sold to
 *      clear the funding and its interest
 *   5. the rest stays freely tradable in the same account
 *
 * The portal's part in that is steps 1 and 2 only. It does not track the
 * funding, the interest or any subsequent sale — that is between the
 * participant and the partner, and deliberately outside this system. What the
 * portal does is record which account the shares go to, and explain the
 * arrangement to the participant before they choose it.
 *
 * The consequence for this file: the partner is the counterparty to the
 * shares, not just the payer of a bill, so they see the whole picture for
 * their own requests and they enter the demat identifiers on the
 * participant's behalf — the participant frequently does not know their own
 * new DP ID and client ID yet.
 *
 * The partner still sees only their own requests, and still cannot see the
 * PAN card image, the CML or the exercise payment proof: those are the ESOP
 * team's verification evidence, not the partner's.
 */


const PartnerApi = (function () {


  function assertPartner(session) {
    if (session.role !== ROLE.PARTNER) throw new Error('This screen is for fund partners.');
    if (!Util.trim(session.fundPartnerName)) {
      throw new Error('Your login is not linked to a fund partner. Contact the ESOP team.');
    }
  }


  function myRequests(session) {
    const partner = Util.trim(session.fundPartnerName);
    return Repo.filter(T.PARTNER_REQUESTS, r => Util.trim(r.FundPartnerName) === partner);
  }


  function requireRequest(session, requestId) {
    const key = Util.trim(requestId);
    const row = myRequests(session).filter(r => Util.trim(r.RequestID) === key)[0];
    if (!row) throw new Error('Request ' + key + ' is not assigned to ' + Util.trim(session.fundPartnerName) + '.');
    return row;
  }


  /** The partner's worklist. */
  function dashboard(session) {
    assertPartner(session);
    const employees = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { employees[Util.trim(e.EmployeeID).toUpperCase()] = e; });
    const apps = {};
    Repo.objects(T.APPLICATIONS).forEach(a => { apps[Util.trim(a.AppID)] = a; });


    const rows = myRequests(session).map(function (r) {
      const emp = employees[Util.trim(r.EmployeeID).toUpperCase()] || {};
      const app = apps[Util.trim(r.AppID)] || {};
      return {
        requestId: Util.trim(r.RequestID),
        appId: Util.trim(r.AppID),
        employeeId: Util.trim(r.EmployeeID),
        employeeName: Util.trim(emp.Name),
        windowId: Util.windowKey(app.WindowID),
        employeeEmail: Domain.emailFor(emp),
        employeeMobile: Util.trim(app.ApplicantMobile) || Util.trim(emp.Mobile),
        pan: Util.trim(app.PANNumber) || Util.trim(emp.PAN),


        totalOptions: Util.num(app.TotalOptions, 0),
        // The shares are the partner's security, so the count, the price they
        // were valued at and the exercise cost all matter to them.
        totalShares: Util.num(app.TotalShares, 0),
        exerciseAmount: Util.num(app.ExerciseAmount, 0),
        fmvValue: Util.num(app.FMVValue, 0),
        prettyFmvDate: Util.prettyDate(app.FMVDate),
        perquisiteAmount: Util.num(app.PerquisiteAmount, 0),
        taxRatePercent: Util.num(app.TaxRatePercent, 0),
        taxAmount: Util.num(r.TaxAmount, 0),
        taxDueDate: Util.dateKey(app.TaxDueDate),
        prettyTaxDueDate: Util.prettyDate(app.TaxDueDate),
        status: Util.trim(r.Status),
        assignedAt: Util.prettyStamp(r.AssignedAt),


        // The account the shares will be allotted into. Blank until the
        // partner fills it in.
        demat: {
          dpName: Util.trim(r.PartnerDPName),
          dpId: Util.trim(r.PartnerDPId),
          clientId: Util.trim(r.PartnerClientId),
          accountType: Util.trim(r.PartnerAccountType),
          accountName: Util.trim(r.PartnerAccountName),
          providedBy: Util.trim(r.DematProvidedBy),
          providedAt: Util.prettyStamp(r.DematProvidedAt),
          cml: Files.meta(r.CMLFileId),
          complete: !!(Util.trim(r.PartnerDPId) && Util.trim(r.PartnerClientId) &&
            Util.trim(r.PartnerAccountType) && Util.trim(r.CMLFileId))
        },
        // What the participant themselves supplied at step 2. Read from the
        // stash once the partner's account has displaced it on the
        // application, so the comparison stays meaningful.
        ownDemat: {
          dpName: Util.trim(r.EmployeeDPName) || (Util.trim(app.DematSource) ? '' : Util.trim(app.DematDPName)),
          dpId: Util.trim(r.EmployeeDPId) || (Util.trim(app.DematSource) ? '' : Util.trim(app.DematDPId)),
          clientId: Util.trim(r.EmployeeClientId) || (Util.trim(app.DematSource) ? '' : Util.trim(app.DematClientId)),
          accountType: Util.trim(r.EmployeeAccountType) || (Util.trim(app.DematSource) ? '' : Util.trim(app.DematAccountType))
        },
        payment: {
          utr: Util.trim(r.PaymentUTR),
          date: Util.dateKey(r.PaymentDate),
          prettyDate: Util.prettyDate(r.PaymentDate),
          amount: Util.num(r.PaymentAmount, 0),
          bank: Util.trim(r.PaymentBank),
          proof: Files.meta(r.ProofFileId)
        },
        fedBy: Util.trim(r.FedBy),
        fedAt: Util.prettyStamp(r.FedAt),
        remarks: Util.trim(r.Remarks),
        editable: [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK].indexOf(Util.trim(r.Status)) >= 0
      };
    });


    const rank = {};
    rank[PARTNER_STATUS.SENT_BACK] = 0;
    rank[PARTNER_STATUS.ASSIGNED] = 1;
    rank[PARTNER_STATUS.PAID] = 2;
    rank[PARTNER_STATUS.VERIFIED] = 3;
    rank[PARTNER_STATUS.DECLINED] = 4;
    rows.sort(function (a, b) {
      const d = (rank[a.status] === undefined ? 9 : rank[a.status]) - (rank[b.status] === undefined ? 9 : rank[b.status]);
      if (d !== 0) return d;
      return String(a.taxDueDate).localeCompare(String(b.taxDueDate));
    });


    const openRows = rows.filter(r => r.editable);
    return {
      partnerName: Util.trim(session.fundPartnerName),
      rows: rows,
      summary: {
        awaitingPayment: openRows.length,
        awaitingAmount: openRows.reduce((a, r) => a + r.taxAmount, 0),
        fedNotVerified: rows.filter(r => r.status === PARTNER_STATUS.PAID).length,
        verified: rows.filter(r => r.status === PARTNER_STATUS.VERIFIED).length,
        overdue: openRows.filter(r => r.taxDueDate && r.taxDueDate < Util.dateKey(new Date())).length
      },
      bankDetails: cfg('TAX_BANK_DETAILS')
    };
  }


  /**
   * The partner records the demat account the shares are to be allotted into.
   *
   * That account is opened with the partner, so they are the ones who know the
   * DP ID and client ID — often before the participant does. Saving it here
   * makes it the allotment account on the application, replacing whatever the
   * participant entered at step 2, and re-opens the demat section for the
   * ESOP team to check.
   *
   * The DP name defaults to the partner's own name rather than being asked
   * for: it is their account, and letting it be typed freely is how you end
   * up with three spellings of the same DP.
   */
  function saveDemat(session, payload) {
    assertPartner(session);
    const req = requireRequest(session, payload.requestId);
    if ([PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK].indexOf(Util.trim(req.Status)) < 0) {
      throw new Error('This request is ' + Util.trim(req.Status).toLowerCase() +
        ' and the demat account can no longer be changed. Contact the ESOP team.');
    }


    const app = AppStore.require(req.AppID);
    const partner = Util.trim(session.fundPartnerName);


    // Validated by the same rules as a participant's own account, so a
    // partner cannot enter something the registrar will reject either.
    const dm = Domain.validateDemat({
      dematDPName: Util.trim(payload.dpName) || partner,
      dematAccountName: Util.trim(payload.accountName),
      dematDPId: Util.trim(payload.dpId),
      dematClientId: Util.trim(payload.clientId),
      dematAccountType: Util.trim(payload.accountType)
    });


    // The client master list for the account the shares are allotted to.
    // Required, for the same reason it is required of a participant: the
    // registrar allots against the CML, and an account nobody has evidenced
    // is not an account to allot 8,532 shares into.
    //
    // The CML columns arrived after the first partner requests existed, and
    // Repo.update ignores a column the tab does not have — so on a workbook
    // that has not been migrated the requirement is dropped rather than
    // silently accepting a file that goes nowhere.
    const hasCmlColumn = Repo.headers(T.PARTNER_REQUESTS).indexOf('CMLFileId') >= 0;
    if (hasCmlColumn && !payload.cmlFile && !Util.trim(req.CMLFileId)) {
      throw new Error('Attach the client master list (CML) for the demat account — ' +
        'the shares are allotted against it.');
    }
    if (!hasCmlColumn) {
      console.warn('FundPartners requests tab has no CMLFileId column — run createWorkbook(). ' +
        'The partner CML is not being required or stored until then.');
    }


    const stamp = Util.stamp();
    const reqPatch = {
      PartnerDPName: Util.trim(payload.dpName) || partner,
      PartnerDPId: dm.dpId,
      PartnerClientId: dm.clientId,
      PartnerAccountType: dm.accountType,
      PartnerAccountName: Util.trim(payload.accountName),
      DematProvidedBy: session.userId,
      DematProvidedAt: stamp
    };


    // Keep the participant's own account the first time we displace it, so
    // going back to paying the tax themselves restores what they entered
    // rather than leaving the partner's identifiers on their application.
    if (!Util.trim(req.EmployeeDPId) && !Util.trim(app.DematSource)) {
      reqPatch.EmployeeDPName = Util.trim(app.DematDPName);
      reqPatch.EmployeeDPId = Util.trim(app.DematDPId);
      reqPatch.EmployeeClientId = Util.trim(app.DematClientId);
      reqPatch.EmployeeAccountType = Util.trim(app.DematAccountType);
      reqPatch.EmployeeAccountName = Util.trim(app.DematAccountName);
      reqPatch.EmployeeCMLFileId = Util.trim(app.CMLFileId);
    }


    // The partner's CML becomes the application's, because it evidences the
    // account the shares actually go to. The participant's own file is
    // stashed above and stays in Drive either way.
    let cmlId = Util.trim(req.CMLFileId);
    if (hasCmlColumn && payload.cmlFile) {
      const folder = Files.applicationFolder(app, Domain.employee(app.EmployeeID));
      cmlId = Files.save(folder, 'CML — ' + partner, payload.cmlFile).fileId;
      reqPatch.CMLFileId = cmlId;
    }
    Repo.update(T.PARTNER_REQUESTS, req._row, reqPatch);


    // The application carries the account the shares actually go to, because
    // that is what the notice prints and what the registrar is given.
    Repo.update(T.APPLICATIONS, app._row, {
      DematDPName: Util.trim(payload.dpName) || partner,
      DematDPId: dm.dpId,
      DematClientId: dm.clientId,
      DematAccountType: dm.accountType,
      DematAccountName: Util.trim(payload.accountName),
      DematSource: partner,
      CMLFileId: cmlId || Util.trim(app.CMLFileId),
      // Changing where the shares land has to be re-checked, even if the
      // section was already verified against the participant's own account.
      ReviewDemat: REVIEW.PENDING,
      UpdatedAt: stamp
    });


    audit(session.userId, session.role, 'PARTNER_DEMAT_SET', Util.trim(app.AppID),
      partner + ' ' + dm.accountType + ' ' + dm.dpId + ' / ' + dm.clientId);


    const emp = Domain.employee(app.EmployeeID);
    Mailer.send('partner_demat_set_employee', Domain.emailFor(emp), {
      name: Util.trim(emp.Name),
      appId: Util.trim(app.AppID),
      partner: partner,
      dpName: Util.trim(payload.dpName) || partner,
      dpId: dm.dpId,
      clientId: dm.clientId,
      accountType: dm.accountType,
      accountName: Util.trim(payload.accountName),
      totalShares: Util.num(app.TotalShares, 0)
    });
    Mailer.sendToAdmins('partner_demat_set_admin', {
      partner: partner,
      appId: Util.trim(app.AppID),
      employeeName: Util.trim(emp.Name),
      employeeId: Util.trim(app.EmployeeID),
      dpId: dm.dpId,
      clientId: dm.clientId,
      accountType: dm.accountType,
      accountName: Util.trim(payload.accountName),
      totalShares: Util.num(app.TotalShares, 0)
    });


    return {
      ok: true,
      message: 'Demat account recorded. The shares for this exercise will be allotted to ' +
        dm.dpId + ' / ' + dm.clientId + '.',
      dashboard: dashboard(session)
    };
  }


  /**
   * Feed the payment. Partial saves are allowed so a partner can record the
   * UTR now and attach the advice later; `finalise` locks it for verification.
   */
  function savePayment(session, payload) {
    assertPartner(session);
    const req = requireRequest(session, payload.requestId);
    if ([PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK].indexOf(Util.trim(req.Status)) < 0) {
      throw new Error('This request is ' + Util.trim(req.Status).toLowerCase() + ' and can no longer be edited.');
    }


    const app = AppStore.require(req.AppID);
    const emp = Domain.employee(app.EmployeeID);
    const folder = Files.applicationFolder(app, emp);


    const patch = {};
    if (payload.utr !== undefined) patch.PaymentUTR = Util.trim(payload.utr).toUpperCase();
    if (payload.bank !== undefined) patch.PaymentBank = Util.trim(payload.bank);
    if (payload.amount !== undefined && payload.amount !== '') patch.PaymentAmount = Util.num(payload.amount, 0);
    if (payload.paymentDate !== undefined && Util.trim(payload.paymentDate)) {
      patch.PaymentDate = Util.dateKey(Domain.validatePaymentDate(payload.paymentDate, 'tax payment'));
    }
    if (payload.proofFile) {
      patch.ProofFileId = Files.save(folder, 'Tax payment proof — ' + Util.trim(session.fundPartnerName), payload.proofFile).fileId;
    }


    if (payload.finalise) {
      // The shares have to have somewhere to go before the funding is
      // treated as complete, and the partner is the one who knows where.
      if (!Util.trim(req.PartnerDPId) || !Util.trim(req.PartnerClientId)) {
        throw new Error('Record the demat account first — the shares from this exercise are ' +
          'allotted into the account held with you, and the ESOP team needs it before allotment.');
      }
      patch.PaymentUTR = Domain.validateUtr(patch.PaymentUTR !== undefined ? patch.PaymentUTR : req.PaymentUTR);
      const dateVal = patch.PaymentDate || Util.dateKey(req.PaymentDate);
      if (!dateVal) throw new Error('Enter the date on which the tax was paid.');
      if (!(patch.ProofFileId || Util.trim(req.ProofFileId))) {
        throw new Error('Upload the payment advice or bank statement for this transfer.');
      }
      const due = Util.num(req.TaxAmount, 0);
      const paid = patch.PaymentAmount !== undefined ? patch.PaymentAmount : Util.num(req.PaymentAmount, 0);
      if (!paid) {
        patch.PaymentAmount = due;
      } else if (paid + 1 < due) {
        throw new Error('The amount paid (' + Util.inr(paid) + ') is short of the tax due (' + Util.inr(due) +
          '). Pay the balance before marking this complete.');
      }
      patch.Status = PARTNER_STATUS.PAID;
      patch.FedBy = session.userId;
      patch.FedAt = Util.stamp();
    }


    Repo.update(T.PARTNER_REQUESTS, req._row, patch);


    // Mirror the partner's payment onto the application so the admin review
    // screen and the payroll export read from one place.
    if (payload.finalise) {
      const fresh = requireRequest(session, payload.requestId);
      Repo.update(T.APPLICATIONS, app._row, {
        TaxPaymentUTR: Util.trim(fresh.PaymentUTR),
        TaxPaymentDate: Util.dateKey(fresh.PaymentDate),
        TaxPaymentAmount: Util.num(fresh.PaymentAmount, 0),
        TaxPaymentBank: Util.trim(fresh.PaymentBank),
        TaxProofFileId: Util.trim(fresh.ProofFileId),
        ReviewTaxPayment: REVIEW.PENDING,
        UpdatedAt: Util.stamp()
      });


      // Mirror it into TaxPayments so the admin screen and the export read every
      // remittance from one place. A fund partner pays in a single entry — it has
      // the funds — so this is an upsert of one row, not an append per call.
      const partnerRows = AppStore.taxPaymentsOf(app.AppID)
        .filter(r => Util.trim(r.PaidBy) === TAX_MODE.PARTNER);
      const mirror = {
        AppID: Util.trim(app.AppID),
        EmployeeID: Util.trim(app.EmployeeID),
        PaidBy: TAX_MODE.PARTNER,
        FundPartnerName: Util.trim(session.fundPartnerName),
        UTR: Util.trim(fresh.PaymentUTR),
        PaymentDate: Util.dateKey(fresh.PaymentDate),
        Amount: Util.num(fresh.PaymentAmount, 0),
        Bank: Util.trim(fresh.PaymentBank),
        ProofFileId: Util.trim(fresh.ProofFileId),
        EnteredBy: session.userId,
        EnteredAt: Util.stamp(),
        Remarks: 'Paid by fund partner'
      };
      if (partnerRows.length) {
        Repo.update(T.TAX_PAYMENTS, partnerRows[0]._row, mirror);
      } else {
        Repo.append(T.TAX_PAYMENTS, Object.assign({
          PaymentID: Util.uid('TP-'),
          Seq: AppStore.nextTaxSeq(app.AppID)
        }, mirror));
      }
      AppStore.refreshTaxTotals(AppStore.require(app.AppID));


      audit(session.userId, session.role, 'PARTNER_PAYMENT_FED', Util.trim(app.AppID),
        Util.trim(session.fundPartnerName) + ' utr ' + Util.trim(fresh.PaymentUTR) + ' ' + Util.inr(fresh.PaymentAmount));


      const employeeUser = Auth.findUser(Util.trim(app.EmployeeID));
      const to = employeeUser
        ? Auth.notificationEmailFor(employeeUser)
        : Domain.emailFor(emp);
      Mailer.send('partner_payment_fed_employee', to, {
        name: Util.trim(emp.Name),
        appId: Util.trim(app.AppID),
        partner: Util.trim(session.fundPartnerName),
        amount: Util.num(fresh.PaymentAmount, 0),
        utr: Util.trim(fresh.PaymentUTR),
        paymentDate: Util.prettyDate(fresh.PaymentDate)
      });
      Mailer.sendToAdmins('partner_payment_fed_admin', {
        partner: Util.trim(session.fundPartnerName),
        appId: Util.trim(app.AppID),
        employeeName: Util.trim(emp.Name),
        employeeId: Util.trim(emp.EmployeeID),
        amount: Util.num(fresh.PaymentAmount, 0),
        utr: Util.trim(fresh.PaymentUTR),
        paymentDate: Util.prettyDate(fresh.PaymentDate)
      });
    } else {
      audit(session.userId, session.role, 'PARTNER_PAYMENT_SAVED', Util.trim(app.AppID), '');
    }


    return {
      ok: true,
      message: payload.finalise
        ? 'Payment recorded. The employee and the ESOP team have been notified.'
        : 'Saved, but NOT yet submitted — the ESOP team cannot see it until you record the ' +
          'payment as made.',
      dashboard: dashboard(session)
    };
  }


  /**
   * The whole request in one action: the allotment account and the payment,
   * recorded together.
   *
   * Two separate saves were wrong in two ways. A partner had to press three
   * buttons in the right order to finish one job, and "Save for later" looked
   * like submitting — so a request could be left unsubmitted with no
   * attachment and nothing said so.
   *
   * Everything is therefore checked BEFORE anything is written, and every
   * problem is reported at once. Being told about one missing field, fixing
   * it, and only then being told about the next is what makes a form feel
   * broken.
   */
  function submitAll(session, payload) {
    assertPartner(session);
    const req = requireRequest(session, payload.requestId);
    if ([PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK].indexOf(Util.trim(req.Status)) < 0) {
      throw new Error('This request is ' + Util.trim(req.Status).toLowerCase() +
        ' and can no longer be edited. Contact the ESOP team.');
    }


    const problems = [];
    const guard = function (fn) {
      try { fn(); } catch (e) { problems.push(e.message); }
    };


    // 1. the allotment account
    guard(function () {
      Domain.validateDemat({
        dematDPName: Util.trim(payload.dpName) || Util.trim(session.fundPartnerName),
        dematAccountName: Util.trim(payload.accountName),
        dematDPId: Util.trim(payload.dpId),
        dematClientId: Util.trim(payload.clientId),
        dematAccountType: Util.trim(payload.accountType)
      });
    });


    if (Repo.headers(T.PARTNER_REQUESTS).indexOf('CMLFileId') >= 0 &&
        !payload.cmlFile && !Util.trim(req.CMLFileId)) {
      problems.push('Attach the client master list (CML) for the demat account — the shares are ' +
        'allotted against it.');
    }


    // 2. the payment
    guard(function () { Domain.validateUtr(Util.trim(payload.utr)); });
    if (!Util.trim(payload.paymentDate)) {
      problems.push('Enter the date on which the tax was paid.');
    } else {
      guard(function () { Domain.validatePaymentDate(payload.paymentDate, 'tax payment'); });
    }


    // 3. the proof. This is the evidence the ESOP team verifies the transfer
    //    against, so a request cannot be submitted without it.
    if (!payload.proofFile && !Util.trim(req.ProofFileId)) {
      problems.push('Attach the payment advice or bank statement for this transfer — ' +
        'the ESOP team verifies the UTR against it.');
    }


    // 4. the amount
    const due = Util.num(req.TaxAmount, 0);
    const paid = Util.num(payload.amount, 0) || due;
    if (paid + 1 < due) {
      problems.push('The amount paid (' + Util.inr(paid) + ') is short of the tax due (' +
        Util.inr(due) + '). Pay the balance before submitting.');
    }


    if (problems.length) {
      throw new Error((problems.length === 1 ? '' : problems.length + ' things to fix:\n\n') +
        problems.map(p => '• ' + p).join('\n'));
    }


    // Only now does anything change. The demat account first, because the
    // payment step checks it is there.
    saveDemat(session, payload);
    return savePayment(session, Object.assign({}, payload, { finalise: true, amount: paid }));
  }


  /**
   * The partner turns the request down.
   *
   * A partner is a lender, and lenders refuse: the shares may not suit them,
   * the participant may not pass their checks, the account may not open in
   * time. Without this the only options were to leave the request open for
   * ever or to enter a payment they were not making.
   *
   * What it does is give the participant their position back, untouched:
   * the tax route is cleared, and if the partner had already entered a demat
   * account on their behalf, the participant's own is restored. Everything
   * the participant did — options, exercise payment, notice — stands.
   */
  function decline(session, payload) {
    assertPartner(session);
    const req = requireRequest(session, payload.requestId);
    if ([PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK].indexOf(Util.trim(req.Status)) < 0) {
      throw new Error('This request is ' + Util.trim(req.Status).toLowerCase() + ' and can no longer be declined.');
    }
    const reason = Util.trim(payload.reason);
    if (reason.length < 5) {
      throw new Error('Give the participant a reason — they are shown it, and it is what they act on.');
    }


    const app = AppStore.require(req.AppID);
    const partner = Util.trim(session.fundPartnerName);
    const stamp = Util.stamp();


    // If the partner had already put their own account on the application,
    // hand the participant's back.
    const appPatch = {
      TaxMode: '', FundPartnerName: '',
      ReviewTaxPayment: REVIEW.PENDING, UpdatedAt: stamp
    };
    if (Util.trim(app.DematSource)) {
      appPatch.DematSource = '';
      appPatch.DematDPName = Util.trim(req.EmployeeDPName);
      appPatch.DematDPId = Util.trim(req.EmployeeDPId);
      appPatch.DematClientId = Util.trim(req.EmployeeClientId);
      appPatch.DematAccountType = Util.trim(req.EmployeeAccountType);
      appPatch.DematAccountName = Util.trim(req.EmployeeAccountName);
      appPatch.CMLFileId = Util.trim(req.EmployeeCMLFileId);
      appPatch.ReviewDemat = REVIEW.PENDING;
    }
    Repo.update(T.APPLICATIONS, app._row, appPatch);


    // A request sent back after a payment was entered leaves a mirrored
    // remittance behind; it was never the participant's, so it goes.
    AppStore.taxPaymentsOf(app.AppID)
      .filter(r => Util.trim(r.PaidBy) === TAX_MODE.PARTNER)
      .sort((a, b) => b._row - a._row)
      .forEach(r => Repo.deleteRow(T.TAX_PAYMENTS, r._row));
    AppStore.refreshTaxTotals(AppStore.require(app.AppID));


    Repo.update(T.PARTNER_REQUESTS, req._row, {
      Status: PARTNER_STATUS.DECLINED,
      Remarks: 'Declined by ' + session.userId + ' on ' + stamp + ': ' + reason
    });


    audit(session.userId, session.role, 'PARTNER_DECLINED', Util.trim(app.AppID), partner + ' — ' + reason);


    const emp = Domain.employee(app.EmployeeID);
    const user = Auth.findUser(Util.trim(app.EmployeeID));
    const data = {
      name: Util.trim(emp.Name), appId: Util.trim(app.AppID), partner: partner, reason: reason,
      taxAmount: Util.num(req.TaxAmount, 0), taxDueDate: Util.prettyDate(app.TaxDueDate),
      employeeName: Util.trim(emp.Name), employeeId: Util.trim(emp.EmployeeID)
    };
    Mailer.send('partner_declined_employee', user ? Auth.notificationEmailFor(user) : Domain.emailFor(emp), data);
    Mailer.sendToAdmins('partner_declined_admin', data);


    return {
      ok: true,
      message: 'Declined. The participant has been told why and can choose another route.',
      dashboard: dashboard(session)
    };
  }


  return {
    dashboard: dashboard,
    savePayment: savePayment,
    saveDemat: saveDemat,
    submitAll: submitAll,
    decline: decline
  };
})();


