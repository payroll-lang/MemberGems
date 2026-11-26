/**
 * Field validation (Domain.gs 650-760, EmployeeApi.gs save* and signNotice).
 * Each returns the normalised value or the exact legacy message.
 */
import { DEMAT_TYPES, type DematType } from './config';
import { inr, round2 } from './money';
import { addDays, num, prettyDate, toDateKey, trim, type Numeric } from './util';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Domain.validatePan: ABCDE1234F. */
export function validatePan(pan: unknown): Checked<string> {
  const p = trim(pan).toUpperCase();
  if (!p) return fail('Enter your PAN.');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) {
    return fail('That PAN does not look right. The format is five letters, four digits, one letter — for example ABCDE1234F.');
  }
  return { ok: true, value: p };
}

/** Domain.validateUtr */
export function validateUtr(utr: unknown): Checked<string> {
  const u = trim(utr).toUpperCase();
  if (!u) return fail('Enter the UTR / reference number of the transfer.');
  if (u.length < 6) return fail('That UTR looks too short. Copy it exactly as it appears in your bank statement.');
  if (!/^[A-Z0-9\-/]+$/.test(u)) return fail('A UTR contains only letters, digits, hyphens and slashes.');
  return { ok: true, value: u };
}

/**
 * Domain.validateMobile: strips spaces, hyphens, brackets and a leading
 * +91/91, then requires ^[6-9]\d{9}$. (The message mentions overseas
 * numbers, which are in fact refused — review item 19; wording kept.)
 */
export function validateMobile(mobile: unknown): Checked<string> {
  const m = trim(mobile).replace(/[\s\-()]/g, '');
  if (!m) return fail('Enter your mobile number.');
  const digits = m.replace(/^\+?91/, '');
  if (!/^[6-9][0-9]{9}$/.test(digits)) {
    return fail('Enter a 10-digit Indian mobile number, or include the country code for an overseas number.');
  }
  return { ok: true, value: digits };
}

/** Domain.validatePaymentDate: not after today, not more than 400 days before. */
export function validatePaymentDate(dateInput: unknown, label: string, today: string): Checked<string> {
  const d = toDateKey(dateInput);
  if (!d) return fail('Enter the date of the ' + label + '.');
  if (d > today) return fail('The ' + label + ' date cannot be in the future.');
  if (d < addDays(today, -400)) return fail('That ' + label + ' date is more than a year old. Please check it.');
  return { ok: true, value: d };
}

export interface DematInput {
  dematDPName: unknown;
  dematAccountName: unknown;
  dematDPId: unknown;
  dematClientId: unknown;
  dematAccountType: unknown;
}

/**
 * Domain.validateDemat.
 *   NSDL: DP ID ^IN[A-Z0-9]{6}$, client ID ^[0-9]{8}$
 *   CDSL: DP ID ^[0-9]{8}$,      client ID ^[0-9]{8}$
 * No type given: inferred from the shape.
 */
export function validateDemat(d: DematInput): Checked<{ dpId: string; clientId: string; accountType: DematType }> {
  const dpId = trim(d.dematDPId).toUpperCase();
  const clientId = trim(d.dematClientId).toUpperCase();
  const type = trim(d.dematAccountType).toUpperCase();

  if (!trim(d.dematDPName)) return fail('Enter the name of your depository participant.');
  if (!trim(d.dematAccountName)) return fail('Enter the demat account holder name, exactly as it appears on the CML.');
  if (!dpId) return fail('Enter your DP ID.');
  if (!clientId) return fail('Enter your client ID.');
  if (type && (DEMAT_TYPES as readonly string[]).indexOf(type) < 0) return fail('Choose whether the account is with NSDL or CDSL.');

  const looksNsdl = /^IN[A-Z0-9]{6}$/.test(dpId) && /^[0-9]{8}$/.test(clientId);
  const looksCdsl = /^[0-9]{8}$/.test(dpId) && /^[0-9]{8}$/.test(clientId);

  if (type === 'NSDL' && !looksNsdl) {
    return fail('For an NSDL account the DP ID is 8 characters beginning "IN" (for example IN300123) ' +
      'and the client ID is 8 digits. Check both, or switch the account type to CDSL.');
  }
  if (type === 'CDSL' && !looksCdsl) {
    return fail('For a CDSL account the 16-digit BO ID splits into an 8-digit DP ID and an ' +
      '8-digit client ID. Check both, or switch the account type to NSDL.');
  }
  if (!type && !looksNsdl && !looksCdsl) {
    return fail('Check your demat identifiers. NSDL accounts are an 8-character DP ID starting ' +
      '"IN" plus an 8-digit client ID; CDSL accounts are 16 digits split 8 and 8.');
  }
  return { ok: true, value: { dpId, clientId, accountType: (type || (looksNsdl ? 'NSDL' : 'CDSL')) as DematType } };
}

