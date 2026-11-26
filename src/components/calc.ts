/**
 * "How this was worked out" explanations (App.html calc / taxExplain).
 * Pure: builds the data; <Explain> renders it. The numbers all come from
 * stored figures and the stored TaxBreakdown — no tax arithmetic here.
 */
import { count, inr, inr2, inWords, prettyDate, type FmvPoint, type SheetBreakdown, type TaxBreakdown } from '@/domain';

export type Step = [label: string, value: string, cls?: 'total' | 'out' | 'sub'];

export interface CalcSpec {
  title: string;
  formula?: string;
  steps?: Step[];
  sections?: { heading: string; text?: string; steps: Step[] }[];
  result?: string;
  resultWords?: string;
  notes?: string[];
}

export interface TaxSource {
  method: string;
  breakdown: unknown;
  tax: number;
  perquisite: number;
  flatRate: number;
}

function isSheet(b: unknown): b is SheetBreakdown {
  return !!b && typeof b === 'object' && (b as TaxBreakdown).method === 'Sheet';
}

export function taxLabel(t: TaxSource): string {
  if (t.method === 'Sheet') return 'Tax on this exercise';
  return 'Tax at ' + t.flatRate + '%' + (t.flatRate ? ' (estimate)' : '');
}

/** taxExplain: the tax on an exercise, explained from its breakdown. */
export function taxExplain(t: TaxSource, opts: { admin?: boolean } = {}): CalcSpec {
  const b = t.breakdown;
  if (!isSheet(b)) {
    const fb = b && typeof b === 'object' ? (b as { ratePercent?: number; reason?: string }) : null;
    const rate = fb && fb.ratePercent !== undefined ? fb.ratePercent : t.flatRate;
    const why = fb && fb.reason ? fb.reason : '';
    return {
      title: 'Tax on the perquisite',
      formula: 'tax = perquisite × a flat percentage (an estimate)',
      steps: [['Perquisite', inr(t.perquisite)], ['Percentage used', (rate || 0) + '%'], ['Tax (estimate)', inr(t.tax), 'total']],
      result: inr(t.tax),
      resultWords: inWords(t.tax),
      notes: [rate
        ? 'This is an estimate. ' + (why ? why + '. ' : '') + 'Tax is charged on a whole year’s income, so the exact ' +
          'figure depends on your income for the year, which the ESOP team loads from payroll. Once that is loaded ' +
          'this is recalculated and explained step by step.'
        : 'Your tax has not been worked out yet, so this shows nil. It is not the real figure. The ESOP team loads ' +
          'your income position from payroll, after which it is calculated and explained here.'],
    };
  }

  const rateTxt = b.surchargeRate + '%';
  const cessAmt = Math.max(0, b.collect - (b.dBase + b.ownSurcharge + b.cliffNow));
  const regimeTxt = b.regime === 'Old' ? 'old tax regime' : 'new tax regime';
  const sections: CalcSpec['sections'] = [
    {
      heading: 'Step 1 — Your income for the year',
      text: 'From payroll, as on ' + prettyDate(b.asOn) + '. You are on the ' + regimeTxt + '.',
      steps: [
        ['Income earned so far this year', inr(b.earned)],
        ['Expected for the rest of the year', inr(b.future)],
        ...(b.priorPerquisite > 0 ? [['Exercises approved since payroll’s date', inr(b.priorPerquisite)] as Step] : []),
        ['Taxable income for the year, before this exercise', inr(b.incomeBefore), 'total'],
      ],
    },
    {
      heading: 'Step 2 — What this exercise adds',
      steps: [['Perquisite from this exercise', inr(b.perquisite)], ['Taxable income for the year, after this exercise', inr(b.incomeAfter), 'total']],
    },
    {
      heading: 'Step 3 — The year’s tax, with and without it',
      text: 'Tax is charged on a whole year’s income, so we work it out both ways. Each figure is the slab tax, plus ' +
        'surcharge where it applies, plus ' + b.cessPercent + '% cess.',
      steps: [
        ['Year’s tax without this exercise', inr(b.totalBefore)],
        ['Year’s tax with this exercise', inr(b.totalAfter)],
        ['Extra tax this exercise causes', inr(b.whole), 'total'],
        ...(b.surchargeRate > 0 ? [['Surcharge band your income falls in', rateTxt + ' of the tax'] as Step] : []),
      ],
    },
    {
      heading: 'Step 4 — What you pay now',
      steps: [
        ['Tax on the perquisite itself', inr(b.dBase)],
        ...(b.surchargeRate > 0 ? [['Surcharge on that tax (' + rateTxt + ')', inr(b.ownSurcharge)] as Step] : []),
        ...(b.cliff > 0 ? [['Extra surcharge on income you have already earned', inr(b.cliffNow)] as Step] : []),
        ['Cess (' + b.cessPercent + '%)', inr(cessAmt)],
        ['Tax to pay now', inr(b.collect), 'total'],
        ...(b.left > 0 ? [['Left for payroll over your remaining months', inr(b.left), 'sub'] as Step] : []),
      ],
    },
  ];
  if (opts.admin) {
    sections.push({
      heading: 'For the ESOP team',
      steps: [
        ['Share of the year’s income already earned', (b.earnedShare * 100).toFixed(1) + '%'],
        ['Remaining months of payroll', String(b.remainingMonths)],
        ['Tax deducted by payroll to date', inr(b.tdsToDate)],
        ['Outside tax / advance tax recorded', inr(b.outsideTax)],
      ],
    });
  }
  const notes: string[] = [];
  if (b.cliff > 0) {
    notes.push('Because this exercise takes your income into the ' + rateTxt + ' surcharge band, that higher surcharge ' +
      'applies to your whole year’s tax — including the tax on salary you have already earned. We collect now the part ' +
      'linked to income you have already earned (' + inr(b.cliffNow) + '). The part linked to future salary (' +
      inr(b.cliffLater) + ') is not collected now; your payroll adjusts your monthly tax deduction for it, because you ' +
      'may not be with the company by then.');
  } else if (b.surchargeRate > 0) {
    notes.push('Your income is in the ' + rateTxt + ' surcharge band, and was before this exercise too, so the surcharge ' +
      'is charged only on the tax this exercise adds.');
  }
  if (b.marginalRelief > 0) {
    notes.push('Marginal relief reduced the surcharge by ' + inr(b.marginalRelief) + ': just over a surcharge limit, tax ' +
      'plus surcharge can never rise by more than the income above the limit.');
  }
  notes.push('These figures use payroll’s position as on ' + prettyDate(b.asOn) + '. If it changes, the ESOP team reloads ' +
    'it and this is recalculated.');
  return {
    title: 'Tax on this exercise',
    formula: 'tax now = tax on the perquisite + its surcharge + surcharge on income already earned + cess',
    sections,
    result: inr(b.collect),
    resultWords: inWords(b.collect),
    notes,
  };
}

