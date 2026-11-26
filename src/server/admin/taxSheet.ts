import 'server-only';
import { STATUS, assessTaxSheet, prettyDate, toDateKey, trim, type TaxFlag } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { COL, type TaxPositionDoc, type UserDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { loadSettings } from '../settings';
import { MAX_TAX_ROWS, sanitizeTaxRow, taxRowsFromGrid, type TaxRow } from './core/taxSheet';
import { taxSheetState } from './data';
import { checkImportPath, deleteImport, readImportGrid } from './imports';
import { autoReprice } from './review';
import { idList, plural, runAdmin } from './run';

/**
 * Tax.load: payroll's year-to-date positions, flagged, replacing the
 * previous load. Then AGREED CHANGE: only Draft and Sent Back applications
 * are repriced (canAutoReprice); submitted ones keep their frozen tax and are
 * listed for an explicit reprice.
 */

export interface TaxLoadReport {
  loaded: number;
  received: number;
  notParticipants: number;
  duplicates: number;
  participantsWithoutRow: number;
  repriced: number;
  frozen: string[];
  flagged: Record<TaxFlag, string[]>;
  asOn: string;
}

export async function loadTaxSheetStatus() {
  const [st, count] = await Promise.all([taxSheetState(), db().collection(COL.employees).count().get()]);
  return { ...st, covered: st.covered.size, participants: count.data().count };
}

export function loadTaxSheet(user: UserDoc, input: { asOn: string; rows?: unknown[]; path?: string }): Promise<ActionResult> {
  return runAdmin(user, 'loadTaxSheet', async () => {
    const asOn = toDateKey(trim(input.asOn));
    if (!asOn) throw new UserError('Enter the date payroll was processed up to (the “as on” date of this report).');
    if (asOn > todayIst()) throw new UserError('The “as on” date cannot be in the future.');
    let rows: TaxRow[];
    if (input.path) {
      const path = checkImportPath('taxSheet', input.path);
      try {
        const { grid } = await readImportGrid(path);
        const read = taxRowsFromGrid(grid);
        if (read.missing.length) throw new UserError('That file is missing these columns: ' + read.missing.join('; ') + '. Is it the HRIMS tax report?');
        rows = read.rows;
      } finally {
        // Only ten columns are kept; the file itself (names, PAN, deductions) is not.
        await deleteImport(path);
      }
    } else {
      rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, MAX_TAX_ROWS + 1).map(sanitizeTaxRow);
    }
    if (!rows.length) throw new UserError('No rows were received.');
    if (rows.length > MAX_TAX_ROWS) throw new UserError('That is more than ' + MAX_TAX_ROWS + ' rows — is it the right report?');

    const settings = await loadSettings();
    const ids = await db().collection(COL.employees).select().get();
    const assessed = assessTaxSheet({ rows, participantIds: ids.docs.map((d) => d.id), asOn, tables: settings.tax });
    if (!assessed.ok) throw new UserError(assessed.error);

    const now = nowIso();
    const keep = new Set(assessed.positions.map((p) => p.employeeId));
    const old = await db().collection(COL.taxPositions).select().get();
    const w = db().bulkWriter();
    w.onWriteError((err) => err.failedAttempts < 5);
    let failed = 0;
    const track = (t: Promise<unknown>) => { t.catch(() => { failed++; }); };
    assessed.positions.forEach((p) => {
      const doc: TaxPositionDoc = {
        employeeId: p.employeeId, regime: (p.regime === 'New' || p.regime === 'Old' ? p.regime : '') as TaxPositionDoc['regime'],
        netTaxable: p.netTaxable, totalGross: p.totalGross, projectedGross: p.projectedGross, totalTax: p.totalTax,
        previousTds: p.previousTds, outsideTax: p.outsideTax, tdsToDate: p.tdsToDate, remainingMonths: p.remainingMonths,
        asOn: p.asOn, loadedAt: now, loadedBy: user.userId, flags: p.flags, engineTotal: typeof p.engineTotal === 'number' ? p.engineTotal : 0,
      };
      track(w.set(db().collection(COL.taxPositions).doc(p.employeeId), doc));
    });
    await w.flush();
    if (failed) { await w.close(); throw new UserError(failed + ' row(s) could not be written; the previous rows were kept. Load the sheet again.'); }
    old.docs.filter((d) => !keep.has(d.id)).forEach((d) => track(w.delete(d.ref)));
    await w.close();

    const open = await db().collection(COL.applications).where('status', 'in', [STATUS.DRAFT, STATUS.SENT_BACK, STATUS.SUBMITTED, STATUS.UNDER_REVIEW]).select('status').get();
    const rep = await autoReprice(open.docs.map((d) => d.id), user.userId, 'tax sheet as on ' + asOn);
    const report: TaxLoadReport = {
      loaded: assessed.positions.length, received: assessed.received, notParticipants: assessed.notParticipants,
      duplicates: assessed.duplicates, participantsWithoutRow: assessed.participantsWithoutRow,
      repriced: rep.repriced.length, frozen: rep.frozen, flagged: assessed.flagged, asOn,
    };
    const flagText = (Object.keys(assessed.flagged) as TaxFlag[]).map((k) => k + ' ' + assessed.flagged[k].length).join(', ');
    await audit(user.userId, 'Admin', 'TAX_SHEET_LOADED', assessed.positions.length + ' participants as on ' + asOn + ', ' + flagText + ', ' +
      rep.repriced.length + ' draft applications repriced, ' + rep.frozen.length + ' submitted left frozen');
    return {
      message: assessed.positions.length + ' participants’ tax rows loaded, as on ' + prettyDate(asOn) + '. ' +
        plural(rep.repriced.length, 'draft application') + ' repriced.' +
        (rep.frozen.length ? ' ' + rep.frozen.length + ' submitted application(s) keep their frozen tax: ' + idList(rep.frozen) + '.' : ''),
      data: report,
    };
  });
}
