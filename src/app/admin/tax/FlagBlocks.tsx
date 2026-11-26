/** The tax-sheet flags, each saying whether anything needs doing (App.html taxFlagBlocks). */
const FLAG_TEXT: Record<string, { title: string; action: string; fyi?: boolean }> = {
  NO_REGIME: { title: 'No tax regime', action: 'Priced at the flat percentage. Ask payroll for the regime, or set a flat percentage.' },
  NO_INCOME: { title: 'No taxable income', action: 'Priced at the flat percentage. Check the participant’s row in HRIMS.' },
  MISMATCH: { title: 'Does not reconcile with payroll’s total tax (by more than ₹5)', action: 'Priced at the flat percentage. Check the slabs and rules, or the row.' },
  NEG_MONTHS: { title: 'Negative remaining months', action: 'FYI: treated as 0 — the year’s tax is collected now.', fyi: true },
  OVER_DEDUCTED: { title: 'Payroll has deducted more than the year’s tax', action: 'FYI: used normally.', fyi: true },
};

export function FlagBlocks({ flagged }: { flagged: Record<string, string[]> }) {
  const keys = Object.keys(flagged).filter((k) => flagged[k]?.length);
  if (!keys.length) return <div className="callout info"><h4>Nothing flagged</h4></div>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {keys.map((k) => {
        const t = FLAG_TEXT[k] ?? { title: k, action: '' };
        return (
          <div key={k} className={'callout ' + (t.fyi ? 'plain' : 'warn')}>
            <h4>{t.title} ({k}) — {flagged[k].length}</h4>
            <p>{t.action}</p>
            <p className="mono small">{flagged[k].slice(0, 300).join(', ')}{flagged[k].length > 300 ? ' …' : ''}</p>
          </div>
        );
      })}
    </div>
  );
}
