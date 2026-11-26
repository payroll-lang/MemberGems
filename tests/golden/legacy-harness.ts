/**
 * Runs the legacy Apps Script source in a Node `vm` context, with an
 * in-memory spreadsheet and minimal stubs for the Apps Script services, so
 * golden tests can call the real Tax.annual, Tax.forExercise, Domain.* and
 * AppStore.progress on the same inputs as the TypeScript port.
 *
 * Loaded unmodified: Config.gs, Repo.gs (Repo + Util), Tax.gs, Domain.gs,
 * AppStore.gs. From EmployeeApi.gs only the signature-matching fragment of
 * signNotice is lifted out (the rest is entangled with sessions, Drive and
 * mail).
 *
 * The clock is faked: `new Date()` / `Date.now()` inside the context return
 * the time set with setNow(). Dates are read with local getters, as Apps
 * Script does in the script time zone, so vitest runs with TZ=Asia/Kolkata.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const LEGACY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'legacy', 'apps-script');
const FILES = ['Config.gs', 'Repo.gs', 'Tax.gs', 'Domain.gs', 'AppStore.gs'];

export type Cell = string | number | boolean | Date | null | undefined;
export type Row = Record<string, Cell>;

/* eslint-disable @typescript-eslint/no-explicit-any -- the legacy surface is untyped JS */
export interface LegacyApi {
  Tax: any;
  Domain: any;
  Util: any;
  AppStore: any;
  Repo: any;
  SCHEMA: Record<string, string[]>;
  T: Record<string, string>;
  clearConfigCache: () => void;
  signatureMatches: (typed: string, expected: string) => boolean;
}

interface FakeRange {
  getValues(): Cell[][];
  setValues(v: Cell[][]): FakeRange;
  setValue(v: Cell): FakeRange;
  setNumberFormat(): FakeRange;
  clearContent(): FakeRange;
}

class FakeSheet {
  data: Cell[][];
  constructor(public name: string, headers: string[]) {
    this.data = [headers.slice()];
  }
  getLastRow(): number { return this.data.length; }
  getLastColumn(): number { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows(): number { return Math.max(this.data.length, 1000); }
  getName(): string { return this.name; }
  appendRow(row: Cell[]): void { this.data.push(row.slice()); }
  deleteRow(n: number): void { this.data.splice(n - 1, 1); }
  getRange(r: number, c: number, nr = 1, nc = 1): FakeRange {
    const data = this.data;
    const range: FakeRange = {
      getValues() {
        const out: Cell[][] = [];
        for (let i = 0; i < nr; i++) {
          const row = data[r - 1 + i] || [];
          const vals: Cell[] = [];
          for (let j = 0; j < nc; j++) {
            const v = row[c - 1 + j];
            vals.push(v === undefined || v === null ? '' : v);
          }
          out.push(vals);
        }
        return out;
      },
      setValues(v) {
        for (let i = 0; i < v.length; i++) {
          while (data.length < r + i) data.push([]);
          const row = data[r - 1 + i];
          for (let j = 0; j < v[i].length; j++) row[c - 1 + j] = v[i][j];
        }
        return range;
      },
      setValue(v) { return range.setValues([[v]]); },
      setNumberFormat() { return range; },
      clearContent() {
        for (let i = 0; i < nr; i++) {
          const row = data[r - 1 + i];
          if (row) for (let j = 0; j < nc; j++) row[c - 1 + j] = '';
        }
        return range;
      }
    };
    return range;
  }
}

function formatDate(d: Date, _tz: string, fmt: string): string {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const p = (n: number) => String(n).padStart(2, '0');
  return fmt.replace(/yyyy|MMMM|MMM|MM|dd|HH|mm|ss/g, (t) => {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'MMMM': return MONTHS[d.getMonth()];
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM': return p(d.getMonth() + 1);
      case 'dd': return p(d.getDate());
      case 'HH': return p(d.getHours());
      case 'mm': return p(d.getMinutes());
      default: return p(d.getSeconds());
    }
  });
}

function extractSignatureFragment(): string {
  const src = readFileSync(join(LEGACY_DIR, 'EmployeeApi.gs'), 'utf8');
  const start = src.indexOf('const typed = Util.trim(payload.signatureName);');
  const end = src.indexOf('if (!nameMatches) {');
  if (start < 0 || end < 0) throw new Error('signNotice fragment not found in EmployeeApi.gs');
  return 'function __signatureMatches(typedIn, expectedIn) {\n' +
    '  const payload = { signatureName: typedIn }; const emp = { Name: expectedIn };\n' +
    '  if (!String(typedIn).trim()) return false;\n' + src.slice(start, end) + '\n' +
    '  return nameMatches;\n}';
}

