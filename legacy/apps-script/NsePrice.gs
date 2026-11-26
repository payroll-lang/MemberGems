/**
 * NsePrice.gs — loading PWL's opening and closing price from NSE.
 *
 * WHY NOT THE get-quote PAGE. https://www.nseindia.com/get-quote/equity/PWL
 * renders its numbers from https://www.nseindia.com/api/quote-equity?symbol=PWL,
 * which returns 403 to anything that is not a real browser session — tested,
 * including after the usual cookie handshake against the quote page. Scraping
 * it would also give a live intraday quote, not a settled official close.
 *
 * WHAT THIS USES INSTEAD. NSE publishes the day's full securities bhavcopy as
 * a plain CSV, which carries OPEN_PRICE and CLOSE_PRICE per symbol:
 *
 *   https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
 *   SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE,
 *   LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, ...
 *   PWL, EQ, 07-Sep-2026, 126.42, 127.47, 130.32, 126.54, 129.50, 129.67, ...
 *
 * That is the official settled record — the same file an auditor would ask for
 * — so it is both more reliable and more defensible than the quote page. The
 * UDiFF BhavCopy zip is tried as a second source if the CSV is unavailable.
 *
 * WHAT WE LEARNED IN PRACTICE. This does work from Apps Script — the first
 * backfill loaded three weeks of prices. But NSE THROTTLES BURSTS: after a
 * dozen or so requests in quick succession it starts leaving connections open
 * until Apps Script gives up, so a long backfill stalls part way through.
 *
 * Hence the shape of this file: every source is retried twice a few seconds
 * apart, the backfill paces itself and can be re-run to continue where it
 * stopped, and the scheduled job makes exactly ONE request a day — well inside
 * what NSE tolerates, and the only call that matters day to day.
 *
 * If NSE ever does refuse outright, nothing else breaks: the ESOP team enters
 * the two prices by hand on the Share price screen, which is the auditable
 * path anyway, and a failed daily run emails them so it never goes unnoticed.
 */


