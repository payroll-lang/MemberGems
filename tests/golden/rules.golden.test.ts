/**
 * Golden tests: lots, grant balances, line validation and pricing against
 * the legacy Domain.gs running in the harness.
 */
import { describe, expect, it } from 'vitest';
import {
  computeGrantBalances, price, settingsFromConfig, shareGranularity, shares, stepFor, validateLines,
  type GrantRecord, type HoldingApplication, type HoldingLine, type LineRequest, type PortalSettings,
  type PriceLineInput, type TaxPosition
} from '@/domain';
import { j, Legacy, rng, type Row } from './legacy-harness';

const NOW = new Date(2026, 10, 20, 11, 30, 0);
const TODAY = '2026-11-20';
const L = new Legacy(NOW);
type R = ReturnType<typeof rng>;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const CONFIGS: Record<string, string>[] = [
  {},
  { LOT_SCOPE: 'total' },
  { LOT_SCOPE: ' Total ', OPTION_LOT_SIZE: '20', EXERCISE_PRICE: '2' },
  { OPTION_LOT_SIZE: '0', EXERCISE_PRICE: 'abc' },
  { OPTION_LOT_SIZE: '5', LOT_SCOPE: 'grant' }
];

describe('shareGranularity / stepFor / shares (golden)', () => {
  const mults: (number | string)[] = [3.6, 1, 0, '', '3.6', 2.5, 1.5, 0.1, 7, 1.25, 0.333, 3.61, -2, '1,5', 1e-7];
  for (const cfg of CONFIGS) {
    it('config ' + JSON.stringify(cfg), () => {
      L.reset();
      L.setConfig(cfg);
      const s = settingsFromConfig(cfg);
      for (const m of mults) {
        expect(shareGranularity(m)).toBe((L.run((a) => a.Domain.shareGranularity(m)) as { value: number }).value);
        expect(stepFor(m, s)).toBe((L.run((a) => a.Domain.stepFor(m)) as { value: number }).value);
        for (const o of [0, 5, 10, 17, 35, 1000, '250', 3.3]) {
          expect(j(shares(o, m))).toBe((L.run((a) => a.Domain.shares(o, m)) as { value: number }).value);
        }
      }
      expect(s.lotScope).toBe(L.run((a) => a.Domain.lotScope()).ok ? (L.run((a) => a.Domain.lotScope()) as { value: string }).value : '');
    });
  }
});

/* ================= a random participant ================= */

interface World {
  grants: Row[];
  apps: Row[];
  lines: Row[];
  cfg: Record<string, string>;
}

const DATES = ['2022-05-01', '2023-01-15', '2024-07-31', '2025-03-10', '2025-03-10', '15/08/2023', ''];

