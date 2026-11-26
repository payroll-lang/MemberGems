/**
 * Golden test: the grant report sync. The same "Vest wise Report" grid is run
 * through the legacy GrantSync.run (loaded unmodified into the harness) and
 * through rollupGrantReport + planEmployeeUpserts; the grant rows, the
 * summary and the participant master that result must match.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { settingsFromConfig } from '@/domain';
import type { EmployeeDoc } from '@/lib/schema';
import { blankEmployee, planEmployeeUpserts, rollupGrantReport } from '@/server/admin/core/grantReport';
import type { Cell } from '@/server/admin/core/grid';
import { Legacy, rng, type Row } from './legacy-harness';

const NOW = new Date(2026, 10, 15, 10, 0, 0);
const TODAY = '2026-11-15';
const L = new Legacy(NOW);
const GRANT_SYNC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'legacy', 'apps-script', 'GrantSync.gs'), 'utf8');
vm.runInContext(GRANT_SYNC, L.ctx, { filename: 'GrantSync.gs' });
/* eslint-disable @typescript-eslint/no-explicit-any -- the legacy surface is untyped JS */
const GrantSync = vm.runInContext('GrantSync', L.ctx) as { run: (opts: any, actor: string) => any };

const HEADERS = [
  'Plan Name', 'Employee Designation', 'Stakeholder Category', 'Employee ID', 'Stakeholder Name', 'Awardee Status',
  'Separation Date(Last Working Date)', 'Resignation Date', 'Grant ID', 'Grant Date', 'Tranche ID', 'Actual Vest Date', 'Vest Date',
  'Type of Vesting', 'Expiry Date', 'Exercise Price', 'Grant Status', 'Granted', 'Unvested', 'Vested', 'Quantity Outstanding',
  'Exercises Pending for Approval', 'Exercised', 'Cancelled', 'Lapsed', 'Unvested Cancelled', 'Vested Cancelled',
  'Access Email ID', 'Secondary Email ID', 'Multiplier', 'PAN', 'Mobile', 'DP ID', 'Client ID', 'Demat Account Type',
];

interface Built { host: Cell[][]; legacy: Cell[][] }

/** A random but realistic report: several tranches per grant, odd cells the real export has. */
function report(seed: number, opts: { headerRow?: number; withPrefill?: boolean } = {}): Built {
  const r = rng(seed);
  const plans: [string, Cell][] = [['ESOP Plan 2022', 3.6], ['ESOP Plan 2025', 1], ['Test Plan', ''], ['Test Plan', '-'], ['Old Plan', 2], ['ESOP Plan 2022', 'abc']];
  const statuses = ['Accepted', 'Accepted', 'Accepted', 'PendingAcceptance', 'Cancelled', 'PendingApproval'];
  const host: Cell[][] = [];
  const legacy: Cell[][] = [];
  const push = (row: Cell[]) => {
    host.push(row.map((c) => (c instanceof Date ? new Date(c.getTime()) : c)));
    legacy.push(row.map((c) => (c instanceof Date ? L.date(c) : c)));
  };
  const headerRow = opts.headerRow ?? 4;
  for (let i = 1; i < headerRow; i++) push(i === 1 ? ['Vest wise Report of Physics Wallah as on Sep 08, 2026'] : i === 2 ? ['', 'Generated'] : []);
  const headers = opts.withPrefill === false ? HEADERS.slice(0, 30) : HEADERS;
  push(headers);
  let grantNo = 1000;
  for (let e = 0; e < 40; e++) {
    const emp = 'PW' + String(100 + e);
    const name = 'Person ' + e;
    const left = r.next() < 0.2;
    const grants = r.int(1, 3);
    for (let g = 0; g < grants; g++) {
      const [plan, mult] = r.pick(plans);
      const status = r.pick(statuses);
      const grantId = r.next() < 0.03 ? 'G' + (grantNo - 1) : 'G' + grantNo++;
      const tranches = r.int(1, 5);
      const gd = new Date(2022 + r.int(0, 3), r.int(0, 11), r.int(1, 28));
      for (let t = 0; t < tranches; t++) {
        const granted = r.pick([100, 250, 1000, 37]);
        const vested = r.next() < 0.6 ? r.pick([0, 10, 25, 100, 37.5]) : 0;
        const unvested = r.next() < 0.5 ? r.pick([0, 50, 100]) : 0;
        const vd = new Date(2024 + r.int(0, 4), r.int(0, 11), r.int(1, 28));
        const row: Cell[] = [
          plan, r.pick(['Engineer', 'Manager', '-']), 'Employee', r.next() < 0.02 ? '' : emp.toLowerCase(), name, left ? 'Separated' : r.pick(['Active', '']),
          left ? r.pick([new Date(2025, 5, 30), '30-Jun-2025', 0, '-']) : r.pick([0, '-', '']), left ? '15/05/2025' : '-',
          grantId, r.pick([gd, gd]), grantId + '-T' + t, r.pick([vd, '-', 0]), r.pick([vd, '2027-03-31', '-']),
          r.pick(['Time', '-', '0']), r.pick([new Date(2032, 0, 1), '-']), r.pick([1, 1, 0, '', 2.5]), status,
          granted, unvested, vested, unvested + vested, r.pick([0, 0, 5]), r.pick([0, 10]), 0, 0, r.pick([0, 3]), r.pick([0, 2]),
          r.next() < 0.1 ? '-' : emp.toLowerCase() + '@pw.live', r.pick(['', emp.toLowerCase() + '@gmail.com']), mult,
          r.pick(['', 'ABCDE1234F', '-']), r.pick(['', '9876543210']), r.pick(['', 'IN300123']), r.pick(['', '12345678']), r.pick(['', 'NSDL', 'CDSL']),
        ];
        push(headers === HEADERS ? row : row.slice(0, 30));
      }
    }
    if (r.next() < 0.05) push(['', '', '', '', '', '', '', '', '', '']);
  }
  return { host, legacy };
}

