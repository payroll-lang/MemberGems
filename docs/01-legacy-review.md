# ESOP Exercise Portal — Review of the current Apps Script system

Reviewed 2026-11-26 from the source snapshot in `legacy/apps-script/` (v2.1.0, about 19,000 lines)
and the live data sheet "ESOP Exercise Portal — Data". The purpose is to record what the system does
today, so the move to Vercel + Firestore + GitHub keeps every rule, and to list what should be fixed
along the way.

---

## 1. What it is

A web portal where PhysicsWallah Limited ESOP holders, including people who have left, **exercise
vested options** once a month. They pay the exercise price and the perquisite tax, provide a demat
account, and sign an exercise notice. The ESOP team verifies each application section by section and
approves it. **Fund partners** (brokers who finance the tax) can pay the tax and supply the demat
account for a participant.

| Layer | Today |
|---|---|
| Hosting | Apps Script web app, "execute as owner, anyone can access" (owner: the ESOP team account) |
| Database | One Google Sheet with 19 tabs |
| Files | The owner's Google Drive, one folder per employee and one sub-folder per application |
| Email | Gmail (MailApp), 25 templates, all logged to the `EmailLog` tab |
| Jobs | Two daily triggers: 08:00 (reminders and windows) and 20:00 (share price) |
| Front end | One single-page app of 5,800 lines (`App.html`) with no framework, plus `Styles.html` and `Index.html` |
| Back end | One RPC entry point `rpc(method, token, payload)` and about 60 methods, each with a role check |

---

## 2. Users and sign-in

**Roles:** `Admin`, `Employee` (participant) and `FundPartner`.

**Sign-in** uses the portal's own passwords, not Google login. The user ID is the employee code, or any
email on record. Leavers sign in with the personal email held in the vesting report.

**Password storage** (`Auth.gs`):
- The hash is an HMAC-SHA256 chain of 200 rounds, keyed by `pepper + "|" + salt`. Each round's output is
  base64url **with `=` padding**.
- It is stored as `r200$<digest>`. A value without a prefix is a legacy hash at 5,000 rounds.
- The pepper is in the script's **Script Properties as `ESOP_PEPPER`**.
- These hashes **can be checked in Node.js**, so existing passwords can carry over without a forced
  reset, provided the pepper is copied across securely.

**Sessions** are stateless signed tokens that last 8 hours. Each user has a `TokenVersion`, and raising
it signs out all of that user's sessions. The token is kept in the browser's `sessionStorage`.

**Lockout and invites:**
- Five failed attempts lock the account for 20 minutes.
- Reset and invite codes are 6 digits and valid for 30 minutes.
- Admins can bulk-create logins for participants. Codes are shown on screen, or emailed when
  `INVITE_EMAILS=auto`.

---

## 3. The participant journey (6 steps)

| # | Step | Key rules |
|---|---|---|
| 1 | **Options** | Pick options per grant from the exercisable balance. Lot of 10, or a step of 1 for 1:1 plans. `LOT_SCOPE` sets whether the lot applies per grant or to the total. A live quote shows shares, amount, perquisite and tax. |
| 2 | **Applicant, demat and PAN** | Address (at least 12 characters), Indian mobile number, designation, NSDL/CDSL account (DP ID and client ID checked for shape), PAN (`ABCDE1234F`), CML upload, PAN-card upload. Saved back to the employee master. |
| 3 | **Exercise payment** | ₹1 × options to the company account. UTR, date (not in the future, at most 400 days old), amount within ±₹1, and a proof file. **Saving the date fixes the FMV and the tax due date.** |
| 4 | **Tax** | **Self:** one or more instalments, each with its own UTR and proof. **Fund partner:** a request is created and the partner pays in one transfer, possibly also supplying the demat account. |
| 5 | **Notice** | Generated exercise notice (HTML, then PDF to Drive). Signed by typing your registered name and a place. Emailed with the PDF attached. |
| 6 | **Submit** | Every section complete and none still sent back. Lines are re-checked against the live balance. |

**Application statuses:** Draft → Submitted → Under Review → Approved, or Sent Back (back to the
participant), or Rejected. A participant can have only **one live application per window**. After an
approval or rejection they can start another (`APP-YYYYMM-EMPID-2`).

**Saving and resuming:** each step has "Save for later", and the portal reopens at the first unfinished
section.

---

## 4. The calculations (must be ported exactly)

**Exercisable balance:**
- The report's `Vested` figure, minus options held by the employee's own applications. Rejected
  applications hold nothing. Drafts from past windows hold nothing. Approved applications approved
  after the report's "as on" date still hold their options.
