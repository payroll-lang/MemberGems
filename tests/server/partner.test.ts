import { describe, expect, it } from 'vitest';
import {
  CML_REQUIRED, checkDeclineReason, checkPartnerDemat, dematMismatch, isPartnerEditable, partnerSummary, planPayment,
  problemsMessage, sortRequests, submitAllProblems,
} from '@/server/partner/rules';

const goodDemat = { accountType: 'NSDL', dpName: '', accountName: 'Asha Rao', dpId: 'in300123', clientId: '12345678', cmlFileId: '' };
const goodPay = { utr: 'utr123456', paymentDate: '2026-12-03', amount: '', bank: 'HDFC', proofFileId: '' };
const blankPay = { utr: '', date: '', amount: 0, bank: '', proofFileId: '' };

describe('partner request rules', () => {
  it('only Assigned and Sent Back are editable', () => {
    expect(['Assigned', 'Payment Fed', 'Verified', 'Sent Back', 'Declined', 'Withdrawn'].filter(isPartnerEditable)).toEqual(['Assigned', 'Sent Back']);
  });

  it('demat: DP name defaults to the partner, identifiers normalised, CML required', () => {
    const r = checkPartnerDemat(goodDemat, 'Acme Capital', true);
    expect(r).toEqual({ ok: true, value: { dpName: 'Acme Capital', accountName: 'Asha Rao', dpId: 'IN300123', clientId: '12345678', accountType: 'NSDL' } });
    expect(checkPartnerDemat(goodDemat, 'Acme Capital', false)).toEqual({ ok: false, errors: [CML_REQUIRED] });
    const bad = checkPartnerDemat({ ...goodDemat, dpId: '1234' }, 'Acme', false);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(2);
  });

  it('submitAll lists every problem at once', () => {
    const r = submitAllProblems({
      demat: { ...goodDemat, clientId: '' }, payment: { utr: '12', paymentDate: '', amount: '1000', bank: '', proofFileId: '' },
      partnerName: 'Acme', hasCml: false, hasProof: false, due: 373269, today: '2026-12-05',
    });
    expect(r.problems).toEqual([
      'Enter your client ID.',
      CML_REQUIRED,
      'That UTR looks too short. Copy it exactly as it appears in your bank statement.',
      'Enter the date on which the tax was paid.',
      'Attach the payment advice or bank statement for this transfer — the ESOP team verifies the UTR against it.',
      'The amount paid (₹1,000) is short of the tax due (₹3,73,269). Pay the balance before submitting.',
    ]);
    expect(problemsMessage(r.problems).startsWith('6 things to fix:\n\n• Enter your client ID.\n• ')).toBe(true);
    expect(problemsMessage(['Only one'])).toBe('• Only one');
  });

  it('submitAll: a blank amount means the tax due; future dates refused', () => {
    const ok = submitAllProblems({ demat: goodDemat, payment: goodPay, partnerName: 'Acme', hasCml: true, hasProof: true, due: 5000, today: '2026-12-05' });
    expect(ok).toEqual({ problems: [], paid: 5000 });
    const fut = submitAllProblems({ demat: goodDemat, payment: { ...goodPay, paymentDate: '2026-12-06' }, partnerName: 'Acme', hasCml: true, hasProof: true, due: 5000, today: '2026-12-05' });
    expect(fut.problems).toEqual(['The tax payment date cannot be in the future.']);
    // Within a rupee is not short.
    expect(submitAllProblems({ demat: goodDemat, payment: { ...goodPay, amount: '4999.5' }, partnerName: 'A', hasCml: true, hasProof: true, due: 5000, today: '2026-12-05' }).problems).toEqual([]);
  });

  it('savePayment: partial saves keep what is typed; finalise checks in the legacy order', () => {
    const partial = planPayment({ current: blankPay, entered: { ...goodPay, paymentDate: '' }, newProofFileId: '', finalise: false, due: 5000, today: '2026-12-05', dematRecorded: false });
    expect(partial).toEqual({ ok: true, payment: { utr: 'UTR123456', date: '', amount: 0, bank: 'HDFC', proofFileId: '' } });
    expect(planPayment({ current: blankPay, entered: goodPay, newProofFileId: 'F1', finalise: true, due: 5000, today: '2026-12-05', dematRecorded: false }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^Record the demat account first/) });
    expect(planPayment({ current: blankPay, entered: goodPay, newProofFileId: '', finalise: true, due: 5000, today: '2026-12-05', dematRecorded: true }))
      .toEqual({ ok: false, error: 'Upload the payment advice or bank statement for this transfer.' });
    expect(planPayment({ current: blankPay, entered: { ...goodPay, amount: '100' }, newProofFileId: 'F1', finalise: true, due: 5000, today: '2026-12-05', dematRecorded: true }))
      .toEqual({ ok: false, error: 'The amount paid (₹100) is short of the tax due (₹5,000). Pay the balance before marking this complete.' });
    expect(planPayment({ current: { ...blankPay, proofFileId: 'Fold', date: '2026-12-01' }, entered: { ...goodPay, paymentDate: '' }, newProofFileId: '', finalise: true, due: 5000, today: '2026-12-05', dematRecorded: true }))
      .toEqual({ ok: true, payment: { utr: 'UTR123456', date: '2026-12-01', amount: 5000, bank: 'HDFC', proofFileId: 'Fold' } });
  });

  it('decline needs a reason of 5 or more characters', () => {
    expect(checkDeclineReason(' no ').ok).toBe(false);
    expect(checkDeclineReason('Account not opened')).toEqual({ ok: true, value: 'Account not opened' });
  });

  it('mismatch against the participant’s own account', () => {
    expect(dematMismatch({ dpId: 'IN300123', clientId: '12345678' }, { dpId: 'in300123', clientId: '12345678' })).toBe(false);
    expect(dematMismatch({ dpId: 'IN300123', clientId: '12345678' }, { dpId: 'IN300999', clientId: '12345678' })).toBe(true);
    expect(dematMismatch({ dpId: '', clientId: '' }, { dpId: 'IN300999', clientId: '12345678' })).toBe(false);
    expect(dematMismatch(null, { dpId: 'IN300999', clientId: '12345678' })).toBe(false);
  });

  it('summary figures and worklist order', () => {
    const rows = [
      { status: 'Verified', taxAmount: 10, taxDueDate: '2026-11-25' },
      { status: 'Assigned', taxAmount: 100.5, taxDueDate: '2026-12-25' },
      { status: 'Sent Back', taxAmount: 200, taxDueDate: '2026-12-01' },
      { status: 'Payment Fed', taxAmount: 300, taxDueDate: '2026-12-25' },
      { status: 'Declined', taxAmount: 1, taxDueDate: '' },
    ];
    expect(partnerSummary(rows, '2026-12-05')).toEqual({ awaitingPayment: 2, awaitingAmount: 300.5, overdue: 1, fedNotVerified: 1, verified: 1 });
    expect(sortRequests(rows).map((r) => r.status)).toEqual(['Sent Back', 'Assigned', 'Payment Fed', 'Verified', 'Declined']);
  });
});
