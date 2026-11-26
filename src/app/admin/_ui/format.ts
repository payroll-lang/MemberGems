/** Small formatting helpers for the admin screens. */
import { inr, prettyStamp } from '@/domain';

export function sp(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

/** ₹12.3L / ₹4.5Cr for figure tiles. */
export function shortInr(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
  return inr(n);
}

export function stamp(v: string): string {
  return prettyStamp(v) || '—';
}

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== 0) u.set(k, String(v)); });
  const s = u.toString();
  return s ? '?' + s : '';
}