- Rounded down to the lot step.
- Plan and grant-status filters are applied when the grant report is synced: `ALLOWED_PLANS` and
  `ALLOWED_GRANT_STATUSES` (`Accepted`, `PendingAcceptance`).

**Shares** = options × multiplier, where ESOP Plan 2022 is **3.6** and Plan 2025 is **1**. The result must
be a whole number.

**FMV** = average of the PWL open and close on the **latest trading day strictly before the payment
date**, rounded to 2 dp. It is fixed on the application once the payment date is saved.

**Perquisite** = max(0, FMV × shares − exercise amount), worked out per grant line, rounded to 2 dp.

**Tax** has two methods:
- **Flat:** perquisite × the employee's `TaxRatePercent`, to the paise.
- **Sheet engine** (`Tax.gs`), used when payroll's tax sheet has a usable row for the employee. It
  computes the tax on this exercise as the difference between annual tax with and without it:
  - New and old regime slabs, from the `TaxSlabs` tab.
  - Taxable income rounded **up** to ₹10.
  - Rebate up to ₹60k with marginal relief (new regime: income up to ₹12L). Old regime: ₹12.5k up to
    ₹5L, no relief.
  - Surcharge of 10% / 15% / 25% (and 37% under the old regime), with marginal relief.
  - 4% cess on tax plus surcharge.
  - Income added by earlier approved exercises since the sheet's "as on" date is included.
  - A surcharge "cliff" caused by the exercise is spread by the share of the year already earned.
  - The amount is in whole rupees, and a full breakdown is stored on the application (`TaxBreakdown`).
  - It falls back to the flat rate when the sheet row is missing or flagged (`NO_INCOME`, `MISMATCH`,
    no regime).

**Tax due date:** the 25th of the payment month if the payment is on or before the 25th, otherwise the
25th of the next month.

---

## 5. Admin, fund-partner and back-office functions

**Admin screens:** Verification queue · Application detail · Participants · Share price · Logins &
fund partners · Settings · Guide.

**Review:**
- Five sections (options, demat, exercise payment, tax payment, notice) are each marked Verified or
  Sent Back, with remarks.
- Sections can be verified in bulk.
- An application can be approved only when all five sections are Verified.
- "Close without processing" means Reject.
- Documents open in a viewer: images directly, PDFs through pdf.js. Every view is audited.

**Master data:**
- **Grant sync** reads the "Vest wise Report" export (pasted into a tab or linked by ID). It rebuilds the
  `Grants` tab, upserts `Employees`, and shows a dry-run preview first.
- **Participant details sync** brings in PAN, mobile, address and demat details.
- **Bulk pastes:** CTC and tax rate · PAN and demat details · eligibility (enabled) list · block and
  unblock.
- **Tax sheet:** the HRIMS CSV is parsed in the browser, flagged (`NO_REGIME`, `NO_INCOME`, `MISMATCH`,
  `NEG_MONTHS`, `OVER_DEDUCTED`), and open applications are repriced.
- **Share price:** manual entry; fetch one day; backfill up to 120 days. Sources are the NSE bhavcopy
  (currently switched off) and Google Finance through a hidden sheet formula.
- **Windows:** created automatically for each month (opening day 1, closing day 30 or the month end) and
  closed automatically. There is no edit screen.
- **Monthly export:** one row per grant line, 39 columns, written to an `Export YYYY-MM` tab.

**Fund partners:**
- A partner sees only its own requests, including the participant's PAN number but no documents.
- A partner can set the allotment demat account (with a CML), record the tax payment (UTR, date,
  amount, proof), or decline the request.
- The admin's review of the tax section feeds back into the partner request as Verified or Sent Back.

**Daily jobs:**
- **08:00:**
  - Alert if yesterday's price is missing.
  - Ensure the month's window exists, and announce it on day 1 (only when bulk emails are on).
  - Tax reminders at 5, 2, 0 and −1 days before the due date.
  - Draft reminders at 2 and 0 days before the window closes.
  - Close past windows.
- **20:00:** load the latest share prices.

---

## 6. Data model (19 tabs) and its Firestore equivalent