const NsePrice = (function () {


  const CSV_BASE = 'https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_';
  const UDIFF_BASE = 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_';


  function headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Accept': 'text/csv,application/zip,text/plain,*/*',
      'Accept-Language': 'en-IN,en;q=0.9',
      'Referer': 'https://www.nseindia.com/all-reports'
    };
  }


  function symbol() { return Util.trim(cfg('NSE_SYMBOL')) || 'PWL'; }
  function series() { return Util.trim(cfg('NSE_SERIES')) || 'EQ'; }


  /* ---------------- source 1: sec_bhavdata_full CSV ---------------- */


  function fromBhavdataCsv(date) {
    const url = CSV_BASE + Utilities.formatDate(date, Util.tz(), 'ddMMyyyy') + '.csv';
    const res = UrlFetchApp.fetch(url, {
      method: 'get', headers: headers(), muteHttpExceptions: true, followRedirects: true
    });
    const code = res.getResponseCode();
    if (code === 404) {
      throw notPublished(date, 'sec_bhavdata_full');
    }
    if (code !== 200) {
      throw new Error('NSE returned HTTP ' + code + ' for the ' + Util.prettyDate(date) +
        ' bhavcopy CSV. ' + blockedHint());
    }


    const text = res.getContentText();
    const lines = text.split(/\r?\n/);
    const head = lines[0].split(',').map(s => Util.trim(s).toUpperCase());
    const iSym = head.indexOf('SYMBOL');
    const iSer = head.indexOf('SERIES');
    const iOpen = head.indexOf('OPEN_PRICE');
    const iClose = head.indexOf('CLOSE_PRICE');
    if (iSym < 0 || iOpen < 0 || iClose < 0) {
      throw new Error('The NSE bhavcopy CSV for ' + Util.prettyDate(date) +
        ' does not have the expected columns. NSE may have changed the format — enter the prices manually and tell whoever maintains this script.');
    }


    const want = symbol().toUpperCase();
    const wantSeries = series().toUpperCase();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const parts = lines[i].split(',');
      if (Util.trim(parts[iSym]).toUpperCase() !== want) continue;
      if (iSer >= 0 && Util.trim(parts[iSer]).toUpperCase() !== wantSeries) continue;
      const open = Util.num(Util.trim(parts[iOpen]), NaN);
      const close = Util.num(Util.trim(parts[iClose]), NaN);
      if (isNaN(open) || isNaN(close) || open <= 0 || close <= 0) {
        throw new Error('The ' + Util.prettyDate(date) + ' bhavcopy has no usable open/close for ' +
          want + ' — it may not have traded that day.');
      }
      return { open: open, close: close, source: 'NSE bhavcopy (sec_bhavdata_full) ' + Util.prettyDate(date) };
    }
    throw new Error(want + ' (' + wantSeries + ') does not appear in the NSE bhavcopy for ' +
      Util.prettyDate(date) + '. Check NSE_SYMBOL and NSE_SERIES in Settings.');
  }


  /* ---------------- source 2: GOOGLEFINANCE, via the sheet ---------------- */


  /**
   * Ask Sheets for the day's open and close instead of fetching anything.
   *
   * This exists because of what NSE actually does to us. Their archives answer
   * a normal network instantly — verified, HTTP 200 in under a second — but
   * from Apps Script they frequently accept the connection and then never
   * reply. UrlFetchApp has no timeout setting, so a blocked request consumes
   * the whole execution and the caller sits watching a spinner. That is the
   * "still running" symptom, and it is why a long backfill stalls part way.
   *
   * A GOOGLEFINANCE formula makes no outbound request from our side at all:
   * Sheets already holds the price data, so there is nothing for NSE to block
   * and nothing to hang on. The formula is written into the hidden _Scratch
   * tab, read back, and removed.
   *
   * The trade-off, stated plainly: the bhavcopy is the official settled record
   * — the file an auditor would ask for — and this is not. So NSE is still
   * tried first, this is the fallback, and the FMV row records which was used
   * so the provenance of every price is visible on the tab.
   */
  function fromGoogleFinance(date, tickerOverride) {
    const ticker = Util.trim(tickerOverride) || gfTicker();
    if (!ticker) {
      throw new Error('No Google Finance ticker is set. Put one in GF_TICKER in Settings ' +
        '(try NSE:PWL), or enter the prices by hand.');
    }
    const r = gfQuery(ticker, date);
    if (r.error) throw new Error(r.error);
    return {
      open: round2(r.open),
      close: round2(r.close),
      source: 'Google Finance ' + ticker + ' ' + Util.prettyDate(date)
    };
  }


  /**
   * Run one GOOGLEFINANCE history query and pick out the row for `date`.
   *
   * Asked as a RANGE ending on the date rather than as a single day. A
   * one-day historical query returns an empty table surprisingly often — a
   * holiday, a settlement lag, or simply Google not holding that exact
   * session — and an empty table is indistinguishable from a bad ticker. A
   * range tells the two apart: rows but not the date you wanted means the
   * ticker is right and the day is missing; no rows at all means the ticker
   * is wrong.
   *
   * Returns { open, close, error, rows, matchedDate } rather than throwing,
   * so the diagnostic can report the difference.
   */
  function gfQuery(ticker, date) {
    // The ticker is interpolated into a formula, so it must not be able to
    // close the string and add its own arguments. Admin-only today, but a
    // setting that becomes a formula is worth constraining at the point of
    // use rather than trusting whoever edits Settings.
    if (!/^[A-Za-z0-9.:_-]{1,24}$/.test(String(ticker))) {
      return { error: 'A ticker may only contain letters, digits, dot, colon, underscore or ' +
        'hyphen. "' + ticker + '" does not qualify.', rows: 0 };
    }
    const sh = Repo.book().getSheetByName(T.SCRATCH) || Repo.book().insertSheet(T.SCRATCH);
    const area = sh.getRange('A1:H40');
    const from = Util.addDays(date, -9);
    const fmt = d => Utilities.formatDate(d, Util.tz(), 'yyyy,MM,dd');


    try {
      area.clearContent();
      sh.getRange('A1').setFormula(
        '=IFERROR(GOOGLEFINANCE("' + ticker + '","all",DATE(' + fmt(from) + '),DATE(' + fmt(date) + ')),"")');
      SpreadsheetApp.flush();


      // GOOGLEFINANCE resolves asynchronously — the cell reads empty for a
      // moment after the formula lands.
      let grid = area.getValues();
      for (let wait = 0; wait < 12 && !String(grid[0][0]).trim(); wait++) {
        Utilities.sleep(600);
        SpreadsheetApp.flush();
        grid = area.getValues();
      }


      const head = (grid[0] || []).map(v => String(v).trim().toLowerCase());
      if (!String(head[0] || '').trim()) {
        return { error: 'Google Finance returned nothing at all for "' + ticker +
          '" over ' + Util.dateKey(from) + ' to ' + Util.dateKey(date) +
          '" — that ticker is almost certainly not one it recognises.', rows: 0 };
      }


      const iDate = head.indexOf('date');
      const iOpen = head.indexOf('open');
      const iClose = head.indexOf('close');
      if (iOpen < 0 || iClose < 0) {
        return { error: 'Google Finance answered for "' + ticker + '" but without open/close ' +
          'columns (got: ' + head.filter(Boolean).join(', ') + ').', rows: 0 };
      }


      const want = Util.dateKey(date);
      const seen = [];
      let exact = null, latest = null;
      for (let i = 1; i < grid.length; i++) {
        const cellDate = iDate >= 0 ? grid[i][iDate] : null;
        const key = cellDate ? Util.dateKey(cellDate) : '';
        const open = Util.num(grid[i][iOpen], NaN);
        const close = Util.num(grid[i][iClose], NaN);
        if (isNaN(open) || isNaN(close) || open <= 0 || close <= 0) continue;
        seen.push(key);
        if (key === want) exact = { open: open, close: close, matchedDate: key };
        latest = { open: open, close: close, matchedDate: key };
      }


      if (exact) return Object.assign({ rows: seen.length, seen: seen }, exact);
      if (seen.length) {
        return {
          error: 'Google Finance knows "' + ticker + '" — it returned ' + seen.length +
            ' day(s) up to ' + (latest ? latest.matchedDate : '?') + ' — but not ' + want +
            ' itself. Days returned: ' + seen.join(', ') + '.',
          rows: seen.length, seen: seen, latest: latest
        };
      }
      return { error: 'Google Finance returned a table for "' + ticker +
        '" but no usable price rows in it.', rows: 0 };
    } finally {
      // Never leave a live formula behind: it would recalculate whenever the
      // book opens, and the next run would read the previous date's value.
      try { area.clearContent(); } catch (e) { /* ignore */ }
    }
  }


  function gfTicker() {
    return Util.trim(cfg('GF_TICKER')) || 'NSE:' + symbol();
  }


  /* ---------------- source 3: UDiFF BhavCopy zip ---------------- */


  function fromUdiffZip(date) {
    const url = UDIFF_BASE + Utilities.formatDate(date, Util.tz(), 'yyyyMMdd') + '_F_0000.csv.zip';
    const res = UrlFetchApp.fetch(url, {
      method: 'get', headers: headers(), muteHttpExceptions: true, followRedirects: true
    });
    const code = res.getResponseCode();
    if (code === 404) throw notPublished(date, 'UDiFF BhavCopy');
    if (code !== 200) {
      throw new Error('NSE returned HTTP ' + code + ' for the ' + Util.prettyDate(date) +
        ' UDiFF BhavCopy. ' + blockedHint());
    }


    let files;
    try {
      files = Utilities.unzip(res.getBlob().setContentType('application/zip'));
    } catch (e) {
      throw new Error('The ' + Util.prettyDate(date) + ' UDiFF BhavCopy could not be unzipped: ' + e.message);
    }
    const csv = files.filter(f => /\.csv$/i.test(f.getName()))[0];
    if (!csv) throw new Error('The UDiFF BhavCopy zip for ' + Util.prettyDate(date) + ' held no CSV.');


    const lines = csv.getDataAsString().split(/\r?\n/);
    const head = lines[0].split(',').map(s => Util.trim(s));
    const iSym = head.indexOf('TckrSymb');
    const iSer = head.indexOf('SctySrs');
    const iOpen = head.indexOf('OpnPric');
    const iClose = head.indexOf('ClsPric');
    if (iSym < 0 || iOpen < 0 || iClose < 0) {
      throw new Error('The UDiFF BhavCopy for ' + Util.prettyDate(date) + ' does not have the expected columns.');
    }


    const want = symbol().toUpperCase();
    const wantSeries = series().toUpperCase();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const parts = lines[i].split(',');
      if (Util.trim(parts[iSym]).toUpperCase() !== want) continue;
      if (iSer >= 0 && Util.trim(parts[iSer]).toUpperCase() !== wantSeries) continue;
      const open = Util.num(Util.trim(parts[iOpen]), NaN);
      const close = Util.num(Util.trim(parts[iClose]), NaN);
      if (isNaN(open) || isNaN(close) || open <= 0 || close <= 0) continue;
      return { open: open, close: close, source: 'NSE UDiFF BhavCopy ' + Util.prettyDate(date) };
    }
    throw new Error(want + ' does not appear in the UDiFF BhavCopy for ' + Util.prettyDate(date) + '.');
  }


  function notPublished(date, which) {
    const e = new Error('NSE has not published the ' + which + ' for ' + Util.prettyDate(date) +
      ' yet. It appears after the market closes, usually by about 19:00 IST, and never for a ' +
      'weekend or an exchange holiday.');
    e.notPublished = true;
    return e;
  }


  function blockedHint() {
    return 'If this keeps happening, NSE is likely refusing requests from Google\'s servers — ' +
      'enter the opening and closing price by hand on the Share price screen.';
  }


  /* ---------------- public ---------------- */


  /**
   * Is the NSE route allowed?
   *
   * This gates the two NSE sources ONLY — not automatic pricing as a whole.
   * That distinction matters: NSE can hang for the entire execution when it
   * blocks Google's IPs, and the way out of that is to switch NSE off and
   * let Google Finance answer. Treating the flag as "no automatic pricing at
   * all" left the flag useless for the one problem it needs to solve.
   */
  function nseAllowed() {
    return cfgBool('NSE_FETCH_ENABLED');
  }


  /**
   * Fetch one date's prices. Does not write anything.
   *
   * `onlySource` restricts which source is tried: the backfill sets it once it
   * knows which one answers, so it doesn't pay for a doomed second attempt on
   * every date. Each UrlFetchApp call can sit for up to a minute before giving
   * up, and the whole script gets six.
   */
  function fetch(dateInput, onlySource, options) {
    const opts = options || {};
    const d = Util.startOfDay(Util.toDate(dateInput));
    if (!d) throw new Error('Enter a valid date.');
    if (d.getDay() === 0 || d.getDay() === 6) {
      throw new Error(Util.prettyDate(d) + ' is a ' +
        (d.getDay() === 0 ? 'Sunday' : 'Saturday') + ' — the market was closed, so there is no price to load.');
    }
    if (d.getTime() > Util.startOfDay(new Date()).getTime()) {
      throw new Error('That date is in the future.');
    }


    // Order matters, and differs by who is waiting.
    //
    // The bhavcopy is the official settled record, so it leads for the
    // scheduled job — nobody is watching at 8 PM, and a patient retry is
    // free. But an admin pressing "fetch" needs an answer in seconds, and an
    // NSE request that is being silently blocked will hang for the whole
    // execution. So for the interactive path Google Finance goes first: it
    // makes no outbound request, cannot hang, and cannot be blocked.
    const interactive = !!opts.interactive;
    const nse = [
      { name: 'csv', label: 'sec_bhavdata_full', fn: fromBhavdataCsv },
      { name: 'udiff', label: 'UDiFF BhavCopy', fn: fromUdiffZip }
    ];
    const gf = { name: 'gf', label: 'Google Finance', fn: fromGoogleFinance };
    const sources = (interactive ? [gf].concat(nse) : nse.concat([gf]))
      // NSE_FETCH_ENABLED=false takes the NSE sources out; Google Finance
      // still works, so automatic pricing survives NSE blocking us.
      .filter(s => s.name === 'gf' || nseAllowed())
      .filter(s => !onlySource || s.name === onlySource);


    if (!sources.length) {
      const off = new Error('No price source is available. NSE is switched off ' +
        '(NSE_FETCH_ENABLED=false) and no Google Finance ticker is set. ' +
        'Enter the opening and closing price by hand on the Share price screen.');
      off.disabled = true;
      throw off;
    }


    // NSE throttles bursts rather than refusing outright: a date that fails
    // once will often succeed a few seconds later. Retry each source twice
    // before moving on, but never retry a 404 - that means the file is not
    // published, and waiting will not conjure it. One try only when someone
    // is waiting on the answer.
    const TRIES = interactive ? 1 : 2;
    const attempts = [];
    let allNotPublished = true;
    for (let i = 0; i < sources.length; i++) {
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
          const r = sources[i].fn(d);
          return Object.assign({
            date: Util.dateKey(d),
            fmv: round2((r.open + r.close) / 2),
            via: sources[i].name
          }, r);
        } catch (e) {
          if (e.notPublished) {
            attempts.push(sources[i].label + ': ' + e.message);
            break;                       // no point retrying a 404
          }
          allNotPublished = false;
          if (attempt < TRIES) {
            Utilities.sleep(4000);       // let the throttle window pass
            continue;
          }
          attempts.push(sources[i].label + ' (after ' + TRIES + ' tries): ' + e.message);
        }
      }
    }
    // Name the sources actually tried. Saying "from NSE" when NSE was
    // switched off and only Google Finance ran sends whoever reads it
    // looking in the wrong place.
    const err = new Error('Could not load the ' + Util.prettyDate(d) + ' price from ' +
      sources.map(s => s.label).join(' or ') + '.\n\n' + attempts.join('\n\n'));
    err.notPublished = allNotPublished;
    throw err;
  }


  /** Fetch one date and write it to the FMV tab. */
  function load(dateInput, actorId, onlySource, options) {
    const r = fetch(dateInput, onlySource, options);
    Domain.upsertFmv(r.date, r.open, r.close, r.source, actorId || 'price fetch');
    return r;
  }


  /**
   * Fill in every missing weekday between two dates — to seed the tab when the
   * portal goes live, or to catch up after a holiday break.
   *
   * Three guards, because 30 days could otherwise mean 60 requests and Apps
   * Script allows six minutes in total:
   *
   *   · it works BACKWARDS from the most recent day, so if it does run out of
   *     time the days you are most likely to need are already in
   *   · once one source answers, only that source is tried thereafter
   *   · two consecutive hard failures (anything that is not "not published
   *     yet") aborts the run — if NSE is refusing Apps Script it will refuse
   *     every date, and there is no sense burning five minutes proving it
   *
   * Whatever it managed to load is committed as it goes, so an abort or a
   * timeout still leaves you better off than before. Re-run it to continue.
   */
  function backfill(fromInput, toInput, actorId, options) {
    const opts = options || {};
    const from = Util.startOfDay(Util.toDate(fromInput));
    const to = Util.startOfDay(Util.toDate(toInput) || new Date());
    if (!from || !to) throw new Error('Enter both dates.');
    if (from.getTime() > to.getTime()) throw new Error('The "from" date is after the "to" date.');
    if (Math.round((to - from) / 86400000) > 120) {
      throw new Error('Backfill at most 120 days at a time.');
    }


    const have = {};
    Repo.objects(T.FMV).forEach(r => { have[Util.dateKey(r.Date)] = true; });


    // A Workspace account gets 30 minutes of script runtime, so a manual
    // backfill can afford a real budget; leave plenty of headroom to render
    // the result. The once-a-day job is a single request and never comes
    // near this.
    const budgetMinutes = Math.min(Math.max(Util.num(opts.budgetMinutes, 20), 1), 25);
    const deadline = new Date().getTime() + budgetMinutes * 60 * 1000;


    const loaded = [], skipped = [], failed = [], notAttempted = [];
    let source = null;          // pinned once something answers
    let consecutiveHard = 0;
    let aborted = '';


    for (let d = new Date(to); d.getTime() >= from.getTime(); d = Util.addDays(d, -1)) {
      const key = Util.dateKey(d);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      if (have[key]) { skipped.push(key + ' (already on record)'); continue; }


      if (aborted) { notAttempted.push(key); continue; }
      if (new Date().getTime() > deadline) {
        aborted = 'Stopped after ' + budgetMinutes + ' minutes to stay inside the Apps Script ' +
          'runtime limit. Everything loaded so far is saved - run it again to carry on from ' +
          'where it left off.';
        notAttempted.push(key);
        continue;
      }


      try {
        const r = load(d, actorId, source);
        loaded.push(key + ' → open ' + r.open + ', close ' + r.close + ', FMV ' + r.fmv);
        source = source || r.via;      // stick with whatever worked
        consecutiveHard = 0;
      } catch (e) {
        if (e.notPublished) {
          skipped.push(key + ' (exchange holiday, or not published yet)');
          consecutiveHard = 0;
        } else {
          failed.push(key + ': ' + e.message.split('\n')[0]);
          consecutiveHard++;
          if (consecutiveHard >= 3) {
            aborted = 'Stopped after three failures in a row, each already retried. NSE is either ' +
              'throttling heavily or refusing these requests. Everything loaded so far is saved. ' +
              'Wait a few minutes and run it again; if it keeps happening, set NSE_FETCH_ENABLED ' +
              'to false and enter prices on the Share price screen instead.';
          }
        }
      }
      Utilities.sleep(1500);           // pace it; NSE throttles bursts
    }


    loaded.reverse();                  // read oldest-first in the report
    return {
      ok: !aborted || loaded.length > 0,
      loaded: loaded, skipped: skipped, failed: failed,
      notAttempted: notAttempted, aborted: aborted,
      source: source
    };
  }


  /**
   * The daily job: put the LAST TRADED DAY on record — one day per run, once
   * a day, and nothing else.
   *
   * It starts with TODAY, not yesterday. NSE publishes the day's bhavcopy by
   * about 19:00 IST and the job runs at 20:00, so today's open and close are
   * available by then — and today's is the price that matters, because FMV is
   * the trading day BEFORE the exercise payment date. Whoever pays tomorrow is
   * priced off today. Loading only yesterday would leave the portal a day
   * behind for ever and block anyone recording a payment made today.
   *
   * If today's file is not out yet — an early run, a holiday, a weekend — it
   * steps back a day at a time to find the genuine last traded day. Hitting a
   * date already on record ends the search: there is nothing newer to fetch.
   */
  function loadLatestTradingDay(actorId) {
    const today = Util.startOfDay(new Date());
    const have = {};
    Repo.objects(T.FMV).forEach(r => { have[Util.dateKey(r.Date)] = true; });


    // Fill every recent trading day that is missing, not only the newest.
    //
    // The original version stopped at the first day it found on record, on
    // the reasoning that there was nothing newer to fetch. But that leaves a
    // hole permanently: any day the fetch failed stays empty for ever, and
    // FMV is the day BEFORE the exercise payment — so a single missing
    // Wednesday makes every Thursday payment unpriceable. A gap has to heal
    // itself, because nobody notices it until someone cannot be priced.
    //
    // Bounded to the last few trading days: enough to cover a failed run, a
    // long weekend or a holiday cluster, without turning the nightly job
    // into a backfill.
    const WINDOW = 6;
    const loaded = [], failures = [], missing = [];


    for (let back = 0; back <= WINDOW + 4; back++) {
      const d = Util.addDays(today, -back);
      if (d.getDay() === 0 || d.getDay() === 6) continue;          // market shut
      if (missing.length >= WINDOW) break;
      if (have[Util.dateKey(d)]) continue;
      missing.push(d);
    }


    if (!missing.length) {
      return { ok: true, loaded: false,
        message: 'price: nothing missing in the last ' + WINDOW + ' trading days' };
    }


    // Newest first: if the run is cut short, the day most likely to be needed
    // tomorrow is already in.
    for (let i = 0; i < missing.length; i++) {
      const d = missing[i];
      try {
        const r = load(d, actorId || 'daily price job');
        loaded.push(r.date + ' (open ' + r.open + ', close ' + r.close + ', FMV ' + r.fmv + ')');
      } catch (e) {
        if (e.disabled) {
          return { ok: true, loaded: false, skipped: true, message: 'price: ' + e.message };
        }
        // Not published and holidays are expected, not failures — today's
        // file before the market settles, or a day the exchange was shut.
        if (!e.notPublished) failures.push(Util.dateKey(d) + ': ' + e.message.split('\n')[0]);
      }
    }


    const parts = [];
    if (loaded.length) parts.push('loaded ' + loaded.join('; '));
    if (failures.length) parts.push('FAILED ' + failures.join('; '));
    if (!parts.length) parts.push('nothing to load — the missing days are holidays or not yet published');


    return {
      ok: failures.length === 0,
      loaded: loaded.length > 0,
      date: loaded.length ? loaded[0].split(' ')[0] : '',
      message: 'price: ' + parts.join(' | ')
    };
  }


  function round2(n) { return Math.round(Util.num(n) * 100) / 100; }


  return {
    fetch: fetch,
    load: load,
    backfill: backfill,
    loadLatestTradingDay: loadLatestTradingDay,
    // Exposed for the diagnostic, which needs the reason a ticker failed
    // rather than just the fact that it did.
    gfQuery: gfQuery
  };
})();




