'use server';

import { redirect } from 'next/navigation';
import { AuthError, login, revokeSession, resolveUser, issueCode, setPasswordWithCode } from '@/lib/auth/service';
import { clearSessionCookie, requestMeta, sessionToken, setSessionCookie } from '@/lib/auth/session';
import { sendTemplate } from '@/lib/mail';

export interface FormState {
  error?: string;
  message?: string;
}

function homeFor(role: string, mustReset: boolean): string {
  if (mustReset) return '/login/set-password';
  return role === 'Admin' ? '/admin' : role === 'FundPartner' ? '/partner' : '/employee';
}

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const identifier = String(form.get('identifier') ?? '');
  const password = String(form.get('password') ?? '');
  let dest: string;
  try {
    const res = await login(identifier, password, await requestMeta());
    await setSessionCookie(res.token);
    dest = homeFor(res.user.role, res.user.mustResetPassword);
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error('signIn failed', e);
    return { error: 'Something went wrong. Please try again.' };
  }
  redirect(dest);
}

export async function requestCode(_prev: FormState, form: FormData): Promise<FormState> {
  const identifier = String(form.get('identifier') ?? '');
  const done: FormState = {
    message: 'If that matches a login, a 6-digit code has been sent to the email on record. It is valid for 30 minutes.',
  };
  try {
    const user = await resolveUser(identifier);
    if (user && user.status === 'Active') {
      const code = await issueCode(user, 'reset');
      await sendTemplate('reset_code', user.notifyEmail, { name: user.name, code });
    }
  } catch (e) {
    console.error('requestCode failed', e);
  }
  return done;
}

export async function setPassword(_prev: FormState, form: FormData): Promise<FormState> {
  const identifier = String(form.get('identifier') ?? '');
  const code = String(form.get('code') ?? '');
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) return { error: 'The two passwords do not match.' };
  let dest = '/login';
  try {
    const res = await setPasswordWithCode(identifier, code, password, await requestMeta());
    await sendTemplate('password_changed', res.user.notifyEmail, { name: res.user.name });
    if (!res.token) return { message: 'Your password is set. Your access is on hold; contact the ESOP team.' };
    await setSessionCookie(res.token);
    dest = homeFor(res.user.role, false);
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message };
    console.error('setPassword failed', e);
    return { error: 'Something went wrong. Please try again.' };
  }
  redirect(dest);
}

export async function signOut(): Promise<void> {
  const token = await sessionToken();
  if (token) await revokeSession(token);
  await clearSessionCookie();
  redirect('/login');
}
