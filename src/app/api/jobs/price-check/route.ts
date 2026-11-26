import { isAuthorisedJobRequest, notFound } from '@/server/jobs/auth';
import { runPriceJob } from '@/server/jobs/daily';

/**
 * The 20:00 IST job: alert the ESOP team if today's share price (a trading day) has not been entered.
 * Scheduled in vercel.json; requires `Authorization: Bearer ${CRON_SECRET}`.
 */
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  if (!isAuthorisedJobRequest(request)) return notFound();
  try {
    const report = await runPriceJob();
    console.log(report.job + '\n' + report.report);
    return Response.json(report, { status: report.ok ? 200 : 500, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('price-check job failed', e);
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export const GET = handle;
export const POST = handle;
