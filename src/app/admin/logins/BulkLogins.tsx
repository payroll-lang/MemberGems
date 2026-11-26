'use client';

import { bulkLoginsAction } from '../actions';
import { BatchRunner } from '../_ui/BatchRunner';

export function BulkLogins({ bulkEmails }: { bulkEmails: boolean }) {
  return (
    <BatchRunner
      label="Create logins for all exercisable participants without one"
      confirm="Create a login for every participant with something exercisable who may use the portal and has none? This runs in batches of 100."
      run={(cursor, sendEmail) => bulkLoginsAction(cursor, sendEmail)}
      withEmailOption
      emailLabel={bulkEmails ? 'Email each person their one-time code (account_ready)' : 'Email the codes — needs BULK_EMAILS_ENABLED, which is off'}
    />
  );
}
