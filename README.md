# OT Support Tool

Local MVP for reviewing the UI and testing core flows with Google Sheets DB storage.

## Google Sheets DB Setup - Apps Script Mode

Use this mode if you cannot create Google Cloud service accounts.

1. Open the Google Sheets DB:

```text
https://docs.google.com/spreadsheets/d/1ts9sj3cdT_Z3BMrtHo2_R5H35gxPmRlnztXxLkM8fog/edit
```

2. Go to `Extensions` -> `Apps Script`.
3. Replace the Apps Script code with `apps-script/Code.gs`.
4. In `Code.gs`, change:

```javascript
const SECRET_TOKEN = 'CHANGE_ME_TO_A_RANDOM_SECRET';
```

5. Deploy -> New deployment -> Web app.
6. Set:
   - Execute as: `Me`
   - Who has access: `Anyone with the link` or the closest option allowed by company policy.
7. Copy the Web app URL.
8. Create `.env.local`:

```env
GOOGLE_SHEETS_DB_ID=1ts9sj3cdT_Z3BMrtHo2_R5H35gxPmRlnztXxLkM8fog
GOOGLE_SHEETS_API_MODE=apps_script
APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
APPS_SCRIPT_TOKEN=the-same-secret-token-from-Code.gs
```

## Google Sheets DB Setup - Service Account Mode

This is optional. Use it only if you can create a Google Cloud service account.

## Run Locally

```powershell
.\start-local.cmd
```

Or:

```powershell
& "C:\Program Files\nodejs\node.exe" server.mjs
```

Open:

```text
http://localhost:4173
```

## Local Login

Use:

```text
hau.nt@kyanon.digital
```

This account is treated as admin.

## Current Local Scope

This build reads and writes the Google Sheets DB through the local Node server. It lets you test:

- Login domain restriction.
- Monthly dashboard with calendar and slot table.
- Auto-generated weekend slots.
- Register/cancel a future support day from Register Dashboard calendar popups.
- Admin can register past slots on behalf of members.
- One active support registration per member per month.
- Admin add/deactivate/reactivate users.
- Admin create holiday/Tet override.
- User update request.
- Admin approve/reject update request.
- Monthly statistics with holiday/Tet man-month split evenly across registered members.
- Export preview placeholder.

## Storage Note

The browser never receives Google credentials. `server.mjs` talks to Google Sheets and exposes local `/api/state` endpoints to the frontend.
