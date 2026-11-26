/**
 * An expected refusal with a message for the person using the portal
 * (legacy `throw new Error(message)` on the participant's side). Anything
 * else thrown is a fault and is logged, not shown.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export type ActionResult =
  | { ok: true; message: string; appId?: string; data?: unknown }
  | { ok: false; error: string };

export function fail(error: string): ActionResult {
  return { ok: false, error };
}

export const GENERIC_FAILURE = 'Something went wrong and nothing was saved. Please try again; if it keeps happening, contact the ESOP team.';

/** Turn a thrown error into a result for the client, logging faults. */
export function toActionResult(e: unknown, context: string): ActionResult {
  if (e instanceof UserError) return { ok: false, error: e.message };
  console.error(context + ' failed', e);
  return { ok: false, error: GENERIC_FAILURE };
}