function randomWorld(r: R, i: number): World {
  const grants: Row[] = [];
  const nGrants = r.int(0, 5);
  for (let g = 0; g < nGrants; g++) {
    const mult = r.pick<number | string>([3.6, 3.6, 1, 1, '', 0, '3.6', 2.5]);
    grants.push({
      GrantID: 'G' + i + '-' + g, EmployeeID: r.next() < 0.1 ? 'pw100' : 'PW100',
      PlanName: r.pick(['ESOP Plan 2022', 'ESOP Plan 2025']), Multiplier: mult,
      GrantDate: r.pick(DATES), ExercisePrice: r.pick<number | string>(['', 1, 1, 2, 0]),
      TypeOfVesting: 'Time', GrantStatus: r.pick(['Accepted', 'PendingAcceptance']),
      TotalGranted: r.int(0, 5000), UnvestedOptions: r.int(0, 2000),
      VestedOptions: r.pick<number | string>([r.int(0, 3000), r.int(0, 40), r.int(0, 300) + 0.5, String(r.int(0, 2000))]),
      ExercisedOptions: r.int(0, 500), ExercisePendingOptions: 0, CancelledOptions: r.int(0, 10),
      TrancheCount: r.int(1, 4), VestedTrancheCount: r.int(0, 4), NextVestDate: r.pick(DATES),
      TrancheDetail: r.pick(['', '[{"id":"T1","v":10}]', 'not json']),
      ReportAsOn: r.pick(['2026-10-31', '2026-11-10', '2026-11-25', ''])
    });
  }
  // Someone else's grant, which must be ignored.
  grants.push({ GrantID: 'OTHER-' + i, EmployeeID: 'PW200', PlanName: 'ESOP Plan 2022', Multiplier: 3.6, VestedOptions: 1000 });

  const apps: Row[] = [];
  const lines: Row[] = [];
  const nApps = r.int(0, 4);
  for (let k = 0; k < nApps; k++) {
    const status = r.pick(['Draft', 'Submitted', 'Under Review', 'Sent Back', 'Approved', 'Approved', 'Rejected']);
    const win = r.pick(['2026-11', '2026-10', '2026-9', '2025-12', '2026-12']);
    const approvedAt = status === 'Approved' && r.next() < 0.85
      ? new Date(2026, r.pick([9, 10]), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59)) : '';
    const reviewedAt = r.next() < 0.5 ? new Date(2026, 9, r.int(1, 28), 9, 0, 0) : '';
    const appId = 'APP-' + i + '-' + k;
    apps.push({ AppID: appId, EmployeeID: r.next() < 0.9 ? 'PW100' : 'PW200', Status: status, WindowID: win, ApprovedAt: approvedAt, ReviewedAt: reviewedAt });
    const used: Record<string, boolean> = {};
    for (const g of grants) {
      if (r.next() < 0.5 || used[g.GrantID as string]) continue;
      used[g.GrantID as string] = true;
      lines.push({ LineID: 'L' + lines.length, AppID: appId, GrantID: g.GrantID, OptionsExercised: r.pick([0, 10, 20, 50, 100, 7, r.int(0, 500)]) });
    }
  }
  return { grants, apps, lines, cfg: r.pick(CONFIGS) };
}

function load(w: World): PortalSettings {
  L.reset();
  L.setConfig(w.cfg);
  L.setRows('Grants', w.grants);
  L.setRows('Applications', w.apps);
  L.setRows('ApplicationLines', w.lines);
  return settingsFromConfig(w.cfg);
}

function toPort(w: World, settings: PortalSettings, excludeAppId: string): ReturnType<typeof computeGrantBalances> {
  const mine = (id: unknown) => String(id).trim().toUpperCase() === 'PW100';
  const grants: GrantRecord[] = w.grants.filter((g) => mine(g.EmployeeID)).map((g) => ({
    grantId: String(g.GrantID), employeeId: String(g.EmployeeID), planName: String(g.PlanName),
    multiplier: g.Multiplier as number, grantDate: g.GrantDate, exercisePrice: g.ExercisePrice as number,
    typeOfVesting: g.TypeOfVesting as string, grantStatus: g.GrantStatus as string,
    totalGranted: g.TotalGranted as number, unvestedOptions: g.UnvestedOptions as number,
    vestedOptions: g.VestedOptions as number, exercisedOptions: g.ExercisedOptions as number,
    exercisePendingOptions: g.ExercisePendingOptions as number, cancelledOptions: g.CancelledOptions as number,
    trancheCount: g.TrancheCount as number, vestedTrancheCount: g.VestedTrancheCount as number,
    nextVestDate: g.NextVestDate, tranches: g.TrancheDetail, reportAsOn: g.ReportAsOn
  }));
  const applications: HoldingApplication[] = w.apps.filter((a) => mine(a.EmployeeID)).map((a) => ({
    appId: String(a.AppID), status: String(a.Status), windowId: a.WindowID,
    approvedAt: a.ApprovedAt instanceof Date ? stamp(a.ApprovedAt) : a.ApprovedAt,
    reviewedAt: a.ReviewedAt instanceof Date ? stamp(a.ReviewedAt) : a.ReviewedAt
  }));
  const lines: HoldingLine[] = w.lines.map((l) => ({ appId: String(l.AppID), grantId: String(l.GrantID), optionsExercised: l.OptionsExercised as number }));
  return computeGrantBalances({ grants, applications, lines, excludeAppId, today: TODAY, settings });
}