const CONFIG = { ALLOWED_PLANS: 'ESOP Plan 2022, ESOP Plan 2025, Test Plan', DEFAULT_MULTIPLIER: '1', EXERCISE_PRICE: '1' };

function existingEmployees(): { host: Map<string, EmployeeDoc>; legacy: Row[] } {
  const host = new Map<string, EmployeeDoc>();
  const legacy: Row[] = [];
  for (const [id, name, rate, pan] of [['PW100', 'Old Name', 30, 'ZZZZZ9999Z'], ['PW105', 'Person 5', 0, ''], ['PW120', 'Person 20', 12.5, 'ABCDE1234F']] as const) {
    const e = { ...blankEmployee(id, ''), name, taxRatePercent: rate || null, pan, designation: 'Old', accessEmail: 'old@pw.live', nationality: 'Indian' };
    host.set(id, e);
    legacy.push({ EmployeeID: id, Name: name, TaxRatePercent: rate || '', PAN: pan, Designation: 'Old', AccessEmail: 'old@pw.live', Nationality: 'Indian', EmploymentStatus: 'Active' });
  }
  return { host, legacy };
}

function runLegacy(grid: Cell[][], cfg: Record<string, string>, employees: Row[], dryRun: boolean) {
  L.reset();
  L.setConfig(cfg);
  L.setRows('Employees', employees);
  const sh = L.api.Repo.book().insertSheet('Vest wise Report') as { data: Cell[][] };
  sh.data = grid.map((r) => r.slice());
  L.invalidate();
  L.setNow(NOW);
  return L.run(() => GrantSync.run({ dryRun }, 'tester'));
}

function legacyGrant(g: Row) {
  return {
    grantId: g.GrantID, employeeId: g.EmployeeID, planName: g.PlanName, multiplier: g.Multiplier, grantDate: g.GrantDate,
    exercisePrice: g.ExercisePrice, typeOfVesting: g.TypeOfVesting, grantStatus: g.GrantStatus, totalGranted: g.TotalGranted,
    unvestedOptions: g.UnvestedOptions, vestedOptions: g.VestedOptions, exercisedOptions: g.ExercisedOptions,
    exercisePendingOptions: g.ExercisePendingOptions, cancelledOptions: g.CancelledOptions, trancheCount: g.TrancheCount,
    vestedTrancheCount: g.VestedTrancheCount, nextVestDate: g.NextVestDate, lastVestDate: g.LastVestDate, expiryDate: g.ExpiryDate,
    tranches: JSON.parse(String(g.TrancheDetail)), reportAsOn: g.ReportAsOn,
  };
}

const EMP_FIELDS: [keyof EmployeeDoc | string, string][] = [
  ['name', 'Name'], ['designation', 'Designation'], ['stakeholderCategory', 'StakeholderCategory'], ['accessEmail', 'AccessEmail'],
  ['secondaryEmail', 'SecondaryEmail'], ['employmentStatus', 'EmploymentStatus'], ['separationDate', 'SeparationDate'],
  ['resignationDate', 'ResignationDate'], ['pan', 'PAN'], ['mobile', 'Mobile'], ['nationality', 'Nationality'],
  ['demat.dpId', 'DematDPId'], ['demat.clientId', 'DematClientId'], ['demat.accountType', 'DematAccountType'],
];

function pick(e: EmployeeDoc, path: string): string {
  const v = path.startsWith('demat.') ? e.demat[path.slice(6) as keyof EmployeeDoc['demat']] : (e as unknown as Record<string, unknown>)[path];
  return String(v ?? '').trim();
}

