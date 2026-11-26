/**
 * The ESOP exercise rules: a pure TypeScript port of the legacy Apps Script
 * Domain.gs / Tax.gs / AppStore.progress. No I/O, no clock: callers pass
 * `today` and data in. Dates are 'yyyy-MM-dd' (Asia/Kolkata).
 */
export * from './config';
export * from './util';
export * from './money';
export * from './lots';
export * from './eligibility';
export * from './fmv';
export * from './pricing';
export * from './tax';
export * from './windows';
export * from './progress';
export * from './validation';
