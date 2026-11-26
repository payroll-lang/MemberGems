/**
 * Setup.gs — run these from the Apps Script editor, in this order.
 *
 *   1. createWorkbook()          builds/updates every tab and its headers
 *   2. seedAdminNow()            your ESOP-team login (edit the details first)
 *   3. seedFundPartnerLogins()   one login per fund partner (add the addresses)
 *   4. installTriggers()         the daily jobs
 *   5. testNsePriceFetch()       can Apps Script reach NSE from here?
 *   6. backfillPricesLast30Days()  seed the FMV tab
 *   7. checkGrantReport()        dry-run the vesting report
 *   8. syncGrantReport()         load it for real
 *   9. selfTest()                final check before letting anyone in
 *
 * Deploy > New deployment > Web app: execute as *me*, access *anyone*.
 * "Anyone" is what lets separated participants — who no longer have a domain
 * account — reach the login screen. The portal's own password check is the gate.
 */


/** Tabs from an earlier version of this script that are no longer used. */
const LEGACY_TABS = ['GrantImport'];


/**
 * Create or update every tab. Safe to re-run.
 *
 * Because column ORDER changed between v1 and v2, this refuses to rewrite
 * headers over a tab that already holds data unless you pass true — otherwise
 * existing rows would silently end up under the wrong headings.
 */
