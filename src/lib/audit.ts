import 'server-only';
import { db } from './firebase';
import { COL, type AuditDoc, type Role } from './schema';
import { nowIso } from './time';

export async function audit(
  actor: string,
  role: Role | 'system',
  action: string,
  details = '',
  appId = '',
): Promise<void> {
  const doc: AuditDoc = { at: nowIso(), actor, role, action, appId, details: details.slice(0, 4000) };
  await db().collection(COL.auditLog).add(doc);
}
