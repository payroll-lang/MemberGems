/**
 * Lots, share granularity and option-line validation (Domain.gs 186-499).
 */
import { lotSize, type PortalSettings } from './config';
import { count } from './money';
import { num, trim, type Numeric } from './util';

/**
 * The smallest whole number of options that converts to a whole number of
 * shares at this multiplier (3.6 → 5, 1 → 1).
 */
export function shareGranularity(multiplier: Numeric): number {
  const m = num(multiplier, 1) || 1;
  for (let k = 1; k <= 1000; k++) {
    const v = k * m;
    if (Math.abs(v - Math.round(v)) < 1e-9) return k;
  }
  return 1;
}

/** The step a single grant's quantity must be a multiple of. */
export function stepFor(multiplier: Numeric, settings: PortalSettings): number {
  if (settings.lotScope === 'total') return shareGranularity(multiplier);
  if (shareGranularity(multiplier) === 1) return 1;
  return lotSize(settings);
}

/** options × multiplier, to 6 dp. */
export function shares(options: Numeric, multiplier: Numeric): number {
  return Math.round(num(options) * num(multiplier, 1) * 1e6) / 1e6;
}

/** What validateLines needs to know about each grant (a GrantBalance satisfies it). */
export interface LineGrant {
  grantId: string;
  planName: string;
  multiplier: number;
  exercisePrice: number;
  availableOptions: number;
  exercisableOptions: number;
  pledgedElsewhere: number;
  step: number;
}

export interface LineRequest {
  grantId: Numeric;
  options: Numeric;
}

export interface ValidatedLine {
  grantId: string;
  planName: string;
  multiplier: number;
  options: number;
  shares: number;
  exercisePrice: number;
  lineExerciseAmount: number;
}

export type ValidateLinesResult =
  | { ok: true; lines: ValidatedLine[] }
  | { ok: false; error: string };

/**
 * Domain.validateLines, with one FIX: several lines naming the same grant are
 * merged (in the position of the first) and validated on their combined
 * total. Legacy checked each against the full balance, so together they
 * could exceed it (review item 12). A grant with any negative line is
 * reported as negative. For input without duplicates the result, including
 * every error message, is identical to legacy.
 */
export function validateLines(
  input: readonly LineRequest[] | null | undefined,
  grants: readonly LineGrant[],
  settings: PortalSettings
): ValidateLinesResult {
  const lot = lotSize(settings);
  const scope = settings.lotScope;
  const byId: Record<string, LineGrant> = {};
  grants.forEach((g) => { byId[g.grantId] = g; });

  // Merge duplicates, keeping first-appearance order.
  const merged: { gid: string; n: number; negative: boolean }[] = [];
  const at: Record<string, number> = {};
  (input || []).forEach((l) => {
    const gid = trim(l.grantId);
    const n = num(l.options, 0);
    if (!gid || n === 0) return;
    if (at[gid] === undefined) {
      at[gid] = merged.length;
      merged.push({ gid, n, negative: n < 0 });
    } else {
      const m = merged[at[gid]];
      m.n += n;
      if (n < 0) m.negative = true;
    }
  });

  const out: ValidatedLine[] = [];
  for (const { gid, n, negative } of merged) {
    const g = byId[gid];
    if (!g) return { ok: false, error: 'Grant ' + gid + ' is not on your record.' };
    if (negative || n < 0) return { ok: false, error: 'Enter a positive number of options for grant ' + gid + '.' };
    if (n === 0) continue;

    if (g.exercisableOptions <= 0) {
      return {
        ok: false,
        error: 'Grant ' + gid + ' has ' + count(g.availableOptions) +
          ' vested options, which is less than one lot of ' + lot +
          '. It cannot be exercised on its own' +
          (scope === 'grant' ? '.' : ' unless combined with another grant.')
      };
    }

    const step = g.step;
    if (Math.abs(n / step - Math.round(n / step)) > 1e-9) {
      const lower = Math.floor(n / step) * step;
      const upper = lower + step;
      return {
        ok: false,
        error: 'For grant ' + gid + ', options must be in multiples of ' + step +
          '. You entered ' + count(n) + ' — use ' + count(lower) + ' or ' + count(upper) + '.' +
          (step !== lot ? ' (A multiple of ' + step + ' is what converts to a whole number of shares at a multiplier of ' + g.multiplier + '.)' : '')
      };
    }

    if (n > g.exercisableOptions + 1e-9) {
      return {
        ok: false,
        error: 'Grant ' + gid + ' has ' + count(g.exercisableOptions) +
          ' options available to exercise' +
          (g.pledgedElsewhere ? ' (' + count(g.pledgedElsewhere) + ' are already committed on another application)' : '') +
          '. You entered ' + count(n) + '.'
      };
    }

    const sh = shares(n, g.multiplier);
    if (Math.abs(sh - Math.round(sh)) > 1e-6) {
      return {
        ok: false,
        error: 'For grant ' + gid + ', ' + count(n) + ' options convert to ' + sh +
          ' shares, which is not a whole number. Use a multiple of ' + shareGranularity(g.multiplier) + '.'
      };
    }

    out.push({
      grantId: gid,
      planName: g.planName,
      multiplier: g.multiplier,
      options: n,
      shares: Math.round(sh),
      exercisePrice: g.exercisePrice,
      lineExerciseAmount: Math.round(n * g.exercisePrice * 100) / 100
    });
  }

  if (!out.length) {
    return { ok: false, error: 'Enter the number of options you wish to exercise on at least one grant.' };
  }

  if (scope === 'total') {
    const total = out.reduce((a, l) => a + l.options, 0);
    if (Math.abs(total / lot - Math.round(total / lot)) > 1e-9) {
      const lower = Math.floor(total / lot) * lot;
      return {
        ok: false,
        error: 'Your total across all grants must be a multiple of ' + lot +
          '. You have entered ' + count(total) + ' — adjust to ' + count(lower) +
          ' or ' + count(lower + lot) + '.'
      };
    }
  }

  return { ok: true, lines: out };
}
