/**
 * Triggers.gs — the daily job behind the reminder emails.
 *
 * Installed by Setup.installTriggers() to run twice a day: once early to load
 * the previous trading day's share price, and once at 09:00 IST for the
 * reminders. It does four things and nothing else:
 *
 *   1. opens the month's window on day 1 and announces it
 *   2. reminds anyone whose tax is due in 5, 2 or 0 days
 *   3. nudges drafts as the window closes (2 days out, and on the last day)
 *   4. closes a window that has passed its close date
 *
 * The share price is loaded by priceJob at 19:30, after NSE publishes the
 * day's bhavcopy — deliberately separate, so a slow or refused connection
 * can never hold up the reminders.
 *
 * Each reminder is sent at most once per day per application, and the
 * EmailLog tab is the record of what went out. A failed price load emails the
 * ESOP team, because without a price nothing can be exercised.
 */


const Triggers = (function () {


  function daily() {
    const today = Util.startOfDay(new Date());
    const log = [];


    // The price fetch lives in priceJob (19:30) only. A slow or hanging NSE
    // connection must never delay the reminders, which are time-sensitive.
    // Reads the FMV tab only — no fetch, so it cannot hang the reminders.
    try { log.push(checkPriceForToday()); } catch (e) { log.push('price check: FAILED ' + e.message); }
    try { log.push(openAndAnnounce(today)); } catch (e) { log.push('window: FAILED ' + e.message); }
    try { log.push(taxReminders(today)); } catch (e) { log.push('tax reminders: FAILED ' + e.message); }
    try { log.push(draftReminders(today)); } catch (e) { log.push('draft reminders: FAILED ' + e.message); }
    try { log.push(closeStaleWindows(today)); } catch (e) { log.push('window close: FAILED ' + e.message); }


    const report = log.join('\n');
    audit('system', 'system', 'DAILY_JOB', '', report);
    console.log(report);
    return report;
  }


  /**
   * The once-a-day price call, run by priceJob at 20:00 IST. Loads any of the
   * last few trading days that are missing, and emails the ESOP team if
   * anything failed — without a price nobody can record an exercise payment.
   */
  function loadPrice() {
    const r = NsePrice.loadLatestTradingDay('daily price job');
    if (!r.ok) notifyPriceProblem(r.message);
    return r.message;
  }


  /**
   * Morning check: is the price an exercise payment made TODAY would be
   * taxed on actually on record?
   *
   * FMV is the trading day before the payment date, so a participant paying
   * this morning needs yesterday's price. If it is missing they get an error
   * at the moment they try to record their payment — which is the worst place
   * to discover it. This says so at 08:00 instead, while there is a whole day
   * to put it right.
   */
  function checkPriceForToday() {
    let prior = Util.addDays(Util.startOfDay(new Date()), -1);
    for (let i = 0; i < 7 && (prior.getDay() === 0 || prior.getDay() === 6); i++) {
      prior = Util.addDays(prior, -1);
    }
    const key = Util.dateKey(prior);
    const present = Repo.objects(T.FMV).some(function (row) {
      return Util.dateKey(row.Date) === key && Util.num(row.FMV, 0) > 0;
    });
    if (present) return 'price check: ' + key + ' is on record';


    notifyPriceProblem('No price is on record for ' + Util.prettyDate(prior) +
      ', which is the day an exercise payment made today would be priced from. ' +
      'Anyone trying to record a payment today will be refused until it is entered. ' +
      'Load it from the Share price screen, or run diagnosePriceFetch() to see why ' +
      'the automatic load did not get it.');
    return 'price check: MISSING ' + key + ' — the ESOP team has been emailed';
  }


  function notifyPriceProblem(detail) {
    const to = Util.trim(cfg('ADMIN_NOTIFY_EMAILS'));
    if (!to) return;
    Mailer.send('price_load_failed', to.split(/[,;\s]+/).filter(Boolean).join(','), {
      symbol: cfg('NSE_SYMBOL'),
      detail: detail
    });
  }


  /** Day 1: make sure the window row exists and tell participants. */
  function openAndAnnounce(today) {
    const win = Domain.ensureWindow(today);
    const openDate = Util.startOfDay(win.OpenDate);
    if (!openDate || openDate.getTime() !== today.getTime()) {
      return 'window: ' + Util.windowKey(win.WindowID) + ' already open, nothing announced';
    }
    if (!bulkEmailsAllowed()) {
      return 'window: ' + Util.windowKey(win.WindowID) +
        ' opened — no announcement sent (BULK_EMAILS_ENABLED=false)';
    }
    if (alreadySent('window_open', Util.windowKey(win.WindowID), today)) {
      return 'window: announcement for ' + Util.windowKey(win.WindowID) + ' already sent today';
    }


    let sent = 0;
    Repo.objects(T.EMPLOYEES).forEach(function (e) {
      // Never announce a window to somebody the window is not open to: they
      // are blocked, or not on the enabled list, and would be invited to do
      // something the portal would then refuse.
      if (Domain.accessBar(e)) return;
      const available = Domain.grantsFor(e.EmployeeID, '').reduce((a, g) => a + g.exercisableOptions, 0);
      if (available <= 0) return;
      const user = Auth.findUser(Util.trim(e.EmployeeID));
      const to = user ? Auth.notificationEmailFor(user)
        : Domain.emailFor(e);
      if (!to) return;
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
    });
    return 'window: ' + Util.windowKey(win.WindowID) + ' opened, ' + sent + ' participant(s) emailed';
  }


  /** Tax due in 5 days, 2 days, or today — and once more the day after. */
  function taxReminders(today) {
    const apps = Repo.filter(T.APPLICATIONS, function (a) {
      if ([STATUS.APPROVED, STATUS.REJECTED].indexOf(Util.trim(a.Status)) >= 0) return false;
      if (Util.num(a.TaxAmount, 0) <= 0) return false;
      const prog = AppStore.progress(a);
      return !prog.done.tax;
    });


    let sent = 0, considered = 0;
    apps.forEach(function (a) {
      const due = Util.startOfDay(a.TaxDueDate);
      if (!due) return;
      considered++;
      const daysLeft = Math.round((due.getTime() - today.getTime()) / 86400000);
      if ([5, 2, 0, -1].indexOf(daysLeft) < 0) return;
      if (alreadySent('tax_reminder', Util.trim(a.AppID), today)) return;


      const emp = Repo.find(T.EMPLOYEES,
        e => Util.trim(e.EmployeeID).toUpperCase() === Util.trim(a.EmployeeID).toUpperCase());
      if (!emp) return;
      const win = Repo.find(T.WINDOWS, w => Util.windowKey(w.WindowID) === Util.windowKey(a.WindowID));


      // A fund-partner route reminds the partner as well as the employee.
      const pr = AppStore.partnerRequestOf(a.AppID);
      if (Util.trim(a.TaxMode) === TAX_MODE.PARTNER && pr &&
          Util.trim(pr.Status) === PARTNER_STATUS.ASSIGNED) {
        Repo.filter(T.USERS, u => Util.trim(u.Role) === ROLE.PARTNER &&
          Util.trim(u.FundPartnerName) === Util.trim(pr.FundPartnerName) &&
          Util.trim(u.Status).toLowerCase() === 'active')
          .forEach(function (u) {
            Mailer.send('partner_assigned_partner', Util.trim(u.LoginEmail), {
              partner: Util.trim(pr.FundPartnerName),
              requestId: Util.trim(pr.RequestID),
              appId: Util.trim(a.AppID),
              employeeName: Util.trim(emp.Name),
              employeeId: Util.trim(emp.EmployeeID),
              totalOptions: Util.num(a.TotalOptions, 0),
              perquisite: Util.num(a.PerquisiteAmount, 0),
              tax: Util.num(a.TaxAmount, 0),
              taxDueDate: Util.prettyDate(due)
            });
          });
      }


      const user = Auth.findUser(Util.trim(a.EmployeeID));
      const to = user ? Auth.notificationEmailFor(user)
        : Domain.emailFor(emp);
      if (!to) return;


      if (Mailer.send('tax_reminder', to, {
        name: Util.trim(emp.Name),
        appId: Util.trim(a.AppID),
        windowLabel: win ? Util.monthLabel(win.Label) : Util.windowKey(a.WindowID),
        taxDueDate: Util.prettyDate(due),
        daysLeft: Math.max(0, daysLeft),
        perquisite: Util.num(a.PerquisiteAmount, 0),
        tax: Util.num(a.TaxAmount, 0)
      })) sent++;
    });
    return 'tax reminders: ' + sent + ' sent of ' + considered + ' unpaid application(s)';
  }


  /** Drafts that will die when the window closes. */
  function draftReminders(today) {
    const win = Domain.currentWindow();
    const close = Util.startOfDay(win.CloseDate);
    if (!close) return 'draft reminders: no close date on ' + Util.windowKey(win.WindowID);
    const daysLeft = Math.round((close.getTime() - today.getTime()) / 86400000);
    if ([2, 0].indexOf(daysLeft) < 0) {
      return 'draft reminders: ' + daysLeft + ' day(s) to close, nothing due';
    }


    const drafts = Repo.filter(T.APPLICATIONS, a =>
      Util.windowKey(a.WindowID) === Util.windowKey(win.WindowID) &&
      [STATUS.DRAFT, STATUS.SENT_BACK].indexOf(Util.trim(a.Status)) >= 0);


    let sent = 0;
    drafts.forEach(function (a) {
      if (alreadySent('window_closing', Util.trim(a.AppID), today)) return;
      const emp = Repo.find(T.EMPLOYEES,
        e => Util.trim(e.EmployeeID).toUpperCase() === Util.trim(a.EmployeeID).toUpperCase());
      if (!emp) return;
      const user = Auth.findUser(Util.trim(a.EmployeeID));
      const to = user ? Auth.notificationEmailFor(user)
        : Domain.emailFor(emp);
      if (!to) return;
      const prog = AppStore.progress(a);
      if (Mailer.send('window_closing', to, {
        name: Util.trim(emp.Name),
        appId: Util.trim(a.AppID),
        windowLabel: Util.monthLabel(win.Label),
        closeDate: Util.prettyDate(close),
        daysLeft: Math.max(0, daysLeft),
        pending: prog.pendingLabels.join(', ') || 'submit the application'
      })) sent++;
    });
    return 'draft reminders: ' + sent + ' sent to ' + drafts.length + ' open draft(s), ' + daysLeft + ' day(s) to close';
  }


  /** Mark a window closed once its close date has passed. */
  function closeStaleWindows(today) {
    let closed = 0;
    Repo.filter(T.WINDOWS, w => Util.trim(w.Status) !== 'Closed').forEach(function (w) {
      const close = Util.startOfDay(w.CloseDate);
      if (!close || close.getTime() >= today.getTime()) return;
      Repo.update(T.WINDOWS, w._row, {
        Status: 'Closed',
        ClosedAt: Util.stamp(),
        Remarks: Util.trim(w.Remarks) + (Util.trim(w.Remarks) ? '; ' : '') + 'closed automatically'
      });
      closed++;
    });
    return 'window close: ' + closed + ' window(s) closed';
  }


  /** Has this template already gone out for this key today? */
  function alreadySent(template, appId, today) {
    const key = Util.dateKey(today);
    return Repo.filter(T.EMAIL_LOG, function (r) {
      return Util.trim(r.Template) === template &&
        Util.trim(r.AppID) === Util.trim(appId) &&
        Util.trim(r.Timestamp).indexOf(key) === 0 &&
        Util.trim(r.Result) === 'sent';
    }).length > 0;
  }


  /** Let an admin run the job by hand from the portal. */
  function runRemindersNow(session) {
    if (session.role !== ROLE.ADMIN) throw new Error('Only the ESOP team can run the reminder job.');
    const report = daily();
    return { ok: true, message: 'Reminder job run.', report: report };
  }


  return {
    daily: daily,
    loadPrice: loadPrice,
    checkPriceForToday: checkPriceForToday,
    runRemindersNow: runRemindersNow
  };
})();


/** The trigger's handler must be a plain global function. */
function dailyJob() {
  return Triggers.daily();
}
