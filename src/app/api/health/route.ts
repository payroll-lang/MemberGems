import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { bucket, db } from '@/lib/firebase';

/**
 * Infrastructure check: can the server reach Firestore and the Storage bucket
 * with its credentials? Requires `Authorization: Bearer <CRON_SECRET>` (or
 * ?key=) so it reveals nothing publicly.
 */
export async function GET(request: Request) {
  const e = env();
  const url = new URL(request.url);
  const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('key') ?? '';
  const want = e.CRON_SECRET ?? '';
  const ok = want.length > 0 && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (!ok) return new Response('Not found', { status: 404 });

  const result: Record<string, unknown> = { project: e.FIREBASE_PROJECT_ID, bucket: e.FIREBASE_STORAGE_BUCKET };
  try {
    const ref = db().collection('_health').doc('ping');
    await ref.set({ at: new Date().toISOString() });
    result.firestore = (await ref.get()).exists ? 'ok' : 'write did not persist';
  } catch (err) {
    result.firestore = `error: ${(err as Error).message}`;
  }
  try {
    const [exists] = await bucket().exists();
    if (!exists) result.storage = 'bucket not found';
    else {
      const f = bucket().file('_health/ping.txt');
      await f.save('ok', { contentType: 'text/plain' });
      await f.delete();
      result.storage = 'ok';
    }
  } catch (err) {
    result.storage = `error: ${(err as Error).message}`;
  }
  result.legacyPepper = e.LEGACY_ESOP_PEPPER ? `present (${e.LEGACY_ESOP_PEPPER.length} chars)` : 'missing';
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
