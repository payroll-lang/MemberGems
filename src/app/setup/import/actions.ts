'use server';

import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { parseWorkbook, type MigrationPlan } from '@/lib/migration/parse';
import { writePlan, type WriteResult } from '@/lib/migration/write';

export interface ImportState {
  error?: string;
  dryRun?: boolean;
  report?: MigrationPlan['report'];
  result?: WriteResult;
}

function keyOk(given: string): boolean {
  const want = env().SETUP_KEY ?? '';
  if (!want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function runImport(_prev: ImportState, form: FormData): Promise<ImportState> {
  if (!env().SETUP_KEY) return { error: 'The import is switched off (no SETUP_KEY is configured).' };
  if (!keyOk(String(form.get('key') ?? ''))) {
    await new Promise((r) => setTimeout(r, 1500));
    return { error: 'That setup key is not right.' };
  }
  const file = form.get('workbook');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose the .xlsx file to import.' };
  if (!file.name.toLowerCase().endsWith('.xlsx')) return { error: 'The file must be the workbook downloaded as .xlsx.' };
  const mode = String(form.get('mode') ?? 'dry');
  try {
    const plan = await parseWorkbook(Buffer.from(await file.arrayBuffer()), 'setup-import');
    if (mode === 'dry') return { dryRun: true, report: plan.report };
    const result = await writePlan(plan, { final: mode === 'final', by: 'setup-import' });
    return { dryRun: false, report: plan.report, result };
  } catch (e) {
    console.error('import failed', e);
    return { error: (e as Error).message || 'The import failed.' };
  }
}
