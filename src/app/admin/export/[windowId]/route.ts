import { windowKey } from '@/domain';
import { getSession } from '@/lib/auth/session';
import { exportWorkbook } from '@/server/admin/export';

export const maxDuration = 300;

/** GET /admin/export/{yyyy-MM} → the window's export as .xlsx (Admin only, audited). */
export async function GET(_request: Request, ctx: { params: Promise<{ windowId: string }> }) {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  if (session.user.role !== 'Admin') return new Response('Not found', { status: 404 });
  const win = windowKey(decodeURIComponent((await ctx.params).windowId));
  if (!/^\d{4}-\d{2}$/.test(win)) return new Response('Not found', { status: 404 });
  const out = await exportWorkbook(session.user, win);
  if (!out.rows) return new Response('No applications in window ' + win + ' yet.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(Buffer.from(out.bytes), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="' + out.name + '"',
      'cache-control': 'no-store',
    },
  });
}
