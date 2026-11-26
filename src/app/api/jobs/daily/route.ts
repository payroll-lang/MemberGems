import { isAuthorisedJobRequest, notFound } from '@/server/jobs/auth';
import { runDailyJob } from '@/server/jobs/daily';

/**
 * The 08:00 IST daily job (Triggers.daily): missing-price alert, window open\/close and announcement, tax and draft reminders.
 * Scheduled in vercel.json; requires `Authorization: Bearer ${CRON_SECRET}`.
 */
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  if (!isAuthorisedJobRequest(request)) return notFound();
  try {
    const report = await runDailyJob();
    console.log(report.job + '\n' + report.report);
    return Response.json(report, { status: report.ok ? 200 : 500, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('daily job failed', e);
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export const GET = handle;
export const POST = handle;
