/** The section review rules (AdminApi reviewSection / reviewMany / approve). Pure. */
import { STATUS, trim } from '@/domain';
import type { ApplicationDoc, ReviewState, SectionKey } from '@/lib/schema';
import { SECTION_KEYS } from '../../core/applications';
import { UserError } from '../../core/errors';

export const SECTION_LABEL: Record<SectionKey, string> = {
  options: 'Options to exercise',
  demat: 'Applicant, demat and PAN',
  exercisePayment: 'Exercise payment',
  taxPayment: 'Tax payment',
  notice: 'Exercise notice',
};

/** Which progress flag says a section has been filled in. */
export const SECTION_DONE: Record<SectionKey, 'options' | 'demat' | 'exercise' | 'tax' | 'notice'> = {
  options: 'options', demat: 'demat', exercisePayment: 'exercise', taxPayment: 'tax', notice: 'notice',
};

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === 'string' && (SECTION_KEYS as string[]).includes(v);
}

export function isVerdict(v: unknown): v is ReviewState {
  return v === 'Verified' || v === 'Sent Back' || v === 'Pending';
}

/** Nothing is reviewable until the participant submits (requireSubmitted). */
export function assertReviewable(app: Pick<ApplicationDoc, 'appId' | 'status'>): void {
  const st = trim(app.status);
  if (st === STATUS.SUBMITTED || st === STATUS.UNDER_REVIEW) return;
  if (st === STATUS.APPROVED || st === STATUS.REJECTED) throw new UserError('This application is already ' + st.toLowerCase() + '.');
  throw new UserError(app.appId + ' is still with the participant (' + st.toLowerCase() + '). There is nothing to review until they submit it.');
}

export function unverifiedSections(review: ApplicationDoc['review']): SectionKey[] {
  return SECTION_KEYS.filter((k) => review[k] !== 'Verified');
}

export function labels(keys: readonly SectionKey[]): string {
  return keys.map((k) => SECTION_LABEL[k]).join(', ');
}
