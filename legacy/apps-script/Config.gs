/**
 * Config.gs — constants, sheet schema and runtime configuration.
 *
 * Shaped to the real "Vest wise Report" export and the real exercise notice:
 *
 *   options  →  shares       shares = options × the grant's Multiplier
 *                            (ESOP Plan 2022 = 3.6, ESOP Plan 2025 = 1)
 *   exercise price           ₹1 per OPTION — the notice states the total
 *                            exercise amount as the option count in rupees
 *   perquisite               (FMV × shares) − exercise amount
 *   lot size                 10 options; 10 × 3.6 = 36, so a whole lot always
 *                            converts to a whole number of shares
 *
 * Nothing secret lives here. The password pepper lives in Script Properties.
 */


const APP = {
  NAME: 'ESOP Exercise Portal',
  VERSION: '2.1.0',
  SESSION_HOURS: 8,
  // Each round is a service call out of V8 at ~1-3 ms, so this is the single
  // biggest lever on login time. See the note in Auth.hashRaw for why the
  // pepper, not the round count, is what protects the stored hashes.
  PASSWORD_ITERATIONS: 200,
  // What hashes written before the change were made with. Never change this:
  // it is how those hashes stay verifiable until their owner next signs in.
  LEGACY_PASSWORD_ITERATIONS: 5000,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 20,
  RESET_CODE_MINUTES: 30,
  MAX_UPLOAD_MB: 8,
  ALLOWED_UPLOAD_TYPES: ['application/pdf', 'image/jpeg', 'image/png']
};


/** Sheet tab names. Setup.createWorkbook() creates every one of these. */
const T = {
  CONFIG: 'Config',
  USERS: 'Users',
  EMPLOYEES: 'Employees',
  GRANTS: 'Grants',
  GRANT_IMPORT: 'Vest wise Report',
  FMV: 'FMV',
  WINDOWS: 'Windows',
  APPLICATIONS: 'Applications',
  APP_LINES: 'ApplicationLines',
  TAX_PAYMENTS: 'TaxPayments',
  FUND_PARTNERS: 'FundPartners',
  PARTNER_REQUESTS: 'FundPartnerRequests',
  AUDIT: 'AuditLog',
  EMAIL_LOG: 'EmailLog',
  // The tax on an exercise: the rules (editable), and payroll's year-to-date
  // position for each participant (loaded from the HRIMS tax sheet).
  TAX_SLABS: 'TaxSlabs',
  TAX_SURCHARGE: 'TaxSurcharge',
  TAX_RULES: 'TaxRules',
  TAX_SHEET: 'TaxSheet',
  SCRATCH: '_Scratch'
};


