/**
 * Api.gs — the web app entry point and the single RPC door.
 *
 * The client calls exactly one server function, `rpc(method, token, payload)`.
 * Every method is looked up in one table that records the role it needs, so
 * there is no route where an authorisation check could be forgotten.
 */


function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.appName = APP.NAME;
  t.companyName = cfg('COMPANY_NAME');
  // Passed into the page itself so the very first loading screen can show
  // them — it appears before any server call has returned.
  t.facts = JSON.stringify(loadingFacts());


  const out = t.evaluate()
    .setTitle(cfg('COMPANY_NAME') + ' — ESOP Exercise Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');


  // The browser tab belongs to Google's outer frame, not to our document, so
  // a <link rel="icon"> inside the page cannot change it and a data URI is no
  // use here. Only a public https URL works.
  //
  // WRAPPED, and it must stay wrapped. setFaviconUrl throws if it dislikes
  // the image — "The favicon icon image type is not supported" for a WebP,
  // for instance — and an exception here takes down the WHOLE PORTAL. A tab
  // icon is decoration; it must never be able to stop anyone signing in.
  const icon = Util.trim(cfg('LOGO_URL'));
  if (icon) {
    try {
      out.setFaviconUrl(icon);
    } catch (err) {
      console.warn('LOGO_URL rejected as a tab icon (' + err.message +
        '). The portal is unaffected; run makeFaviconNow() to generate a PNG that works.');
    }
  }
  return out;
}