export function fmvExplain(fmv: { date: string; fmv: number; open?: number | null; close?: number | null } | null, note: string): CalcSpec {
  const steps: Step[] = !fmv ? [] : fmv.open && fmv.close
    ? [['Trading day', prettyDate(fmv.date)], ['PWL opening price', inr2(fmv.open)], ['PWL closing price', inr2(fmv.close)],
      ['Sum', inr2(fmv.open + fmv.close)], ['÷ 2 = FMV', inr2(fmv.fmv), 'total']]
    : [['Trading day', prettyDate(fmv.date)], ['FMV per share', inr2(fmv.fmv), 'total']];
  return {
    title: 'Fair market value per share',
    formula: 'FMV = (opening price + closing price) ÷ 2, on the trading day before the exercise amount is paid',
    steps,
    result: fmv ? inr2(fmv.fmv) + ' per share' : '',
    notes: [note],
  };
}

export function latestFmvExplain(fmv: FmvPoint): CalcSpec {
  return fmvExplain(fmv, 'Taken from the NSE price for PWL on the last traded day on record. The FMV that applies to ' +
    'your exercise is the one for the trading day immediately before the date you pay the exercise amount — which may ' +
    'not be this day.');
}

export function perquisiteExplain(p: { fmv: number; shares: number; exerciseAmount: number; perquisite: number }): CalcSpec {
  return {
    title: 'Perquisite value',
    formula: 'perquisite = (FMV × shares) − exercise amount, worked out per grant',
    steps: [
      ['FMV per share', p.fmv ? inr2(p.fmv) : 'not available'],
      ['Shares', count(p.shares)],
      ['FMV × shares', p.fmv ? inr(p.fmv * p.shares) : '—'],
      ['Less exercise amount', '(' + inr(p.exerciseAmount) + ')', 'out'],
      ['Perquisite', inr(p.perquisite), 'total'],
    ],
    result: inr(p.perquisite),
    resultWords: inWords(p.perquisite),
    notes: ['This is the taxable benefit — the value of the shares over and above what you pay for them. It is ' +
      'treated as salary income in the year you exercise.'],
  };
}

export function sharesExplain(lines: { planName: string; grantId: string; options: number; multiplier: number; shares: number }[], total: number): CalcSpec {
  return {
    title: 'Equity shares you receive',
    formula: 'shares = options × the conversion multiplier of the grant',
    steps: [
      ...lines.map((l): Step => [(l.planName || l.grantId) + ' · ' + count(l.options) + ' × ' + l.multiplier, count(l.shares)]),
      ['Total shares', count(total), 'total'],
    ],
    result: count(total) + ' equity shares',
    notes: ['The multiplier belongs to the plan, not to you — ESOP Plan 2022 grants convert at 3.6 shares per option, ' +
      'ESOP Plan 2025 at 1. That is why the number of shares can differ from the number of options.'],
  };
}

export function exerciseExplain(options: number, price: number, amount: number): CalcSpec {
  return {
    title: 'Exercise amount payable',
    formula: 'exercise amount = options × the exercise price per option',
    steps: [['Options', count(options)], ['Exercise price per option', inr2(price)], ['Exercise amount', inr(amount), 'total']],
    result: inr(amount),
    resultWords: inWords(amount),
    notes: ['Charged per option, not per share — this is the amount you transfer to the company.'],
  };
}
