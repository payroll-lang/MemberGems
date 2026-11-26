import { isAuthorisedJobRequest, notFound } from '@/server/jobs/auth';
import { runAnnounceJob } from '@/server/jobs/daily';

/**
 * Every 15 minutes: carry on a window announcement still being sent in batches. One read when there is none.
 * Scheduled in vercel.json; requires `Authorization: Bearer ${CRON_SECRET}`.
 */
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  if (!isAuthorisedJobRequest(request)) return notFound();
  try {
    const report = await runAnnounceJob();
    console.log(report.job + '\n' + report.report);
    return Response.json(report, { status: report.ok ? 200 : 500, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('announce job failed', e);
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export const GET = handle;
export const POST = handle;