/** The rotating "did you know" lines, as an array. */
function loadingFacts() {
  return String(cfg('LOADING_FACTS') || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}


/** Used by Index.html to pull in the CSS and JS partials. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/**
 * method -> { role, fn }
 *   role null  = no session needed (login, reset)
 *   role '*'   = any signed-in user
 */
function RPC_METHODS() {
  return {
    /* --- public --- */
    'bootstrap':              { role: null, fn: (s, p) => publicBootstrap() },
    // One call that does the work of bootstrap + auth.session + the landing
    // screen. Every google.script.run round trip costs 0.4-1s of pure
    // transport, so three sequential calls to open the portal was most of
    // the wait before anything appeared.
    'boot':                   { role: null, fn: (s, p, token) => boot(token) },
    'auth.login':             { role: null, fn: (s, p) => login(p.userId, p.password) },
    'auth.requestResetCode':  { role: null, fn: (s, p) => Auth.requestResetCode(p.userId) },
    'auth.setPasswordWithCode': { role: null, fn: (s, p) => Auth.setPasswordWithCode(p.userId, p.code, p.newPassword) },


    /* --- any signed-in user --- */
    'auth.session':           { role: '*', fn: (s) => sessionView(s) },
    'auth.changePassword':    { role: '*', fn: (s, p) => Auth.changePassword(s, p.currentPassword, p.newPassword) },


    /* --- employee --- */
    'emp.dashboard':          { role: ROLE.EMPLOYEE, fn: (s) => EmployeeApi.dashboard(s) },
    'emp.quote':              { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.quote(s, p.lines) },
    'emp.saveOptions':        { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.saveOptions(s, p) },
    'emp.saveDemat':          { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.saveDemat(s, p) },
    'emp.saveExercisePayment':{ role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.saveExercisePayment(s, p) },
    'emp.chooseTaxMode':      { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.chooseTaxMode(s, p) },
    'emp.addTaxPayment':      { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.addTaxPayment(s, p) },
    'emp.deleteTaxPayment':   { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.deleteTaxPayment(s, p) },
    'emp.notice':             { role: ROLE.EMPLOYEE, fn: (s) => EmployeeApi.getNotice(s) },
    'emp.application':        { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.applicationById(s, p) },
    'emp.signNotice':         { role: ROLE.EMPLOYEE, fn: (s, p) => EmployeeApi.signNotice(s, p) },
    'emp.submit':             { role: ROLE.EMPLOYEE, fn: (s) => EmployeeApi.submit(s) },


    /* --- admin --- */
    'admin.queue':            { role: ROLE.ADMIN, fn: (s, p) => AdminApi.queue(s, p) },
    'admin.detail':           { role: ROLE.ADMIN, fn: (s, p) => AdminApi.detail(s, p.appId) },
    'admin.document':         { role: ROLE.ADMIN, fn: (s, p) => AdminApi.document(s, p.appId, p.fileId) },
    'admin.reviewSection':    { role: ROLE.ADMIN, fn: (s, p) => AdminApi.reviewSection(s, p.appId, p.section, p.verdict, p.remarks) },
    'admin.reviewMany':       { role: ROLE.ADMIN, fn: (s, p) => AdminApi.reviewMany(s, p) },
    'admin.approve':          { role: ROLE.ADMIN, fn: (s, p) => AdminApi.approve(s, p.appId, p.remarks) },
    'admin.sendBack':         { role: ROLE.ADMIN, fn: (s, p) => AdminApi.sendBack(s, p.appId, p.remarks) },
    'admin.reject':           { role: ROLE.ADMIN, fn: (s, p) => AdminApi.reject(s, p.appId, p.remarks) },
    'admin.syncGrants':       { role: ROLE.ADMIN, fn: (s, p) => AdminApi.syncGrants(s, p) },
    'admin.syncDetails':      { role: ROLE.ADMIN, fn: (s) => AdminApi.syncDetails(s) },
    'admin.employees':        { role: ROLE.ADMIN, fn: (s, p) => AdminApi.employees(s, p) },
    'admin.saveEmployee':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.saveEmployee(s, p) },
    'admin.bulkTaxRates':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.bulkTaxRates(s, p.rows) },
    'admin.setBlocked':       { role: ROLE.ADMIN, fn: (s, p) => AdminApi.setBlocked(s, p) },
    'admin.bulkBlock':        { role: ROLE.ADMIN, fn: (s, p) => AdminApi.bulkBlock(s, p) },
    'admin.taxSheetInfo':     { role: ROLE.ADMIN, fn: (s) => AdminApi.taxSheetInfo(s) },
    'admin.taxSheetReport':   { role: ROLE.ADMIN, fn: (s) => AdminApi.taxSheetReport(s) },
    'admin.loadTaxSheet':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.loadTaxSheet(s, p) },
    'admin.setEnabledList':   { role: ROLE.ADMIN, fn: (s, p) => AdminApi.setEnabledList(s, p) },
    'admin.bulkDetails':      { role: ROLE.ADMIN, fn: (s, p) => AdminApi.bulkParticipantDetails(s, p) },
    'admin.fmvList':          { role: ROLE.ADMIN, fn: (s, p) => AdminApi.fmvList(s, p && p.limit) },
    'admin.saveFmv':          { role: ROLE.ADMIN, fn: (s, p) => AdminApi.saveFmv(s, p) },
    'admin.fetchFmv':         { role: ROLE.ADMIN, fn: (s, p) => AdminApi.fetchFmv(s, p.date) },
    'admin.loadFmvFromNse':   { role: ROLE.ADMIN, fn: (s, p) => AdminApi.loadFmvFromNse(s, p.date) },
    'admin.backfillFmv':      { role: ROLE.ADMIN, fn: (s, p) => AdminApi.backfillFmv(s, p) },
    'admin.saveWindow':       { role: ROLE.ADMIN, fn: (s, p) => AdminApi.saveWindow(s, p) },
    'admin.announceWindow':   { role: ROLE.ADMIN, fn: (s, p) => AdminApi.announceWindow(s, p) },
    'admin.users':            { role: ROLE.ADMIN, fn: (s) => AdminApi.users(s) },
    'admin.partners':         { role: ROLE.ADMIN, fn: (s) => AdminApi.partners(s) },
    'admin.savePartner':      { role: ROLE.ADMIN, fn: (s, p) => AdminApi.savePartner(s, p) },
    'admin.partnerLogin':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.createPartnerLogin(s, p) },
    'admin.setPartnerStatus': { role: ROLE.ADMIN, fn: (s, p) => AdminApi.setPartnerStatus(s, p) },
    'admin.provisionUser':    { role: ROLE.ADMIN, fn: (s, p) => AdminApi.provisionUser(s, p) },
    'admin.provisionAll':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.provisionAllEmployees(s, p) },
    'admin.setUserStatus':    { role: ROLE.ADMIN, fn: (s, p) => AdminApi.setUserStatus(s, p.userId, p.status) },
    'admin.config':           { role: ROLE.ADMIN, fn: (s) => AdminApi.config(s) },
    'admin.saveConfig':       { role: ROLE.ADMIN, fn: (s, p) => AdminApi.saveConfig(s, p.key, p.value) },
    'admin.exportWindow':     { role: ROLE.ADMIN, fn: (s, p) => AdminApi.exportWindow(s, p && p.windowId) },
    'admin.runReminders':     { role: ROLE.ADMIN, fn: (s) => Triggers.runRemindersNow(s) },


    /* --- fund partner --- */
    'fp.dashboard':           { role: ROLE.PARTNER, fn: (s) => PartnerApi.dashboard(s) },
    'fp.savePayment':         { role: ROLE.PARTNER, fn: (s, p) => PartnerApi.savePayment(s, p) },
    'fp.saveDemat':           { role: ROLE.PARTNER, fn: (s, p) => PartnerApi.saveDemat(s, p) },
    'fp.submitAll':           { role: ROLE.PARTNER, fn: (s, p) => PartnerApi.submitAll(s, p) },
    'fp.decline':             { role: ROLE.PARTNER, fn: (s, p) => PartnerApi.decline(s, p) }
  };
}


