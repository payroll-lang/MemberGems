import 'server-only';
import { dayStartMs, toDateKey, trim } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type AuditDoc } from '@/lib/schema';

/**
 * The audit log viewer (legacy had none). Firestore is queried on ONE field
 * (an equality on application, actor or action, or the time range) so no
 * composite index is needed; the other filters are applied here.
 */
export interface AuditFilters {
  appId: string;
  actor: string;
  action: string;
  text: string;
  from: string;
  to: string;
}

export interface AuditRow extends AuditDoc { id: string }

export const AUDIT_LIMIT = 300;

export async function queryAudit(f: AuditFilters): Promise<{ rows: AuditRow[]; scanned: number; capped: boolean }> {
  const col = db().collection(COL.auditLog);
  const from = toDateKey(f.from);
  const to = toDateKey(f.to);
  const fromIso = from ? new Date(dayStartMs(from)).toISOString() : '';
  const toIso = to ? new Date(dayStartMs(to) + 86400000).toISOString() : '';
  const appId = trim(f.appId), actorTyped = trim(f.actor), actor = actorTyped.toUpperCase(), action = trim(f.action).toUpperCase();
  const SCAN = 3000;
  let q: FirebaseFirestore.Query;
  if (appId) q = col.where('appId', '==', appId).limit(SCAN);
  else if (actor) q = col.where('actor', 'in', [...new Set([actorTyped, actor, actorTyped.toLowerCase()])]).limit(SCAN);
  else if (action) q = col.where('action', '==', action).limit(SCAN);
  else {
    q = col.orderBy('at', 'desc');
    if (fromIso) q = q.where('at', '>=', fromIso);
    if (toIso) q = q.where('at', '<', toIso);
    q = q.limit(SCAN);
  }
  const snap = await q.get();
  const text = trim(f.text).toLowerCase();
  const rows = snap.docs.map((d) => ({ ...(d.data() as AuditDoc), id: d.id }))
    .filter((r) => (!actor || String(r.actor).toUpperCase() === actor) && (!action || String(r.action).toUpperCase() === action) &&
      (!appId || r.appId === appId) && (!fromIso || r.at >= fromIso) && (!toIso || r.at < toIso) &&
      (!text || (r.details + ' ' + r.action + ' ' + r.actor + ' ' + r.appId).toLowerCase().includes(text)))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { rows: rows.slice(0, AUDIT_LIMIT), scanned: snap.size, capped: snap.size >= SCAN };
}