export class Legacy {
  readonly ctx: vm.Context;
  readonly api: LegacyApi;
  private sheets: Record<string, FakeSheet> = {};
  private ctxDate: DateConstructor;

  constructor(now: Date = new Date(2026, 10, 15, 10, 0, 0)) {
    const book = {
      getSheetByName: (n: string) => this.sheets[n] || null,
      getSheets: () => Object.values(this.sheets),
      insertSheet: (n: string) => (this.sheets[n] = new FakeSheet(n, []))
    };
    let uuid = 0;
    const sandbox: Record<string, unknown> = {
      __NOW: now.getTime(),
      console: { log() {}, warn() {}, error() {}, info() {} },
      Logger: { log() {} },
      Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
      SpreadsheetApp: { getActiveSpreadsheet: () => book },
      LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
      CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} })
      },
      Utilities: {
        formatDate,
        getUuid: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0')
      }
    };
    this.ctx = vm.createContext(sandbox);
    vm.runInContext(
      'class FakeDate extends Date {' +
      '  constructor(...a) { if (a.length === 0) super(globalThis.__NOW); else super(...a); }' +
      '  static now() { return globalThis.__NOW; }' +
      '}' +
      'globalThis.Date = FakeDate;', this.ctx);
    for (const f of FILES) {
      vm.runInContext(readFileSync(join(LEGACY_DIR, f), 'utf8'), this.ctx, { filename: f });
    }
    vm.runInContext(extractSignatureFragment(), this.ctx, { filename: 'EmployeeApi.gs#signNotice' });
    this.api = vm.runInContext(
      '({ Tax, Domain, Util, AppStore, Repo, SCHEMA, T, clearConfigCache, signatureMatches: __signatureMatches })',
      this.ctx) as LegacyApi;
    this.ctxDate = vm.runInContext('Date', this.ctx) as DateConstructor;
    this.reset();
  }

  /** Empty every tab (headers from SCHEMA). */
  reset(): void {
    this.sheets = {};
    for (const name of Object.keys(this.api.SCHEMA)) this.sheets[name] = new FakeSheet(name, this.api.SCHEMA[name]);
    this.invalidate();
  }

  setNow(d: Date): void {
    (this.ctx as { __NOW: number }).__NOW = d.getTime();
  }

  /** A Date that belongs to the legacy realm (so `instanceof Date` holds there). */
  date(d: Date): Date {
    return new this.ctxDate(d.getTime());
  }

  /** Replace a tab's rows. Host Dates are converted to legacy-realm Dates. */
  setRows(tab: string, rows: Row[]): void {
    const headers = this.api.SCHEMA[tab];
    if (!headers) throw new Error('Unknown tab ' + tab);
    const sh = new FakeSheet(tab, headers);
    rows.forEach((r) => sh.appendRow(headers.map((h) => {
      const v = r[h];
      return v instanceof Date ? this.date(v) : v === undefined ? '' : v;
    })));
    this.sheets[tab] = sh;
    this.invalidate();
  }

  rows(tab: string): Row[] {
    return this.api.Repo.objects(tab).map((o: Row) => ({ ...o }));
  }

  setConfig(map: Record<string, string>): void {
    this.setRows('Config', Object.keys(map).map((k) => ({ Key: k, Value: map[k] })));
  }

  invalidate(): void {
    this.api.Repo.invalidate();
    this.api.clearConfigCache();
    this.api.Tax.resetCache();
  }

  /** Run fn; return its value (JSON-normalised) or the thrown message. */
  run<T>(fn: (api: LegacyApi) => T): { ok: true; value: T } | { ok: false; error: string } {
    try {
      const v = fn(this.api);
      return { ok: true, value: v === undefined ? v : JSON.parse(JSON.stringify(v)) as T };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): { next: () => number; int: (lo: number, hi: number) => number; pick: <T>(xs: readonly T[]) => T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]
  };
}

/**
 * JSON-normalise a port result the way legacy results are normalised, so
 * that -0 (which both sides produce for income 0 via ceilTo) compares as 0.
 */
export function j<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}
