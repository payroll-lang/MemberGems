import { prettyDate } from '@/domain';
import { Callout, Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { todayIst } from '@/lib/time';
import { loadTaxSheetStatus } from '@/server/admin/taxSheet';
import { stamp } from '../_ui/format';
import { FlagBlocks } from './FlagBlocks';
import { TaxLoader } from './TaxLoader';

export const metadata = { title: 'Tax sheet · ESOP team' };
export const maxDuration = 300;

export default async function TaxPage() {
  await requireRole('Admin');
  const st = await loadTaxSheetStatus();
  return (
    <div className="stack">
      <div><div className="eyebrow">Masters</div><h1 className="title">Tax sheet</h1>
        <p className="lede">Payroll’s year-to-date position for each participant, from the HRIMS tax report. Each participant’s tax is worked out from their own income; anyone without a usable row keeps the flat percentage.</p></div>
      <Callout title="Loaded now">
        {st.rows ? <p>{st.rows.toLocaleString('en-IN')} rows as on {prettyDate(st.asOn) || '—'}, loaded {stamp(st.loadedAt)} by {st.loadedBy || '—'} · {st.covered.toLocaleString('en-IN')} of {st.participants.toLocaleString('en-IN')} participants can be priced from it · {Math.max(0, st.participants - st.rows)} have no row.</p>
          : <p>No tax sheet loaded — every application is priced at the participant’s flat percentage.</p>}
      </Callout>
      <Panel title="Load a new sheet">
        <TaxLoader today={todayIst()} />
        <Callout kind="info" title="What happens">
          <p>The rows replace the previous load. Draft and sent-back applications are repriced. Submitted applications keep their frozen tax (agreed rule) and are listed, so you can reprice any of them explicitly from the application.</p>
        </Callout>
      </Panel>
      {st.rows ? <Panel title="Rows to look at (current load)"><FlagBlocks flagged={st.flagged} /></Panel> : null}
    </div>
  );
}
