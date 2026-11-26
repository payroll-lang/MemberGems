import 'server-only';
import type { DocumentData, DocumentReference, DocumentSnapshot, Query, QuerySnapshot, Transaction } from 'firebase-admin/firestore';

/**
 * Read helpers that work both inside and outside a transaction, so every
 * data-access function below can be reused by a mutation (which must do all
 * of its reads through the transaction, before any write).
 */
export type Tx = Transaction;

export function getDoc<T = DocumentData>(ref: DocumentReference<T>, tx?: Tx): Promise<DocumentSnapshot<T>> {
  return tx ? tx.get(ref) : ref.get();
}

export function getQuery<T = DocumentData>(q: Query<T>, tx?: Tx): Promise<QuerySnapshot<T>> {
  return tx ? tx.get(q) : q.get();
}

/** A short random id with a prefix (Util.uid). */
export function uid(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return prefix + Buffer.from(bytes).toString('base64url');
}
