import { describe, expect, it } from 'vitest';
import {
  daysUntil, dedupeKeys, isAbandoned, isDraftReminderDay, isFinalStatus, isStaleWindow, isTaxReminderDay,
  priceDayToCheck, taxReminderDates, windowOpenJobId,
} from '@/server/jobs/plan';

describe('job date rules', () => {
  const holidays = ['2026-12-25'];

  it('morning checks the previous trading day, skipping weekends and holidays', () => {
    expect(priceDayToCheck('2026-12-02', holidays, 'morning')).toBe('2026-12-01'); // Wed → Tue
    expect(priceDayToCheck('2026-12-07', holidays, 'morning')).toBe('2026-12-04'); // Mon → Fri
    expect(priceDayToCheck('2026-12-28', holidays, 'morning')).toBe('2026-12-24'); // Mon after Christmas Fri
  });

  it('evening checks today only on a trading day', () => {
    expect(priceDayToCheck('2026-12-02', holidays, 'evening')).toBe('2026-12-02');
    expect(priceDayToCheck('2026-12-05', holidays, 'evening')).toBeNull(); // Saturday
    expect(priceDayToCheck('2026-12-25', holidays, 'evening')).toBeNull(); // holiday
  });

  it('tax reminders go 5, 2, 0 days before and the day after', () => {
    expect([6, 5, 4, 3, 2, 1, 0, -1, -2].filter(isTaxReminderDay)).toEqual([5, 2, 0, -1]);
    expect(taxReminderDates('2026-12-25')).toEqual(['2026-12-20', '2026-12-23', '2026-12-25', '2026-12-26']);
    expect(daysUntil('2026-12-20', '2026-12-25')).toBe(5);
    expect(daysUntil('2026-12-26', '2026-12-25')).toBe(-1);
    expect(daysUntil('2026-12-26', '')).toBeNull();
  });

  it('draft reminders go 2 days before close and on the last day', () => {
    expect([3, 2, 1, 0, -1].filter(isDraftReminderDay)).toEqual([2, 0]);
  });

  it('final, abandoned and stale', () => {
    expect(isFinalStatus('Approved')).toBe(true);
    expect(isFinalStatus('Rejected')).toBe(true);
    expect(isFinalStatus('Submitted')).toBe(false);
    expect(isAbandoned({ status: 'Draft', windowId: '2026-11' }, '2026-12-03')).toBe(true);
    expect(isAbandoned({ status: 'Sent Back', windowId: '2026-12' }, '2026-12-03')).toBe(false);
    expect(isAbandoned({ status: 'Submitted', windowId: '2026-11' }, '2026-12-03')).toBe(false);
    expect(isStaleWindow({ status: 'Open', closeDate: '2026-11-30' }, '2026-12-01')).toBe(true);
    expect(isStaleWindow({ status: 'Open', closeDate: '2026-12-01' }, '2026-12-01')).toBe(false);
    expect(isStaleWindow({ status: 'Closed', closeDate: '2026-11-30' }, '2026-12-01')).toBe(false);
  });
});

describe('dedupe keys', () => {
  it('are deterministic and differ by day, application and recipient', () => {
    expect(dedupeKeys.taxReminder('APP-202612-PW1', '2026-12-20')).toBe('tax_reminder:APP-202612-PW1:2026-12-20');
    expect(dedupeKeys.taxReminder('A', '2026-12-20')).not.toBe(dedupeKeys.taxReminder('A', '2026-12-23'));
    expect(dedupeKeys.partnerTaxReminder('A', 'FP1', '2026-12-20')).not.toBe(dedupeKeys.partnerTaxReminder('A', 'FP2', '2026-12-20'));
    expect(dedupeKeys.draftReminder('A', '2026-12-28')).toBe('window_closing:A:2026-12-28');
    // Once per window per participant, whatever day the batch reaches them.
    expect(dedupeKeys.windowOpen('2026-12', 'PW1')).toBe('window_open:2026-12:PW1');
    expect(dedupeKeys.priceMissing('2026-12-01', 'morning', '2026-12-02')).not.toBe(dedupeKeys.priceMissing('2026-12-01', 'evening', '2026-12-01'));
    expect(windowOpenJobId('2026-12')).toBe('window_open-2026-12');
    // Firestore document ids may not contain '/'.
    for (const k of [dedupeKeys.taxReminder('A', 'B'), dedupeKeys.windowOpen('2026-12', 'X')]) expect(k).not.toContain('/');
  });
});