describe('grant report sync (golden vs GrantSync.run)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const variant of [{ headerRow: 4 }, { headerRow: 2, withPrefill: false }, { headerRow: 1 }]) {
      it('seed ' + seed + ' ' + JSON.stringify(variant), () => {
        const grid = report(seed, variant);
        const emps = existingEmployees();
        const legacy = runLegacy(grid.legacy, { ...CONFIG, REPORT_HEADER_ROW: '4' }, emps.legacy, false);
        const settings = settingsFromConfig(CONFIG);
        let port: ReturnType<typeof rollupGrantReport> | null = null;
        let portError = '';
        try { port = rollupGrantReport(grid.host, { settings, today: TODAY, syncedAt: 'x', headerRow: 4 }); } catch (e) { portError = (e as Error).message; }
        if (!legacy.ok) {
          // Legacy refuses an empty result in run(); the port leaves that to the caller.
          if (port) expect(port.grants.length, legacy.error).toBe(0);
          else expect(portError).toBe(legacy.error);
          return;
        }
        expect(port, portError).not.toBeNull();
        const p = port!;
        const s = legacy.value as Record<string, unknown>;
        for (const k of ['reportAsOn', 'headerRow', 'rowsRead', 'rowsUsed', 'skippedPlan', 'skippedStatus', 'skippedNoId', 'statusesSkipped',
          'plansSeen', 'grantsWithDefaultedMultiplier', 'grantsFullyClosed', 'grantRows', 'employees', 'prefillColumnsFound',
          'participantsWithPrefills', 'unmatchedColumns', 'warnings', 'preview'] as const) {
          expect((p.summary as unknown as Record<string, unknown>)[k], k).toEqual(s[k]);
        }
        const lg = L.rows('Grants').map(legacyGrant);
        expect(lg.length).toBeGreaterThan(5);
        expect((s.warnings as string[]).length + p.summary.skippedPlan + p.summary.skippedStatus).toBeGreaterThan(0);
        expect(plan0(p)).toBeGreaterThan(0);
        const pg = p.grants.map(({ lastSyncedAt: _x, ...g }) => { void _x; return g; });
        expect(pg).toEqual(lg);

        // The participant master after the upsert.
        const plan = planEmployeeUpserts(emps.host, p.employees, 'now');
        expect({ created: plan.created, updated: plan.updated, missingRate: plan.missingRate, missingEmail: plan.missingEmail })
          .toEqual({ created: s.employeesCreated, updated: s.employeesUpdated, missingRate: s.employeesMissingTaxRate, missingEmail: s.employeesMissingEmail });
        const after = new Map(emps.host);
        plan.creates.forEach((e) => after.set(e.employeeId, e));
        plan.updates.forEach((u) => after.set(u.employeeId, { ...after.get(u.employeeId)!, ...(u.patch as Partial<EmployeeDoc>) }));
        const legacyEmps = L.rows('Employees');
        expect(after.size).toBe(legacyEmps.length);
        for (const le of legacyEmps) {
          const e = after.get(String(le.EmployeeID));
          expect(e, String(le.EmployeeID)).toBeDefined();
          for (const [port2, col] of EMP_FIELDS) expect(pick(e!, port2), le.EmployeeID + ' ' + col).toBe(String(le[col] ?? '').trim());
        }
      });
    }
  }

  it('dry run sample matches', () => {
    const grid = report(11);
    const legacy = runLegacy(grid.legacy, CONFIG, [], true);
    expect(legacy.ok).toBe(true);
    const p = rollupGrantReport(grid.host, { settings: settingsFromConfig(CONFIG), today: TODAY, syncedAt: 'x' });
    expect(p.summary.sample).toEqual((legacy as { value: Record<string, unknown> }).value.sample);
  });

  it('missing required columns and missing heading row are refused with the legacy wording', () => {
    const noHead: Cell[][] = [['nothing here'], ['a', 'b']];
    const l1 = runLegacy(noHead, CONFIG, [], true);
    expect(() => rollupGrantReport(noHead, { settings: settingsFromConfig(CONFIG), today: TODAY, syncedAt: 'x' })).toThrow((l1 as { error: string }).error);
    const noVested: Cell[][] = [['Plan Name', 'Employee ID', 'Grant ID', 'Unvested', 'Multiplier'], ['ESOP Plan 2025', 'PW1', 'G1', 1, 1]];
    const l2 = runLegacy(noVested, CONFIG, [], true);
    expect(() => rollupGrantReport(noVested, { settings: settingsFromConfig(CONFIG), today: TODAY, syncedAt: 'x' })).toThrow((l2 as { error: string }).error);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

function plan0(p: ReturnType<typeof rollupGrantReport>): number {
  return Object.keys(p.employees).length;
}