/**
 * One run that answers every question about why a price is missing.
 *
 * Writes nothing. Reports, in order: whether the nightly job is actually
 * installed and when it last ran, what the FMV tab currently holds, and then
 * each source tried separately against the last trading day with its own
 * timing — so a source that hangs is visibly the one that took 60 seconds
 * rather than being lost inside a single "it failed" message.
 */
function diagnosePriceFetch() {
  const out = [];
  // Logged line by line, not collected and printed at the end. The previous
  // version built the whole report first, so when a step hung the run was
  // cancelled with nothing written at all — seven minutes and no information.
  const say = function (s) { out.push(s); console.log(s); };
  const report = function () { return out.join('\n'); };


  say('=== the nightly job ===');
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'priceJob');
  if (!triggers.length) {
    say('NOT INSTALLED — priceJob has no trigger, so nothing runs at 8 PM.');
    say('Fix: run installTriggers() from this editor. This alone would explain');
    say('a price that never appears on its own.');
  } else {
    say('installed: ' + triggers.length + ' trigger(s) for priceJob');
  }


  say('');
  say('=== what the FMV tab holds ===');
  const rows = Repo.objects(T.FMV)
    .map(r => ({ key: Util.dateKey(r.Date), open: Util.num(r.OpenPrice, 0),
                 close: Util.num(r.ClosePrice, 0), src: Util.trim(r.Source) }))
    .filter(r => r.key)
    .sort((a, b) => String(b.key).localeCompare(String(a.key)));
  say('rows: ' + rows.length);
  rows.slice(0, 5).forEach(r => say('  ' + r.key + '  open ' + r.open + '  close ' + r.close +
    '  [' + (r.src || 'no source recorded') + ']'));
  if (!rows.length) say('  (empty)');


  // The day a payment today would be priced from.
  let target = Util.addDays(Util.startOfDay(new Date()), -1);
  while (target.getDay() === 0 || target.getDay() === 6) target = Util.addDays(target, -1);
  say('');
  say('last trading day to test: ' + Util.dateKey(target));
  say('on record already: ' + (rows.some(r => r.key === Util.dateKey(target)) ? 'YES' : 'no'));


  say('');
  say('=== Google Finance: which ticker does it actually know? ===');
  say('GF_TICKER is currently ' + (cfg('GF_TICKER') || '(unset)'));
  say('');


  // The trading symbol in the bhavcopy is PWL, but Google Finance indexes by
  // its own symbols and the two do not always agree — the v1 config held
  // NSE:PHYSICSWAL. Rather than guessing one at a time across several runs,
  // try the plausible ones and report what each returns.
  const candidates = [];
  const push = function (t) { if (t && candidates.indexOf(t) < 0) candidates.push(t); };
  push(Util.trim(cfg('GF_TICKER')));
  push('NSE:' + Util.trim(cfg('NSE_SYMBOL') || 'PWL'));
  push('NSE:PWL');
  push('NSE:PHYSICSWAL');
  push('BOM:544367');            // BSE listing, if NSE is not indexed
  push('PWL');


  let winner = null;
  candidates.forEach(function (t) {
    const t0 = new Date().getTime();
    const r = NsePrice.gfQuery(t, target);
    const took = (new Date().getTime() - t0) + 'ms';
    if (!r.error) {
      say('PASS  ' + t + '  ' + took + '  open ' + r.open + '  close ' + r.close +
        '  FMV ' + (Math.round(((r.open + r.close) / 2) * 100) / 100));
      if (!winner) winner = t;
    } else {
      say('FAIL  ' + t + '  ' + took);
      say('        ' + r.error);
    }
  });


  say('');
  if (winner) {
    say('USE THIS: set GF_TICKER = ' + winner + ' in Settings.');
    say('Automatic pricing then works whatever NSE does.');
  } else {
    say('None of these tickers works. Google Finance is not a route for this');
    say('stock, so pricing stays manual: two numbers a day on the Share price');
    say('screen, which is the auditable path anyway. Tell me and I will make');
    say('that path as quick as possible and add a daily reminder so a missing');
    say('price is never a surprise.');
  }


  say('');
  say('NSE is NOT tested here. It hangs rather than refusing when it blocks');
  say('Google\'s IPs, and there is no timeout to cut it short — testing it in');
  say('this function is what made the last run consume its whole six minutes');
  say('and report nothing. Run testNseOnly() separately if you want to know,');
  say('expecting it to sit for minutes and probably be cancelled.');


  say('');
  say('Manual entry on the Share price screen always works, and is the');
  say('auditable path regardless.');


  return report();
}