/** saveDemat (finalise): the postal address must be at least 12 characters. */
export function validateAddress(address: unknown): Checked<string> {
  const a = trim(address);
  if (a.length < 12) return fail('Enter your full postal address — it appears on the exercise notice.');
  return { ok: true, value: a };
}

/**
 * signNotice name matching: the first typed word must equal the first
 * registered word, and every further typed word must appear in the
 * registered name, in order. Compared on letters only, case-insensitive.
 */
export function signatureNameMatches(typed: unknown, expected: unknown): boolean {
  const norm = (s: string): string => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const parts = trim(expected).split(/\s+/).filter(Boolean);
  const typedParts = trim(typed).split(/\s+/).filter(Boolean);
  let matches = parts.length > 0 && typedParts.length > 0 && norm(typedParts[0]) === norm(parts[0]);
  if (matches) {
    let at = 1;
    for (let i = 1; i < typedParts.length && matches; i++) {
      while (at < parts.length && norm(parts[at]) !== norm(typedParts[i])) at++;
      if (at >= parts.length) matches = false; else at++;
    }
  }
  return matches;
}

/** signNotice's own checks after the progress gates, in legacy order. */
export function validateSignature(input: {
  accepted: unknown; place: unknown; signatureName: unknown; expectedName: unknown;
}): Checked<{ signatureName: string; place: string }> {
  if (!input.accepted) return fail('Tick the declaration to sign the notice.');
  const place = trim(input.place);
  if (!place) return fail('Enter the place at which you are signing.');
  const typed = trim(input.signatureName);
  const expected = trim(input.expectedName);
  if (!typed) return fail('Type your name to sign.');
  if (!signatureNameMatches(typed, expected)) {
    const first = expected.split(/\s+/).filter(Boolean)[0];
    return fail('Sign with your own name as it appears on your record — "' +
      (first || expected) + '" on its own is enough, or the full name "' + expected + '".');
  }
  return { ok: true, value: { signatureName: typed, place } };
}

/**
 * saveExercisePayment (finalise): the amount must be within ₹1 of the
 * exercise amount; blank/0 means "the amount due".
 */
export function validateExercisePaymentAmount(entered: Numeric, expected: Numeric): Checked<number> {
  const exp = num(expected, 0);
  const e = num(entered, 0);
  if (!e) return { ok: true, value: exp };
  if (Math.abs(e - exp) > 1) {
    return fail('The amount you entered (' + inr(e) + ') does not match the exercise amount due (' +
      inr(exp) + '). Correct the amount, or adjust the options you are exercising.');
  }
  return { ok: true, value: e };
}

/** addTaxPayment's amount and duplicate-UTR checks. */
export function validateTaxPaymentEntry(input: {
  due: Numeric; alreadyPaid: Numeric; amount: Numeric; utr: string;
  existing: readonly { utr: string; amount: Numeric; paymentDate: unknown }[];
}): Checked<{ amount: number; remaining: number }> {
  const due = num(input.due, 0);
  if (due <= 0) return fail('Your tax amount is not fixed yet. Record the exercise payment first.');
  const amount = num(input.amount, 0);
  if (amount <= 0) return fail('Enter the amount you paid against this UTR.');
  const already = num(input.alreadyPaid, 0);
  const remaining = round2(due - already);
  if (remaining <= 0) {
    return fail('The full tax of ' + inr(due) + ' is already recorded. Remove an entry first if one of them is wrong.');
  }
  if (amount > remaining + 1) {
    return fail('That is more than is outstanding. ' + inr(due) + ' is due, ' +
      inr(already) + ' is already recorded, so ' + inr(remaining) + ' remains. ' +
      'Enter ' + inr(remaining) + ' or less.');
  }
  const utr = trim(input.utr).toUpperCase();
  const dup = input.existing.filter((r) => trim(r.utr).toUpperCase() === utr)[0];
  if (dup) {
    return fail('UTR ' + utr + ' is already recorded against this application, for ' +
      inr(dup.amount) + ' on ' + prettyDate(dup.paymentDate) + '.');
  }
  return { ok: true, value: { amount: round2(amount), remaining } };
}