/** Column headers, in order. Order is safe to change; the code is header-driven. */
const SCHEMA = {
  [T.CONFIG]: ['Key', 'Value', 'Notes'],


  [T.USERS]: [
    'UserID', 'Role', 'Name', 'LoginEmail', 'FundPartnerName',
    'PasswordSalt', 'PasswordHash', 'TokenVersion', 'MustResetPassword',
    'ResetCodeHash', 'ResetCodeExpiresAt', 'FailedAttempts', 'LockedUntil',
    'Status', 'LastLoginAt', 'CreatedAt', 'CreatedBy',
    // The one-time code gets its OWN salt. It used to be hashed under
    // PasswordSalt, which meant issuing a code rewrote that salt and left the
    // stored password hash unverifiable — so anyone who knew an employee code
    // could lock that person out of their password, unauthenticated, at will.
    'ResetCodeSalt'
  ],


  // AccessEmail comes straight from the report and is the address of record —
  // for separated staff the report already carries a personal address.
  [T.EMPLOYEES]: [
    'EmployeeID', 'Name', 'Designation', 'StakeholderCategory',
    'AccessEmail', 'SecondaryEmail', 'EmailOverride',
    'Mobile', 'Address', 'Nationality', 'PAN',
    'EmploymentStatus', 'SeparationDate', 'ResignationDate',
    'CTC', 'TaxRatePercent',
    // Blocked participants keep their record and their balances but cannot
    // start or edit an application. Set by the ESOP team; never touched by a
    // report sync.
    'Blocked', 'BlockedReason', 'BlockedAt', 'BlockedBy',
    'DriveFolderId', 'Remarks', 'UpdatedAt',
    // Details the ESOP team already holds for long-standing participants.
    // Seeded onto a new application so they do not have to retype them,
    // and written back here whenever a participant confirms their own.
    // APPENDED deliberately: adding columns at the end keeps 2,000+
    // existing rows aligned under their original headings.
    'DematDPName', 'DematDPId', 'DematClientId', 'DematAccountName',
    'DematAccountType'
  ],


  // One row per GRANT, rolled up from the report's tranche rows.
  // VestedOptions is the report's own Vested figure, which is ALREADY net of
  // exercised, pending and cancelled — do not subtract those again.
  // TrancheDetail holds the per-tranche breakdown as JSON so the tranche view
  // costs one cell rather than its own tab.
  [T.GRANTS]: [
    'GrantID', 'EmployeeID', 'PlanName', 'Multiplier', 'GrantDate',
    'ExercisePrice', 'TypeOfVesting', 'GrantStatus',
    'TotalGranted', 'UnvestedOptions', 'VestedOptions',
    'ExercisedOptions', 'ExercisePendingOptions', 'CancelledOptions',
    'TrancheCount', 'VestedTrancheCount', 'NextVestDate', 'LastVestDate',
    'ExpiryDate', 'TrancheDetail', 'ReportAsOn', 'LastSyncedAt'
  ],


  [T.FMV]: ['Date', 'OpenPrice', 'ClosePrice', 'FMV', 'Source', 'EnteredBy', 'EnteredAt'],


  [T.WINDOWS]: [
    'WindowID', 'Label', 'OpenDate', 'CloseDate', 'TaxDueDate',
    'Status', 'CreatedAt', 'ClosedAt', 'Remarks'
  ],


  [T.APPLICATIONS]: [
    'AppID', 'WindowID', 'EmployeeID', 'Status', 'Stage',
    'TotalOptions', 'TotalShares', 'ExercisePrice', 'ExerciseAmount',
    'FMVDate', 'FMVValue', 'PerquisiteAmount', 'TaxRatePercent', 'TaxAmount',
    'DematDPName', 'DematDPId', 'DematClientId', 'DematAccountName',
    'PANNumber', 'CMLFileId', 'PANFileId',
    'ApplicantAddress', 'ApplicantNationality', 'ApplicantMobile', 'ApplicantDesignation',
    'ExercisePaymentUTR', 'ExercisePaymentDate', 'ExercisePaymentAmount',
    'ExercisePaymentBank', 'ExerciseProofFileId',
    'TaxMode', 'FundPartnerName',
    'TaxPaymentUTR', 'TaxPaymentDate', 'TaxPaymentAmount',
    'TaxPaymentBank', 'TaxProofFileId', 'TaxDueDate',
    // Aggregate over the TaxPayments rows, kept here so the queue and the
    // export do not have to re-add them.
    'TaxPaidAmount', 'TaxPaymentCount',
    'DematAccountType',
    'NoticeSignatureName', 'NoticeSignedAt', 'NoticePlace', 'NoticeFileId',
    'ReviewOptions', 'ReviewDemat', 'ReviewExercisePayment',
    'ReviewTaxPayment', 'ReviewNotice',
    'AdminRemarks', 'ReviewedBy', 'ReviewedAt', 'ApprovedAt',
    'FolderId', 'CreatedAt', 'UpdatedAt', 'SubmittedAt',
    // Blank when the participant supplied the demat account themselves; the
    // partner's name when the shares are being allotted into an account the
    // participant opened with that partner and the partner keyed it in.
    'DematSource',
    // How the tax was worked out — 'Sheet' (from payroll's year-to-date
    // position) or 'Flat' (a percentage of the perquisite) — and every step of
    // it as JSON, so the screen can explain the figure and an auditor can
    // reproduce it. Appended, never reordered.
    'TaxMethod', 'TaxBreakdown'
  ],


  [T.APP_LINES]: [
    'LineID', 'AppID', 'GrantID', 'PlanName', 'Multiplier',
    'OptionsExercised', 'SharesAllotted', 'ExercisePrice',
    'LineExerciseAmount', 'PerquisitePerShare', 'LinePerquisite', 'UpdatedAt'
  ],


  // One row per tax remittance. A participant may pay the tax across
  // several UTRs - 2L now, 3L later - so the tax section is complete when
  // the SUM reaches the amount due, not on any single entry. A fund
  // partner pays in one go, but its payment is mirrored here too so the
  // admin screen and the export read from one place.
  [T.TAX_PAYMENTS]: [
    'PaymentID', 'AppID', 'EmployeeID', 'Seq', 'PaidBy', 'FundPartnerName',
    'UTR', 'PaymentDate', 'Amount', 'Bank', 'ProofFileId',
    'EnteredBy', 'EnteredAt', 'Remarks'
  ],


  // The fund partners, managed from the portal rather than in code.
  //
  // Rows are never deleted, only deactivated: an application from an earlier
  // window records its partner by name, and removing the row would leave that
  // history pointing at nothing. Deactivating stops new applications choosing
  // it while every existing one still resolves.
  [T.FUND_PARTNERS]: [
    'PartnerName', 'Status', 'ContactEmails', 'Notes',
    'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'
  ],


  [T.PARTNER_REQUESTS]: [
    'RequestID', 'AppID', 'EmployeeID', 'FundPartnerName', 'TaxAmount',
    'Status', 'AssignedAt', 'PaymentUTR', 'PaymentDate', 'PaymentAmount',
    'PaymentBank', 'ProofFileId', 'FedBy', 'FedAt', 'Remarks',


    // The demat account the shares are allotted to when a partner funds the
    // tax. That account is opened with the partner, so the partner holds the
    // identifiers and enters them here on the participant's behalf — the
    // participant often does not know their own new DP ID yet. Appended,
    // never reordered, so existing rows stay aligned.
    'PartnerDPName', 'PartnerDPId', 'PartnerClientId',
    'PartnerAccountType', 'PartnerAccountName',
    'DematProvidedBy', 'DematProvidedAt',
    // The participant's own account as it stood before the partner's took
    // over, so switching back to paying the tax themselves restores it
    // instead of leaving them with the partner's identifiers.
    'EmployeeDPName', 'EmployeeDPId', 'EmployeeClientId',
    'EmployeeAccountType', 'EmployeeAccountName',


    // The client master list for the partner-held account, and the
    // participant's own CML as it stood before it. The shares are allotted
    // against the partner's account, so the partner's CML is the one the
    // registrar needs — and the participant's has to be recoverable if they
    // switch back to paying the tax themselves. Appended, never reordered.
    'CMLFileId', 'EmployeeCMLFileId'
  ],


  [T.AUDIT]: ['Timestamp', 'Actor', 'Role', 'Action', 'AppID', 'Details'],


  [T.EMAIL_LOG]: ['Timestamp', 'Template', 'To', 'Cc', 'Subject', 'AppID', 'Result'],


  // The rules. Edit a cell here when the Finance Act changes; no code change.
  [T.TAX_SLABS]: ['Regime', 'AboveAmount', 'RatePercent', 'Note'],
  [T.TAX_SURCHARGE]: ['Regime', 'AboveAmount', 'RatePercent', 'Note'],
  [T.TAX_RULES]: ['Regime', 'Rule', 'Value', 'Note'],


  // One row per participant, replaced each cycle from the HRIMS tax sheet.
  [T.TAX_SHEET]: [
    'EmployeeID', 'Regime', 'NetTaxable', 'TotalGross', 'ProjectedGross',
    'TotalTax', 'PreviousTDS', 'OutsideTax', 'TDSToDate', 'RemainingMonths',
    'AsOn', 'LoadedAt', 'LoadedBy', 'Flags', 'EngineTotal'
  ]
};