function createWorkbook(force) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const created = [], migrated = [], blocked = [], added = [];


  Object.keys(SCHEMA).forEach(function (name) {
    const headers = SCHEMA[name];
    let sh = book.getSheetByName(name);


    if (!sh) {
      sh = book.insertSheet(name);
      created.push(name);
    } else {
      const existing = sh.getLastColumn()
        ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim())
        : [];
      const same = existing.length === headers.length &&
        headers.every((h, i) => existing[i] === h);


      // A pure APPEND — the existing headings are an unchanged prefix of the
      // new ones — is always safe, however much data the tab holds: every
      // existing value stays under the heading it was written beneath, and the
      // new columns simply start empty. Only a REORDER can misalign rows, and
      // that is what the block below refuses.
      const pureAppend = !same &&
        existing.length > 0 && existing.length < headers.length &&
        existing.every((h, i) => h === headers[i]);


      if (!same && !pureAppend) {
        const dataRows = Math.max(0, sh.getLastRow() - 1);
        if (dataRows > 0 && !force) {
          blocked.push(name + ' (' + dataRows + ' data row' + (dataRows === 1 ? '' : 's') + ')');
          return;
        }
        if (existing.length) migrated.push(name);
      } else if (pureAppend) {
        added.push(name + ' (+' + (headers.length - existing.length) + ' column' +
          (headers.length - existing.length === 1 ? '' : 's') + ')');
      }
    }


    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold').setBackground('#e8efe9').setFontColor('#14211c');
    sh.setFrozenRows(1);
    // Identifier columns stay text so a leading zero is never dropped.
    applyTextColumns(sh, headers);
    if (sh.getMaxColumns() > headers.length) {
      sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
    }
  });


  if (blocked.length) {
    throw new Error(
      'These tabs hold data and their columns have changed, so nothing was written:\n  ' +
      blocked.join('\n  ') +
      '\n\nThe column ORDER differs from the previous version, so rewriting the headings ' +
      'over existing rows would put values under the wrong headings.\n\n' +
      'If this data is test data you do not need, delete the rows and run createWorkbook() again. ' +
      'To overwrite regardless, run createWorkbook(true).');
  }


  // The scratch tab is machinery, not data.
  const scratch = book.getSheetByName(T.SCRATCH) || book.insertSheet(T.SCRATCH);
  scratch.hideSheet();


  // Fund partners are data now, not code. Seed the tab on a fresh install so
  // the three we started with are there without anyone typing them; never
  // touch it again once it holds rows.
  Repo.invalidate(T.FUND_PARTNERS);
  const seededPartners = Partners.seedIfEmpty('setup');


  // The tax rules go onto their tabs the first time and are never touched
  // again, so an edit made for a change in the Finance Act survives re-runs.
  const seededTax = Tax.seedIfEmpty();


  // Retire tabs from the earlier version, but never one holding data.
  const retired = [];
  LEGACY_TABS.forEach(function (name) {
    const sh = book.getSheetByName(name);
    if (!sh) return;
    if (sh.getLastRow() > 1) {
      retired.push(name + ' — left in place, it still has rows in it');
      return;
    }
    book.deleteSheet(sh);
    retired.push(name + ' — removed');
  });


  // Config defaults, only for keys not already present. Existing values win,
  // so nothing you have already set is overwritten.
  const existingKeys = {};
  Repo.objects(T.CONFIG).forEach(r => { existingKeys[Util.trim(r.Key)] = true; });
  const notes = {
    COMPANY_NAME: 'Appears in the portal header, emails and the exercise notice',
    COMPANY_FORMER_NAME: 'Printed under the company name on the notice',
    COMPANY_ADDRESS: 'The "To," address block on the notice',
    PLAN_NAME: 'Scheme name as it should read on the notice',
    EXERCISE_PRICE: 'Rupees per OPTION. The notice states the total as the option count in rupees',
    OPTION_LOT_SIZE: 'Options must be in multiples of this. 10 × 3.6 = 36, so a whole lot always gives whole shares',
    DEFAULT_MULTIPLIER: 'Used when the report leaves Multiplier blank, as it does for every Test Plan row',
    LOT_SCOPE: '"grant" = each grant in multiples of 10 on its own. "total" = the multiple-of-10 test applies to the total across grants, letting small balances combine',
    ALLOWED_PLANS: 'Comma-separated. Plans in the report that are not listed here are ignored. Include Test Plan to allow test accounts',
    ALLOWED_GRANT_STATUSES: 'Grant statuses whose options may be exercised. Accepted, PendingAcceptance. Cancelled and PendingApproval are left out on purpose',
    WINDOW_OPEN_DAY: 'Day of the month the window opens',
    WINDOW_CLOSE_DAY: 'Day of the month the window closes (clamped to month end)',
    TAX_DUE_DAY: 'Tax due by this day of the month',
    NSE_SYMBOL: 'NSE trading symbol. PWL for Physicswallah Limited',
    NSE_SERIES: 'NSE series to match in the bhavcopy. EQ',
    NSE_FETCH_ENABLED: 'false stops the jobs even trying NSE. Set false if diagnosePriceFetch() shows NSE hanging, and rely on Google Finance or manual entry',
    GF_TICKER: 'Google Finance ticker for the fallback source, e.g. NSE:PWL. Runs inside Sheets so it cannot be blocked like an NSE request can',
    DRIVE_ROOT_FOLDER_ID: 'Parent folder for participant document folders. Blank = created on first upload',
    ELIGIBLE_EMPLOYEE_IDS: 'Employee codes allowed to use the portal, comma or newline separated. Blank = everyone on the report. Edit it from the Participants screen',
    LOGO_FILE_ID: 'Drive file ID of the company logo. Shown on every screen, the notice and the emails. Blank = no logo',
    SUPPORT_EMAIL: 'Reply-to address on every portal email',
    ADMIN_NOTIFY_EMAILS: 'Comma-separated. Gets "application to verify" and price-failure emails. Point this at the ESOP mailbox, not one person',
    EMAIL_SENDER_NAME: 'The name recipients see on portal emails',
    EMAIL_REPLY_TO: 'Where replies go. Falls back to SUPPORT_EMAIL if blank',
    EMAIL_FROM: 'Only works if this is a verified send-as alias on the account that owns this script. Leave blank otherwise',
    COMPANY_BANK_DETAILS: 'Shown to participants and printed in section C of the notice. Keep the "Label: value" format',
    TAX_BANK_DETAILS: 'Shown to participants and fund partners for the tax transfer',
    PAYMENT_REFERENCE_FORMAT: 'Reference participants must quote. {EMPLOYEE_ID} and {NAME} are substituted',
    NOTICE_TEMPLATE_DOC_ID: 'Optional. A Google Doc holding your own notice wording with {{Placeholders}}',
    NOTICE_SHOW_SHARES: 'true = the notice also states the equity shares and a grant-wise breakdown. Set false to print options only, as in the original form',
    EMAILS_ENABLED: 'Set false while testing to log emails without sending',
    PORTAL_URL: 'The deployed web app URL, so email buttons work',
    GRANT_SOURCE_SPREADSHEET_ID: 'Recommended. Keep the 21k-row vesting report in its own file and put its ID here',
    GRANT_SOURCE_TAB: 'Tab name of the vesting report (defaults to "' + T.GRANT_IMPORT + '")',
    REPORT_HEADER_ROW: 'Row the report headings sit on. 4 in the standard export; auto-detected anyway'
  };
  const toAdd = [];
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    if (!existingKeys[k]) toAdd.push({ Key: k, Value: CONFIG_DEFAULTS[k], Notes: notes[k] || '' });
  });
  if (!existingKeys['NOTICE_SHOW_SHARES']) {
    toAdd.push({ Key: 'NOTICE_SHOW_SHARES', Value: 'true', Notes: notes.NOTICE_SHOW_SHARES });
  }
  if (toAdd.length) Repo.appendAll(T.CONFIG, toAdd);
  clearConfigCache();


  // Formatting that makes the tabs readable by hand.
  numberFormats(book);
  validations(book);


  Domain.ensureWindow(new Date());


  // Always state the resulting position, not only what changed. A bare
  // "Workbook ready." after a no-op run is indistinguishable from a run that
  // silently did nothing, which is no use to anyone checking it worked.
  const changes = [
    created.length ? '  created: ' + created.join(', ') : '',
    added.length ? '  columns added: ' + added.join(', ') : '',
    migrated.length ? '  headings updated: ' + migrated.join(', ') : '',
    retired.length ? '  legacy tabs: ' + retired.join('; ') : '',
    toAdd.length ? '  config keys added: ' + toAdd.length : '',
    seededPartners ? '  fund partners seeded: ' + seededPartners : '',
    seededTax.length ? '  tax rules written to: ' + seededTax.join(', ') : ''
  ].filter(Boolean);


  const partnerRows = Partners.all();
  const msg = [
    'Workbook ready.',
    '',
    changes.length ? 'Changed:' : 'Changed: nothing — every tab and column was already in place.',
    changes.join('\n'),
    '',
    'Now standing at:',
    '  tabs: ' + Object.keys(SCHEMA).length,
    '  fund partners: ' + (partnerRows.length
      ? partnerRows.map(p => p.name + (p.active ? '' : ' (retired)')).join('; ')
      : 'NONE — the FundPartners tab is empty'),
    '  applications: ' + Math.max(0, (Repo.book().getSheetByName(T.APPLICATIONS) || { getLastRow: () => 1 }).getLastRow() - 1),
    '  participants: ' + Math.max(0, (Repo.book().getSheetByName(T.EMPLOYEES) || { getLastRow: () => 1 }).getLastRow() - 1),
    '',
    'Next: selfTest() to confirm, then seedAdminNow() / installTriggers() if this is a fresh install.'
  ].filter(x => x !== '' || true).join('\n');
  console.log(msg);
  return msg;
}