describe('Domain.grantsFor (golden)', () => {
  it('800 pseudo-random participants', () => {
    const r = rng(31337);
    let pledgedCases = 0;
    for (let i = 0; i < 800; i++) {
      const w = randomWorld(r, i);
      const settings = load(w);
      const exclude = w.apps.length && r.next() < 0.4 ? String(w.apps[0].AppID) : '';
      const legacy = L.run((a) => a.Domain.grantsFor('PW100', exclude));
      const port = toPort(w, settings, exclude);
      expect({ ok: true, value: j(port) }, 'world ' + i).toEqual(legacy);
      pledgedCases += port.filter((g) => g.pledgedElsewhere > 0).length;
    }
    expect(pledgedCases).toBeGreaterThan(200);
  });
});

describe('Domain.validateLines (golden, no duplicate grants)', () => {
  it('1,500 pseudo-random requests, every error message identical', () => {
    const r = rng(2718);
    let oks = 0, errs = 0;
    for (let i = 0; i < 1500; i++) {
      const w = randomWorld(r, i);
      const settings = load(w);
      const exclude = w.apps.length && r.next() < 0.5 ? String(w.apps[0].AppID) : '';
      const ids = w.grants.filter((g) => g.EmployeeID !== 'PW200').map((g) => String(g.GrantID));
      const pool = ids.concat(['NOPE', '', 'OTHER-' + i]);
      const req: LineRequest[] = [];
      const used: Record<string, boolean> = {};
      const n = r.int(0, 4);
      for (let k = 0; k < n; k++) {
        const gid = r.pick(pool);
        if (used[gid]) continue;
        used[gid] = true;
        req.push({
          grantId: r.next() < 0.1 ? ' ' + gid + ' ' : gid,
          options: r.pick<number | string>([0, 10, 20, 30, 100, 5, 15, 7, 3, -10, '1,000', '40', r.int(1, 60) * 10, r.int(1, 300)])
        });
      }
      const legacy = L.run((a) => a.Domain.validateLines('PW100', req, exclude));
      const port = validateLines(req, toPort(w, settings, exclude), settings);
      const shaped = port.ok ? { ok: true, value: j(port.lines) } : { ok: false, error: port.error };
      expect(shaped, 'case ' + i + ' ' + JSON.stringify(req)).toEqual(legacy);
      if (port.ok) oks++; else errs++;
    }
    expect(oks).toBeGreaterThan(100);
    expect(errs).toBeGreaterThan(300);
  });
});

/* ================= pricing ================= */