/**
 * Columns that hold identifiers, not quantities, and so must stay text.
 *
 * Sheets reads a typed or pasted "01234567" as the number 1234567 and drops
 * the leading zero for good — which for a DP ID, a client ID, a mobile number
 * or a bank reference is a different identifier, not a cosmetic change. A
 * column formatted as plain text keeps what it was given. Compared on the
 * lower-cased letters of the heading, so "ClientID" and "Client ID" both match.
 */
const TEXT_COLUMN_NAMES = [
  'employeeid', 'userid', 'mobile', 'applicantmobile', 'pan', 'pannumber',
  'dpid', 'clientid', 'dematdpid', 'dematclientid', 'partnerdpid', 'partnerclientid',
  'employeedpid', 'employeeclientid', 'utr', 'exerciseutr', 'exercisepaymentutr',
  'taxpaymentutr', 'paymentutr', 'grantid', 'bankaccount', 'accountnumber'
];


function isTextColumn(heading) {
  return TEXT_COLUMN_NAMES.indexOf(String(heading || '').toLowerCase().replace(/[^a-z]/g, '')) >= 0;
}


/** Format the identifier columns of a sheet as plain text, header to the last row. */
function applyTextColumns(sh, headers) {
  headers.forEach(function (h, i) {
    if (isTextColumn(h)) sh.getRange(1, i + 1, Math.max(sh.getMaxRows(), 2), 1).setNumberFormat('@');
  });
}


