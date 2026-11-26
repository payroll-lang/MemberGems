import { getSession } from '@/lib/auth/session';
import { toActionResult } from '@/server/errors';
import { authoriseUpload } from '@/server/uploads';

/**
 * POST { purpose, appId, requestId?, contentType, size, name }
 *   → { ok, fileId, url, headers, expiresAt }
 * The browser then PUTs the file to `url` with exactly `headers`, and calls
 * /api/files/confirm. Files never pass through this server (Vercel caps
 * request bodies at 4.5 MB).
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: 'Your session has ended. Sign in again.' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: 'Bad request.' }, { status: 400 });
  }
  try {
    const ticket = await authoriseUpload(session.user, {
      purpose: body.purpose, appId: body.appId, requestId: body.requestId,
      contentType: body.contentType, size: body.size, name: body.name,
    });
    return Response.json({ ok: true, ...ticket }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const r = toActionResult(e, 'upload url');
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
}
