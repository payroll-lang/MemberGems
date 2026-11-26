import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** Argon2id with a server-side pepper (the `secret` parameter). */
export async function hashPassword(password: string, pepper: string): Promise<string> {
  return argonHash(password, { secret: Buffer.from(pepper, 'utf8') });
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  try {
    return await argonVerify(stored, password, { secret: Buffer.from(pepper, 'utf8') });
  } catch {
    return false;
  }
}

/** Same rule as the old portal: 8+ characters with at least one letter and one digit. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Use at least one letter and one digit.';
  return null;
}

/** 6-digit one-time code from a cryptographic source (the old portal used Math.random). */
export function newOneTimeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(code: string, userId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`code|${userId}|${code}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Opaque session token for the cookie; only its SHA-256 is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
