# Go-live runbook: ESOP Exercise Portal on Vercel + Firestore

Target: the window opening **1 December 2026**. The November window on the old
portal closes on 30 November. Switch over on the night of 30 November.

Portal: https://esop-portal-pw-payroll.vercel.app (until a custom domain such as
`esop.pw.live` is connected).

---

## A. One-time setup (before the trial)

| # | Step | Who | Status |
|---|---|---|---|
| A1 | Firestore (Native, asia-south1) and Storage (asia-south1) created | ESOP team | ✅ |
| A2 | Vercel env vars: `FIREBASE_SERVICE_ACCOUNT`, `LEGACY_ESOP_PEPPER`, `PASSWORD_PEPPER`, `CRON_SECRET`, `SETUP_KEY`, `PORTAL_URL`, `EMAIL_SENDER`, `EMAIL_SENDER_NAME`, `SUPPORT_EMAIL` | ESOP team / Claude | ✅ |
| A3 | GitHub repository linked to Vercel | ESOP team | ✅ |
| A4 | **Gmail sending as esop@pw.live:** enable the Gmail API in Cloud project hrmemgems; in admin.google.com add domain-wide delegation for the service account's Client ID with scope `https://www.googleapis.com/auth/gmail.send` | Workspace super-admin | ⏳ |
| A5 | Health check, which also sets the Storage CORS rule for browser uploads | Claude | after deploy |

## B. Trial (29–30 November)

1. **Trial import.** Download the sheet "ESOP Exercise Portal — Data" as .xlsx.
   Open `/setup/import` and enter the setup key.
   - Run **Check only**. Expect about 2,151 employees, 3,584 grants, 3 users and no warnings.
   - Then run **Import**.
2. **Sign in as the ESOP admin** with the *old* password. The password is
   upgraded automatically on first sign-in.
3. **Admin checks:**
   - **Participants:** figures look right for 5–10 people you know.
   - **Share price:** prices up to the latest trading day are present.
     **Enter the NSE holidays** (Share price → Holidays). The portal will not
     guess a price for a missing day.
   - **Settings:** check the bank details, notice wording, ALLOWED_PLANS and
     the admin notify emails.
4. **End-to-end test with the test employee (PW4872) and the test fund partner.**
   Complete one application each way: self-paid tax, and partner-paid tax.
   Then verify, send back, correct, approve, and check the notice PDF and the
   export.
   - Emails stay **off** after an import (`EMAILS_ENABLED=false`). To test
     email, switch it on briefly in Settings, using only the test accounts.
5. **Compare figures with the old portal** for 3 to 5 real participants. Look at
   exercisable options, FMV, perquisite and tax for the same inputs. The rules
   are golden-tested against the old code, but this is the business sign-off.
6. **Remove the test data** created in step 4 before the final import. Re-running
   the import does not delete applications.

## C. Cut-over (night of 30 November)

1. **Old portal: stop new activity.**
   - Set the old portal's Config to `EMAILS_ENABLED=false`.
   - Post a notice that the portal is moving.
   - Leave the Apps Script deployment in place as a fallback; do not delete it.
2. **Final data.**
   - Make sure the grant report and the tax sheet in the old workbook are the
     latest.
   - Download the workbook as .xlsx again.
   - In `/setup/import`, run **Check only**, then **Final import**. The final
     import locks the import page.
3. **Settings on the new portal.**
   - `EMAILS_ENABLED=true`.
   - Decide on `BULK_EMAILS_ENABLED` for the 1 December announcement.
   - Check `ADMIN_NOTIFY_EMAILS`.
4. **Logins for everyone else.** Only 3 logins exist today.
   - Go to Admin → Logins → "Create logins for all exercisable participants",
     with "email the codes" ticked. This needs A4 to be done.
   - Codes expire after 30 minutes. People who miss it use "Set or reset
     password" on the sign-in page.
5. **Point people to the new address.** Update the link in the old portal's
   page or email footer, and in any intranet links.
6. **Remove `SETUP_KEY`** from Vercel and redeploy. The import is off for good.

## D. Rollback

The old Apps Script portal and its sheet are untouched. To roll back:
1. switch the old portal's `EMAILS_ENABLED` back on;
2. tell participants to use the old link.

Anything entered on the new portal after go-live would have to be re-keyed in
the old one, so decide within the first day.

## E. Known limits at go-live

- **Share prices are entered manually.** The NSE / Google Finance fetch is not
  ported. The 8 am and 8 pm jobs alert if a trading day's price is missing.
- **The notice PDF prints "Rs."** instead of the ₹ sign; the built-in PDF fonts
  have no ₹. The on-screen notice and emails use ₹.
- **Late corrections:** an application sent back after its window has closed
  cannot be resubmitted. This is the same as the old portal. Approve or reject
  such applications instead.
- **No retries for failed emails:** a failed email is logged, not retried.
  Check the email log after the 1 December announcement.
