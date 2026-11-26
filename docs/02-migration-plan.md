# ESOP Exercise Portal: migration plan (draft for discussion)

From Google Apps Script and Sheets to **Next.js on Vercel**, **Firestore** and **GitHub**.
This builds on `01-legacy-review.md`. Items marked **[Decide]** need an answer from the ESOP team.

---

## 1. Target architecture

```
Browser (participant / admin / fund partner)
   │  HTTPS, httpOnly session cookie
   ▼
Vercel: Next.js App Router (Node.js runtime, region bom1 Mumbai)
   ├─ Server pages and route handlers (all business rules run here)
   ├─ packages/domain: pure TypeScript port of Domain.gs and Tax.gs (unit tested)
   ├─ Vercel Schedules: 08:00 and 20:00 IST jobs
   │
   ├──► Firestore (asia-south1 Mumbai), Firebase Admin SDK, server only
   ├──► Cloud Storage bucket (asia-south1), private, read only through short-lived signed URLs
   └──► Email: [Decide] Gmail API as esop@pw.live, or a transactional email service
GitHub (payroll-lang/MemberGems): code, pull-request reviews, CI tests; Vercel deploys from it
```

**Principles:**
- **The browser never reads Firestore or Storage directly.** Every read and write goes through the
  server, which checks the role.
  - Firestore security rules are set to deny all client access.
  - This is the simplest safe model for PAN, demat and salary data.
- **Data stays in India.** Firestore, Storage and the Vercel functions all run in Mumbai.
- **Rules live in one place.** The tax, eligibility, lot and pricing rules are a single tested module
  used by every screen, job and export.
- **Settings stay editable.** Everything that is a Config or tax-rule tab today remains editable on the
  admin Settings screen, with an audit entry for each change.

---

## 2. Sign-in

- **Keep the current model:** the employee code or an email on record, plus a password. This also
  works for people who have left.
- **Existing passwords keep working.**
  - The legacy `r200$…` hash is checked with the copied `ESOP_PEPPER`.
  - On the first successful login, the password is rehashed with Argon2id (the modern standard), and
    the legacy hash is deleted.
- **Fixes:**
  - Attempt limits per account **and** per IP address.
  - Codes from a cryptographic random generator, with a limit on guesses.
  - A reset no longer clears the lockout.
  - A blocked user cannot sign in.
  - Logging out ends the session on the server (sessions are stored in Firestore).
  - Separate keys for signing sessions and for hashing passwords.
- **[Decide]** Optional "Sign in with Google" for `@pw.live` admin accounts, with two-step verification
  enforced by Workspace.

---

## 3. Delivery phases

| Phase | What | Output |
|---|---|---|
| **0. Setup** | GitHub repo layout, Next.js app, Vercel project, Firebase project (Mumbai), CI, environments (dev / staging / prod) | An empty app deployed to staging |
| **1. Rules engine** | Port Domain.gs and Tax.gs (eligibility, lot rule, shares, FMV, perquisite, both tax methods, due dates) to TypeScript. **Golden tests:** the same inputs run through the old Apps Script code must give the same rupee results. | `packages/domain` with tests |
| **2. Data model and migration scripts** | Firestore schema; import scripts for Sheet → Firestore and Drive → Storage that can be run again safely; reconciliation report (counts and totals match) | Staging loaded with a copy of live data |
| **3. Participant portal** | Sign-in, dashboard, grants, the 6-step wizard, uploads, notice PDF, history | Employees can complete an application on staging |
| **4. Admin portal** | Queue, detail and section review, approve / send back / reject, participants and bulk pastes, grant sync, tax-sheet load, share price and holiday calendar, logins, fund partners, settings, export (XLSX/CSV), audit view | The ESOP team can process applications on staging |
| **5. Fund-partner portal** | Requests, demat, payment, decline | Partners can work on staging |
| **6. Jobs and email** | Window open/close, reminders (deduplicated by a unique key), price job, missing-price alert, all 25 templates | Automated running on staging |
| **7. Parallel run (UAT)** | The ESOP team runs real cases on staging against the live portal; results are compared | Sign-off |
| **8. Cut-over** | Between two windows (see section 5) | Live on Vercel; Apps Script made read-only |

The fixes listed in the review (items 1–19) are built into phases 1–6. They are not a separate phase.

---

## 4. Rule changes agreed

| Rule | Old | New |
|---|---|---|
| Missing share price | Uses any older price | **Stops.** The payment step waits until the price is entered; the ESOP team is alerted. Exchange holidays are kept in an admin-editable calendar, so "previous trading day" is exact. |
| Grant expiry / separation | Not enforced | Unchanged. Not enforced; handled case by case with block and eligibility. |
| PendingAcceptance grants | Exercisable | Unchanged. |
| Test Plan | Allowed | Removed from allowed plans; test data not migrated. |
| Flat-tax rounding | Paise | **[Confirm]** keep paise, or round to whole rupees |
| Send back on approved / rejected | Allowed (bug) | Blocked |
| Repricing after submission | Silent | Frozen once submitted. An admin can reprice explicitly, with an audit entry and a notice to the participant. |
| Editing after signing | Old notice kept | Signature cleared; re-signing is required |

---

## 5. Cut-over approach

- Windows run from the 1st to the 30th. The cut-over is done **after a window closes and before the
  next one opens**, for example the evening of the 30th or 31st.
- **Steps:**
  1. Freeze the Apps Script portal (read-only banner).
  2. Run a final import (Sheet → Firestore, Drive → Storage).
  3. Check the reconciliation report.
  4. Switch the email links and `PORTAL_URL`.
  5. Announce.
- **Open applications** (tax still being paid after the window closes) carry over with their full
  history.
- **Rollback:** the Apps Script portal and the Sheet are left untouched, so it can be switched back on.

---

## 6. Things needed from the ESOP team

1. **Google Cloud / Firebase project:** who owns it and pays for it. A project under the `pw.live`
   Workspace is recommended, so the data stays under company control.
2. **Vercel account / team** for hosting, and the **domain**, for example `esop.pw.live` (needs one DNS
   record from IT).
3. **Email sending:** as `esop@pw.live` through the Gmail API (needs a Workspace admin to approve), or a
   transactional email service with a `pw.live` sender domain.
4. **`ESOP_PEPPER`**, copied from Script Properties into the Vercel secret store at migration time. Do not
   share it in chat or email.
5. **Target go-live window** (for example, the window opening 1 February 2027).
6. A **staging test group**: 2–3 people from the ESOP team plus 1 fund partner.
