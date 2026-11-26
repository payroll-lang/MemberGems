import { getSession } from '@/lib/auth/session';
import { toActionResult } from '@/server/errors';
import { confirmUpload, fileMeta } from '@/server/files';

/** POST { fileId } → { ok, file } once the uploaded object has been checked. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: 'Your session has ended. Sign in again.' }, { status: 401 });
  let fileId = '';
  try {
    fileId = String(((await request.json()) as { fileId?: unknown }).fileId ?? '');
  } catch {
    return Response.json({ ok: false, error: 'Bad request.' }, { status: 400 });
  }
  try {
    const f = await confirmUpload(fileId, session.user.userId);
    return Response.json({ ok: true, file: fileMeta(f) }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const r = toActionResult(e, 'upload confirm');
    return Response.json(r, { status: 400 });
  }
}