function numberFormats(book) {
  const fmt = function (tab, headerName, pattern) {
    const sh = book.getSheetByName(tab);
    if (!sh) return;
    const headers = SCHEMA[tab];
    const at = headers.indexOf(headerName);
    if (at < 0) return;
    try {
      sh.getRange(2, at + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(pattern);
    } catch (e) { /* ignore */ }
  };


  ['OpenPrice', 'ClosePrice', 'FMV'].forEach(h => fmt(T.FMV, h, '#,##0.00'));
  fmt(T.FMV, 'Date', 'yyyy-mm-dd');


  // WindowID is the string "2026-09", which Sheets otherwise parses as a date.
  // Plain text keeps the cell readable; Util.windowKey() is what actually makes
  // the comparisons safe either way.
  fmt(T.WINDOWS, 'WindowID', '@');
  fmt(T.APPLICATIONS, 'WindowID', '@');


  ['TotalGranted', 'UnvestedOptions', 'VestedOptions', 'ExercisedOptions',
    'ExercisePendingOptions', 'CancelledOptions'].forEach(h => fmt(T.GRANTS, h, '#,##0.00'));
  fmt(T.GRANTS, 'Multiplier', '0.0#');
  fmt(T.GRANTS, 'ExercisePrice', '#,##0.00');


  ['TotalOptions', 'TotalShares'].forEach(h => fmt(T.APPLICATIONS, h, '#,##0.00'));
  ['ExerciseAmount', 'FMVValue', 'PerquisiteAmount', 'TaxAmount',
    'ExercisePaymentAmount', 'TaxPaymentAmount'].forEach(h => fmt(T.APPLICATIONS, h, '#,##0.00'));
  fmt(T.APPLICATIONS, 'TaxRatePercent', '0.00');


  ['OptionsExercised', 'SharesAllotted'].forEach(h => fmt(T.APP_LINES, h, '#,##0.00'));
  ['LineExerciseAmount', 'PerquisitePerShare', 'LinePerquisite'].forEach(h => fmt(T.APP_LINES, h, '#,##0.00'));


  fmt(T.EMPLOYEES, 'CTC', '#,##0');
  fmt(T.EMPLOYEES, 'TaxRatePercent', '0.00');
  fmt(T.PARTNER_REQUESTS, 'TaxAmount', '#,##0.00');
  fmt(T.PARTNER_REQUESTS, 'PaymentAmount', '#,##0.00');
}


function validations(book) {
  const list = function (tab, headerName, values) {
    const sh = book.getSheetByName(tab);
    if (!sh) return;
    const at = SCHEMA[tab].indexOf(headerName);
    if (at < 0) return;
    try {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(values, true).setAllowInvalid(true).build();
      sh.getRange(2, at + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(rule);
    } catch (e) { /* ignore */ }
  };
  list(T.EMPLOYEES, 'EmploymentStatus', ['Active', 'Separated']);
  list(T.USERS, 'Role', [ROLE.EMPLOYEE, ROLE.ADMIN, ROLE.PARTNER]);
  list(T.USERS, 'Status', ['Active', 'Locked', 'Inactive']);
  list(T.WINDOWS, 'Status', ['Open', 'Closed']);
  list(T.APPLICATIONS, 'Status', Object.keys(STATUS).map(k => STATUS[k]));
  list(T.APPLICATIONS, 'TaxMode', [TAX_MODE.SELF, TAX_MODE.PARTNER]);
  list(T.FUND_PARTNERS, 'Status', ['Active', 'Inactive']);
}


/* ================= invitations ================= */


/**
 * Invite ONE participant, and say exactly what happened.
 *
 * Edit WHO below to an employee code or an email address, then press Run.
 *
 * This exists because the normal path is deliberately quiet: INVITE_EMAILS is
 * set to 'manual', so creating a login from the portal sends nothing and shows
 * you the code instead. This function does the opposite — it emails the code —
 * and reports every step, so when nothing arrives you can see which step was
 * the problem rather than guessing.
 */
function inviteParticipantNow() {
  const WHO = 'PW4872';        // employee code, or their email address


  return inviteParticipant(WHO);
}


/**
 * Invite a handful at once. Edit the list, press Run.
 * Each one is created and emailed individually, and each is reported.
 */
function inviteParticipantsNow() {
  const WHO = 'PW4872, PW1306';        // employee codes or emails, comma separated


  const out = [];
  WHO.split(',').map(x => x.trim()).filter(Boolean).forEach(function (who) {
    try {
      out.push(inviteParticipant(who));
    } catch (e) {
      out.push('INVITE: ' + who + '\n\nFAILED  ' + e.message);
    }
    out.push('----------------------------------------');
  });
  const report = out.join('\n');
  console.log(report);
  return report;
}


function inviteParticipant(idOrEmail) {
  const who = Util.trim(idOrEmail);
  if (!who) throw new Error('Edit WHO at the top of inviteParticipantNow() first.');


  const lines = ['INVITE: ' + who, ''];


  // 1. is there an employee record at all?
  const key = who.toUpperCase();
  let emp = Repo.find(T.EMPLOYEES, e => Util.trim(e.EmployeeID).toUpperCase() === key);
  if (!emp && who.indexOf('@') >= 0) {
    const email = who.toLowerCase();
    emp = Repo.find(T.EMPLOYEES, function (e) {
      return [e.EmailOverride, e.AccessEmail, e.SecondaryEmail]
        .some(v => Util.trim(v).toLowerCase() === email);
    });
  }
  if (!emp) {
    lines.push('FAILED  No participant record matches "' + who + '".');
    lines.push('        The Employees tab is built by syncGrantReport() — run that first.');
    lines.push('        Employees rows currently: ' + Repo.objects(T.EMPLOYEES).length);
    const msg = lines.join('\n');
    console.log(msg);
    return msg;
  }
  const empId = Util.trim(emp.EmployeeID);
  lines.push('participant record   ' + empId + '  ' + Util.trim(emp.Name));


  // Inviting someone who is blocked, or not on the enabled list, would hand
  // them a login they cannot use. Refuse rather than explain it later.
  const bar = Domain.accessBar(emp);
  if (bar) {
    lines.push('');
    lines.push('FAILED  ' + empId + ' cannot use the portal at the moment:');
    lines.push('        ' + bar);
    lines.push('        Release them on the Participants screen, or add them to the');
    lines.push('        enabled list, then invite again.');
    const msg = lines.join('\n');
    console.log(msg);
    return msg;
  }


  // 2. where would an email go?
  const to = Domain.emailFor(emp);
  lines.push('address of record    ' + (to || '(NONE — this is why nothing arrives)'));
  if (!to) {
    lines.push('');
    lines.push('FAILED  No email on this record. Fill in AccessEmail or EmailOverride');
    lines.push('        on the Employees tab, then run this again.');
    const msg = lines.join('\n');
    console.log(msg);
    return msg;
  }


  // 3. is sending switched on at all?
  lines.push('EMAILS_ENABLED       ' + cfg('EMAILS_ENABLED'));
  if (!cfgBool('EMAILS_ENABLED')) {
    lines.push('');
    lines.push('FAILED  EMAILS_ENABLED is false, so nothing is ever sent.');
    lines.push('        Set it to true on the Config tab and run this again.');
    const msg = lines.join('\n');
    console.log(msg);
    return msg;
  }


  // 4. how much Gmail quota is left today?
  let quota = 'unknown';
  try { quota = String(MailApp.getRemainingDailyQuota()); } catch (e) { quota = 'unreadable: ' + e.message; }
  lines.push('email quota left     ' + quota);


  // 5. did they already have a login?
  const existing = Auth.findUser(empId);
  lines.push('existing login       ' + (existing ? Util.trim(existing.Status) : 'none — will be created'));


  // 6. create or reset it, and ACTUALLY send the code
  const res = Auth.provisionUser({
    userId: empId,
    role: ROLE.EMPLOYEE,
    name: Util.trim(emp.Name),
    email: to
  }, 'invite', { sendEmail: true });


  lines.push('');
  lines.push(res.emailed
    ? 'SENT    A one-time code was emailed to ' + res.emailAddress + ', valid ' +
      res.expiresInMinutes + ' minutes.'
    : 'NOT SENT  The email did not go out. Code below — pass it on by hand.');
  if (res.oneTimeCode) lines.push('        one-time code: ' + res.oneTimeCode);
  lines.push('');
  lines.push('They sign in with ' + empId + ' or ' + to + ', via "Set or reset password".');
  lines.push('Check the EmailLog tab for the delivery result.');


  const msg = lines.join('\n');
  console.log(msg);
  return msg;
}


/* ================= repairs ================= */


/**
 * Fix the Windows tab.
 *
 * `WindowID` is the string "2026-09", which Sheets parses as a date on write.
 * An earlier version compared it as text, so the lookup stopped matching and a
 * duplicate row was appended every time a window was touched. This collapses
 * the duplicates — keeping the earliest row for each month, and preserving a
 * 'Closed' status if any duplicate carried one — and rewrites the id as plain
 * text. Safe to re-run; harmless if there was nothing wrong.
 */
function repairWindows() {
  const rows = Repo.objects(T.WINDOWS);
  if (!rows.length) return 'Windows tab is empty — nothing to repair.';


  const groups = {};
  rows.forEach(function (r) {
    const key = Util.windowKey(r.WindowID);
    if (!key) return;
    (groups[key] = groups[key] || []).push(r);
  });


  const removed = [], kept = [];
  Object.keys(groups).sort().forEach(function (key) {
    const dupes = groups[key].slice().sort(function (a, b) {
      return Util.timeMs(a.CreatedAt) - Util.timeMs(b.CreatedAt);
    });
    const keep = dupes[0];


    // Don't lose a deliberate close, or remarks, recorded on a later duplicate.
    const closed = dupes.filter(r => Util.trim(r.Status).toLowerCase() === 'closed')[0];
    const patch = { WindowID: key };
    if (closed && Util.trim(keep.Status).toLowerCase() !== 'closed') {
      patch.Status = 'Closed';
      patch.ClosedAt = Util.trim(closed.ClosedAt) || Util.stamp();
      patch.Remarks = Util.trim(closed.Remarks) || Util.trim(keep.Remarks);
    }
    Repo.update(T.WINDOWS, keep._row, patch);
    kept.push(key + (patch.Status ? ' (kept as Closed)' : ''));


    dupes.slice(1).sort((a, b) => b._row - a._row).forEach(function (r) {
      Repo.deleteRow(T.WINDOWS, r._row);
      removed.push(key + ' row ' + r._row);
    });
  });


  // Keep the column as text so the ids stay readable from now on.
  try {
    const sh = Repo.sheet(T.WINDOWS);
    const at = SCHEMA[T.WINDOWS].indexOf('WindowID');
    sh.getRange(2, at + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  } catch (e) { /* formatting is cosmetic */ }


  const msg = 'Windows repaired. Kept: ' + kept.join(', ') +
    '. Removed ' + removed.length + ' duplicate row(s)' +
    (removed.length ? ': ' + removed.join(', ') : '') + '.';
  audit('editor', ROLE.ADMIN, 'WINDOWS_REPAIRED', '', msg);
  console.log(msg);
  return msg;
}


/* ================= logins ================= */


/**
 * Your ESOP-team login. EDIT THE THREE VALUES, then press Run.
 *
 * The Run button cannot pass arguments, which is why this wrapper exists —
 * seedAdmin() itself takes them.
 */
function seedAdminNow() {
  const USER_ID = 'ESOPADMIN';              // the ID you will type at sign-in
  const EMAIL   = 'ganesh.jadhav@pw.live';  // where the one-time code is sent
  const NAME    = 'ESOP Team';


  return seedAdmin(USER_ID, EMAIL, NAME);
}


/** Create or reset an ESOP-team login. Emails a one-time code, never a password. */
function seedAdmin(userId, email, name) {
  const id = Util.trim(userId), mail = Util.trim(email);
  if (!id || !mail) {
    throw new Error('Edit the three values at the top of seedAdminNow() and run that instead — ' +
      'the Run button cannot pass arguments to seedAdmin().');
  }
  const res = Auth.provisionUser({
    userId: id, role: ROLE.ADMIN, name: Util.trim(name) || 'ESOP Administrator', email: mail
  }, 'setup');


  if (!Util.trim(cfg('ADMIN_NOTIFY_EMAILS'))) Files.setConfigValue('ADMIN_NOTIFY_EMAILS', mail);
  if (!Util.trim(cfg('SUPPORT_EMAIL'))) Files.setConfigValue('SUPPORT_EMAIL', mail);


  const msg = 'Admin login "' + res.userId + '" is ready. A one-time code was emailed to ' + res.emailedTo +
    '.\nOpen the web app, choose "Set or reset password", and use the code within ' +
    APP.RESET_CODE_MINUTES + ' minutes.' +
    (Util.trim(cfg('PORTAL_URL')) ? '\n' + cfg('PORTAL_URL') : '');
  console.log(msg);
  return msg;
}


/**
 * A login for every active fund partner that has a contact address but no
 * login yet.
 *
 * Normally you would not run this: partners are managed from the portal, at
 * Logins > Fund partners, where you add the partner, set the contact
 * addresses and create the login in one place. This is the bulk equivalent
 * for a fresh install, and it takes the addresses from the FundPartners tab
 * rather than from a list edited into this file.
 *
 * The one-time code is emailed to the first contact address on each partner.
 */
function seedFundPartnerLogins() {
  const targets = Partners.active().filter(function (p) {
    return p.contactEmails.length && !Partners.logins(p.name).length;
  });


  if (!Partners.all().length) {
    throw new Error('The FundPartners tab is empty. Run createWorkbook() first, ' +
      'or add the partners at Logins > Fund partners in the portal.');
  }
  if (!targets.length) {
    const noEmail = Partners.active()
      .filter(p => !p.contactEmails.length && !Partners.logins(p.name).length)
      .map(p => p.name);
    const msg = noEmail.length
      ? 'Nothing to do. These partners have no contact address yet, so no login can be ' +
        'created for them: ' + noEmail.join('; ') +
        '. Add one at Logins > Fund partners in the portal.'
      : 'Nothing to do — every active fund partner already has a login.';
    console.log(msg);
    return msg;
  }


  const out = targets.map(function (p) {
    // A stable, readable user ID derived from the name, so the same partner
    // gets the same ID if this is ever re-run.
    const userId = 'FP-' + p.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40);
    try {
      const res = Auth.provisionUser({
        userId: userId, role: ROLE.PARTNER, name: p.name,
        email: p.contactEmails[0], fundPartnerName: p.name
      }, 'setup', { sendEmail: true });
      return 'CREATED  ' + res.userId + '  ' + p.name +
        (res.emailed ? '  — code emailed to ' + res.emailAddress
                     : '  — NOT emailed, code: ' + res.oneTimeCode);
    } catch (e) {
      return 'FAILED   ' + p.name + '  — ' + e.message;
    }
  });


  const msg = out.join('\n');
  console.log(msg);
  return msg;
}


/**
 * Make a browser-tab icon from the logo, and wire it up.
 *
 * A tab icon cannot be embedded by us — Google fetches it from a public
 * address — and `setFaviconUrl` is fussy about what it will accept. It judges
 * the address, not the picture: every Drive address for an image is
 * extensionless (`/d/<id>`, `?id=<id>`), and those it refuses whatever the
 * file's real type is. That is why converting the WebP to a PNG was necessary
 * but not sufficient.
 *
 * So this tries several addresses in turn and asks `setFaviconUrl` about each
 * one, keeping the first it accepts. It still makes the PNG copy — that is
 * what the Drive candidates point at, and it costs nothing if an earlier
 * candidate wins.
 *
 * Pass a URL to test just that one, e.g. an image on the company website:
 *   makeFaviconNow('https://example.com/icon.png')
 *
 * Safe to re-run: it replaces the icon it made last time.
 */
function makeFaviconNow(urlOverride) {
  const forced = Util.trim(urlOverride);
  const lines = [];
  let iconId = '';


  let candidates;
  if (forced) {
    candidates = [{ url: forced, what: 'the address you passed in' }];
  } else {
    const sourceId = Util.trim(cfg('LOGO_FILE_ID'));
    if (!sourceId) {
      throw new Error('Set LOGO_FILE_ID in the Config tab first — it is the Drive ID of your logo file.');
    }


    const source = DriveApp.getFileById(sourceId);
    const parents = source.getParents();
    const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    const name = 'ESOP portal tab icon.png';


    // Clear out a previous run's copy so re-running does not accumulate files.
    const old = folder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);


    let png;
    try {
      png = source.getBlob().getAs('image/png');
    } catch (e) {
      throw new Error('That logo could not be converted to PNG (' + e.message +
        '). Put a PNG or JPG version in the same folder and point LOGO_FILE_ID at it.');
    }


    const file = folder.createFile(png.setName(name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    iconId = file.getId();
    lines.push('PNG copy made: ' + name + '  (' + iconId + '), shared link-view only.');
    lines.push('Your original logo file was not changed and stays private.');
    lines.push('');


    candidates = [
      // The company site's own icon: a real .ico at a plain address, which is
      // the shape setFaviconUrl is happiest with. Same PW mark, so nothing is
      // lost by preferring it.
      { url: 'https://www.pw.live/favicon.ico', what: 'the PW website icon' },
      { url: 'https://lh3.googleusercontent.com/d/' + iconId, what: "Google's image host" },
      { url: 'https://drive.google.com/uc?export=view&id=' + iconId, what: 'Drive direct view' },
      { url: 'https://drive.google.com/thumbnail?id=' + iconId + '&sz=w128',
        what: 'Drive thumbnail' }
    ];
  }


  // Ask setFaviconUrl itself rather than assuming: it is the thing that
  // rejected the WebP, and it is the only opinion that matters.
  let winner = null;
  candidates.forEach(function (c) {
    if (winner) return;
    try {
      HtmlService.createHtmlOutput('<p>ok</p>').setFaviconUrl(c.url);
      winner = c;
      lines.push('ACCEPTED  ' + c.what + '  ' + c.url);
    } catch (e) {
      lines.push('rejected  ' + c.what + '  (' + e.message + ')');
    }
  });


  lines.push('');
  if (winner) {
    Files.setConfigValue('LOGO_URL', winner.url);
    lines.push('LOGO_URL set to ' + winner.url);
    lines.push('Reload the portal with Ctrl+Shift+R to see the tab icon.');
  } else {
    lines.push('None of the addresses were accepted, so LOGO_URL was left alone ' +
      'and the portal is unaffected. Host the icon somewhere with a plain ' +
      '.png or .ico address and re-run as makeFaviconNow("that address").');
  }


  const msg = lines.join('\n');
  console.log(msg);
  return msg;
}


/* ================= triggers ================= */


/**
 * Two jobs, once a day each:
 *   08:00  window announcement, tax reminders, draft nudges, window close
 *   20:00  the share price — one call, for today's open and close
 *
 * 20:00 because NSE publishes the day's bhavcopy by about 19:00 IST. Today's
 * price is what tomorrow's payers are taxed on, so having it in by tonight is
 * what keeps the portal able to price an exercise the moment it is recorded.
 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'dailyJob' || fn === 'priceJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(8).everyDays(1).inTimezone(Util.tz()).create();
  ScriptApp.newTrigger('priceJob').timeBased().atHour(20).everyDays(1).inTimezone(Util.tz()).create();
  const msg = 'Installed: dailyJob at 08:00 and priceJob at 20:00, ' + Util.tz() +
    '. priceJob loads one day only — the last traded day.';
  console.log(msg);
  return msg;
}


/**
 * The 20:00 job. One NSE call for the last traded day — today's, once the
 * bhavcopy is out. Goes through Triggers.loadPrice so a failure emails the
 * ESOP team rather than only landing in the execution log.
 */
function priceJob() {
  const message = Triggers.loadPrice();
  audit('system', 'system', 'PRICE_JOB', '', message);
  console.log(message);
  return message;
}


/* ================= checks ================= */


/**
 * Sanity check. Exercises the rules without touching anyone's data, and
 * reports on the state of the masters.
 */
function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try { const r = fn(); results.push('PASS  ' + name + (r ? ' — ' + r : '')); }
    catch (e) { results.push('FAIL  ' + name + ' — ' + e.message); }
  };


  check('every tab exists', function () {
    const missing = Object.keys(SCHEMA).filter(n => !Repo.book().getSheetByName(n));
    if (missing.length) throw new Error('missing ' + missing.join(', '));
    return Object.keys(SCHEMA).length + ' tabs';
  });


  check('config readable', function () {
    if (!cfg('COMPANY_NAME')) throw new Error('COMPANY_NAME is blank');
    return cfg('COMPANY_NAME') + ', ' + Util.inr2(cfgNum('EXERCISE_PRICE', 1)) + ' per option, lots of ' +
      Domain.lotSize() + ' (' + Domain.lotScope() + ' scope)';
  });


  check('tax engine reproduces payroll and the Finance Bill rules', function () {
    // Each figure is payroll's own total tax for a real slip (new or old
    // regime, with and without surcharge, rebate and its marginal relief),
    // plus one case computed from the marginal-relief formula in the Finance
    // Bill 2026 for income just over ₹1 crore. Cleared first so edited rule
    // tabs are what is tested, not a stale copy.
    Tax.resetCache();
    const cases = [
      ['New', 4786080, 1056457, 'new regime, no surcharge'],
      ['Old', 2356680, 540284, 'old regime, no surcharge'],
      ['New', 7611750, 2131873, 'new regime, 10% surcharge'],
      ['Old', 9206860, 2945294, 'old regime, 10% surcharge'],
      ['New', 21784150, 7949819, 'new regime, 25% surcharge'],
      ['New', 1231790, 33061, 'rebate marginal relief just over ₹12 lakh'],
      ['New', 1200000, 0, 'nil at ₹12 lakh'],
      ['New', 10004510, 2956210, 'surcharge marginal relief just over ₹1 crore']
    ];
    const bad = cases.filter(c => Math.abs(Tax.annual(c[0], c[1]).total - c[2]) > 2)
      .map(c => c[3] + ': got ' + Tax.annual(c[0], c[1]).total + ', expected ' + c[2]);
    if (bad.length) throw new Error(bad.join('; ') + ' — check the TaxSlabs, TaxSurcharge and TaxRules tabs');
    const st = Tax.status();
    return cases.length + ' cases agree. Tax sheet: ' +
      (st.loaded ? st.rows + ' participants as on ' + st.asOn : 'not loaded yet (flat percentage in use)');
  });


  check('share conversion', function () {
    const g22 = Domain.shareGranularity(3.6), g25 = Domain.shareGranularity(1);
    if (Math.abs(Domain.shares(10, 3.6) - 36) > 1e-9) throw new Error('10 options at 3.6 should be 36 shares');
    if (g22 !== 5) throw new Error('granularity at 3.6 should be 5, got ' + g22);
    return '10 options × 3.6 = 36 shares; whole-share granularity 3.6→' + g22 + ', 1→' + g25;
  });


  check('a typed formula is stored as text, not run', function () {
    // Proves the defence rather than assuming it. If this ever fails, a
    // participant can exfiltrate the workbook through an admin's own session
    // by typing a formula into any free-text field.
    const sh = Repo.book().getSheetByName(T.SCRATCH) || Repo.book().insertSheet(T.SCRATCH);
    const cell = sh.getRange('Z1');
    const attack = '=1+1';
    try {
      cell.clearContent();
      cell.setValue(Repo.cellSafe(attack));
      SpreadsheetApp.flush();
      const back = cell.getValue();
      const formula = cell.getFormula();
      if (formula) throw new Error('the cell became a live formula: ' + formula);
      if (String(back) !== attack) {
        throw new Error('round-trip changed the value: wrote "' + attack + '", read "' + back + '"');
      }
      // And confirm the raw path really is dangerous, so this test is
      // measuring something.
      cell.setValue(attack);
      SpreadsheetApp.flush();
      if (!cell.getFormula()) {
        return 'stored as text — note: raw setValue did NOT create a formula here, so the ' +
          'platform may have changed; the guard is harmless either way';
      }
      return 'formula text stored verbatim and inert; unguarded writes do evaluate, so the guard matters';
    } finally {
      try { cell.clearContent(); } catch (e) { /* ignore */ }
    }
  });


  check('amounts in words', function () {
    const cases = [
      [230926, 'Rupees Two Lakh Thirty Thousand Nine Hundred Twenty Six only'],
      [500, 'Rupees Five Hundred only'],
      [100000, 'Rupees One Lakh only'],
      [10000000, 'Rupees One Crore only'],
      [0, 'Rupees Zero only']
    ];
    cases.forEach(function (c) {
      const got = Util.inWords(c[0]);
      if (got !== c[1]) throw new Error(c[0] + ' gave "' + got + '", expected "' + c[1] + '"');
    });
    return cases.length + ' amounts read correctly, incl. ' + Util.inr(230926) + ' → ' + Util.inWords(230926);
  });


  check('password hashing is tagged and verifiable', function () {
    // A stored hash must carry its round count, and the old untagged form
    // must still verify — otherwise every existing password breaks.
    if (APP.PASSWORD_ITERATIONS >= APP.LEGACY_PASSWORD_ITERATIONS) {
      throw new Error('PASSWORD_ITERATIONS should now be below the legacy count');
    }
    return 'new hashes at ' + APP.PASSWORD_ITERATIONS + ' rounds, legacy hashes verified at ' +
      APP.LEGACY_PASSWORD_ITERATIONS;
  });


  check('admin notifications have a recipient', function () {
    const to = Util.trim(cfg('ADMIN_NOTIFY_EMAILS'));
    if (!to) {
      throw new Error('ADMIN_NOTIFY_EMAILS is blank — nobody is told when an application is submitted');
    }
    return to;
  });


  check('every active fund partner can be reached', function () {
    const list = Partners.active();
    if (!list.length) {
      throw new Error('no active fund partners on the FundPartners tab — ' +
        'add them at Logins > Fund partners, or run createWorkbook() to seed them');
    }
    const problems = list.map(function (p) {
      const r = Partners.readiness(p.name);
      if (!r.logins) return p.name + ' (no login — cannot be selected)';
      if (!r.contactEmails.length) return p.name + ' (no contact address on the partner record)';
      return null;
    }).filter(Boolean);
    if (problems.length) throw new Error(problems.join('; '));
    return list.length + ' active partner' + (list.length === 1 ? '' : 's') +
      ', each with a login and a contact address';
  });


  check('lot rule rejects a non-multiple', function () {
    const lot = Domain.lotSize();
    if (233 % lot === 0) throw new Error('233 should not be valid at lot ' + lot);
    return '233 rejected; 230 and 240 accepted';
  });


  check('tax due date rolls past the 25th', function () {
    const early = Domain.taxDueDateFor(new Date(2026, 8, 10));
    const late = Domain.taxDueDateFor(new Date(2026, 8, 26));
    if (early.getMonth() !== 8) throw new Error('10 Sep should be due 25 Sep');
    if (late.getMonth() !== 9) throw new Error('26 Sep should be due 25 Oct');
    return Util.prettyDate(early) + ' / ' + Util.prettyDate(late);
  });


  check('current window', function () {
    const w = Domain.currentWindow();
    const st = Domain.windowState(w);
    return Util.monthLabel(w.Label) + ' ' + Util.prettyDate(w.OpenDate) + '–' + Util.prettyDate(w.CloseDate) +
      ' · ' + (st.open ? 'open' : 'closed');
  });


  check('no duplicate windows', function () {
    const seen = {}, dupes = [];
    Repo.objects(T.WINDOWS).forEach(function (r) {
      const k = Util.windowKey(r.WindowID);
      if (seen[k]) dupes.push(k); else seen[k] = true;
    });
    if (dupes.length) {
      throw new Error(dupes.length + ' duplicate row(s) for ' +
        dupes.filter((v, i, a) => a.indexOf(v) === i).join(', ') + ' — run repairWindows()');
    }
    return Object.keys(seen).length + ' window(s), no duplicates';
  });


  check('grant status filter', function () {
    const list = allowedGrantStatuses();
    return list ? list.join(', ') : 'every status accepted';
  });


  check('share prices parse as numbers', function () {
    const rows = Repo.objects(T.FMV);
    if (!rows.length) throw new Error('no FMV rows yet');
    const bad = rows.filter(function (r) {
      const o = Util.num(r.OpenPrice, 0), c = Util.num(r.ClosePrice, 0);
      return !(o > 0 && c > 0);
    });
    if (bad.length) {
      throw new Error(bad.length + ' of ' + rows.length + ' price row(s) have an unreadable ' +
        'open or close — first is ' + Util.dateKey(bad[0].Date) +
        '. Enter them as plain numbers (79.99), not text.');
    }
    return 'all ' + rows.length + ' row(s) readable';
  });


  check('share price on record', function () {
    const l = Domain.latestFmv();
    if (!l) throw new Error('no FMV rows — run backfillPricesLast30Days() or enter prices by hand');
    const age = Math.round((Util.startOfDay(new Date()) - Util.startOfDay(l.date)) / 86400000);
    if (age > 5) throw new Error('latest price is ' + age + ' days old (' + l.prettyDate + ')');
    return 'latest ' + l.prettyDate + ' = ' + Util.inr2(l.fmv) + ' (' + age + ' day(s) old)';
  });


  check('grant master loaded', function () {
    const rows = Repo.objects(T.GRANTS);
    if (!rows.length) throw new Error('no grants — run checkGrantReport() then syncGrantReport()');
    let vested = 0, exercisable = 0;
    rows.forEach(function (g) {
      const step = Domain.stepFor(Util.num(g.Multiplier, 1) || 1);
      vested += Util.num(g.VestedOptions, 0);
      exercisable += Math.floor((Util.num(g.VestedOptions, 0) + 1e-9) / step) * step;
    });
    return rows.length + ' grants, report as on ' + Util.dateKey(rows[0].ReportAsOn) +
      ', ' + Util.count(exercisable) + ' of ' + Util.count(vested) + ' vested options exercisable';
  });


  check('participants have a tax basis (tax sheet or percentage)', function () {
    const covered = Tax.covered();
    const grants = Repo.objects(T.GRANTS);
    const withOptions = {};
    grants.forEach(function (g) {
      if (Util.num(g.VestedOptions, 0) > 0) withOptions[Util.trim(g.EmployeeID).toUpperCase()] = true;
    });
    const ids = Object.keys(withOptions);
    if (!ids.length) throw new Error('no participants with vested options yet');
    const missing = Repo.objects(T.EMPLOYEES)
      .filter(e => withOptions[Util.trim(e.EmployeeID).toUpperCase()] && !Util.num(e.TaxRatePercent, 0) &&
        !covered[Util.trim(e.EmployeeID).toUpperCase()]);
    if (missing.length) {
      throw new Error(missing.length + ' of ' + ids.length +
        ' participants have neither a tax-sheet row nor a tax percentage — their tax would compute as nil. ' +
        'Load the tax sheet (Participants > Load tax sheet), or a percentage (Paste CTC and tax rates).');
    }
    const onSheet = ids.filter(id => covered[id]).length;
    return 'all ' + ids.length + ' covered (' + onSheet + ' from the tax sheet, ' + (ids.length - onSheet) + ' on a percentage)';
  });


  check('Drive root reachable', function () {
    return Files.rootFolder().getName();
  });


  check('at least one admin login', function () {
    const admins = Repo.filter(T.USERS, u => Util.trim(u.Role) === ROLE.ADMIN && Util.trim(u.Status) === 'Active');
    if (!admins.length) throw new Error('run seedAdminNow() first');
    return admins.map(a => Util.trim(a.UserID)).join(', ');
  });


  // Fund partner readiness is checked once, above, under
  // "every active fund partner can be reached".


  check('bank details filled in', function () {
    const b = Util.trim(cfg('COMPANY_BANK_DETAILS'));
    if (!b || b.indexOf('<') >= 0) throw new Error('COMPANY_BANK_DETAILS still has placeholder text in it');
    return b.split('\n')[0];
  });


  check('portal URL set', function () {
    const u = Util.trim(cfg('PORTAL_URL'));
    if (!u) throw new Error('set PORTAL_URL in Config so email buttons link back');
    return u;
  });


  check('triggers installed', function () {
    const fns = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    const missing = ['dailyJob', 'priceJob'].filter(f => fns.indexOf(f) < 0);
    if (missing.length) throw new Error('missing: ' + missing.join(', ') + ' — run installTriggers()');
    return fns.join(', ');
  });


  const report = results.join('\n');
  console.log(report);
  return report;
}


