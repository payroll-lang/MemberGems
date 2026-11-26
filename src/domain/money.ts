/**
 * Money helpers. The legacy code rounds inline; these name the exact same
 * expressions so the port reads clearly and rounds identically.
 */
import { num, type Numeric } from './util';

/** Math.round(x * 100) / 100 — paise. */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Math.round(x * 1e6) / 1e6 — option and share quantities. */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Math.round(x * 10000) / 100 — a ratio as a percentage to 2 dp. */
export function percent2(ratio: number): number {
  return Math.round(ratio * 10000) / 100;
}

/** Tax.gs ceilTo: round UP to a multiple of `step` (> 1), else to the nearest whole. */
export function ceilTo(x: number, step: number): number {
  return step > 1 ? Math.ceil(x / step - 1e-9) * step : Math.round(x);
}

function indianGroup(s: string): string {
  if (s.length <= 3) return s;
  const head = s.slice(0, s.length - 3);
  const tail = s.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
}

/** Util.inr: "₹2,30,926", no decimals. */
export function inr(n: Numeric): string {
  const v = Math.round(num(n));
  return (v < 0 ? '-₹' : '₹') + indianGroup(String(Math.abs(v)));
}

/** Util.inr2: "₹2,30,926.50". */
export function inr2(n: Numeric): string {
  const v = num(n);
  const whole = Math.floor(Math.abs(v));
  const paise = Math.round((Math.abs(v) - whole) * 100);
  return inr(v < 0 ? -whole : whole).replace(/^-?₹/, v < 0 ? '-₹' : '₹') +
    '.' + String(paise).padStart(2, '0');
}

/** Util.count: Indian grouping without a currency sign. */
export function count(n: Numeric): string {
  const v = Math.round(num(n));
  return (v < 0 ? '-' : '') + indianGroup(String(Math.abs(v)));
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function two(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

/**
 * Util.inWords (the server copy used by Mailer `payable` and the notice):
 * "Rupees Two Lakh Thirty Thousand Nine Hundred Twenty Six only".
 * The App.html copy differs only in reading the sign with Number() rather
 * than Util.num, which matters only for text such as "(250)".
 */
export function inWords(amount: Numeric): string {
  const raw = num(amount, 0);
  const v = Math.abs(Math.round(raw * 100) / 100);
  const whole = Math.floor(v);
  const paise = Math.round((v - whole) * 100);

  const say = (input: number): string => {
    let n = input;
    if (n === 0) return 'Zero';
    const out: string[] = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const hundred = Math.floor(n / 100); n %= 100;
    if (crore) out.push(two(crore) + ' Crore');
    if (lakh) out.push(two(lakh) + ' Lakh');
    if (thousand) out.push(two(thousand) + ' Thousand');
    if (hundred) out.push(ONES[hundred] + ' Hundred');
    if (n) out.push(two(n));
    return out.join(' ');
  };

  let out = 'Rupees ' + say(whole);
  if (paise) out += ' and ' + two(paise) + ' Paise';
  return (raw < 0 ? 'Minus ' : '') + out + ' only';
}
