import 'server-only';
import { editClearsSignature, price, round2, shares as sharesOf, type PriceOptions } from '@/domain';
import type { ApplicationDoc, ApplicationLineDoc, GrantDoc, SectionKey } from '@/lib/schema';
import { appRef, linesCol } from './applications';
import type { Tx } from './db';
import { supersede } from './files';

/**
 * Collects the changes to one application and writes them once, raising
 * `rev` (the optimistic-concurrency counter). Shared by the participant and
 * admin mutations so every write to an application goes through one place.
 */
export class AppWriter {
  doc: ApplicationDoc;
  private changed = new Set<keyof ApplicationDoc>();
  constructor(doc: ApplicationDoc, private readonly isNew: boolean) {
    this.doc = structuredClone(doc);
  }
  set<K extends keyof ApplicationDoc>(k: K, v: ApplicationDoc[K]) {
    this.doc[k] = v;
    this.changed.add(k);
  }
  /** Has anything been set? */
  get dirty(): boolean {
    return this.changed.size > 0;
  }
  /** AppStore.touchSection: an edited section goes back to Pending for review. */
  touch(section: SectionKey) {
    this.set('review', { ...this.doc.review, [section]: 'Pending' });
  }
  /**
   * AGREED CHANGE: editing a signed application clears the signature, so the
   * notice is signed again over the corrected figures. Returns whether it did.
   */
  clearSignatureFor(section: SectionKey, tx: Tx, now: string): boolean {
    if (!editClearsSignature(section, this.doc.notice.signedAt)) return false;
    if (this.doc.notice.fileId) supersede(tx, this.doc.notice.fileId, now);
    this.set('notice', { signatureName: '', signedAt: '', place: this.doc.notice.place, fileId: '' });
    this.touch('notice');
    return true;
  }
  write(tx: Tx, now: string) {
    const ref = appRef(this.doc.appId);
    this.doc.rev = (this.doc.rev || 0) + 1;
    this.doc.updatedAt = now;
    if (this.isNew) {
      tx.create(ref, this.doc);
      return;
    }
    const patch: Record<string, unknown> = { rev: this.doc.rev, updatedAt: now };
    this.changed.forEach((k) => { patch[k] = this.doc[k]; });
    tx.update(ref, patch);
  }
}

/**
 * AppStore.reprice into a writer: the multiplier and price are re-read from
 * the grant, so a corrected grant master flows through, then the lines and
 * totals are priced at the writer's FMV and tax rate. Line documents are
 * updated through the transaction (a write: call after every read).
 *
 * Callers decide WHEN this may run: automatically only for Draft / Sent Back
 * (canAutoReprice — AGREED CHANGE: frozen once submitted), or by an explicit,
 * audited admin reprice.
 */
export function repriceInto(
  w: AppWriter,
  ctx: { grants: readonly GrantDoc[]; defaultExercisePrice: number; priceOptions: PriceOptions },
  lines: readonly ApplicationLineDoc[],
  tx: Tx,
  now: string,
): void {
  if (!lines.length) return;
  const byId = new Map(ctx.grants.map((g) => [g.grantId, g]));
  const input = lines.map((l) => {
    const g = byId.get(l.grantId);
    const multiplier = (g?.multiplier || l.multiplier || 1);
    const p = g?.exercisePrice || l.exercisePrice || ctx.defaultExercisePrice;
    return {
      lineId: l.lineId, grantId: l.grantId, planName: g?.planName || l.planName, multiplier, options: l.optionsExercised,
      shares: sharesOf(l.optionsExercised, multiplier), exercisePrice: p,
      lineExerciseAmount: round2(l.optionsExercised * p),
    };
  });
  const priced = price(input, w.doc.fmvValue || null, w.doc.taxRatePercent, ctx.priceOptions);
  priced.lines.forEach((l) => {
    tx.update(linesCol(w.doc.appId).doc(l.lineId), {
      planName: l.planName, multiplier: l.multiplier, exercisePrice: l.exercisePrice, lineExerciseAmount: l.lineExerciseAmount,
      sharesAllotted: l.shares, perquisitePerShare: l.perquisitePerShare, linePerquisite: l.linePerquisite, updatedAt: now,
    });
  });
  w.set('totalOptions', priced.totalOptions);
  w.set('totalShares', priced.totalShares);
  w.set('exerciseAmount', priced.exerciseAmount);
  w.set('perquisiteAmount', priced.perquisiteAmount);
  w.set('taxAmount', priced.taxAmount);
  w.set('taxMethod', priced.taxMethod);
  w.set('taxBreakdown', priced.taxBreakdown);
}