/** Application lifecycle. */
const STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  SENT_BACK: 'Sent Back',
  APPROVED: 'Approved',
  REJECTED: 'Rejected'
};


const REVIEW = { PENDING: 'Pending', OK: 'Verified', BACK: 'Sent Back' };


const ROLE = { EMPLOYEE: 'Employee', ADMIN: 'Admin', PARTNER: 'FundPartner' };


const TAX_MODE = { SELF: 'Self', PARTNER: 'FundPartner' };


/**
 * The two depositories. The identifier shapes differ, so knowing which one
 * an account sits with lets the portal check the DP ID and client ID
 * properly instead of guessing from their format.
 */
const DEMAT_TYPES = ['NSDL', 'CDSL'];


const PARTNER_STATUS = {
  ASSIGNED: 'Assigned',
  PAID: 'Payment Fed',
  VERIFIED: 'Verified',
  SENT_BACK: 'Sent Back',
  // The partner turned the request down. The participant is released to pick
  // another partner or pay the tax themselves.
  DECLINED: 'Declined'
};


/**
 * The fund partners as at first setup — seed values only.
 *
 * The live list is the FundPartners tab, managed by the ESOP team from the
 * portal, because who the partners are will change and that should not need
 * a code push. These names are written into the tab the first time
 * createWorkbook() finds it empty, and never consulted again.
 *
 * Use Partners.names() / Partners.activeNames() everywhere instead.
 */
const DEFAULT_FUND_PARTNERS = [
  'Funds India with Infina Finance Pvt Ltd',
  'Funds India with Bajaj',
  'Nuvama'
];


const STAGES = [
  { key: 'options', label: 'Options to exercise' },
  { key: 'demat', label: 'Applicant, demat & PAN' },
  { key: 'exercise', label: 'Exercise payment' },
  { key: 'tax', label: 'Tax payment' },
  { key: 'notice', label: 'Exercise notice' },
  { key: 'submit', label: 'Submit' }
];


