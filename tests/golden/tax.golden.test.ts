import { describe, expect, it } from 'vitest';
import {
  annualTax, assessTaxSheet, buildTaxTables, DEFAULT_TAX_TABLES, taxForExercise,
  type PriorApplication, type Regime, type TaxPosition, type TaxSheetInputRow
} from '@/domain';
import live from './fixtures/live-tax-tabs.json';
import { j, Legacy, rng, type Row } from './legacy-harness';

const L = new Legacy(new Date(2026, 10, 20, 11, 0, 0));

function legacyAnnual(regime: Regime, income: number): unknown {
  const r = L.run((a) => a.Tax.annual(regime, income));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const THRESHOLDS = [5000000, 10000000, 20000000, 50000000];
const DELTAS = [-50000, -1000, -100, -11, -10, -9, -1, 0, 1, 9, 10, 11, 100, 1000, 50000, 250000];

function handPickedIncomes(): number[] {
  const xs = [0, -5, 0.5, 1, 9, 10, 11, 250000, 399999, 400000, 400001, 499990, 500000, 500001, 500010,
    800000, 1000000, 1199990, 1199999, 1200000, 1200001, 1200009, 1200010, 1200011, 1210000,
    1250000, 1270000, 1274990, 1275000, 1275010, 1280000, 1600000, 2000000, 2400000, 2400001,
    3000000.37, 123456789, 999999999];
  for (const t of THRESHOLDS) for (const d of DELTAS) xs.push(t + d);
  return xs;
}

describe('Tax tables', () => {
  it('shipped defaults equal legacy Tax.tables() with empty tabs', () => {
    L.reset();
    const r = L.run((a) => a.Tax.tables());
    expect(r).toEqual({ ok: true, value: DEFAULT_TAX_TABLES });
  });

  it('the live TaxSlabs / TaxSurcharge / TaxRules tabs equal the shipped defaults', () => {
    L.reset();
    L.setRows('TaxSlabs', live.TaxSlabs as Row[]);
    L.setRows('TaxSurcharge', live.TaxSurcharge as Row[]);
    L.setRows('TaxRules', live.TaxRules as Row[]);
    const legacyLive = L.run((a) => a.Tax.tables());
    expect(legacyLive.ok).toBe(true);
    const port = buildTaxTables(
      live.TaxSlabs.map((r) => ({ regime: r.Regime, above: r.AboveAmount, rate: r.RatePercent })),
      live.TaxSurcharge.map((r) => ({ regime: r.Regime, above: r.AboveAmount, rate: r.RatePercent })),
      live.TaxRules.map((r) => ({ regime: r.Regime, rule: r.Rule, value: r.Value })));
    expect(port).toEqual(legacyLive.ok ? legacyLive.value : null);
    // Rule values arrive as text ("4", "TRUE") — numerically identical to the defaults.
    for (const g of ['New', 'Old'] as const) {
      expect(port[g].slabs).toEqual(DEFAULT_TAX_TABLES[g].slabs);
      expect(port[g].surcharge).toEqual(DEFAULT_TAX_TABLES[g].surcharge);
      for (const k of Object.keys(DEFAULT_TAX_TABLES[g].rules)) {
        expect(String(port[g].rules[k]).toUpperCase()).toBe(String(DEFAULT_TAX_TABLES[g].rules[k]).toUpperCase());
      }
    }
    L.reset();
  });
});

describe('Tax.annual (golden)', () => {
  L.reset();
  for (const regime of ['New', 'Old'] as const) {
    it(regime + ' regime: hand-picked boundaries (rebate 12L/5L, surcharge 50L/1Cr/2Cr/5Cr)', () => {
      for (const x of handPickedIncomes()) {
        expect(j(annualTax(regime, x)), regime + ' ' + x).toEqual(legacyAnnual(regime, x));
      }
    });
    it(regime + ' regime: 3,000 pseudo-random incomes', () => {
      const r = rng(regime === 'New' ? 101 : 202);
      for (let i = 0; i < 3000; i++) {
        const x = i % 3 === 0 ? r.int(0, 3000000) : Math.round(Math.exp(r.next() * Math.log(1e9)) * 100) / 100;
        expect(j(annualTax(regime, x)), regime + ' ' + x).toEqual(legacyAnnual(regime, x));
      }
    });
  }

  it('edited rule tabs (custom slabs, relief off, missing rules, odd values) match legacy', () => {
    const variants: { slabs: Row[]; sur: Row[]; rules: Row[] }[] = [
      {
        slabs: [{ Regime: 'new', AboveAmount: '3,00,000', RatePercent: '5%' }, { Regime: 'New', AboveAmount: 0, RatePercent: 0 },
          { Regime: 'New', AboveAmount: 1500000, RatePercent: 30 }, { Regime: 'Old', AboveAmount: 0, RatePercent: 10 }],
        sur: [{ Regime: 'New', AboveAmount: 5000000, RatePercent: 12 }, { Regime: 'Other', AboveAmount: 1, RatePercent: 99 }],
        rules: [{ Regime: 'New', Rule: 'RebateMarginalRelief', Value: 'no' }, { Regime: 'New', Rule: 'RebateIncomeLimit', Value: 700000 },
          { Regime: 'New', Rule: 'RebateMaxAmount', Value: 25000 }, { Regime: 'Old', Rule: 'SurchargeMarginalRelief', Value: false },
          { Regime: 'Old', Rule: 'CessPercent', Value: '' }, { Regime: 'New', Rule: 'RoundIncomeTo', Value: 1 }]
      },
      {
        slabs: [{ Regime: 'Old', AboveAmount: 0, RatePercent: 0 }, { Regime: 'Old', AboveAmount: 300000, RatePercent: 10 }],
        sur: [{ Regime: 'Old', AboveAmount: 1000000, RatePercent: 10 }, { Regime: 'Old', AboveAmount: 2000000, RatePercent: 20 }],
        rules: [{ Regime: 'Old', Rule: 'RoundIncomeTo', Value: 100 }, { Regime: 'Old', Rule: 'SurchargeMarginalRelief', Value: true },
          { Regime: 'New', Rule: 'CessPercent', Value: 3 }]
      }
    ];
    const r = rng(7);
    for (const v of variants) {
      L.reset();
      L.setRows('TaxSlabs', v.slabs);
      L.setRows('TaxSurcharge', v.sur);
      L.setRows('TaxRules', v.rules);
      const tables = buildTaxTables(
        v.slabs.map((x) => ({ regime: x.Regime, above: x.AboveAmount as string, rate: x.RatePercent as string })),
        v.sur.map((x) => ({ regime: x.Regime, above: x.AboveAmount as string, rate: x.RatePercent as string })),
        v.rules.map((x) => ({ regime: x.Regime, rule: x.Rule, value: x.Value as string })));
      expect(tables).toEqual((L.run((a) => a.Tax.tables()) as { value: unknown }).value);
      const xs = handPickedIncomes().concat([...Array(500)].map(() => r.int(0, 60000000)));
      for (const g of ['New', 'Old'] as const) {
        for (const x of xs) expect(j(annualTax(g, x, tables)), g + ' ' + x).toEqual(legacyAnnual(g, x));
      }
    }
    L.reset();
  });
});

/* ================= forExercise ================= */

interface Case {
  position: (TaxPosition & { employeeId: string }) | null;
  apps: (PriorApplication & { employeeId: string; approvedAtDate: Date | null })[];
  perquisite: number;
  flatRate: number;
  appId: string;
}

function istStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function runForExercise(c: Case): string {
  L.reset();
  if (c.position) {
    const p = c.position;
    L.setRows('TaxSheet', [{
      EmployeeID: p.employeeId, Regime: p.regime as string, NetTaxable: p.netTaxable as number,
      TotalGross: p.totalGross as number, ProjectedGross: p.projectedGross as number,
      TotalTax: p.totalTax as number, OutsideTax: p.outsideTax as number, TDSToDate: p.tdsToDate as number,
      RemainingMonths: p.remainingMonths as number, AsOn: p.asOn as string, Flags: p.flags as string
    }]);
  }
  L.setRows('Applications', c.apps.map((a) => ({
    AppID: a.appId, EmployeeID: a.employeeId, Status: a.status,
    ApprovedAt: a.approvedAtDate || '', PerquisiteAmount: a.perquisiteAmount as number
  })));
  const legacy = L.run((api) => api.Tax.forExercise('PW100', c.appId, c.perquisite, c.flatRate));
  const port = taxForExercise({
    perquisite: c.perquisite, flatRate: c.flatRate, position: c.position,
    applications: c.apps.filter((a) => a.employeeId.toUpperCase() === 'PW100'),
    appId: c.appId, flatRounding: 'paise'
  });
  expect({ ok: true, value: j(port) }, JSON.stringify(c)).toEqual(legacy);
  return port.method + (port.breakdown && port.breakdown.method === 'Sheet' && port.breakdown.cliff > 0 ? '+cliff' : '');
}

function randomCase(r: ReturnType<typeof rng>, i: number): Case {
  const nearThreshold = r.next() < 0.5;
  const t = r.pick([1200000, 500000, ...THRESHOLDS]);
  const net = nearThreshold ? t + r.int(-400000, 50000) : r.int(-100000, 80000000);
  const totalGross = Math.max(0, net + r.int(0, 600000));
  const projectedGross = r.next() < 0.2 ? r.int(0, totalGross + 500000) : Math.round(totalGross * r.next());
  const asOnDay = r.int(1, 28);
  const asOn = r.next() < 0.1 ? '' : '2026-10-' + String(asOnDay).padStart(2, '0');
  const flags = r.pick(['', '', '', 'NEG_MONTHS', 'OVER_DEDUCTED', 'MISMATCH', 'NO_INCOME', 'NO_REGIME', 'OVER_DEDUCTED,NEG_MONTHS', 'MISMATCH OVER_DEDUCTED']);
  const position = r.next() < 0.1 ? null : {
    employeeId: 'PW100',
    regime: r.pick(['New', 'Old', 'new regime', 'OLD', '', 'Unknown']),
    netTaxable: r.next() < 0.1 ? String(net) : net,
    totalGross, projectedGross,
    totalTax: r.int(0, 5000000), outsideTax: r.int(0, 20000), tdsToDate: r.int(0, 400000),
    remainingMonths: r.pick([0, 0, 1, 3, 5, 8, 11, -1]),
    asOn, flags
  };
  const apps: Case['apps'] = [];
  const nApps = r.int(0, 4);
  for (let k = 0; k < nApps; k++) {
    const approved = r.next() < 0.75;
    const day = r.int(1, 30);
    const d = approved && r.next() < 0.9 ? new Date(2026, r.pick([8, 9, 10]), day, r.int(0, 23), r.int(0, 59), r.int(0, 59)) : null;
    apps.push({
      appId: 'APP-' + i + '-' + k, employeeId: r.next() < 0.85 ? 'PW100' : 'PW200',
      status: approved ? 'Approved' : r.pick(['Draft', 'Submitted', 'Rejected']),
      approvedAt: d ? istStamp(d) : '', approvedAtDate: d,
      perquisiteAmount: r.int(0, 3000000) + r.int(0, 99) / 100
    });
  }
  if (apps.length && r.next() < 0.3) apps[0].appId = 'APP-SELF';
  const perquisite = r.next() < 0.05 ? 0 : (r.next() < 0.5 ? r.int(1, 300000) : r.int(1, 40000000)) + r.int(0, 99) / 100;
  return { position, apps, perquisite, flatRate: r.pick([0, 10, 20, 31.2, 35.88, 39]), appId: 'APP-SELF' };
}

describe('Tax.forExercise (golden, flat rounding = legacy paise)', () => {
  it('hand-picked: crossing each surcharge threshold, rebate boundary, perquisite 0, no row', () => {
    const base = (net: number, regime: string, extra: Partial<TaxPosition> = {}): TaxPosition & { employeeId: string } => ({
      employeeId: 'PW100', regime, netTaxable: net, totalGross: net + 200000, projectedGross: 600000,
      totalTax: 0, outsideTax: 0, tdsToDate: 100000, remainingMonths: 4, asOn: '2026-10-31', flags: '', ...extra
    });
    const cases: Case[] = [];
    for (const regime of ['New', 'Old']) {
      for (const t of [1200000, 500000, ...THRESHOLDS]) {
        for (const before of [-200000, -10000, -10, 0, 10]) {
          for (const P of [0, 0.004, 1, 9.99, 10, 25000, 300000, 5000000]) {
            cases.push({ position: base(t + before, regime), apps: [], perquisite: P, flatRate: 30, appId: 'X' });
          }
        }
      }
    }
    cases.push({ position: null, apps: [], perquisite: 123456.78, flatRate: 31.2, appId: 'X' });
    cases.push({ position: base(900000, 'New', { remainingMonths: 0 }), apps: [], perquisite: 500000, flatRate: 10, appId: 'X' });
    cases.push({ position: base(9900000, 'New', { totalGross: 0, projectedGross: 0 }), apps: [], perquisite: 500000, flatRate: 10, appId: 'X' });
    for (const c of cases) runForExercise(c);
  });

  it('1,500 pseudo-random participants, positions and prior approvals', () => {
    const r = rng(4242);
    const seen: Record<string, number> = {};
    for (let i = 0; i < 1500; i++) {
      const m = runForExercise(randomCase(r, i));
      seen[m] = (seen[m] || 0) + 1;
    }
    // The generator must exercise every path, not just the fallback.
    expect(seen.Sheet).toBeGreaterThan(200);
    expect(seen['Sheet+cliff']).toBeGreaterThan(10);
    expect(seen.Flat).toBeGreaterThan(100);
    expect(seen.None).toBeGreaterThan(10);
  });
});

/* ================= the sheet loader ================= */

describe('Tax.load flagging (golden)', () => {
  it('flags, normalisation and counts match legacy for 20 random sheets', () => {
    const r = rng(99);
    for (let s = 0; s < 20; s++) {
      L.reset();
      const participants = [...Array(40)].map((_, i) => 'PW' + (1000 + i));
      L.setRows('Employees', participants.map((id) => ({ EmployeeID: id, Name: 'N ' + id })));
      const rows: TaxSheetInputRow[] = [];
      for (let i = 0; i < 70; i++) {
        const regime = r.pick(['New', 'Old', 'new', 'OLD REGIME', '', 'x']);
        const net = r.pick([0, -10, r.int(100000, 9000000), r.int(100000, 60000000)]);
        const nr = normalise(regime);
        const engine = nr && net > 0 ? annualTax(nr, net).total : 0;
        rows.push({
          employeeId: r.next() < 0.1 ? 'NOBODY' + i : (r.next() < 0.5 ? ' ' : '') + r.pick(participants).toLowerCase(),
          regime, netTaxable: r.next() < 0.1 ? String(net) : net,
          totalGross: r.int(0, 9000000), projectedGross: r.int(0, 3000000),
          totalTax: r.pick([engine, engine + 3, engine - 5, engine + 6, r.int(0, 3000000), 0]),
          previousTds: r.int(0, 100000), outsideTax: r.int(0, 50000), tdsToDate: r.int(0, 2000000),
          remainingMonths: r.pick([0, 4, 11, -2])
        });
      }
      const asOn = '2026-10-31';
      const legacy = L.run((api) => api.Tax.load({ userId: 'ADMIN', role: 'Admin' }, { asOn, rows }));
      const port = assessTaxSheet({ rows, participantIds: participants, asOn });
      expect(legacy.ok).toBe(true);
      expect(port.ok).toBe(true);
      if (!legacy.ok || !port.ok) return;
      const lv = legacy.value as {
        loaded: number; received: number; notParticipants: number; duplicates: number; participantsWithoutRow: number;
        flagged: Record<string, { count: number; ids: string[] }>;
      };
      expect(port.positions.length).toBe(lv.loaded);
      expect(port.received).toBe(lv.received);
      expect(port.notParticipants).toBe(lv.notParticipants);
      expect(port.duplicates).toBe(lv.duplicates);
      expect(port.participantsWithoutRow).toBe(lv.participantsWithoutRow);
      for (const k of Object.keys(lv.flagged)) {
        const f = port.flagged[k as keyof typeof port.flagged];
        expect(f.length).toBe(lv.flagged[k].count);
        expect(f.slice(0, 60)).toEqual(lv.flagged[k].ids);
      }
      const stored = L.rows('TaxSheet');
      expect(port.positions.map((p) => ({
        EmployeeID: p.employeeId, Regime: p.regime, NetTaxable: p.netTaxable, TotalGross: p.totalGross,
        ProjectedGross: p.projectedGross, TotalTax: p.totalTax, PreviousTDS: p.previousTds, OutsideTax: p.outsideTax,
        TDSToDate: p.tdsToDate, RemainingMonths: p.remainingMonths, AsOn: p.asOn, Flags: p.flags.join(','), EngineTotal: p.engineTotal
      }))).toEqual(stored.map((x) => ({
        EmployeeID: x.EmployeeID, Regime: x.Regime, NetTaxable: x.NetTaxable, TotalGross: x.TotalGross,
        ProjectedGross: x.ProjectedGross, TotalTax: x.TotalTax, PreviousTDS: x.PreviousTDS, OutsideTax: x.OutsideTax,
        TDSToDate: x.TDSToDate, RemainingMonths: x.RemainingMonths, AsOn: x.AsOn, Flags: x.Flags, EngineTotal: x.EngineTotal
      })));
    }
  });

  it('refusals match legacy messages', () => {
    L.reset();
    L.setRows('Employees', [{ EmployeeID: 'PW1' }]);
    const row: TaxSheetInputRow = { employeeId: 'ZZ', regime: 'New', netTaxable: 1, totalGross: 0, projectedGross: 0, totalTax: 0, previousTds: 0, outsideTax: 0, tdsToDate: 0, remainingMonths: 0 };
    for (const [asOn, rows] of [['', [row]], ['2026-10-31', []], ['2026-10-31', [row]]] as const) {
      const legacy = L.run((api) => api.Tax.load({ userId: 'A', role: 'Admin' }, { asOn, rows }));
      const port = assessTaxSheet({ rows, participantIds: ['PW1'], asOn });
      expect(port).toEqual({ ok: false, error: legacy.ok ? '' : legacy.error });
    }
  });
});

function normalise(s: string): Regime | '' {
  const v = s.trim().toLowerCase();
  return v.startsWith('new') ? 'New' : v.startsWith('old') ? 'Old' : '';
}
