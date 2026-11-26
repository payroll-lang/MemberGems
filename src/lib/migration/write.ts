import 'server-only';
import { db } from '../firebase';
import { COL, type UserSecretDoc } from '../schema';
import type { MigrationPlan } from './parse';

const LOCK_DOC = 'migration';

export interface WriteResult {
  written: Record<string, number>;
  removed: Record<string, number>;
  keptUpgradedPasswords: number;
  locked: boolean;
}

/**
 * Writes a parsed workbook into Firestore. Safe to run more than once (e.g. a
 * trial import now and the final one on cut-over night):
 *  - master data (employees, grants, prices, windows, partners, tax sheet,
 *    settings) is replaced with the workbook's version;
 *  - a password already upgraded on the new portal is never overwritten;
 *  - legacy audit rows have fixed IDs, so they are not duplicated.
 * Once run with `final: true` the import locks itself, so a stray re-run after
 * go-live cannot overwrite live data.
 */
export async function writePlan(plan: MigrationPlan, opts: { final: boolean; by: string }): Promise<WriteResult> {
  const fs = db();
  const lockRef = fs.collection(COL.settings).doc(LOCK_DOC);
  const lock = (await lockRef.get()).data();
  if (lock?.lockedAt) throw new Error(`The import was locked after the final run on ${lock.lockedAt}. It cannot run again.`);

  const written: Record<string, number> = {};
  const removed: Record<string, number> = {};
  const bump = (k: string, by = 1) => (written[k] = (written[k] ?? 0) + by);
  const w = fs.bulkWriter();
  w.onWriteError((err) => err.failedAttempts < 5);

  // Settings
  w.set(fs.collection(COL.settings).doc('portal'), { values: plan.config, updatedAt: new Date().toISOString(), updatedBy: opts.by }, { merge: true });
  w.set(fs.collection(COL.settings).doc('taxRules'), { ...plan.taxRules, updatedAt: new Date().toISOString(), updatedBy: opts.by });
  const holidaysRef = fs.collection(COL.settings).doc('holidays');
  if (!(await holidaysRef.get()).exists) w.set(holidaysRef, { dates: [], updatedAt: new Date().toISOString(), updatedBy: opts.by });
  bump('settings', 3);

  // Users and their secrets
  const existingSecrets = await fs.getAll(...plan.users.map((u) => fs.collection(COL.userSecrets).doc(u.userId)));
  let keptUpgradedPasswords = 0;
  plan.users.forEach((u, i) => {
    w.set(fs.collection(COL.users).doc(u.userId), JSON.parse(JSON.stringify(u)), { merge: true });
    const current = existingSecrets[i].data() as UserSecretDoc | undefined;
    if (current?.scheme === 'argon2') keptUpgradedPasswords++;
    else w.set(existingSecrets[i].ref, JSON.parse(JSON.stringify(plan.secrets[u.userId])));
    bump('users');
  });

  for (const e of plan.employees) {
    w.set(fs.collection(COL.employees).doc(e.employeeId), e);
    bump('employees');
  }

  // Grants: replace the whole set.
  const keep = new Set(plan.grants.map((g) => g.grantId));
  for (const g of plan.grants) {
    w.set(fs.collection(COL.grants).doc(g.grantId), g);
    bump('grants');
  }
  const oldGrants = await fs.collection(COL.grants).select().get();
  for (const d of oldGrants.docs) {
    if (!keep.has(d.id)) {
      w.delete(d.ref);
      removed.grants = (removed.grants ?? 0) + 1;
    }
  }

  for (const f of plan.fmv) {
    w.set(fs.collection(COL.fmv).doc(f.date), f);
    bump('fmvPrices');
  }
  for (const win of plan.windows) {
    w.set(fs.collection(COL.windows).doc(win.windowId), win);
    bump('windows');
  }
  for (const p of plan.partners) {
    w.set(fs.collection(COL.fundPartners).doc(p.partnerId), p);
    bump('fundPartners');
  }

  // Tax sheet: replace.
  const keepPos = new Set(plan.taxPositions.map((t) => t.employeeId));
  for (const t of plan.taxPositions) {
    w.set(fs.collection(COL.taxPositions).doc(t.employeeId), t);
    bump('taxPositions');
  }
  const oldPos = await fs.collection(COL.taxPositions).select().get();
  for (const d of oldPos.docs) {
    if (!keepPos.has(d.id)) {
      w.delete(d.ref);
      removed.taxPositions = (removed.taxPositions ?? 0) + 1;
    }
  }

  plan.audit.forEach((a, i) => {
    const id = a.action === 'LEGACY_IMPORT' ? `import-${Date.now()}` : `legacy-${String(i).padStart(5, '0')}`;
    w.set(fs.collection(COL.auditLog).doc(id), a);
    bump('auditHistory');
  });

  await w.close();

  const runAt = new Date().toISOString();
  await lockRef.set(
    { lastRunAt: runAt, lastRunBy: opts.by, lastReport: plan.report.counts, ...(opts.final ? { lockedAt: runAt, lockedBy: opts.by } : {}) },
    { merge: true },
  );
  return { written, removed, keptUpgradedPasswords, locked: opts.final };
}
