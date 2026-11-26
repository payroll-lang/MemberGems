/**
 * AdminApi.gs — the ESOP team's side: verification queue, section-by-section
 * review with documents, and the masters (grant report, share price, windows,
 * participants, logins).
 */


const AdminApi = (function () {


  function assertAdmin(session) {
    if (session.role !== ROLE.ADMIN) throw new Error('This screen is for the ESOP team.');
  }


  /* ================= queue ================= */


  function queue(session, filters) {
    assertAdmin(session);
    const f = filters || {};
    const wantWindow = Util.trim(f.windowId);
    const wantStatus = Util.trim(f.status);
    const search = Util.trim(f.search).toLowerCase();


    const employees = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { employees[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    // Partner requests indexed once, not looked up per row: the queue runs
    // over every application. Without this the ESOP team cannot see that a
    // partner has already paid and the file is waiting on the participant.
    const partnerReq = {};
    Repo.objects(T.PARTNER_REQUESTS).forEach(function (r) {
      partnerReq[Util.trim(r.AppID)] = r;
    });


    let rows = Repo.objects(T.APPLICATIONS).map(function (a) {
      const emp = employees[Util.trim(a.EmployeeID).toUpperCase()] || {};
      const prog = AppStore.progress(a);
      const pr = partnerReq[Util.trim(a.AppID)];
      const reviews = [a.ReviewOptions, a.ReviewDemat, a.ReviewExercisePayment, a.ReviewTaxPayment, a.ReviewNotice]
        .map(v => Util.trim(v) || REVIEW.PENDING);
      return {
        appId: Util.trim(a.AppID),
        windowId: Util.windowKey(a.WindowID),
        employeeId: Util.trim(a.EmployeeID),
        employeeName: Util.trim(emp.Name),
        employmentStatus: Util.trim(emp.EmploymentStatus) || 'Active',
        status: Util.trim(a.Status),
        stage: prog.stage,
        pendingLabels: prog.pendingLabels,
        totalOptions: Util.num(a.TotalOptions, 0),
        totalShares: Util.num(a.TotalShares, 0),
        exerciseAmount: Util.num(a.ExerciseAmount, 0),
        perquisiteAmount: Util.num(a.PerquisiteAmount, 0),
        taxAmount: Util.num(a.TaxAmount, 0),
        taxRatePercent: Util.num(a.TaxRatePercent, 0),
        taxMode: Util.trim(a.TaxMode),
        fundPartnerName: Util.trim(a.FundPartnerName),
        fmvValue: Util.num(a.FMVValue, 0),
        fmvDate: Util.dateKey(a.FMVDate),
        taxDueDate: Util.dateKey(a.TaxDueDate),
        submittedAt: Util.prettyStamp(a.SubmittedAt),
        updatedAt: Util.prettyStamp(a.UpdatedAt),
        // The sort key stays a number — the displayed strings above cannot
        // be ordered as text.
        updatedMs: Util.timeMs(a.UpdatedAt),
        verifiedSections: reviews.filter(v => v === REVIEW.OK).length,
        sentBackSections: reviews.filter(v => v === REVIEW.BACK).length,
        partnerStatus: pr ? Util.trim(pr.Status) : '',
        // The partner has done their part but the participant has not
        // submitted. Nothing is expected of the ESOP team yet, and that is
        // exactly what needs saying — otherwise the file looks stuck.
        awaitingParticipant: !!pr && Util.trim(pr.Status) === PARTNER_STATUS.PAID &&
          [STATUS.DRAFT, STATUS.SENT_BACK].indexOf(Util.trim(a.Status)) >= 0,
        docsPresent: [a.CMLFileId, a.PANFileId, a.ExerciseProofFileId, a.TaxProofFileId, a.NoticeFileId]
          .filter(x => Util.trim(x)).length
      };
    });


    if (wantWindow) rows = rows.filter(r => r.windowId === wantWindow);
    if (wantStatus) rows = rows.filter(r => r.status === wantStatus);
    if (search) {
      rows = rows.filter(r =>
        r.employeeId.toLowerCase().indexOf(search) >= 0 ||
        r.employeeName.toLowerCase().indexOf(search) >= 0 ||
        r.appId.toLowerCase().indexOf(search) >= 0);
    }


    const rank = {};
    rank[STATUS.SUBMITTED] = 0;
    rank[STATUS.UNDER_REVIEW] = 1;
    rank[STATUS.SENT_BACK] = 2;
    rank[STATUS.DRAFT] = 3;
    rank[STATUS.APPROVED] = 4;
    rank[STATUS.REJECTED] = 5;
    rows.sort(function (a, b) {
      const d = (rank[a.status] === undefined ? 9 : rank[a.status]) -
        (rank[b.status] === undefined ? 9 : rank[b.status]);
      return d !== 0 ? d : (b.updatedMs || 0) - (a.updatedMs || 0);
    });


    const windows = Repo.objects(T.WINDOWS)
      .sort((a, b) => String(b.WindowID).localeCompare(String(a.WindowID)))
      .map(w => ({
        windowId: Util.windowKey(w.WindowID), label: Util.monthLabel(w.Label),
        openDate: Util.dateKey(w.OpenDate), closeDate: Util.dateKey(w.CloseDate),
        taxDueDate: Util.dateKey(w.TaxDueDate), status: Util.trim(w.Status)
      }));


    const counts = {};
    Object.keys(STATUS).forEach(k => { counts[STATUS[k]] = 0; });
    Repo.objects(T.APPLICATIONS).forEach(a => {
      const s = Util.trim(a.Status);
      counts[s] = (counts[s] || 0) + 1;
    });


    const currentWin = Domain.currentWindow();
    const winState = Domain.windowState(currentWin);


    // Health of the masters, so problems are visible without hunting.
    const grantRows = Repo.objects(T.GRANTS);
    const sheetCovered = Tax.covered();
    const noRate = Repo.objects(T.EMPLOYEES).filter(function (e) {
      if (!Util.num(e.TaxRatePercent, 0) && !sheetCovered[Util.trim(e.EmployeeID).toUpperCase()]) {
        return grantRows.some(g => Util.trim(g.EmployeeID).toUpperCase() === Util.trim(e.EmployeeID).toUpperCase() &&
          Util.num(g.VestedOptions, 0) > 0);
      }
      return false;
    }).length;


    return {
      rows: rows,
      windows: windows,
      counts: counts,
      statuses: [STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.SENT_BACK, STATUS.DRAFT, STATUS.APPROVED, STATUS.REJECTED],
      currentWindow: {
        windowId: Util.windowKey(currentWin.WindowID),
        label: Util.monthLabel(currentWin.Label),
        prettyOpenDate: Util.prettyDate(currentWin.OpenDate),
        prettyCloseDate: Util.prettyDate(currentWin.CloseDate),
        prettyTaxDueDate: Util.prettyDate(currentWin.TaxDueDate),
        status: Util.trim(currentWin.Status),
        isOpen: winState.open,
        reason: winState.reason
      },
      latestFmv: Domain.latestFmv(),
      health: {
        grantRows: grantRows.length,
        reportAsOn: grantRows.length ? Util.dateKey(grantRows[0].ReportAsOn) : '',
        lastSyncedAt: grantRows.length ? Util.trim(grantRows[0].LastSyncedAt) : '',
        participantsWithoutTaxRate: noRate,
        lotSize: Domain.lotSize(),
        lotScope: Domain.lotScope(),
        // Test mode is silent by nature, so the screen has to say it out
        // loud: nothing is worse than a live window where no participant is
        // ever told anything because a switch was left off.
        emailsOff: !cfgBool('EMAILS_ENABLED'),
        bulkEmailsOff: !bulkEmailsAllowed(),
        enabledCount: Domain.enabledIds().length
      },
      totals: {
        options: rows.reduce((a, r) => a + r.totalOptions, 0),
        shares: rows.reduce((a, r) => a + r.totalShares, 0),
        exerciseAmount: rows.reduce((a, r) => a + r.exerciseAmount, 0),
        perquisite: rows.reduce((a, r) => a + r.perquisiteAmount, 0),
        tax: rows.reduce((a, r) => a + r.taxAmount, 0)
      }
    };
  }


  /* ================= one application, in full ================= */


  function detail(session, appId) {
    assertAdmin(session);
    const app = AppStore.require(appId);
    const view = AppStore.view(app, { includeEmployee: true });


    if (Util.trim(app.Status) === STATUS.SUBMITTED) {
      Repo.update(T.APPLICATIONS, app._row, {
        Status: STATUS.UNDER_REVIEW, ReviewedBy: session.userId, UpdatedAt: Util.stamp()
      });
      view.status = STATUS.UNDER_REVIEW;
      audit(session.userId, session.role, 'REVIEW_OPENED', appId, '');
    }


    view.grants = Domain.grantsFor(Util.trim(app.EmployeeID), Util.trim(app.AppID));
    view.notice.html = (function () {
      try {
        const emp = Domain.employee(app.EmployeeID);
        const lines = AppStore.linesOf(appId);
        return lines.length ? Notice.bodyHtml(app, emp, lines) : '';
      } catch (e) { return ''; }
    })();
    view.trail = Repo.filter(T.AUDIT, r => Util.trim(r.AppID) === Util.trim(appId))
      .slice(-60).reverse()
      .map(r => ({
        at: Util.prettyStamp(r.Timestamp), actor: Util.trim(r.Actor),
        role: Util.trim(r.Role), action: Util.trim(r.Action), details: Util.trim(r.Details)
      }));
    return view;
  }


  function document(session, appId, fileId) {
    assertAdmin(session);
    const app = AppStore.require(appId);
    const allowed = [app.CMLFileId, app.PANFileId, app.ExerciseProofFileId,
      app.TaxProofFileId, app.NoticeFileId].map(x => Util.trim(x));
    const pr = AppStore.partnerRequestOf(appId);
    if (pr) allowed.push(Util.trim(pr.ProofFileId));
    // Each tax remittance carries its own proof.
    AppStore.taxPaymentsOf(appId).forEach(r => allowed.push(Util.trim(r.ProofFileId)));
    if (allowed.indexOf(Util.trim(fileId)) < 0) {
      throw new Error('That document does not belong to this application.');
    }
    audit(session.userId, session.role, 'DOC_VIEWED', appId, Util.trim(fileId));
    return Files.inline(fileId);
  }


  /* ================= section review ================= */


  /**
   * Which progress flag says a section has actually been filled in. The
   * review names differ from the progress names for two of them.
   */
  const SECTION_DONE = {
    options: 'options', demat: 'demat', exercisePayment: 'exercise',
    taxPayment: 'tax', notice: 'notice'
  };


  /**
   * Nothing is reviewable until the participant submits.
   *
   * An application in Draft or Sent Back is still in the participant's hands:
   * sections may be half-filled, files missing, figures about to change. The
   * review screen used to offer Verify on all of it — and Approve once every
   * section had been ticked — so an application could be approved that the
   * participant had never submitted.
   */
  function requireSubmitted(app) {
    const st = Util.trim(app.Status);
    if (st === STATUS.SUBMITTED || st === STATUS.UNDER_REVIEW) return;
    if (st === STATUS.APPROVED || st === STATUS.REJECTED) {
      throw new Error('This application is already ' + st.toLowerCase() + '.');
    }
    throw new Error(Util.trim(app.AppID) + ' is still with the participant (' + st.toLowerCase() +
      '). There is nothing to review until they submit it.');
  }


  const SECTION_FIELD = {
    options: 'ReviewOptions',
    demat: 'ReviewDemat',
    exercisePayment: 'ReviewExercisePayment',
    taxPayment: 'ReviewTaxPayment',
    notice: 'ReviewNotice'
  };
  const SECTION_LABEL = {
    options: 'Options to exercise',
    demat: 'Applicant, demat and PAN',
    exercisePayment: 'Exercise payment',
    taxPayment: 'Tax payment',
    notice: 'Exercise notice'
  };


  function reviewSection(session, appId, section, verdict, remarks) {
    assertAdmin(session);
    const field = SECTION_FIELD[Util.trim(section)];
    if (!field) throw new Error('Unknown section "' + section + '".');
    if ([REVIEW.OK, REVIEW.BACK, REVIEW.PENDING].indexOf(Util.trim(verdict)) < 0) {
      throw new Error('Unknown verdict "' + verdict + '".');
    }
    const app = AppStore.require(appId);
    requireSubmitted(app);
    // Verifying or sending back a section nobody has filled in is a decision
    // about nothing. (Putting one back to Pending is always fine.)
    if (Util.trim(verdict) !== REVIEW.PENDING && !AppStore.progress(app).done[SECTION_DONE[section]]) {
      throw new Error(SECTION_LABEL[section] + ' has not been completed by the participant, so ' +
        'there is nothing to ' + (Util.trim(verdict) === REVIEW.OK ? 'verify' : 'send back') + '.');
    }


    const patch = { UpdatedAt: Util.stamp(), ReviewedBy: session.userId, ReviewedAt: Util.stamp() };
    patch[field] = Util.trim(verdict);
    if (Util.trim(remarks)) {
      patch.AdminRemarks = appendRemark(app.AdminRemarks, session.userId,
        SECTION_LABEL[section] + ': ' + Util.trim(remarks));
    }
    Repo.update(T.APPLICATIONS, app._row, patch);


    // A fund partner's payment goes back to the partner, not the participant.
    if (section === 'taxPayment' && Util.trim(app.TaxMode) === TAX_MODE.PARTNER) {
      const pr = AppStore.partnerRequestOf(appId);
      if (pr && Util.trim(verdict) === REVIEW.BACK) {
        Repo.update(T.PARTNER_REQUESTS, pr._row, {
          Status: PARTNER_STATUS.SENT_BACK,
          Remarks: Util.trim(remarks) || 'Sent back by the ESOP team for correction'
        });
      }
      if (pr && Util.trim(verdict) === REVIEW.OK) {
        Repo.update(T.PARTNER_REQUESTS, pr._row, { Status: PARTNER_STATUS.VERIFIED });
      }
    }


    audit(session.userId, session.role,
      'SECTION_' + Util.trim(verdict).toUpperCase().replace(/\s+/g, '_'),
      appId, section + (Util.trim(remarks) ? ' — ' + Util.trim(remarks) : ''));


    return {
      ok: true,
      message: SECTION_LABEL[section] + ' marked ' + Util.trim(verdict).toLowerCase() + '.',
      detail: detail(session, appId)
    };
  }


  /**
   * Verify several sections in one go.
   *
   * Five sections meant five round trips at roughly a second each, for a file
   * the reviewer had already read in full. This writes them together: one
   * call, one row update, one audit line naming every section.
   *
   * Pass the sections to act on, or 'all' for every section not already
   * verified. Deliberately verify-only — sending back needs its own remarks
   * per section and is not a thing to do in bulk.
   */
  function reviewMany(session, payload) {
    assertAdmin(session);
    const appId = Util.trim(payload.appId);
    const app = AppStore.require(appId);
    requireSubmitted(app);
    const doneMap = AppStore.progress(app).done;


    const wanted = payload.all
      ? Object.keys(SECTION_FIELD)
      : (payload.sections || []).map(x => Util.trim(x)).filter(Boolean);


    const unknown = wanted.filter(k => !SECTION_FIELD[k]);
    if (unknown.length) throw new Error('Unknown section "' + unknown[0] + '".');


    // Anything already verified is left alone rather than rewritten, so the
    // audit trail says what actually changed.
    const empty = wanted.filter(k => !doneMap[SECTION_DONE[k]]);
    if (empty.length && !payload.all) {
      throw new Error('Not completed by the participant, so nothing to verify: ' +
        empty.map(k => SECTION_LABEL[k]).join(', ') + '.');
    }
    const todo = wanted.filter(k => doneMap[SECTION_DONE[k]] &&
      Util.trim(app[SECTION_FIELD[k]]) !== REVIEW.OK);
    if (!todo.length) {
      throw new Error(wanted.length
        ? 'Those sections are already verified.'
        : 'Choose at least one section to verify.');
    }


    const at = Util.stamp();
    const patch = { UpdatedAt: at, ReviewedBy: session.userId, ReviewedAt: at };
    todo.forEach(function (k) { patch[SECTION_FIELD[k]] = REVIEW.OK; });
    if (Util.trim(payload.remarks)) {
      patch.AdminRemarks = appendRemark(app.AdminRemarks, session.userId, Util.trim(payload.remarks));
    }
    Repo.update(T.APPLICATIONS, app._row, patch);


    // A verified tax payment releases the fund partner's request, exactly as
    // verifying that section on its own does.
    if (todo.indexOf('taxPayment') >= 0 && Util.trim(app.TaxMode) === TAX_MODE.PARTNER) {
      const pr = AppStore.partnerRequestOf(appId);
      if (pr) Repo.update(T.PARTNER_REQUESTS, pr._row, { Status: PARTNER_STATUS.VERIFIED });
    }


    audit(session.userId, session.role, 'SECTIONS_VERIFIED', appId,
      todo.map(k => SECTION_LABEL[k]).join(', '));


    const fresh = AppStore.require(appId);
    const left = Object.keys(SECTION_FIELD)
      .filter(k => Util.trim(fresh[SECTION_FIELD[k]]) !== REVIEW.OK);


    return {
      ok: true,
      message: todo.length + ' section' + (todo.length === 1 ? '' : 's') + ' verified' +
        (left.length
          ? '. Still to verify: ' + left.map(k => SECTION_LABEL[k]).join(', ') + '.'
          : '. Every section is verified — the application can be approved.'),
      detail: detail(session, appId)
    };
  }


  /**
   * Approve. Every section must be verified first.
   *
   * Note what this does NOT do: it does not write back to the Grants tab. The
   * vesting report is authoritative for vested balances, and stamping
   * ApprovedAt is enough — Domain.grantsFor keeps deducting an approved
   * application's options until a report dated after the approval arrives.
   * That way a re-sync can never double-count or silently restore options.
   */
  function approve(session, appId, remarks) {
    assertAdmin(session);
    const app = AppStore.require(appId);
    if (Util.trim(app.Status) === STATUS.APPROVED) throw new Error('This application is already approved.');
    // Every section ticked is not the same as submitted: the participant may
    // still be editing, and the notice may never have been put in front of the
    // ESOP team by them. Approval answers a submission, so there has to be one.
    requireSubmitted(app);


    const unverified = Object.keys(SECTION_FIELD)
      .filter(k => Util.trim(app[SECTION_FIELD[k]]) !== REVIEW.OK);
    if (unverified.length) {
      throw new Error('Verify every section before approving. Still unverified: ' +
        unverified.map(k => SECTION_LABEL[k]).join(', ') + '.');
    }
    const prog = AppStore.progress(app);
    if (!prog.complete) {
      throw new Error('The application is not complete: ' + prog.pendingLabels.join(', ') + '.');
    }


    const at = Util.stamp();
    const patch = {
      Status: STATUS.APPROVED, ReviewedBy: session.userId,
      ReviewedAt: at, ApprovedAt: at, UpdatedAt: at
    };
    if (Util.trim(remarks)) patch.AdminRemarks = appendRemark(app.AdminRemarks, session.userId, Util.trim(remarks));
    Repo.update(T.APPLICATIONS, app._row, patch);


    const emp = Domain.employee(app.EmployeeID);
    const fresh = AppStore.require(appId);
    audit(session.userId, session.role, 'APP_APPROVED', appId,
      Util.num(fresh.TotalOptions, 0) + ' options / ' + Util.num(fresh.TotalShares, 0) + ' shares');


    Mailer.send('application_approved', employeeEmail(app.EmployeeID, emp), {
      name: Util.trim(emp.Name),
      appId: appId,
      totalOptions: Util.num(fresh.TotalOptions, 0),
      totalShares: Util.num(fresh.TotalShares, 0),
      exerciseAmount: Util.num(fresh.ExerciseAmount, 0),
      perquisite: Util.num(fresh.PerquisiteAmount, 0),
      tax: Util.num(fresh.TaxAmount, 0),
      dpId: Util.trim(fresh.DematDPId),
      clientId: Util.trim(fresh.DematClientId),
      remarks: Util.trim(remarks)
    }, Util.trim(fresh.NoticeFileId) ? { attachFileIds: [Util.trim(fresh.NoticeFileId)] } : {});


    return {
      ok: true,
      message: 'Approved. ' + Util.count(fresh.TotalOptions) + ' options → ' +
        Util.count(fresh.TotalShares) + ' shares for allotment.',
      detail: detail(session, appId)
    };
  }


  function sendBack(session, appId, remarks) {
    assertAdmin(session);
    const app = AppStore.require(appId);
    if (!Util.trim(remarks)) throw new Error('Say what needs correcting — the participant sees these remarks.');


    const at = Util.stamp();
    Repo.update(T.APPLICATIONS, app._row, {
      Status: STATUS.SENT_BACK,
      AdminRemarks: appendRemark(app.AdminRemarks, session.userId, Util.trim(remarks)),
      ReviewedBy: session.userId, ReviewedAt: at, UpdatedAt: at
    });


    const sections = Object.keys(SECTION_FIELD)
      .filter(k => Util.trim(app[SECTION_FIELD[k]]) === REVIEW.BACK)
      .map(k => SECTION_LABEL[k]);


    const emp = Domain.employee(app.EmployeeID);
    audit(session.userId, session.role, 'APP_SENT_BACK', appId, Util.trim(remarks));
    Mailer.send('application_sent_back', employeeEmail(app.EmployeeID, emp), {
      name: Util.trim(emp.Name), appId: appId, sections: sections, remarks: Util.trim(remarks)
    });


    return {
      ok: true,
      message: 'Sent back to ' + Util.trim(emp.Name) + ' with your remarks.',
      detail: detail(session, appId)
    };
  }


  function reject(session, appId, remarks) {
    assertAdmin(session);
    const app = AppStore.require(appId);
    if (!Util.trim(remarks)) throw new Error('Record why the application is being closed.');
    if (Util.trim(app.Status) === STATUS.APPROVED) {
      throw new Error('An approved application cannot be rejected. Raise a reversal with the ESOP team instead.');
    }
    const at = Util.stamp();
    Repo.update(T.APPLICATIONS, app._row, {
      Status: STATUS.REJECTED,
      AdminRemarks: appendRemark(app.AdminRemarks, session.userId, Util.trim(remarks)),
      ReviewedBy: session.userId, ReviewedAt: at, UpdatedAt: at
    });
    const pr = AppStore.partnerRequestOf(appId);
    if (pr && [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.PAID].indexOf(Util.trim(pr.Status)) >= 0) {
      Repo.update(T.PARTNER_REQUESTS, pr._row, {
        Status: 'Withdrawn', Remarks: 'Application closed: ' + Util.trim(remarks)
      });
    }


    const emp = Domain.employee(app.EmployeeID);
    audit(session.userId, session.role, 'APP_REJECTED', appId, Util.trim(remarks));
    Mailer.send('application_rejected', employeeEmail(app.EmployeeID, emp), {
      name: Util.trim(emp.Name), appId: appId, remarks: Util.trim(remarks)
    });


    return { ok: true, message: 'Application closed and options released.', detail: detail(session, appId) };
  }


  function employeeEmail(employeeId, emp) {
    const user = Auth.findUser(Util.trim(employeeId));
    return user ? Auth.notificationEmailFor(user) : Domain.emailFor(emp);
  }


  function appendRemark(existing, actor, text) {
    const line = '[' + Util.stamp() + ' · ' + actor + '] ' + text;
    const prev = Util.trim(existing);
    return prev ? prev + '\n' + line : line;
  }


  /* ================= masters: the vesting report ================= */


  function syncGrants(session, options) {
    assertAdmin(session);
    return GrantSync.run(options || {}, session.userId);
  }


  /** Load PAN, mobile, address and demat details from the details tab. */
  function syncDetails(session) {
    assertAdmin(session);
    return GrantSync.syncDetails(session.userId);
  }


  /* ================= masters: participants ================= */


  function employees(session, filters) {
    assertAdmin(session);
    const f = filters || {};
    const q = Util.trim(f.search).toLowerCase();


    const users = {};
    Repo.filter(T.USERS, u => Util.trim(u.Role) === ROLE.EMPLOYEE)
      .forEach(u => { users[Util.trim(u.UserID).toUpperCase()] = u; });


    const totals = {};
    Repo.objects(T.GRANTS).forEach(function (g) {
      const k = Util.trim(g.EmployeeID).toUpperCase();
      if (!totals[k]) totals[k] = { grants: 0, vested: 0, unvested: 0, exercisable: 0, shares: 0, plans: {} };
      const t = totals[k];
      const mult = Util.num(g.Multiplier, 1) || 1;
      const step = Domain.stepFor(mult);
      const ex = Math.floor((Util.num(g.VestedOptions, 0) + 1e-9) / step) * step;
      t.grants++;
      t.vested += Util.num(g.VestedOptions, 0);
      t.unvested += Util.num(g.UnvestedOptions, 0);
      t.exercisable += ex;
      t.shares += ex * mult;
      t.plans[Util.trim(g.PlanName)] = mult;
    });


    const covered = Tax.covered();
    let rows = Repo.objects(T.EMPLOYEES).map(function (e) {
      const k = Util.trim(e.EmployeeID).toUpperCase();
      const u = users[k];
      const t = totals[k] || { grants: 0, vested: 0, unvested: 0, exercisable: 0, shares: 0, plans: {} };
      return {
        employeeId: Util.trim(e.EmployeeID),
        name: Util.trim(e.Name),
        designation: Util.trim(e.Designation),
        email: Domain.emailFor(e),
        accessEmail: Util.trim(e.AccessEmail),
        emailOverride: Util.trim(e.EmailOverride),
        mobile: Util.trim(e.Mobile),
        address: Util.trim(e.Address),
        nationality: Util.trim(e.Nationality),
        pan: Util.trim(e.PAN),
        dematDPName: Util.trim(e.DematDPName),
        dematDPId: Util.trim(e.DematDPId),
        dematClientId: Util.trim(e.DematClientId),
        dematAccountName: Util.trim(e.DematAccountName),
        dematAccountType: Util.trim(e.DematAccountType),
        hasDemat: !!(Util.trim(e.DematDPId) && Util.trim(e.DematClientId)),
        employmentStatus: Util.trim(e.EmploymentStatus) || 'Active',
        separationDate: Util.dateKey(e.SeparationDate),
        blocked: Domain.isBlocked(e),
        blockedReason: Util.trim(e.BlockedReason),
        blockedBy: Util.trim(e.BlockedBy),
        ctc: Util.num(e.CTC, 0),
        taxRatePercent: Util.num(e.TaxRatePercent, 0),
        // How this person's tax will be worked out: from payroll's sheet, from
        // a flat percentage, or not at all yet.
        taxBasis: covered[k] ? 'sheet' : (Util.num(e.TaxRatePercent, 0) ? 'flat' : 'none'),
        grants: t.grants,
        vested: Math.round(t.vested * 1e6) / 1e6,
        unvested: Math.round(t.unvested * 1e6) / 1e6,
        exercisable: Math.round(t.exercisable * 1e6) / 1e6,
        shares: Math.round(t.shares),
        plans: Object.keys(t.plans).map(p => p + ' ×' + t.plans[p]).join(', '),
        hasLogin: !!u,
        loginStatus: u ? Util.trim(u.Status) : '',
        lastLoginAt: u ? Util.trim(u.LastLoginAt) : '',
        folderId: Util.trim(e.DriveFolderId)
      };
    });


    if (q) {
      rows = rows.filter(r => r.employeeId.toLowerCase().indexOf(q) >= 0 ||
        r.name.toLowerCase().indexOf(q) >= 0 ||
        r.email.toLowerCase().indexOf(q) >= 0);
    }
    if (Util.trim(f.only) === 'exercisable') rows = rows.filter(r => r.exercisable > 0);
    if (Util.trim(f.only) === 'noTaxRate') rows = rows.filter(r => r.exercisable > 0 && r.taxBasis === 'none');
    if (Util.trim(f.only) === 'noLogin') rows = rows.filter(r => r.exercisable > 0 && !r.hasLogin);
    if (Util.trim(f.only) === 'blocked') rows = rows.filter(r => r.blocked);
    if (Util.trim(f.only) === 'prefilled') rows = rows.filter(r => r.hasDemat || r.pan);
    if (Util.trim(f.only) === 'noDetails') {
      rows = rows.filter(r => r.exercisable > 0 && !r.hasDemat && !r.pan);
    }


    rows.sort((a, b) => b.exercisable - a.exercisable || a.name.localeCompare(b.name));


    const all = rows;
    return {
      rows: rows.slice(0, Util.num(f.limit, 300)),
      shown: Math.min(rows.length, Util.num(f.limit, 300)),
      matched: all.length,
      summary: {
        participants: Repo.objects(T.EMPLOYEES).length,
        withExercisable: all.filter(r => r.exercisable > 0).length,
        withoutTaxRate: all.filter(r => r.exercisable > 0 && r.taxBasis === 'none').length,
        onTaxSheet: all.filter(r => r.taxBasis === 'sheet').length,
        withoutLogin: all.filter(r => r.exercisable > 0 && !r.hasLogin).length,
        withoutEmail: all.filter(r => r.exercisable > 0 && !r.email).length,
        blocked: all.filter(r => r.blocked).length,
        withDemat: all.filter(r => r.hasDemat).length,
        withPan: all.filter(r => r.pan).length
      },
      // The enabled list, so the screen can show what it is rather than make
      // the admin remember. Empty array = open to everyone.
      enabledIds: Domain.enabledIds(),
      taxSheet: Tax.status(),
      fundPartners: Partners.activeNames()
    };
  }


  function saveEmployee(session, payload) {
    assertAdmin(session);
    const id = Util.trim(payload.employeeId).toUpperCase();
    if (!id) throw new Error('An employee ID is required.');


    const rate = Util.num(payload.taxRatePercent, NaN);
    if (payload.taxRatePercent !== undefined && payload.taxRatePercent !== '' &&
        (isNaN(rate) || rate < 0 || rate > 60)) {
      throw new Error('The tax rate must be a percentage between 0 and 60.');
    }
    if (Util.trim(payload.pan)) Domain.validatePan(payload.pan);


    const patch = { UpdatedAt: Util.stamp() };
    const map = {
      name: 'Name', designation: 'Designation', emailOverride: 'EmailOverride',
      mobile: 'Mobile', address: 'Address', nationality: 'Nationality',
      employmentStatus: 'EmploymentStatus', pan: 'PAN', remarks: 'Remarks',
      dematDPName: 'DematDPName', dematDPId: 'DematDPId',
      dematClientId: 'DematClientId', dematAccountName: 'DematAccountName',
      dematAccountType: 'DematAccountType'
    };
    Object.keys(map).forEach(function (k) {
      if (payload[k] !== undefined) patch[map[k]] = Util.trim(payload[k]);
    });
    if (patch.PAN) patch.PAN = patch.PAN.toUpperCase();
    if (payload.separationDate !== undefined) patch.SeparationDate = Util.dateKey(payload.separationDate);
    if (payload.ctc !== undefined && payload.ctc !== '') patch.CTC = Util.num(payload.ctc, 0);
    if (payload.taxRatePercent !== undefined && payload.taxRatePercent !== '') patch.TaxRatePercent = rate;


    const existing = Repo.find(T.EMPLOYEES, e => Util.trim(e.EmployeeID).toUpperCase() === id);
    if (existing) {
      Repo.update(T.EMPLOYEES, existing._row, patch);
    } else {
      patch.EmployeeID = id;
      if (!patch.EmploymentStatus) patch.EmploymentStatus = 'Active';
      if (!patch.Nationality) patch.Nationality = 'Indian';
      Repo.append(T.EMPLOYEES, patch);
    }


    if (patch.TaxRatePercent !== undefined) repriceFor(session, id, patch.TaxRatePercent);


    audit(session.userId, session.role, existing ? 'EMPLOYEE_UPDATED' : 'EMPLOYEE_CREATED', '', id);
    return { ok: true, message: 'Saved ' + id + '.' };
  }


  /**
   * What the tax-sheet loader needs before it starts: the participants' IDs,
   * so the browser can keep only those rows and send nothing else, and what
   * is loaded now.
   */
  function taxSheetInfo(session) {
    assertAdmin(session);
    return {
      status: Tax.status(),
      ids: Repo.objects(T.EMPLOYEES).map(e => Util.trim(e.EmployeeID).toUpperCase()).filter(Boolean)
    };
  }


  function taxSheetReport(session) {
    assertAdmin(session);
    return Tax.report();
  }


  function loadTaxSheet(session, payload) {
    assertAdmin(session);
    return Tax.load(session, payload || {});
  }


  function repriceFor(session, employeeId, rate) {
    const affected = Repo.filter(T.APPLICATIONS, a =>
      Util.trim(a.EmployeeID).toUpperCase() === employeeId &&
      [STATUS.APPROVED, STATUS.REJECTED].indexOf(Util.trim(a.Status)) < 0);
    affected.forEach(function (a) {
      Repo.update(T.APPLICATIONS, a._row, { TaxRatePercent: rate });
      AppStore.reprice(AppStore.require(a.AppID));
    });
    if (affected.length) {
      audit(session.userId, session.role, 'TAX_RATE_REPRICED', '',
        employeeId + ' → ' + rate + '% across ' + affected.length + ' open application(s)');
    }
    return affected.length;
  }


  /**
   * Bulk load CTC and the tax percentage: [employeeId, ctc, rate] per row.
   * This is how "CTC and perquisite tax percentage uploaded in the portal"
   * happens each cycle without editing rows one at a time.
   */
  function bulkTaxRates(session, rows) {
    assertAdmin(session);
    const res = { updated: 0, repriced: 0, skipped: [] };
    (rows || []).forEach(function (r) {
      const id = Util.trim(r.employeeId).toUpperCase();
      if (!id) return;
      const emp = Repo.find(T.EMPLOYEES, e => Util.trim(e.EmployeeID).toUpperCase() === id);
      if (!emp) { res.skipped.push(id + ' — no participant record'); return; }
      const rate = Util.num(r.taxRatePercent, NaN);
      if (isNaN(rate) || rate < 0 || rate > 60) {
        res.skipped.push(id + ' — rate "' + r.taxRatePercent + '" is not a percentage between 0 and 60');
        return;
      }
      const patch = { TaxRatePercent: rate, UpdatedAt: Util.stamp() };
      if (r.ctc !== undefined && r.ctc !== '') patch.CTC = Util.num(r.ctc, 0);
      Repo.update(T.EMPLOYEES, emp._row, patch);
      res.updated++;
      res.repriced += repriceFor(session, id, rate);
    });
    audit(session.userId, session.role, 'BULK_TAX_RATES', '',
      res.updated + ' updated, ' + res.repriced + ' applications repriced');
    return Object.assign({ ok: true, message: res.updated + ' participant record(s) updated.' }, res);
  }


  /**
   * Block or unblock one participant. Their record, grants and history are
   * untouched; they simply cannot start or edit an application while blocked.
   * A report sync never changes this.
   */
  function setBlocked(session, payload) {
    assertAdmin(session);
    const id = Util.trim(payload.employeeId).toUpperCase();
    const emp = Repo.find(T.EMPLOYEES, e => Util.trim(e.EmployeeID).toUpperCase() === id);
    if (!emp) throw new Error('No participant record for ' + id + '.');


    const block = payload.blocked === true || String(payload.blocked).toLowerCase() === 'true';
    if (block && !Util.trim(payload.reason)) {
      throw new Error('Record why this participant is being blocked - they are shown the reason.');
    }


    Repo.update(T.EMPLOYEES, emp._row, {
      Blocked: block,
      BlockedReason: block ? Util.trim(payload.reason) : '',
      BlockedAt: block ? Util.stamp() : '',
      BlockedBy: block ? session.userId : '',
      UpdatedAt: Util.stamp()
    });
    audit(session.userId, session.role, block ? 'PARTICIPANT_BLOCKED' : 'PARTICIPANT_UNBLOCKED',
      '', id + (block ? ' - ' + Util.trim(payload.reason) : ''));


    return {
      ok: true,
      message: id + (block ? ' is blocked from exercising.' : ' can exercise again.')
    };
  }


  /**
   * Replace the enabled list — who may use the portal at all.
   *
   * An empty list means everyone on the vesting report, which is the state to
   * be in once the scheme is open. A list is for a controlled start: the
   * people on it can sign in and exercise, nobody else can, and no login or
   * invitation is created for anybody else either.
   *
   * IDs that match no participant are reported rather than silently kept, so
   * a typo does not quietly shut someone out.
   */
  function setEnabledList(session, payload) {
    assertAdmin(session);
    const ids = Util.trim(payload.employeeIds === undefined ? payload.text : payload.employeeIds);
    const list = String(ids || '').split(/[\s,;]+/)
      .map(x => Util.trim(x).toUpperCase()).filter(Boolean);


    const known = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { known[Util.trim(e.EmployeeID).toUpperCase()] = true; });


    const seen = {}, kept = [], unknown = [];
    list.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      kept.push(id);
      if (!known[id]) unknown.push(id);
    });


    Files.setConfigValue('ELIGIBLE_EMPLOYEE_IDS', kept.join(', '));
    audit(session.userId, session.role, 'ENABLED_LIST_SET', '',
      kept.length ? kept.length + ' participant(s) enabled' : 'list cleared — open to everyone');


    return {
      ok: true,
      message: kept.length
        ? kept.length + ' participant(s) can use the portal. Everyone else is held back.'
        : 'List cleared — the portal is open to every participant on the report.',
      count: kept.length,
      ids: kept,
      unknown: unknown
    };
  }


  /**
   * Block a pasted list of employee IDs in one go, with one shared reason.
   * Pass blocked:false to release a list instead.
   */
  function bulkBlock(session, payload) {
    assertAdmin(session);
    const block = payload.blocked !== false;
    const reason = Util.trim(payload.reason);
    if (block && !reason) throw new Error('Give a reason - every blocked participant is shown it.');


    const ids = (payload.employeeIds || []).map(x => Util.trim(x).toUpperCase()).filter(Boolean);
    if (!ids.length) throw new Error('Paste at least one employee ID.');


    const byId = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { byId[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    let changed = 0; const skipped = [];
    ids.forEach(function (id) {
      const emp = byId[id];
      if (!emp) { skipped.push(id + ' - no participant record'); return; }
      Repo.update(T.EMPLOYEES, emp._row, {
        Blocked: block,
        BlockedReason: block ? reason : '',
        BlockedAt: block ? Util.stamp() : '',
        BlockedBy: block ? session.userId : '',
        UpdatedAt: Util.stamp()
      });
      changed++;
    });


    audit(session.userId, session.role, block ? 'BULK_BLOCKED' : 'BULK_UNBLOCKED', '',
      changed + ' participant(s)' + (reason ? ' - ' + reason : ''));
    return {
      ok: true,
      message: changed + ' participant(s) ' + (block ? 'blocked' : 'released') + '.',
      changed: changed, skipped: skipped
    };
  }


  /**
   * Load details the ESOP team already holds, in bulk.
   *
   * For long-standing participants the PAN, address and demat account are
   * already on file, and making them retype it is friction for no gain. Paste
   * what you have; anything left blank in a row is left alone, so a partial
   * paste never wipes a field that was already populated.
   *
   * These are PREFILLS, not verifications. The participant still sees every
   * value, can correct it, and still has to attach a CML - and the ESOP team
   * still verifies the section. What this removes is the typing.
   */
  function bulkParticipantDetails(session, payload) {
    assertAdmin(session);
    const rows = payload.rows || [];
    if (!rows.length) throw new Error('Paste at least one row.');


    const byId = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { byId[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    const FIELDS = {
      pan: 'PAN',
      address: 'Address',
      mobile: 'Mobile',
      nationality: 'Nationality',
      dematDPName: 'DematDPName',
      dematDPId: 'DematDPId',
      dematClientId: 'DematClientId',
      dematAccountName: 'DematAccountName',
      dematAccountType: 'DematAccountType'
    };


    let updated = 0, unchanged = 0;
    const skipped = [], warnings = [];


    rows.forEach(function (r, i) {
      const id = Util.trim(r.employeeId).toUpperCase();
      if (!id) return;
      const emp = byId[id];
      if (!emp) { skipped.push(id + ' - no participant record'); return; }


      const patch = {};
      Object.keys(FIELDS).forEach(function (key) {
        let v = Util.trim(r[key]);
        if (!v) return;                    // blank means "leave as is"


        if (key === 'pan') {
          try {
            v = Domain.validatePan(v);
          } catch (e) {
            warnings.push('Row ' + (i + 1) + ' (' + id + '): ' + e.message + ' PAN not set.');
            return;
          }
        }
        if (key === 'mobile') {
          try {
            v = Domain.validateMobile(v);
          } catch (e) {
            warnings.push('Row ' + (i + 1) + ' (' + id + '): ' + e.message + ' Mobile not set.');
            return;
          }
        }
        if (key === 'dematDPId' || key === 'dematClientId') v = v.toUpperCase();
        if (key === 'dematAccountType') {
          v = v.toUpperCase();
          if (DEMAT_TYPES.indexOf(v) < 0) {
            warnings.push('Row ' + (i + 1) + ' (' + id + '): account type "' + v +
              '" is neither NSDL nor CDSL. Not set.');
            return;
          }
        }


        if (Util.trim(emp[FIELDS[key]]) !== v) patch[FIELDS[key]] = v;
      });


      // Only complain about the identifiers once both are present, since a
      // paste may legitimately carry one column and not the other.
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
          warnings.push('Row ' + (i + 1) + ' (' + id + '): ' + e.message +
            ' Stored anyway - the participant will be asked to confirm it.');
        }
      }


      if (!Object.keys(patch).length) { unchanged++; return; }
      patch.UpdatedAt = Util.stamp();
      Repo.update(T.EMPLOYEES, emp._row, patch);
      updated++;
    });


    audit(session.userId, session.role, 'BULK_DETAILS_PREFILLED', '',
      updated + ' updated, ' + unchanged + ' unchanged, ' + skipped.length + ' skipped');


    return {
      ok: true,
      message: updated + ' participant record(s) updated' +
        (unchanged ? ', ' + unchanged + ' already matched' : '') +
        (skipped.length ? ', ' + skipped.length + ' skipped' : '') + '.',
      updated: updated, unchanged: unchanged, skipped: skipped, warnings: warnings
    };
  }


  /* ================= masters: share price ================= */


  function fmvList(session, limit) {
    assertAdmin(session);
    return Repo.objects(T.FMV)
      .map(r => ({
        date: Util.dateKey(r.Date), prettyDate: Util.prettyDate(r.Date),
        open: Util.num(r.OpenPrice, 0), close: Util.num(r.ClosePrice, 0),
        fmv: Util.num(r.FMV, 0), source: Util.trim(r.Source),
        enteredBy: Util.trim(r.EnteredBy), enteredAt: Util.trim(r.EnteredAt)
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, limit || 60);
  }


  function saveFmv(session, payload) {
    assertAdmin(session);
    const res = Domain.upsertFmv(payload.date, payload.open, payload.close, payload.source, session.userId);


    // A corrected price must not leave stale tax figures behind.
    const affected = Repo.filter(T.APPLICATIONS, a =>
      Util.dateKey(a.FMVDate) === res.date &&
      [STATUS.APPROVED, STATUS.REJECTED].indexOf(Util.trim(a.Status)) < 0);
    affected.forEach(function (a) {
      Repo.update(T.APPLICATIONS, a._row, { FMVValue: res.fmv });
      AppStore.reprice(AppStore.require(a.AppID));
    });


    return {
      ok: true,
      message: 'FMV for ' + res.date + ' set to ' + Util.inr2(res.fmv) +
        (affected.length ? ' · ' + affected.length + ' application(s) repriced' : ''),
      fmv: res.fmv, list: fmvList(session)
    };
  }


  /** Pull one date's open/close from NSE, without saving. */
  function fetchFmv(session, date) {
    assertAdmin(session);
    return NsePrice.fetch(date);
  }


  /** Pull and save one date's price from NSE. */
  function loadFmvFromNse(session, date) {
    assertAdmin(session);
    // interactive: someone is watching, so answer fast and do not sit on a
    // request NSE may be silently blocking.
    const r = NsePrice.load(date, session.userId, null, { interactive: true });
    return {
      ok: true,
      message: 'Loaded ' + r.date + ' — open ' + Util.inr2(r.open) +
        ', close ' + Util.inr2(r.close) + ', FMV ' + Util.inr2(r.fmv) +
        ' (' + r.source + ').',
      fetched: r, list: fmvList(session)
    };
  }


  function backfillFmv(session, payload) {
    assertAdmin(session);
    const r = NsePrice.backfill(payload.from, payload.to, session.userId,
      { budgetMinutes: Util.num(payload.budgetMinutes, 20) });
    return {
      ok: true,
      message: r.loaded.length + ' day(s) loaded, ' + r.skipped.length + ' skipped, ' +
        r.failed.length + ' failed' +
        (r.notAttempted.length ? ', ' + r.notAttempted.length + ' not attempted' : '') + '.',
      result: r, list: fmvList(session)
    };
  }


  /* ================= masters: windows ================= */


  function saveWindow(session, payload) {
    assertAdmin(session);
    const id = Util.trim(payload.windowId);
    const w = Repo.find(T.WINDOWS, r => Util.windowKey(r.WindowID) === id);
    if (!w) throw new Error('Window ' + id + ' was not found.');
    const patch = {};
    if (payload.openDate) patch.OpenDate = Util.dateKey(payload.openDate);
    if (payload.closeDate) patch.CloseDate = Util.dateKey(payload.closeDate);
    if (payload.taxDueDate) patch.TaxDueDate = Util.dateKey(payload.taxDueDate);
    if (payload.status) patch.Status = Util.trim(payload.status);
    if (payload.remarks !== undefined) patch.Remarks = Util.trim(payload.remarks);
    if (Util.trim(payload.status) === 'Closed') patch.ClosedAt = Util.stamp();
    Repo.update(T.WINDOWS, w._row, patch);
    audit(session.userId, session.role, 'WINDOW_UPDATED', '', id + ' ' + JSON.stringify(patch));
    return { ok: true, message: 'Window ' + id + ' updated.' };
  }


  /**
   * Email every participant with something exercisable that the window is
   * open. Batched so it survives the six-minute execution limit: pass a
   * `startAt` cursor to continue.
   */
  function announceWindow(session, payload) {
    assertAdmin(session);
    if (!bulkEmailsAllowed()) {
      throw new Error('Bulk participant emails are switched off, so nothing was sent. ' +
        'This announcement would email every participant with exercisable options. ' +
        'To send it, set BULK_EMAILS_ENABLED to true in Settings, press this again, ' +
        'then set it back to false.');
    }
    const opts = payload || {};
    const win = Domain.currentWindow();
    const batch = Util.num(opts.batch, 200);
    const startAt = Util.num(opts.startAt, 0);


    const grantTotals = {};
    Repo.objects(T.GRANTS).forEach(function (g) {
      const k = Util.trim(g.EmployeeID).toUpperCase();
      const mult = Util.num(g.Multiplier, 1) || 1;
      const step = Domain.stepFor(mult);
      const ex = Math.floor((Util.num(g.VestedOptions, 0) + 1e-9) / step) * step;
      if (ex > 0) grantTotals[k] = (grantTotals[k] || 0) + ex;
    });


    // Blocked participants, and anyone outside the enabled list, are not told
    // a window is open for them: the portal would only refuse them.
    const candidates = Repo.objects(T.EMPLOYEES)
      .filter(e => grantTotals[Util.trim(e.EmployeeID).toUpperCase()] > 0 && !Domain.accessBar(e));


    const slice = candidates.slice(startAt, startAt + batch);
    let sent = 0; const skipped = [];
    slice.forEach(function (e) {
      const user = Auth.findUser(Util.trim(e.EmployeeID));
      const to = user ? Auth.notificationEmailFor(user) : Domain.emailFor(e);
      if (!to) { skipped.push(Util.trim(e.EmployeeID) + ' — no email'); return; }
      const available = grantTotals[Util.trim(e.EmployeeID).toUpperCase()];
      if (Mailer.send('window_open', to, {
        name: Util.trim(e.Name),
        windowLabel: Util.monthLabel(win.Label),
        openDate: Util.prettyDate(win.OpenDate),
        closeDate: Util.prettyDate(win.CloseDate),
        taxDueDate: Util.prettyDate(win.TaxDueDate),
        available: available,
        exercisePrice: cfgNum('EXERCISE_PRICE', 1),
        appId: Util.windowKey(win.WindowID)
      })) sent++;
      else skipped.push(Util.trim(e.EmployeeID) + ' — send failed');
    });


    const nextAt = startAt + slice.length;
    const done = nextAt >= candidates.length;
    audit(session.userId, session.role, 'WINDOW_ANNOUNCED', '',
      Util.windowKey(win.WindowID) + ': ' + sent + ' emailed (' + startAt + '–' + nextAt + ' of ' + candidates.length + ')');


    return {
      ok: true,
      message: sent + ' participant(s) emailed' +
        (done ? '.' : ' — ' + (candidates.length - nextAt) + ' still to go, press again to continue.'),
      sent: sent, skipped: skipped, total: candidates.length, nextAt: done ? null : nextAt, done: done
    };
  }


  /* ================= masters: logins ================= */


  function users(session) {
    assertAdmin(session);
    return {
      rows: Repo.objects(T.USERS).map(u => ({
        userId: Util.trim(u.UserID), role: Util.trim(u.Role), name: Util.trim(u.Name),
        loginEmail: Util.trim(u.LoginEmail), fundPartnerName: Util.trim(u.FundPartnerName),
        status: Util.trim(u.Status),
        mustResetPassword: String(u.MustResetPassword).toLowerCase() === 'true',
        hasPassword: !!Util.trim(u.PasswordHash),
        lastLoginAt: Util.trim(u.LastLoginAt), createdAt: Util.trim(u.CreatedAt)
      })).sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId)),
      roles: [ROLE.EMPLOYEE, ROLE.ADMIN, ROLE.PARTNER],
      // Every partner, not just the active ones: a login may still need
      // creating or resetting for one that is being retired so they can
      // finish the requests open with them.
      fundPartners: Partners.names(),
      partners: partnerList()
    };
  }


  /**
   * The fund partners with everything the admin screen needs to show whether
   * each one can actually be used, and what is holding them if not.
   */
  function partnerList() {
    return Partners.all().map(function (p) {
      const r = Partners.readiness(p.name);
      const open = Repo.filter(T.PARTNER_REQUESTS, x =>
        Util.trim(x.FundPartnerName) === p.name &&
        [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK, PARTNER_STATUS.PAID]
          .indexOf(Util.trim(x.Status)) >= 0);
      const everUsed = Repo.filter(T.PARTNER_REQUESTS, x => Util.trim(x.FundPartnerName) === p.name);
      return {
        name: p.name,
        status: p.status,
        active: p.active,
        contactEmails: p.contactEmails,
        notes: p.notes,
        logins: Partners.logins(p.name).map(u => ({
          userId: Util.trim(u.UserID),
          email: Util.trim(u.LoginEmail),
          hasPassword: !!Util.trim(u.PasswordHash),
          lastLoginAt: Util.trim(u.LastLoginAt)
        })),
        selectable: r.selectable,
        openRequests: open.length,
        openAppIds: open.map(x => Util.trim(x.AppID)),
        totalRequests: everUsed.length,
        updatedAt: p.updatedAt,
        updatedBy: p.updatedBy
      };
    });
  }


  function partners(session) {
    assertAdmin(session);
    return { rows: partnerList() };
  }


  /**
   * Save a partner's details and, unless told otherwise, give them the portal
   * login they need in the same step.
   *
   * A partner is useless without a login — the portal refuses to let anyone
   * choose them — so making that a second, separate errand on another part of
   * the screen was a trap: the obvious action left the job half done. Adding
   * the address a partner is contacted at and creating the login they sign in
   * with are one intention, so they are one action.
   */
  function savePartner(session, payload) {
    assertAdmin(session);
    const r = Partners.save(payload, session.userId);
    const name = r.name;


    const existing = Partners.logins(name);
    const emails = Partners.find(name).contactEmails;
    const wantLogin = payload.createLogin === undefined
      ? (!existing.length && emails.length > 0)     // the sensible default
      : !!payload.createLogin;


    let login = null;
    if (wantLogin && !existing.length) {
      if (!emails.length) {
        throw new Error('Add a contact address first — the sign-in code has to go somewhere.');
      }
      login = Auth.provisionUser({
        userId: partnerUserId(name),
        role: ROLE.PARTNER,
        name: name,
        email: emails[0],
        fundPartnerName: name
      }, session.userId, { sendEmail: payload.sendEmail === undefined ? true : !!payload.sendEmail });
    }


    const parts = [];
    parts.push(r.created ? name + ' added.' : 'Contact details updated for ' + name + '.');
    if (login) {
      parts.push(login.emailed
        ? 'A portal login was created and the sign-in code emailed to ' + login.emailAddress + '.'
        : 'A portal login was created — pass the code on yourself.');
    } else if (!existing.length) {
      parts.push('They still need a portal login before participants can choose them.');
    }


    return {
      ok: true,
      message: parts.join(' '),
      login: login,
      rows: partnerList()
    };
  }


  /**
   * A readable, stable user ID for a partner login, derived from the name so
   * the same partner always resolves to the same ID.
   */
  function partnerUserId(name) {
    return ('FP-' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')).slice(0, 45);
  }


  /** Create (or re-issue) the login for a partner that already has contacts. */
  function createPartnerLogin(session, payload) {
    assertAdmin(session);
    const p = Partners.find(payload.name);
    if (!p) throw new Error('No fund partner called "' + Util.trim(payload.name) + '".');
    const email = Util.trim(payload.email) || p.contactEmails[0];
    if (!email) {
      throw new Error('Add a contact address for ' + p.name + ' first — the sign-in code has to go somewhere.');
    }
    const login = Auth.provisionUser({
      userId: partnerUserId(p.name),
      role: ROLE.PARTNER,
      name: p.name,
      email: email,
      fundPartnerName: p.name
    }, session.userId, { sendEmail: payload.sendEmail === undefined ? true : !!payload.sendEmail });


    return {
      ok: true,
      message: login.emailed
        ? 'Login created for ' + p.name + ' and the sign-in code emailed to ' + login.emailAddress + '.'
        : 'Login created for ' + p.name + '. Pass the code on yourself.',
      login: login,
      rows: partnerList()
    };
  }


  function setPartnerStatus(session, payload) {
    assertAdmin(session);
    const r = Partners.setStatus(payload.name, payload.status, session.userId);
    return {
      ok: true,
      message: r.status === 'Inactive'
        ? r.name + ' retired. Existing applications keep working; no new one can choose them.'
        : r.name + ' is available again.',
      rows: partnerList()
    };
  }


  function provisionUser(session, payload) {
    assertAdmin(session);
    if (Util.trim(payload.role) === ROLE.EMPLOYEE && !Util.trim(payload.email)) {
      const emp = Repo.find(T.EMPLOYEES,
        e => Util.trim(e.EmployeeID).toUpperCase() === Util.trim(payload.userId).toUpperCase());
      if (emp) {
        payload.email = Domain.emailFor(emp);
        if (!Util.trim(payload.name)) payload.name = Util.trim(emp.Name);
      }
    }
    if (!Util.trim(payload.email)) {
      throw new Error('No email address on record for ' + Util.trim(payload.userId) +
        '. Add one to the participant record first — the one-time code has to go somewhere.');
    }
    const res = Auth.provisionUser(payload, session.userId,
      { sendEmail: payload.sendEmail === true });
    return {
      ok: true,
      userId: res.userId,
      emailAddress: res.emailAddress,
      emailed: res.emailed,
      oneTimeCode: res.oneTimeCode,
      expiresInMinutes: res.expiresInMinutes,
      message: res.emailed
        ? 'Login ready for ' + res.userId + '. A one-time code was emailed to ' + res.emailAddress + '.'
        : 'Login ready for ' + res.userId + '. No email was sent — pass the code below on yourself.'
    };
  }


  /**
   * Issue logins in bulk for participants with something exercisable.
   * Batched, like announceWindow, because there are ~1,600 of them.
   */
  /**
   * Create logins in bulk WITHOUT emailing anybody.
   *
   * Inviting participants is a manual activity, so this only creates the
   * accounts. When you are ready to invite someone, tell them to use "Set or
   * reset password" on the sign-in screen — that emails a code to them alone,
   * at their own request.
   */
  function provisionAllEmployees(session, payload) {
    assertAdmin(session);
    const opts = payload || {};
    const batch = Util.num(opts.batch, 100);
    const startAt = Util.num(opts.startAt, 0);


    const exercisable = {};
    Repo.objects(T.GRANTS).forEach(function (g) {
      const k = Util.trim(g.EmployeeID).toUpperCase();
      const mult = Util.num(g.Multiplier, 1) || 1;
      const step = Domain.stepFor(mult);
      const ex = Math.floor((Util.num(g.VestedOptions, 0) + 1e-9) / step) * step;
      if (ex > 0) exercisable[k] = true;
    });


    // Blocked participants, and anyone not on the enabled list, are left out:
    // creating a login for someone who is barred from acting is the first
    // step towards inviting them by mistake.
    const candidates = Repo.objects(T.EMPLOYEES).filter(function (e) {
      const id = Util.trim(e.EmployeeID);
      if (Domain.accessBar(e)) return false;
      return exercisable[id.toUpperCase()] && !Auth.findUser(id);
    });


    const slice = candidates.slice(startAt, startAt + batch);
    let created = 0; const skipped = [];
    slice.forEach(function (e) {
      const email = Domain.emailFor(e);
      if (!email) { skipped.push(Util.trim(e.EmployeeID) + ' — no email on record'); return; }
      try {
        Auth.provisionUser({
          userId: Util.trim(e.EmployeeID), role: ROLE.EMPLOYEE,
          name: Util.trim(e.Name), email: email
        }, session.userId, { sendEmail: false });   // never bulk-email
        created++;
      } catch (err) {
        skipped.push(Util.trim(e.EmployeeID) + ' — ' + err.message);
      }
    });


    const nextAt = startAt + slice.length;
    const done = nextAt >= candidates.length;
    return {
      ok: true,
      message: created + ' login(s) created — no emails sent' +
        (done ? '.' : '. ' + (candidates.length - nextAt) + ' still to go, press again to continue.'),
      created: created, skipped: skipped, total: candidates.length,
      nextAt: done ? null : nextAt, done: done
    };
  }


  function setUserStatus(session, userId, status) {
    assertAdmin(session);
    if (Util.trim(userId).toUpperCase() === Util.trim(session.userId).toUpperCase()) {
      throw new Error('You cannot change the status of your own login.');
    }
    return Auth.setUserStatus(userId, Util.trim(status), session.userId);
  }


  /* ================= config ================= */


  function config(session) {
    assertAdmin(session);
    return {
      rows: Repo.objects(T.CONFIG).map(r => ({
        key: Util.trim(r.Key), value: Util.trim(r.Value), notes: Util.trim(r.Notes)
      })),
      noticePlaceholders: Notice.placeholders
    };
  }


  function saveConfig(session, key, value) {
    assertAdmin(session);
    const k = Util.trim(key);
    if (!k) throw new Error('A key is required.');
    if (k === 'EMAILS_ENABLED' && ['true', 'false'].indexOf(Util.trim(value).toLowerCase()) < 0) {
      throw new Error('EMAILS_ENABLED must be true or false.');
    }
    if (k === 'LOT_SCOPE' && ['grant', 'total'].indexOf(Util.trim(value).toLowerCase()) < 0) {
      throw new Error('LOT_SCOPE must be "grant" or "total".');
    }
    Files.setConfigValue(k, Util.trim(value));
    audit(session.userId, session.role, 'CONFIG_SET', '', k + ' = ' + Util.trim(value));
    return { ok: true, message: k + ' saved.' };
  }


  /* ================= export ================= */


  /** One row per grant line, for payroll and the registrar. */
  function exportWindow(session, windowId) {
    assertAdmin(session);
    // windowKey, not trim: the current window's ID comes back from Sheets as a
    // Date, and a raw date string matched no application at all.
    const win = Util.windowKey(windowId) || Util.windowKey(Domain.currentWindow().WindowID);
    const employees = {};
    Repo.objects(T.EMPLOYEES).forEach(e => { employees[Util.trim(e.EmployeeID).toUpperCase()] = e; });


    const rows = [];
    Repo.filter(T.APPLICATIONS, a => Util.windowKey(a.WindowID) === win).forEach(function (a) {
      const emp = employees[Util.trim(a.EmployeeID).toUpperCase()] || {};
      const pr = AppStore.partnerRequestOf(a.AppID);
      AppStore.linesOf(a.AppID).forEach(function (l) {
        rows.push({
          Window: win,
          AppID: Util.trim(a.AppID),
          Status: Util.trim(a.Status),
          EmployeeID: Util.trim(a.EmployeeID),
          Name: Util.trim(emp.Name),
          Designation: Util.trim(a.ApplicantDesignation) || Util.trim(emp.Designation),
          EmploymentStatus: Util.trim(emp.EmploymentStatus),
          Email: Domain.emailFor(emp),
          PAN: Util.trim(a.PANNumber),
          GrantID: Util.trim(l.GrantID),
          Plan: Util.trim(l.PlanName),
          Multiplier: Util.num(l.Multiplier, 1),
          Options: Util.num(l.OptionsExercised, 0),
          Shares: Util.num(l.SharesAllotted, 0),
          ExercisePrice: Util.num(l.ExercisePrice, 0),
          ExerciseAmount: Util.num(l.LineExerciseAmount, 0),
          FMVDate: Util.dateKey(a.FMVDate),
          FMV: Util.num(a.FMVValue, 0),
          PerquisitePerShare: Util.num(l.PerquisitePerShare, 0),
          Perquisite: Util.num(l.LinePerquisite, 0),
          TaxRatePercent: Util.num(a.TaxRatePercent, 0),
          TaxOnApplication: Util.num(a.TaxAmount, 0),
          TaxMode: Util.trim(a.TaxMode),
          FundPartner: Util.trim(a.FundPartnerName),
          ExerciseUTR: Util.trim(a.ExercisePaymentUTR),
          ExercisePaymentDate: Util.dateKey(a.ExercisePaymentDate),
          TaxPaidAmount: Util.num(a.TaxPaidAmount, 0),
          TaxPaymentCount: Util.num(a.TaxPaymentCount, 0),
          // Every UTR, so payroll can tie each remittance back to a statement.
          TaxUTRs: AppStore.taxPaymentsOf(a.AppID)
            .map(r => Util.trim(r.UTR) + ' (' + Util.inr(r.Amount) + ' on ' +
              Util.prettyDate(r.PaymentDate) + ')').join('; '),
          TaxPaymentDate: Util.dateKey(a.TaxPaymentDate) || (pr ? Util.dateKey(pr.PaymentDate) : ''),
          DematAccountType: Util.trim(a.DematAccountType),
          // Blank when the participant gave the account; the partner's name
          // when the shares go to an account held with that partner.
          DematSuppliedBy: Util.trim(a.DematSource) || 'Participant',
          DPID: Util.trim(a.DematDPId),
          ClientID: Util.trim(a.DematClientId),
          DematAccountName: Util.trim(a.DematAccountName),
          NoticeSignedAt: Util.trim(a.NoticeSignedAt),
          NoticePlace: Util.trim(a.NoticePlace),
          ApprovedAt: Util.trim(a.ApprovedAt),
          FolderURL: Util.trim(a.FolderId)
            ? 'https://drive.google.com/drive/folders/' + Util.trim(a.FolderId) : ''
        });
      });
    });


    if (!rows.length) throw new Error('No applications in window ' + win + ' yet.');


    const tabName = 'Export ' + win;
    const book = Repo.book();
    let sh = book.getSheetByName(tabName);
    if (sh) book.deleteSheet(sh);
    sh = book.insertSheet(tabName);
    const headers = Object.keys(rows[0]);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    // Text FIRST, then the values: a column has to be formatted before it is
    // written, because Sheets decides "01234567" is a number at write time.
    applyTextColumns(sh, headers);
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows.map(r => headers.map(h => r[h])));
    sh.setFrozenRows(1);


    audit(session.userId, session.role, 'EXPORTED', '', win + ': ' + rows.length + ' rows');
    return {
      ok: true,
      message: rows.length + ' rows written to the "' + tabName + '" tab of the workbook.',
      tab: tabName, rows: rows.length,
      url: book.getUrl() + '#gid=' + sh.getSheetId()
    };
  }


  return {
    queue: queue,
    detail: detail,
    document: document,
    reviewSection: reviewSection,
    reviewMany: reviewMany,
    approve: approve,
    sendBack: sendBack,
    reject: reject,
    syncGrants: syncGrants,
    syncDetails: syncDetails,
    employees: employees,
    saveEmployee: saveEmployee,
    bulkTaxRates: bulkTaxRates,
    setBlocked: setBlocked,
    bulkBlock: bulkBlock,
    taxSheetInfo: taxSheetInfo,
    taxSheetReport: taxSheetReport,
    loadTaxSheet: loadTaxSheet,
    setEnabledList: setEnabledList,
    bulkParticipantDetails: bulkParticipantDetails,
    fmvList: fmvList,
    saveFmv: saveFmv,
    fetchFmv: fetchFmv,
    loadFmvFromNse: loadFmvFromNse,
    backfillFmv: backfillFmv,
    saveWindow: saveWindow,
    announceWindow: announceWindow,
    users: users,
    partners: partners,
    savePartner: savePartner,
    createPartnerLogin: createPartnerLogin,
    setPartnerStatus: setPartnerStatus,
    provisionUser: provisionUser,
    provisionAllEmployees: provisionAllEmployees,
    setUserStatus: setUserStatus,
    config: config,
    saveConfig: saveConfig,
    exportWindow: exportWindow
  };
})();


