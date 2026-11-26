import { audit } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { downloadUrl, getFile, mayRead } from '@/server/files';
import { getPartnerRequest } from '@/server/partnerRequests';

/**
 * GET /api/files/{fileId}[?inline=1] → 302 to a signed URL valid for a few
 * minutes, after checking the reader may see the file. Admin views are
 * audited, as the legacy document viewer was.
 */
export async function GET(request: Request, ctx: { params: Promise<{ fileId: string }> }) {
  const session = await getSession();
  if (!session) return new Response('Sign in to view this document.', { status: 401 });
  const { fileId } = await ctx.params;
  const f = await getFile(fileId);
  const notFound = new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!f || f.status !== 'ready') return notFound;
  const user = session.user;
  let partnerOf: string | undefined;
  if (user.role === 'FundPartner' && f.requestId) partnerOf = (await getPartnerRequest(f.requestId))?.fundPartnerId;
  if (!mayRead(user, f, partnerOf)) return notFound;
  if (user.role === 'Admin') await audit(user.userId, 'Admin', 'DOCUMENT_VIEWED', f.label + ' ' + f.fileId, f.appId);
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const url = await downloadUrl(f, inline);
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
