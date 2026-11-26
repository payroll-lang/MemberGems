import { prettyDate } from '@/domain';
import { Callout, Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { grantSyncStatus } from '@/server/admin/grantSync';
import { loadSettings } from '@/server/settings';
import { stamp } from '../_ui/format';
import { GrantSync } from './GrantSync';

export const metadata = { title: 'Grant report · ESOP team' };
export const maxDuration = 300;

export default async function GrantsPage() {
  await requireRole('Admin');
  const [st, settings] = await Promise.all([grantSyncStatus(), loadSettings()]);
  return (
    <div className="stack">
      <div><div className="eyebrow">Masters</div><h1 className="title">Grant report sync</h1>
        <p className="lede">Upload the registrar’s “Vest wise Report”. It is rolled up from tranches to grants, checked, and shown to you before anything is written.</p></div>
      <Callout title="On record now">
        <p>{st.grants.toLocaleString('en-IN')} grants, report as on {prettyDate(st.reportAsOn) || '—'}, synced {stamp(st.lastSyncedAt)} · {st.participants.toLocaleString('en-IN')} participants ({st.withoutEmail} without an email).</p>
        <p>Allowed plans: {settings.portal.allowedPlans.join(', ')} · grant statuses: {settings.portal.allowedGrantStatuses?.join(', ') ?? 'all'} · default multiplier {settings.portal.defaultMultiplier}.</p>
      </Callout>
      <Panel title="Upload and check">
        <GrantSync />
      </Panel>
      <Callout kind="info" title="What a sync changes">
        <p>The grants are replaced with the report’s (only grants with something outstanding are kept). Each participant’s identity — name, designation,
          category, report emails, employment status, separation and resignation dates — is brought into line with the report; PAN, mobile, address,
          nationality and demat columns are written only where the report has a value. CTC, tax rate, email override, block and remarks are never
          touched. A participant login’s sign-in addresses follow the record. Applications are not changed: approved applications keep deducting
          their options until a report dated after the approval arrives.</p>
      </Callout>
    </div>
  );
}