/**
 * The report's own column headings, and the aliases worth tolerating in case a
 * future export renames one. Keys are the portal's internal names.
 */
const REPORT_COLUMNS = {
  planName:        ['Plan Name'],
  designation:     ['Employee Designation', 'Designation'],
  category:        ['Stakeholder Category'],
  employeeId:      ['Employee ID', 'Emp ID', 'Employee Code'],
  employeeName:    ['Stakeholder Name', 'Employee Name'],
  awardeeStatus:   ['Awardee Status'],
  separationDate:  ['Separation Date(Last Working Date)', 'Separation Date'],
  resignationDate: ['Resignation Date'],
  grantId:         ['Grant ID'],
  grantDate:       ['Grant Date'],
  trancheId:       ['Tranche ID'],
  actualVestDate:  ['Actual Vest Date'],
  vestDate:        ['Vest Date'],
  typeOfVesting:   ['Type of Vesting'],
  expiryDate:      ['Expiry Date'],
  exercisePrice:   ['Exercise Price'],
  grantStatus:     ['Grant Status'],
  granted:         ['Granted'],
  unvested:        ['Unvested'],
  vested:          ['Vested'],
  outstanding:     ['Quantity Outstanding'],
  exercisePending: ['Exercises Pending for Approval'],
  exercised:       ['Exercised'],
  cancelled:       ['Cancelled'],
  lapsed:          ['Lapsed'],
  unvestedCancelled: ['Unvested Cancelled'],
  vestedCancelled: ['Vested Cancelled'],
  accessEmail:     ['Access Email ID'],
  secondaryEmail:  ['Secondary Email ID'],
  multiplier:      ['Multiplier'],


  // OPTIONAL prefill columns. Add any of these to the report after
  // Multiplier and the sync will carry them onto the participant master.
  // A BLANK cell means "leave whatever is already on record", so a report
  // that no longer carries the column - next month's refresh, say -
  // never wipes what a previous one loaded.
  pan:             ['PAN', 'PAN Number', 'Pan No', 'PAN No'],
  mobile:          ['Mobile', 'Mobile Number', 'Contact Number', 'Phone'],
  address:         ['Address', 'Member Address', 'Residential Address'],
  nationality:     ['Nationality'],
  dematAccountType: ['Demat Account Type', 'Account Type', 'Depository'],
  dematDPName:     ['Depository Participant Name', 'DP Name', 'Depository Participant'],
  dematDPId:       ['DP ID', 'DPID', 'DP Id'],
  dematClientId:   ['Client ID', 'ClientID', 'Client Id', 'BO ID'],
  dematAccountName: ['Demat Account Holder Name', 'Account Holder Name', 'Demat Account Name']
};