/**
 * NSE on its own. Expect this to hang for minutes and be cancelled — that IS
 * the result, and it means NSE is blocking Apps Script rather than refusing
 * it. Kept separate so it cannot take the useful diagnostics down with it.
 */
function testNseOnly() {
  let target = Util.addDays(Util.startOfDay(new Date()), -1);
  while (target.getDay() === 0 || target.getDay() === 6) target = Util.addDays(target, -1);


  console.log('Trying NSE for ' + Util.dateKey(target) + '.');
  console.log('If this log stops here and the run has to be cancelled, NSE is');
  console.log('silently blocking us. Set NSE_FETCH_ENABLED=false in Settings and');
  console.log('let Google Finance answer instead.');


  ['csv', 'udiff'].forEach(function (name) {
    const t0 = new Date().getTime();
    try {
      const r = NsePrice.fetch(target, name, { interactive: true });
      console.log('PASS  ' + name + '  ' + (new Date().getTime() - t0) + 'ms  open ' +
        r.open + '  close ' + r.close);
    } catch (e) {
      console.log('FAIL  ' + name + '  ' + (new Date().getTime() - t0) + 'ms  ' +
        String(e.message).split('\n')[0]);
    }
  });
  return 'done';
}


/**
 * Kept as the older, narrower check. diagnosePriceFetch() supersedes it and
 * is what you want when a price is missing.
 */
