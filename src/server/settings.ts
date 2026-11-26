import 'server-only';
import { cache } from 'react';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/schema';
import { buildSettings, type Settings } from './core/settings';

export type { Settings } from './core/settings';
export { cfgText, parseBankDetails, PORTAL_TEXT_DEFAULTS } from './core/settings';

/** settings/portal, settings/taxRules and settings/holidays, read once per request. */
export const loadSettings = cache(async (): Promise<Settings> => {
  const col = db().collection(COL.settings);
  const [portal, taxRules, holidays] = await db().getAll(col.doc('portal'), col.doc('taxRules'), col.doc('holidays'));
  return buildSettings(portal.data(), taxRules.data(), holidays.data());
});
