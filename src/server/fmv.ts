import 'server-only';
import { fmvFor, latestFmv, toDateKey, type FmvPoint, type FmvResult, type FmvRow } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type FmvDoc } from '@/lib/schema';
import { getQuery, type Tx } from './db';

function rowOf(d: Partial<FmvDoc>, id: string): FmvRow {
  return { date: d.date || id, openPrice: d.openPrice, closePrice: d.closePrice, fmv: d.fmv, source: d.source };
}

/** The latest usable price on record (Domain.latestFmv). */
export async function latestPrice(tx?: Tx): Promise<FmvPoint | null> {
  // A few rows, because the newest may be unusable (zero or half-entered).
  const q = db().collection(COL.fmv).orderBy('date', 'desc').limit(10);
  const snap = await getQuery(q, tx);
  return latestFmv(snap.docs.map((d) => rowOf(d.data() as Partial<FmvDoc>, d.id)));
}

/**
 * The FMV for a payment date: the previous trading day's price, or
 * PRICE_MISSING (the agreed change — no fallback to an older price).
 */
export async function priceForPayment(paymentDate: string, holidays: readonly string[], tx?: Tx): Promise<FmvResult> {
  const pay = toDateKey(paymentDate);
  if (!pay) return fmvFor('', [], holidays);
  // The previous trading day is within the last few weeks even over long
  // holiday runs; 20 rows before the payment date is ample.
  const q = db().collection(COL.fmv).where('date', '<', pay).orderBy('date', 'desc').limit(20);
  const snap = await getQuery(q, tx);
  return fmvFor(pay, snap.docs.map((d) => rowOf(d.data() as Partial<FmvDoc>, d.id)), holidays);
}
