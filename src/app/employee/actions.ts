'use server';

import { refresh } from 'next/cache';
import { requireRole } from '@/lib/auth/session';
import type { ActionResult } from '@/server/errors';
import { latestPrice } from '@/server/fmv';
import {
  addTaxPayment, chooseTaxMode, deleteTaxPayment, quoteFor, saveDemat, saveExercisePayment, saveOptions, signNotice,
  submitApplication, type Expect, type Quote,
} from '@/server/participant/mutations';

/**
 * The participant's server actions. Each one re-authenticates, then hands a
 * typed request to src/server/participant/mutations, which re-checks every
 * rule (access, window, editability, revision) inside a transaction.
 */

export interface FormResult {
  ok?: boolean;
  message?: string;
  error?: string;
  /** Changes on every response, so the same message twice still re-announces. */
  at?: number;
}

async function participant() {
  return (await requireRole('Employee')).user;
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
}

function expectOf(form: FormData): Expect {
  const rev = Number(str(form, 'rev'));
  return { appId: str(form, 'appId'), rev: Number.isFinite(rev) ? rev : -1 };
}

function finish(r: ActionResult): FormResult {
  refresh();
  return r.ok ? { ok: true, message: r.message, at: Date.now() } : { ok: false, error: r.error, at: Date.now() };
}

/** Live figures for the options form. Saves nothing. */
export async function quoteAction(lines: { grantId: string; options: number }[]): Promise<{ ok: true; quote: Quote } | { ok: false; error: string }> {
  const user = await participant();
  const clean = (Array.isArray(lines) ? lines : []).slice(0, 200)
    .map((l) => ({ grantId: String(l?.grantId ?? ''), options: Number(l?.options) || 0 }))
    .filter((l) => l.grantId && l.options);
  if (!clean.length) return { ok: false, error: '' };
  const latest = await latestPrice();
  return quoteFor(user, clean, latest ? { fmv: latest.fmv, date: latest.date } : null);
}

export async function saveOptionsAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  const lines: { grantId: string; options: number }[] = [];
  for (const [k, v] of form.entries()) {
    if (!k.startsWith('opt:') || typeof v !== 'string' || !v.trim()) continue;
    const n = Number(v);
    lines.push({ grantId: k.slice(4), options: Number.isFinite(n) ? n : NaN });
  }
  const bad = lines.find((l) => !Number.isFinite(l.options));
  if (bad) return { ok: false, error: 'Enter a whole number of options for grant ' + bad.grantId + '.', at: Date.now() };
  return finish(await saveOptions(user, { expect: expectOf(form), lines: lines.filter((l) => l.options !== 0) }));
}

export async function saveDematAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await saveDemat(user, {
    expect: expectOf(form),
    finalise: str(form, 'finalise') === '1',
    fields: {
      designation: str(form, 'designation'), address: str(form, 'address'), nationality: str(form, 'nationality'),
      mobile: str(form, 'mobile'), dematDPName: str(form, 'dpName'), dematAccountName: str(form, 'accountName'),
      dematDPId: str(form, 'dpId'), dematClientId: str(form, 'clientId'), dematAccountType: str(form, 'accountType'),
      pan: str(form, 'pan'), cmlFileId: str(form, 'cmlFileId'), panFileId: str(form, 'panFileId'),
    },
  }));
}

export async function saveExerciseAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await saveExercisePayment(user, {
    expect: expectOf(form),
    finalise: str(form, 'finalise') === '1',
    fields: {
      utr: str(form, 'utr'), paymentDate: str(form, 'paymentDate'), amount: str(form, 'amount'),
      bank: str(form, 'bank'), proofFileId: str(form, 'proofFileId'),
    },
  }));
}

export async function chooseTaxModeAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await chooseTaxMode(user, { expect: expectOf(form), mode: str(form, 'mode'), partnerId: str(form, 'partnerId') }));
}

export async function addTaxPaymentAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await addTaxPayment(user, {
    expect: expectOf(form),
    fields: {
      utr: str(form, 'utr'), paymentDate: str(form, 'paymentDate'), amount: str(form, 'amount'),
      bank: str(form, 'bank'), proofFileId: str(form, 'proofFileId'),
    },
  }));
}

export async function deleteTaxPaymentAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await deleteTaxPayment(user, { expect: expectOf(form), paymentId: str(form, 'paymentId') }));
}

export async function signNoticeAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await signNotice(user, {
    expect: expectOf(form), signatureName: str(form, 'signatureName'), place: str(form, 'place'),
    accepted: str(form, 'accepted') === 'yes',
  }));
}

export async function submitAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await participant();
  return finish(await submitApplication(user, { expect: expectOf(form) }));
}
