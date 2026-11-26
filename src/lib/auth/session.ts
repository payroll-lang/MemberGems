import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Role } from '../schema';
import { readSession, SESSION_HOURS, type Session } from './service';

export const SESSION_COOKIE = 'esop_session';

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function getSession(): Promise<Session | null> {
  return readSession(await sessionToken());
}

/** For pages and server actions: the signed-in user with one of the given roles, or redirect. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  if (roles.length && !roles.includes(s.user.role)) redirect('/');
  return s;
}

export async function requestMeta(): Promise<{ ip?: string; userAgent?: string }> {
  const h = await headers();
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || undefined,
    userAgent: h.get('user-agent') ?? undefined,
  };
}
