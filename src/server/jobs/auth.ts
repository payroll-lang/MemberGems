import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Scheduled job routes are public URLs, so each request must carry
 * `Authorization: Bearer ${CRON_SECRET}` (Vercel sends exactly this to
 * schedule/cron path targets when CRON_SECRET is set on the project).
 * Compared in constant time over SHA-256 digests, so neither the content nor
 * the length of the secret leaks through timing.
 */
export function isAuthorisedJobRequest(request: Request): boolean {
  let want = '';
  try { want = env().CRON_SECRET ?? ''; } catch { return false; }
  if (want.length < 16) return false;
  const header = request.headers.get('authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = createHash('sha256').update(m[1].trim()).digest();
  const b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}

/** What an unauthorised caller sees: nothing that says a job lives here. */
export function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}