/** Config defaults, written into the Config tab by Setup and editable there. */
const CONFIG_DEFAULTS = {
  COMPANY_NAME: 'Physicswallah Limited',
  COMPANY_FORMER_NAME: 'Formerly known as ‘Physicswallah Private Limited’',
  COMPANY_ADDRESS: 'Plot No. B-8, Tower A 101-119,\nKLJ Noida One, 1st Floor, Sector-62, UP- 201309.',
  PLAN_NAME: 'Employees’ Stock Option Plan',
  EXERCISE_PRICE: '1',
  OPTION_LOT_SIZE: '10',
  // Used when the report leaves Multiplier blank, as it does for every
  // Test Plan row. 1 means an option converts to one share.
  DEFAULT_MULTIPLIER: '1',
  // 'grant' = each grant must be exercised in multiples of 10 on its own.
  // 'total' = the multiple-of-10 test applies to the total across grants,
  //           which lets small per-grant balances be combined.
  LOT_SCOPE: 'grant',
  // Test Plan is included so the ESOP team can walk the whole flow on real
  // machinery without touching a live participant's options.
  ALLOWED_PLANS: 'ESOP Plan 2022, ESOP Plan 2025, Test Plan',
  // Grant statuses whose options may be exercised. 'Cancelled' and
  // 'PendingApproval' are deliberately absent: a cancelled grant is gone, and
  // one still awaiting approval has not been made yet.
  ALLOWED_GRANT_STATUSES: 'Accepted, PendingAcceptance',
  WINDOW_OPEN_DAY: '1',
  WINDOW_CLOSE_DAY: '30',
  TAX_DUE_DAY: '25',
  NSE_SYMBOL: 'PWL',
  NSE_SERIES: 'EQ',
  // Set false if NSE refuses requests from Apps Script; the jobs then skip
  // the fetch entirely instead of waiting on a connection that never answers.
  NSE_FETCH_ENABLED: 'true',
  // Google Finance ticker, used as the fallback source. It runs inside Sheets
  // so it cannot be blocked or hang the way an outbound NSE request can.
  // Verify it returns PWL before relying on it.
  GF_TICKER: 'NSE:PWL',
  // Who may use the portal. Blank means every participant on the vesting
  // report. A list of employee codes limits it to those people — nobody
  // else can sign in, be given a login, or be invited. Maintained from the
  // Participants screen; this is only its default.
  ELIGIBLE_EMPLOYEE_IDS: '',
  DRIVE_ROOT_FOLDER_ID: '',
  // The company logo, shown on every screen, the exercise notice and the
  // emails. A Drive file ID — the long code in the file's share link.
  LOGO_FILE_ID: '1pN_LfSYbRlzfwXSJs5W1-L1ykZZy_ZeT',
  // The browser-tab icon. It must be a PUBLIC https URL, because the tab
  // belongs to Google's page frame, not to ours — a data URI or a private
  // Drive file cannot reach it. Blank leaves the Apps Script default.
  LOGO_URL: '',


  /**
   * Shown while a screen loads. Separate them with a vertical bar.
   *
   * Deliberately about the scheme rather than the company: these are facts
   * this system can vouch for. Anything about PhysicsWallah itself should be
   * added by whoever can approve it — see LOADING_FACTS in the guide.
   */
  LOADING_FACTS: [
    'your fair market value is the average of the opening and closing PWL price on the trading day before you pay',
    'the exercise amount is ₹1 for each option — not for each share',
    'options are exercised in multiples of 10, so a whole lot always converts to a whole number of shares',
    'an ESOP Plan 2022 option converts to 3.6 equity shares, while an ESOP Plan 2025 option converts to 1',
    'the perquisite is the value of your shares less what you paid to exercise, and it is taxed as salary',
    'tax on your exercise is due by the 25th, and you can pay it in more than one instalment',
    'you can save an application at any stage and come back to it later',
    'anyone who has left the company can still exercise, using their employee code and personal email',
    'every figure on screen has a small i beside it that shows exactly how it was worked out'
  ].join(' | '),
  SUPPORT_EMAIL: '',
  ADMIN_NOTIFY_EMAILS: '',
  // Sender identity. The script runs as whichever Google account owns it, so
  // until ownership moves to the ESOP account these three are what make the
  // portal's mail look and reply as the ESOP team rather than an individual.
  EMAIL_SENDER_NAME: 'PhysicsWallah ESOP Team',
  EMAIL_REPLY_TO: '',
  // Only works if this address is a verified send-as alias on the sending
  // account. Leave blank otherwise — Gmail ignores an unverified alias.
  EMAIL_FROM: '',
  COMPANY_BANK_DETAILS:
    'Account Name: Physicswallah Limited\n' +
    'Bank Name: ICICI Bank\n' +
    'IFSC Code: ICIC0000816\n' +
    'Account Number: 081605012055\n' +
    'Branch: Noida, Sector-63\n' +
    'Account Type: Current Account\n' +
    'Mode: NEFT / RTGS / IMPS / Bank Transfer only',
  TAX_BANK_DETAILS:
    'Account Name: Physicswallah Limited\n' +
    'Bank Name: ICICI Bank\n' +
    'IFSC Code: ICIC0000816\n' +
    'Account Number: 081605012055\n' +
    'Branch: Noida, Sector-63\n' +
    'Account Type: Current Account\n' +
    'Mode: NEFT / RTGS / IMPS / Bank Transfer only',
  PAYMENT_REFERENCE_FORMAT: 'ESOP Exercise – {EMPLOYEE_ID} – {NAME}',
  NOTICE_TEMPLATE_DOC_ID: '',
  EMAILS_ENABLED: 'true',
  // Nothing may email participants EN MASSE unless this is explicitly true.
  // It gates the window announcement and any bulk login provisioning; the
  // per-application emails to one participant already in a flow are not
  // affected. Deliberately false: a stray bulk send cannot be recalled.
  BULK_EMAILS_ENABLED: 'false',
  // 'manual'  a new login is created WITHOUT emailing anyone; the portal
  //           shows the one-time code for the ESOP team to pass on.
  // 'auto'    the code is emailed on creation.
  INVITE_EMAILS: 'manual',
  PORTAL_URL: '',
  GRANT_SOURCE_SPREADSHEET_ID: '',
  GRANT_SOURCE_TAB: '',
  // A tab of one row per participant carrying PAN, mobile, address and
  // demat details. Kept SEPARATE from the vesting report on purpose: the
  // report tab is replaced wholesale every month, this one is not.
  DETAILS_SOURCE_TAB: 'Participant Details',
  // Blank means: look in the vesting report's file, then in this workbook.
  DETAILS_SOURCE_SPREADSHEET_ID: '',
  REPORT_HEADER_ROW: '4'
};


