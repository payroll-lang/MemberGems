# Legacy: Apps Script ESOP Exercise Portal

Snapshot of the Google Apps Script source for the current ESOP Exercise Portal
(v2.1.0), taken on 2026-11-26. It is kept here as the reference for the
migration to Vercel + Firestore. It is not deployed from this repo.

- Data store: Google Sheet "ESOP Exercise Portal — Data" (owned by the ESOP team account)
- Deployment: Apps Script web app (owned by the ESOP team account)
- `appsscript.json` (manifest) was not included in the export.
- Secrets (the password pepper) live in the script's Script Properties, not here.
