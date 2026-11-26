/** Guards every participant mutation runs inside its transaction. Pure. */
import type { ApplicationDoc } from '@/lib/schema';
import { UserError } from './errors';

/** AppStore.assertEditable */
export function assertEditable(app: ApplicationDoc): void {
  if (app.status !== 'Draft' && app.status !== 'Sent Back') {
    throw new UserError('Application ' + app.appId + ' is ' + app.status.toLowerCase() +
      ' and can no longer be edited. Contact the ESOP team if something needs to change.');
  }
}

export const STALE_MESSAGE = 'This application was changed in another tab, or by the ESOP team, since this page was ' +
  'loaded. Reload the page to see the latest version, then make your change again.';

/** The optimistic-concurrency check: the page must have been showing this version. */
export function assertRev(app: ApplicationDoc | null, expected: { appId: string; rev: number }): void {
  const want = expected.appId.trim();
  if (!app) {
    if (want) throw new UserError(STALE_MESSAGE);
    return;
  }
  if (want !== app.appId) throw new UserError(STALE_MESSAGE);
  if (expected.rev !== app.rev) throw new UserError(STALE_MESSAGE);
}