/**
 * The one server call the client makes.
 * Always resolves; failures come back as { ok:false, error, authFailure }.
 */
function rpc(method, token, payload) {
  const started = new Date().getTime();
  try {
    const table = RPC_METHODS();
    const entry = table[String(method)];
    if (!entry) throw new Error('Unknown request "' + method + '".');


    let session = null;
    if (entry.role !== null) {
      session = Auth.verifyToken(token);
      if (entry.role !== '*' && session.role !== entry.role) {
        throw new Error('Your login does not have access to that.');
      }
    }


    const data = entry.fn(session, payload || {}, token);
    const ms = new Date().getTime() - started;
    const st = Repo.stats();
    // Logged on every call so a slow screen can be diagnosed from the
    // executions list without adding instrumentation after the fact.
    console.log(method + ' ' + ms + 'ms · ' + st.reads + ' reads (' + st.readMs +
      'ms, ' + st.cells + ' cells) · ' + st.writes + ' writes (' + st.writeMs +
      'ms) · ' + JSON.stringify(st.tabs));
    return {
      ok: true,
      data: data === undefined ? null : data,
      ms: ms,
      perf: { reads: st.reads, writes: st.writes, cells: st.cells, readMs: st.readMs, writeMs: st.writeMs }
    };
  } catch (e) {
    const message = (e && e.message) ? e.message : String(e);
    console.error(method + ': ' + message + (e && e.stack ? '\n' + e.stack : ''));
    return {
      ok: false,
      error: message,
      authFailure: !!(e && e.authFailure),
      ms: new Date().getTime() - started
    };
  }
}


/** Branding and feature flags the login screen needs before anyone signs in. */
function publicBootstrap() {
  return {
    appName: APP.NAME,
    version: APP.VERSION,
    companyName: cfg('COMPANY_NAME'),
    planName: cfg('PLAN_NAME'),
    logo: Files.logoDataUri(),
    facts: loadingFacts(),
    supportEmail: cfg('SUPPORT_EMAIL'),
    lotSize: Domain.lotSize(),
    lotScope: Domain.lotScope(),
    dematTypes: DEMAT_TYPES,
    exercisePrice: cfgNum('EXERCISE_PRICE', 1),
    resetCodeMinutes: APP.RESET_CODE_MINUTES,
    maxUploadMb: APP.MAX_UPLOAD_MB
  };
}


/**
 * The landing payload for whoever this is — the same data their first screen
 * would have fetched on its own.
 */
function homeFor(session) {
  if (session.role === ROLE.EMPLOYEE) return { kind: 'employee', data: EmployeeApi.dashboard(session) };
  if (session.role === ROLE.ADMIN)    return { kind: 'admin', data: AdminApi.queue(session, {}) };
  if (session.role === ROLE.PARTNER)  return { kind: 'partner', data: PartnerApi.dashboard(session) };
  return null;
}


/**
 * Open the portal in one call: branding, the session if the saved token is
 * still good, and that user's landing screen.
 *
 * A bad or absent token is not an error here — it just means nobody is signed
 * in yet, and the login screen is what should render.
 */
function boot(token) {
  const out = publicBootstrap();
  out.session = null;
  out.home = null;
  if (Util.trim(token)) {
    try {
      const session = Auth.verifyToken(token);
      out.session = sessionView(session);
      out.home = homeFor(session);
    } catch (e) {
      out.sessionEnded = e.message;
    }
  }
  return out;
}


/** Sign in and hand back the landing screen in the same call. */
function login(userId, password) {
  const r = Auth.login(userId, password);
  if (!r.user.mustResetPassword) {
    // Anyone who must set a password first goes to that screen instead, so
    // there is nothing to preload for them.
    try {
      r.home = homeFor(Auth.verifyToken(r.token));
    } catch (e) {
      r.home = null;   // never let a preload failure block a valid login
    }
  }
  return r;
}


function sessionView(session) {
  return {
    userId: session.userId,
    role: session.role,
    name: session.name,
    email: session.email,
    fundPartnerName: session.fundPartnerName
  };
}


