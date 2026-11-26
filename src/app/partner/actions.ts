'use server';

import { refresh } from 'next/cache';
import { requireRole } from '@/lib/auth/session';
import type { FormResult } from '@/components/useFormAction';
import type { ActionResult } from '@/server/errors';
import {
  declinePartnerRequest, savePartnerDemat, savePartnerPayment, submitPartnerRequest,
} from '@/server/partner/mutations';
import type { PartnerDematInput, PartnerPaymentInput } from '@/server/partner/rules';

/**
 * The fund partner's server actions. Each re-authenticates and hands a typed
 * request to src/server/partner/mutations, which re-checks ownership and
 * status inside a transaction.
 */

async function partner() {
  return (await requireRole('FundPartner')).user;
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.slice(0, 2000) : '';
}

function dematOf(form: FormData): PartnerDematInput {
  return {
    accountType: str(form, 'accountType'), dpName: str(form, 'dpName'), accountName: str(form, 'accountName'),
    dpId: str(form, 'dpId'), clientId: str(form, 'clientId'), cmlFileId: str(form, 'cmlFileId'),
  };
}

function paymentOf(form: FormData): PartnerPaymentInput {
  return {
    utr: str(form, 'utr'), paymentDate: str(form, 'paymentDate'), amount: str(form, 'amount'),
    bank: str(form, 'bank'), proofFileId: str(form, 'proofFileId'),
  };
}

function finish(r: ActionResult): FormResult {
  refresh();
  return r.ok ? { ok: true, message: r.message, at: Date.now() } : { ok: false, error: r.error, at: Date.now() };
}

/** One form, three buttons: submit everything, save the payment only, or save the account only. */
export async function partnerRequestAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await partner();
  const requestId = str(form, 'requestId');
  const intent = str(form, 'intent');
  if (intent === 'submit') {
    return finish(await submitPartnerRequest(user, { requestId, demat: dematOf(form), payment: paymentOf(form) }));
  }
  if (intent === 'demat') return finish(await savePartnerDemat(user, { requestId, demat: dematOf(form) }));
  if (intent === 'save') return finish(await savePartnerPayment(user, { requestId, payment: paymentOf(form), finalise: false }));
  return { ok: false, error: 'Choose what to do.', at: Date.now() };
}

export async function declineAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const user = await partner();
  return finish(await declinePartnerRequest(user, { requestId: str(form, 'requestId'), reason: str(form, 'reason') }));
}
