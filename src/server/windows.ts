import 'server-only';
import { windowFor, windowKey, windowState, type PortalSettings, type WindowState } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type WindowDoc } from '@/lib/schema';
import { nowIso } from '@/lib/time';
import { getDoc, type Tx } from './db';

export function windowRef(windowId: string) {
  return db().collection(COL.windows).doc(windowKey(windowId));
}

export function normalizeWindow(raw: unknown, id: string): WindowDoc {
  const w = (raw ?? {}) as Partial<WindowDoc>;
  return {
    windowId: windowKey(w.windowId || id),
    label: String(w.label ?? ''),
    openDate: String(w.openDate ?? ''),
    closeDate: String(w.closeDate ?? ''),
    taxDueDate: String(w.taxDueDate ?? ''),
    status: String(w.status ?? '').toLowerCase() === 'closed' ? 'Closed' : 'Open',
    createdAt: String(w.createdAt ?? ''),
    closedAt: String(w.closedAt ?? ''),
    remarks: String(w.remarks ?? ''),
  };
}

export async function getWindow(windowId: string, tx?: Tx): Promise<WindowDoc | null> {
  const snap = await getDoc(windowRef(windowId), tx);
  return snap.exists ? normalizeWindow(snap.data(), snap.id) : null;
}

/**
 * Domain.ensureWindow: the window for the month of `date`, created (with
 * windowFor's dates) if it does not exist yet. Done in a transaction, so two
 * requests at the start of a month cannot create it twice — the legacy race
 * that once produced a duplicate window.
 */
export async function ensureWindow(date: string, settings: PortalSettings, createdBy = 'system'): Promise<WindowDoc> {
  const def = windowFor(date, settings);
  const ref = windowRef(def.windowId);
  // The common case — it exists — costs one read, not a transaction.
  const existing = await ref.get();
  if (existing.exists) return normalizeWindow(existing.data(), existing.id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return normalizeWindow(snap.data(), snap.id);
    const doc: WindowDoc = {
      windowId: def.windowId,
      label: def.label,
      openDate: def.openDate,
      closeDate: def.closeDate,
      taxDueDate: def.taxDueDate,
      status: 'Open',
      createdAt: nowIso(),
      closedAt: '',
      remarks: 'Created automatically' + (createdBy !== 'system' ? ' (first visit by ' + createdBy + ')' : ''),
    };
    tx.create(ref, doc);
    return doc;
  });
}

/** windowState, accepting a missing document as closed. */
export function stateOf(w: WindowDoc | null, today: string): WindowState {
  if (!w) return { open: false, reason: 'There is no exercise window this month.' };
  return windowState(w, today);
}
