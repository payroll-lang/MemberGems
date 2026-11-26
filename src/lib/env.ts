import 'server-only';
import { z } from 'zod';

/**
 * Server environment. Every secret lives in Vercel environment variables
 * (Sensitive type) and is never sent to the browser.
 */
const schema = z.object({
  /** Service-account key JSON for the hrmemgems project (pasted as-is), or base64 of it. */
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().default('hrmemgems'),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  /**
   * The legacy Apps Script pepper (Script Property ESOP_PEPPER). Needed only to
   * verify passwords created on the old portal; each one is rehashed with
   * Argon2id on its owner's next sign-in.
   */
  LEGACY_ESOP_PEPPER: z.string().optional(),
  /** Pepper for new Argon2id hashes and one-time codes. 32+ random bytes. */
  PASSWORD_PEPPER: z.string().min(32),
  /** Public base URL used in email links, e.g. https://esop.pw.live */
  PORTAL_URL: z.string().url().default('http://localhost:3000'),
  /** Passphrase for the one-time data import page (/setup/import). Remove after go-live. */
  SETUP_KEY: z.string().min(12).optional(),
  /** Secret that scheduled jobs must present (Authorization: Bearer ...). */
  CRON_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