describe('Domain.price (golden, flat rounding = legacy paise)', () => {
  function randomLines(r: R): PriceLineInput[] {
    const out: PriceLineInput[] = [];
    const n = r.int(0, 4);
    for (let k = 0; k < n; k++) {
      const mult = r.pick<number | string>([3.6, 1, '', 0, 2.5]);
      const opts = r.pick<number | string>([0, 10, 50, 100, 1000, r.int(1, 500) * 10, '2,000', 35]);
      const l: PriceLineInput = { grantId: 'G' + k, options: opts, multiplier: mult, exercisePrice: r.pick<number | string>([1, 1, 2, '', 0.5]) };
      if (r.next() < 0.3) l.shares = r.int(0, 4000);
      if (r.next() < 0.3) l.lineExerciseAmount = r.int(0, 3000) + r.int(0, 99) / 100;
      out.push(l);
    }
    return out;
  }

  it('2,000 pseudo-random quotes, with and without a tax context', () => {
    const r = rng(1618);
    const methods: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      L.reset();
      const lines = randomLines(r);
      const fmv = r.pick<number | string | null>([null, 0, 79.99, 120.5, 145.25, 600, '88.10', r.int(50, 300) + r.int(0, 99) / 100]);
      const rate = r.pick<number | string>([0, 10, 30, 31.2, '35.88', 39]);
      const withCtx = r.next() < 0.6;
      let position: TaxPosition | null = null;
      if (withCtx && r.next() < 0.8) {
        position = {
          regime: r.pick(['New', 'Old']), netTaxable: r.pick([r.int(300000, 1300000), r.int(4800000, 5100000), r.int(9000000, 21000000), r.int(1, 60000000)]),
          totalGross: r.int(0, 9000000), projectedGross: r.int(0, 3000000), totalTax: 0, outsideTax: 0, tdsToDate: 0,
          remainingMonths: r.pick([0, 4, 9]), asOn: '2026-10-31', flags: r.pick(['', '', 'MISMATCH'])
        };
        L.setRows('TaxSheet', [{
          EmployeeID: 'PW100', Regime: position.regime as string, NetTaxable: position.netTaxable as number,
          TotalGross: position.totalGross as number, ProjectedGross: position.projectedGross as number, TotalTax: 0,
          OutsideTax: 0, TDSToDate: 0, RemainingMonths: position.remainingMonths as number, AsOn: '2026-10-31', Flags: position.flags as string
        }]);
      }
      const legacy = L.run((a) => a.Domain.price(lines, fmv, rate, withCtx ? { employeeId: 'PW100', appId: 'APP-1' } : undefined));
      const port = price(lines, fmv, rate, {
        flatRounding: 'paise',
        tax: withCtx ? { position, applications: [], appId: 'APP-1' } : undefined
      });
      expect({ ok: true, value: j(port) }, 'quote ' + i).toEqual(legacy);
      methods[port.taxMethod] = (methods[port.taxMethod] || 0) + 1;
    }
    expect(methods.Sheet).toBeGreaterThan(200);
    expect(methods.Flat).toBeGreaterThan(200);
    expect(methods.None).toBeGreaterThan(100);
  });

  it('validated lines → price, multiplier 3.6 vs 1, perquisite 0 (FMV below price)', () => {
    L.reset();
    const lines = [
      { grantId: 'A', planName: 'ESOP Plan 2022', multiplier: 3.6, options: 100, shares: 360, exercisePrice: 1, lineExerciseAmount: 100 },
      { grantId: 'B', planName: 'ESOP Plan 2025', multiplier: 1, options: 7, shares: 7, exercisePrice: 1, lineExerciseAmount: 7 }
    ];
    for (const fmv of [0.2, 0.27, 0.28, 1, 1.01, 99.99, 145.67]) {
      for (const rate of [0, 30, 31.2]) {
        const legacy = L.run((a) => a.Domain.price(lines, fmv, rate));
        expect({ ok: true, value: j(price(lines, fmv, rate, { flatRounding: 'paise' })) }).toEqual(legacy);
      }
    }
  });
});

describe('Domain.grantsFor (golden, hand-picked hold boundaries)', () => {
  it('approval exactly at / just after the report "as on" midnight, abandoned drafts, current window', () => {
    const cases: { win: string; status: string; approvedAt: Date | '' }[] = [];
    for (const win of ['2026-11', '2026-10', '2026-9']) {
      for (const status of ['Approved', 'Draft', 'Sent Back', 'Submitted', 'Under Review', 'Rejected']) {
        for (const approvedAt of [new Date(2026, 9, 31, 0, 0, 0), new Date(2026, 9, 31, 0, 0, 1), new Date(2026, 9, 30, 23, 59, 59), new Date(2026, 10, 1, 0, 0, 0), '' as const]) {
          cases.push({ win, status, approvedAt });
        }
      }
    }
    for (const c of cases) {
      const w: World = {
        cfg: {},
        grants: [{ GrantID: 'G1', EmployeeID: 'PW100', PlanName: 'ESOP Plan 2022', Multiplier: 3.6, VestedOptions: 500, ReportAsOn: '2026-10-31' }],
        apps: [{ AppID: 'A1', EmployeeID: 'PW100', Status: c.status, WindowID: c.win, ApprovedAt: c.approvedAt }],
        lines: [{ LineID: 'L1', AppID: 'A1', GrantID: 'G1', OptionsExercised: 100 }]
      };
      const settings = load(w);
      expect({ ok: true, value: j(toPort(w, settings, '')) }, JSON.stringify(c)).toEqual(L.run((a) => a.Domain.grantsFor('PW100', '')));
    }
  });
});