| Sheet tab | Rows (Nov 2026) | Proposed Firestore collection |
|---|---|---|
| Config | ~40 keys | `settings/portal` (one document) |
| TaxSlabs, TaxSurcharge, TaxRules | small | `settings/taxRules` (versioned by financial year) |
| Users | few | `users/{userId}`. The hash and salt go in a server-only sub-document |
| Employees | ~2,150 | `employees/{employeeId}`. PAN and demat go in a restricted sub-document |
| Grants | ~3,590 | `employees/{id}/grants/{grantId}` with tranches as a real array |
| FMV | 1 per trading day | `fmvPrices/{yyyy-mm-dd}` |
| Windows | 1 per month | `windows/{yyyy-mm}` |
| Applications (61 columns) | test data only | `applications/{appId}`, with nested objects for each section |
| ApplicationLines | test | `applications/{appId}/lines/{lineId}` |
| TaxPayments | test | `applications/{appId}/taxPayments/{paymentId}` |
| FundPartners | 3 | `fundPartners/{partnerId}` (stable ID, not the name) |
| FundPartnerRequests | test | `partnerRequests/{requestId}` |
| TaxSheet | per participant | `taxPositions/{employeeId}` (with as-on date) |
| AuditLog, EmailLog | logs | `auditLog/*`, `emailLog/*` (write-only from the server) |
| Export YYYY-MM | generated | Generated on demand as a CSV/XLSX download |

**Files** currently in Drive (CML, PAN, payment proofs, signed notices) move to **Cloud Storage**
(Firebase Storage), in a private bucket that is only read through signed URLs issued by the server.

---

## 7. Problems found in the current code

These are worth fixing during the rebuild. None of them needs an emergency patch in the live portal,
but items 1 to 3 are security weaknesses, so it is worth deciding whether to patch them now.

### Security
1. **Unlimited password guessing.** Requesting a reset code clears the lockout, and the 6-digit code
   itself has no attempt limit. Both together allow guessing without end.
2. Reset and invite codes come from `Math.random`, which is not cryptographically secure.
3. **Blocked participants can still sign in.** The block is only enforced on write actions.
4. Logging out does not end the session on the server. The same pepper signs sessions and hashes
   passwords. If the pepper property is lost, it is silently regenerated, and every password and session
   breaks.
5. `admin.saveConfig` accepts any key and any value.
6. Some email bodies insert values without escaping them.
7. Sensitive personal data (PAN, demat, mobile, address, salary and tax) sits in plain sheet cells that
   anyone with access to the sheet can read.

### Correctness
8. **Send back has no status check.** An Approved or Rejected application can be moved to Sent Back and
   becomes editable again.
9. An application sent back after its window has closed can never be resubmitted.
10. Submitted applications are repriced when the tax sheet, a rate or a price changes. The tax due can
    change after the participant has paid it.
11. Editing after signing does not clear the signature or regenerate the notice PDF.
12. Two lines for the same grant are each checked against the full balance, so together they can exceed
    it.
13. If a participant switches back to paying the tax themselves after the partner has paid, the
    partner's payment still counts.
14. Nil tax is handled inconsistently. The tax step counts as done, yet choosing a mode is refused.
15. The duplicate-email check compares a timestamp text prefix, which Sheets turns into a date, so it
    probably never matches. Running the jobs again would resend reminders.
16. The window announcement emails about 1,600 people in one run, close to the 6-minute limit. There is
    no daily email-quota check.
17. Re-uploading a CML deletes files by name prefix, which can delete the partner's CML.
18. Race conditions: there is no lock around "check, then create" for applications and windows. A past
    duplicate-window bug was repaired by hand.
19. Several messages on screen disagree with what the server does:
    - "options move to exercised on the grant master": they don't;
    - "email each a one-time code": it doesn't;
    - the mobile-number message says overseas numbers are accepted: they aren't.

### Rules to confirm with the ESOP team
20. Grant expiry and separation date are stored but never enforced. Is that intended?
21. `PendingAcceptance` grants can be exercised. Is that intended?
22. A missing trading-day price silently falls back to any older price. Should there be a staleness
    limit?
23. Flat tax is to the paise; the sheet engine is in whole rupees. Should they be aligned?
24. "Test Plan" is in `ALLOWED_PLANS`, and the data contains test applications. These should be excluded
    from the production migration.

---

## 8. What the move needs to carry over (checklist)

- [ ] `ESOP_PEPPER` from Script Properties, moved securely to a Vercel environment secret, so
      existing passwords keep working.
- [ ] Tax engine, eligibility, lot rule, FMV and pricing: ported with **golden tests** generated by
      running the same inputs through the old code.
- [ ] Notice wording and layout, including the grant-wise table and the `NOTICE_SHOW_SHARES` switch.
- [ ] All 25 email templates and their triggers.
- [ ] Drive documents copied to Cloud Storage, with the file IDs on each application rewritten.
- [ ] Grant-report and tax-sheet import formats (column aliases, header-row detection).
- [ ] Monthly export columns, which downstream processes (share allotment, payroll) depend on.
- [ ] Audit trail and email log history.
- [ ] Scheduled jobs moved to Vercel scheduled jobs (IST times).
- [ ] Share-price sourcing. Google Finance only works inside Sheets, so the new system needs another
      source or manual entry.