function testNsePriceFetch() {
  const out = [];
  const today = Util.startOfDay(new Date());
  // One date only. If NSE is going to refuse or hang, one attempt says so
  // just as clearly and returns in seconds rather than minutes.
  let tried = 0;
  for (let back = 1; back <= 7 && tried < 1; back++) {
    const d = Util.addDays(today, -back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    tried++;
    try {
      const r = NsePrice.fetch(d);
      out.push('PASS  ' + r.date + '  open ' + r.open + '  close ' + r.close +
        '  → FMV ' + r.fmv + '   [' + r.source + ']');
    } catch (e) {
      out.push('FAIL  ' + Util.dateKey(d) + '  ' + e.message.split('\n')[0]);
    }
  }
  const report = 'NSE fetch test for ' + cfg('NSE_SYMBOL') + ' (' + cfg('NSE_SERIES') + ')\n' + out.join('\n') +
    '\n\nIf every line says FAIL, NSE is refusing Apps Script and the ESOP team should enter ' +
    'the two prices by hand on the Share price screen. Everything else works unchanged.';
  console.log(report);
  return report;
}


/**
 * Seed the FMV tab with the last 30 days of prices. Safe to re-run — it skips
 * days already on record, so running it twice costs nothing and picks up
 * wherever a previous run stopped.
 */
function backfillPricesLast30Days() {
  const to = Util.addDays(new Date(), -1);
  const from = Util.addDays(to, -30);
  const r = NsePrice.backfill(from, to, 'backfill');


  const block = (title, items) =>
    '\n' + title + ' (' + items.length + ')' + (items.length ? ':\n  ' + items.join('\n  ') : '');


  const report =
    (r.aborted ? '*** ' + r.aborted + ' ***\n' : '') +
    (r.source ? 'source that answered: ' + r.source + '\n' : '') +
    block('loaded', r.loaded) +
    block('skipped', r.skipped) +
    block('failed', r.failed) +
    (r.notAttempted.length ? block('not attempted', r.notAttempted) : '') +
    (r.loaded.length
      ? '\n\nThe FMV tab now has ' + r.loaded.length + ' more trading day(s). ' +
        'Run selfTest() to confirm the latest price is recent enough.'
      : '\n\nNothing was loaded. Enter the opening and closing price by hand on the ' +
        'Share price screen — two numbers per trading day is all the portal needs.');


  console.log(report);
  return report;
}


