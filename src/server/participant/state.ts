import 'server-only';
import {
  accessBar, computeGrantBalances, isEnabled, windowIdFor, type GrantBalance, type PriceOptions, type TaxContext, type TaxPosition,
} from '@/domain';
import type { ApplicationDoc, ApplicationLineDoc, EmployeeDoc, GrantDoc, WindowDoc } from '@/lib/schema';
import { applicationsForEmployee, appsThatMayHold, activeInWindow, currentInWindow, holdingApps, holdingLines, linesForApps, priorApps } from '../applications';
import { UserError } from '../core/errors';
import { assertEditable, assertRev, STALE_MESSAGE } from '../core/guards';

export { assertEditable, assertRev, STALE_MESSAGE };
import type { Tx } from '../db';
import { requireEmployee } from '../employees';
import { grantRecord, grantsForEmployee } from '../grants';
import type { Settings } from '../settings';
import { getTaxPosition } from '../taxPositions';
import { getWindow, stateOf } from '../windows';

/**
 * Everything about one participant that the rules need, read in one go —
 * through the transaction when a mutation is running.
 */
export interface ParticipantState {
  today: string;
  settings: Settings;
  employee: EmployeeDoc;
  windowId: string;
  window: WindowDoc | null;
  apps: ApplicationDoc[];
  grants: GrantDoc[];
  /** Lines of every application that can hold options (incl. the live one). */
  linesByApp: Map<string, ApplicationLineDoc[]>;
  taxPosition: TaxPosition | null;
}

export async function loadState(employeeId: string, settings: Settings, today: string, tx?: Tx): Promise<ParticipantState> {
  const windowId = windowIdFor(today);
  const [employee, window, apps, grants, taxPosition] = await Promise.all([
    requireEmployee(employeeId, tx),
    getWindow(windowId, tx),
    applicationsForEmployee(employeeId, tx),
    grantsForEmployee(employeeId, tx),
    getTaxPosition(employeeId, tx),
  ]);
  const holders = appsThatMayHold(apps, today).map((a) => a.appId);
  const linesByApp = await linesForApps(holders, tx);
  return { today, settings, employee, windowId, window, apps, grants, linesByApp, taxPosition };
}

export function liveApp(st: ParticipantState): ApplicationDoc | null {
  return activeInWindow(st.apps, st.employee.employeeId, st.windowId);
}

export function currentApp(st: ParticipantState): ApplicationDoc | null {
  return currentInWindow(st.apps, st.employee.employeeId, st.windowId);
}

/** Domain.grantsFor, leaving out the application being edited. */
export function balances(st: ParticipantState, excludeAppId: string): GrantBalance[] {
  const lines = [...st.linesByApp.values()].flat();
  return computeGrantBalances({
    grants: st.grants.map(grantRecord),
    applications: holdingApps(st.apps),
    lines: holdingLines(lines),
    excludeAppId,
    today: st.today,
    settings: st.settings.portal,
  });
}

export function taxContext(st: ParticipantState, appId: string): TaxContext {
  return { position: st.taxPosition, applications: priorApps(st.apps), appId, tables: st.settings.tax };
}

export function priceOptions(st: ParticipantState, appId: string): PriceOptions {
  return { tax: taxContext(st, appId), flatRounding: st.settings.portal.flatTaxRounding };
}

/** Why this participant may not act, or '' (accessBar). */
export function barOf(st: ParticipantState): string {
  return accessBar(st.employee, st.settings.portal);
}

/**
 * The window as the participant sees it. For someone not on the enabled
 * list it is shut, not merely open with the buttons refusing.
 */
export function windowViewOf(st: ParticipantState): { open: boolean; reason: string } {
  const ws = stateOf(st.window, st.today);
  const enabled = isEnabled(st.employee, st.settings.portal);
  return {
    open: ws.open && enabled,
    reason: enabled
      ? ws.reason
      : 'The exercise window is open to a limited group of participants at the moment. ' +
        'The ESOP team will write to you when it opens to you.',
  };
}

/** requireNotBlocked + requireOpenWindow, with the legacy wording. */
export function assertMayAct(st: ParticipantState): void {
  const bar = barOf(st);
  if (bar) throw new UserError(bar + ' Please contact the ESOP team if you believe this is a mistake.');
  const ws = stateOf(st.window, st.today);
  if (!ws.open) throw new UserError(ws.reason + ' Applications can only be edited while a window is open.');
}

/** EmployeeApi.requireActiveApp */
export function requireActiveApp(st: ParticipantState): ApplicationDoc {
  const app = liveApp(st);
  if (app) return app;
  const previous = currentApp(st);
  if (previous && previous.status === 'Approved') {
    throw new UserError('Application ' + previous.appId + ' has been approved. To exercise more options this window, ' +
      'start again at step 1 - the options you did not use are back in your available balance.');
  }
  throw new UserError('Start by recording the options you wish to exercise in step 1.');
}