let _configCache = null;


/** Read a Config value, falling back to CONFIG_DEFAULTS. */
function cfg(key, fallback) {
  if (_configCache === null) {
    _configCache = {};
    try {
      Repo.objects(T.CONFIG).forEach(r => {
        if (r.Key) {
          _configCache[String(r.Key).trim()] =
            String(r.Value === null || r.Value === undefined ? '' : r.Value);
        }
      });
    } catch (e) {
      _configCache = {};
    }
  }
  const v = _configCache[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  return CONFIG_DEFAULTS[key] !== undefined ? CONFIG_DEFAULTS[key] : '';
}


function cfgNum(key, fallback) {
  const n = Number(cfg(key, fallback === undefined ? undefined : String(fallback)));
  return isNaN(n) ? (fallback || 0) : n;
}


function cfgBool(key) {
  return String(cfg(key)).toLowerCase() === 'true';
}


/** ALLOWED_PLANS as a trimmed list. Anything else in the report is ignored. */
function allowedPlans() {
  return String(cfg('ALLOWED_PLANS'))
    .split(',').map(s => s.trim()).filter(Boolean);
}


/**
 * Grant statuses whose options may be exercised.
 * Honours the older boolean REQUIRE_GRANT_ACCEPTED=false as 'allow everything'
 * so an existing Config tab keeps behaving as it did.
 */
function allowedGrantStatuses() {
  const list = String(cfg('ALLOWED_GRANT_STATUSES'))   // also warms the cache
    .split(',').map(s => s.trim()).filter(Boolean);
  const legacy = _configCache ? _configCache['REQUIRE_GRANT_ACCEPTED'] : undefined;
  if (legacy !== undefined && String(legacy).toLowerCase() === 'false') return null;   // null = no filter
  return list.length ? list : null;
}


/** True only when bulk participant emails have been explicitly turned on. */
function bulkEmailsAllowed() {
  return cfgBool('BULK_EMAILS_ENABLED');
}


/** True when creating a login should email the one-time code itself. */
function inviteEmailsAuto() {
  return Util.trim(cfg('INVITE_EMAILS')).toLowerCase() === 'auto';
}


function clearConfigCache() {
  _configCache = null;
}


