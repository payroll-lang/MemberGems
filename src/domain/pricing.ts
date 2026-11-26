/**
 * Pricing an exercise (Domain.price, AppStore.indicativeFor).
 *
 *   exercise amount = options × exercise price (₹1)
 *   perquisite      = max(0, FMV × shares − exercise amount), per line, 2 dp
 *   tax             = sheet engine (tax.ts) or the flat rate
 */
import type { FlatTaxRounding } from './config';
import { shares as sharesOf } from './lots';
import { flatTaxAmount, taxForExercise, type PriorApplication, type TaxBreakdown, type TaxPosition, type TaxTables } from './tax';
import { num, type Numeric } from './util';

export interface PriceLineInput {
  grantId?: string;
  options: Numeric;
  multiplier?: Numeric;
  /** Taken as given when present; otherwise options × multiplier. */
  shares?: Numeric;
  exercisePrice?: Numeric;
  /** Taken as given when present; otherwise options × price, 2 dp. */
  lineExerciseAmount?: Numeric;
}

export interface PricedLineFields {
  shares: number;
  lineExerciseAmount: number;
  perquisitePerShare: number;
  linePerquisite: number;
}

/**
 * Everything the sheet engine needs about the participant. Supplying it is
 * the equivalent of legacy passing ctx = {employeeId, appId}.
 */
export interface TaxContext {
  position: TaxPosition | null | undefined;
  applications: readonly PriorApplication[];
  appId: string;
  tables?: TaxTables;
}

export interface PriceOptions {
  /** Omit to price on the flat rate only (legacy: no ctx). */
  tax?: TaxContext;
  flatRounding: FlatTaxRounding;
}

export interface PriceResult<L> {
  lines: (Omit<L, keyof PricedLineFields> & PricedLineFields)[];
  totalOptions: number;
  totalShares: number;
  exerciseAmount: number;
  perquisiteAmount: number;
  taxRatePercent: number;
  taxAmount: number;
  taxMethod: 'Sheet' | 'Flat' | 'None';
  taxEffectivePercent: number;
  taxBreakdown: TaxBreakdown | null;
}

/**
 * Domain.price. `fmvValue` null means no FMV applies yet: perquisite and tax
 * are zero rather than guessed.
 *
 * AGREED CHANGE (with flatRounding 'rupee'): the flat tax is whole rupees on
 * the 2-dp perquisite. With 'paise' it is legacy: paise, and on this path
 * (no tax context) computed from the unrounded sum of line perquisites.
 */
export function price<L extends PriceLineInput>(
  lines: readonly L[], fmvValue: Numeric | null, taxRatePercent: Numeric, opts: PriceOptions
): PriceResult<L> {
  const fmv = fmvValue === null || fmvValue === undefined ? null : num(fmvValue);

  let totalOptions = 0, totalShares = 0, exerciseAmount = 0, perquisite = 0;
  const priced = lines.map((l) => {
    const o = num(l.options, 0);
    const mult = num(l.multiplier, 1) || 1;
    const sh = l.shares !== undefined ? num(l.shares) : sharesOf(o, mult);
    const lineAmount = l.lineExerciseAmount !== undefined
      ? num(l.lineExerciseAmount)
      : Math.round(o * num(l.exercisePrice, 1) * 100) / 100;

    const linePerq = fmv === null ? 0 : Math.max(0, Math.round((fmv * sh - lineAmount) * 100) / 100);
    const perShare = fmv === null || sh === 0 ? 0 : Math.round((linePerq / sh) * 100) / 100;

    totalOptions += o;
    totalShares += sh;
    exerciseAmount += lineAmount;
    perquisite += linePerq;

    return Object.assign({}, l, {
      shares: sh,
      lineExerciseAmount: lineAmount,
      perquisitePerShare: perShare,
      linePerquisite: linePerq
    });
  });

  const rate = num(taxRatePercent, 0);
  const perq = Math.round(perquisite * 100) / 100;
  let tax: { amount: number; method: 'Sheet' | 'Flat' | 'None'; breakdown: TaxBreakdown | null; effectivePercent: number } = {
    amount: opts.flatRounding === 'paise' ? flatTaxAmount(perquisite, rate, 'paise') : flatTaxAmount(perq, rate, 'rupee'),
    method: perq > 0 ? 'Flat' : 'None',
    breakdown: null,
    effectivePercent: rate
  };
  if (opts.tax && perq > 0) {
    tax = taxForExercise({
      perquisite: perq, flatRate: rate, position: opts.tax.position, applications: opts.tax.applications,
      appId: opts.tax.appId || '', tables: opts.tax.tables, flatRounding: opts.flatRounding
    });
  }
  return {
    lines: priced,
    totalOptions: Math.round(totalOptions * 1e6) / 1e6,
    totalShares: Math.round(totalShares),
    exerciseAmount: Math.round(exerciseAmount * 100) / 100,
    perquisiteAmount: perq,
    taxRatePercent: rate,
    taxAmount: tax.amount,
    taxMethod: tax.method,
    taxEffectivePercent: tax.effectivePercent,
    taxBreakdown: tax.breakdown
  };
}

export interface IndicativeQuote {
  fmv: number;
  fmvDate: string;
  perquisiteAmount: number;
  taxRatePercent: number;
  taxAmount: number;
  taxMethod: 'Sheet' | 'Flat' | 'None';
  taxEffectivePercent: number;
  taxBreakdown: TaxBreakdown | null;
}

/**
 * AppStore.indicativeFor: a provisional perquisite and tax at the latest
 * price on record, for an application whose FMV is not fixed yet. Null once
 * the FMV is fixed or when no price is on record. Never stored.
 */
export function indicativeQuote<L extends PriceLineInput>(input: {
  fixedFmvValue: Numeric;
  latest: { fmv: number; date: string } | null;
  lines: readonly L[];
  taxRatePercent: Numeric;
  opts: PriceOptions;
}): IndicativeQuote | null {
  if (num(input.fixedFmvValue, 0) > 0) return null;
  if (!input.latest) return null;
  const priced = price(input.lines.map((l) => ({
    grantId: l.grantId, options: l.options, shares: l.shares, multiplier: l.multiplier,
    exercisePrice: l.exercisePrice, lineExerciseAmount: l.lineExerciseAmount
  })), input.latest.fmv, input.taxRatePercent, input.opts);
  return {
    fmv: input.latest.fmv,
    fmvDate: input.latest.date,
    perquisiteAmount: priced.perquisiteAmount,
    taxRatePercent: priced.taxRatePercent,
    taxAmount: priced.taxAmount,
    taxMethod: priced.taxMethod,
    taxEffectivePercent: priced.taxEffectivePercent,
    taxBreakdown: priced.taxBreakdown
  };
}
