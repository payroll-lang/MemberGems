import 'server-only';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { env } from './env';

let app: App | undefined;

function firebaseApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const e = env();
  const credentials = JSON.parse(Buffer.from(e.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
  app = initializeApp({
    credential: cert(credentials),
    projectId: e.FIREBASE_PROJECT_ID,
    storageBucket: e.FIREBASE_STORAGE_BUCKET,
  });
  return app;
}

let firestore: Firestore | undefined;

/** Firestore (server only). Client SDK access is denied by security rules. */
export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(firebaseApp());
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

/** The private documents bucket. Files are served only through signed URLs. */
export function bucket() {
  return getStorage(firebaseApp()).bucket();
}
