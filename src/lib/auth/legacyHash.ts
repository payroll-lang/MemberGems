import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies passwords hashed by the Apps Script portal (Auth.gs hashRaw):
 *
 *   key = pepper + '|' + salt
 *   h   = password
 *   repeat N: h = base64EncodeWebSafe(HMAC-SHA256(message = h, key))
 *   stored = 'r' + N + '$' + h      (no prefix = legacy, N = 5000)
 *
 * Apps Script's base64EncodeWebSafe keeps the '=' padding, so Node's
 * 'base64url' (which drops it) must NOT be used here.
 */

export const LEGACY_DEFAULT_ROUNDS = 5000;

export function appsScriptWebSafeBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function legacyHashRaw(password: string, salt: string, pepper: string, rounds: number): string {
  const key = Buffer.from(`${pepper}|${salt}`, 'utf8');
  let h = String(password);
  for (let i = 0; i < rounds; i++) {
    h = appsScriptWebSafeBase64(createHmac('sha256', key).update(h, 'utf8').digest());
  }
  return h;
}

export function parseLegacyHash(stored: string): { rounds: number; digest: string } | null {
  const s = (stored ?? '').trim();
  if (!s) return null;
  const m = s.match(/^r(\d+)\$(.*)$/);
  if (m) return { rounds: Number(m[1]), digest: m[2] };
  return { rounds: LEGACY_DEFAULT_ROUNDS, digest: s };
}

export function verifyLegacyPassword(password: string, salt: string, stored: string, pepper: string): boolean {
  const parsed = parseLegacyHash(stored);
  if (!parsed || !Number.isFinite(parsed.rounds) || parsed.rounds < 1 || parsed.rounds > 100_000) return false;
  const computed = Buffer.from(legacyHashRaw(password, salt, pepper, parsed.rounds), 'utf8');
  const expected = Buffer.from(parsed.digest, 'utf8');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
