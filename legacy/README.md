# Legacy: Apps Script ESOP Exercise Portal

Snapshot of the Google Apps Script source for the current ESOP Exercise Portal
(v2.1.0), taken on 2026-11-26. It is kept here as the reference for the
migration to Vercel + Firestore. It is not deployed from this repo.

- Data store: Google Sheet "ESOP Exercise Portal — Data" (owned by the ESOP team account)
- Deployment: Apps Script web app (owned by the ESOP team account)
- `appsscript.json` (manifest) was not included in the export.
- Secrets (the password pepper) live in the script's Script Properties, not here.

## Export note

The code was copied out through a Google Doc, which converted five regex
fragments (`$…$` and `\(…\)`) into equations. They were restored by hand from
the Word export of that Doc: `Auth.gs` (hash-format regex), `Domain.gs`
(NSDL/CDSL demat ID checks, 2 lines), `Notice.gs` (former-name brackets) and
`Repo.gs` (accounting-negative parentheses). Every `.gs` file and the inline
scripts in `App.html` and `Index.html` pass `node --check`.
