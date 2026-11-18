# Connecting *Math Circle 2026/2027* Google Sheet (60-Second Setup)

Follow these steps once to link the tablet web app directly to your Google Sheet (`1uWyyPhBvUgaU1odlJQ20d9X6Io5icrF4EQMkDwDC-kE`).

## 1. Open Apps Script on the Sheet
1. Open the **Math Circle 2026/2027** spreadsheet in Google Sheets.
2. In the menu bar, click **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the full contents of [`sheet-backend/Code.gs`](Code.gs) and click **Save** (`Ctrl+S` / `Cmd+S`).

## 2. Deploy as a Web App
1. Click **Deploy → New deployment** (top right).
2. Click the gear icon next to *Select type* and choose **Web app**.
3. Configure:
   - **Description:** `Math Circle API v1`
   - **Execute as:** `Me` (your Google account)
   - **Who has access:** `Anyone` *(required so 3rd-grade tablets do not need Google logins)*
4. Click **Deploy**, authorize permissions when prompted, and copy the resulting **Web app URL** ending in `/exec`.

## 3. Connect the Web App
- **Option A (Permanent for all devices):** Paste the `/exec` URL into `appsScriptUrl` in [`webapp/config.js`](../webapp/config.js) before deploying/hosting `webapp/`.
- **Option B (On-the-spot per tablet):** Open **Teacher Zone** (PIN `885174`) → **Roster, PINs & Sheet Link**, paste the `/exec` URL, and tap **Save & Test Connection**.

## 4. Verify Auto-Initialization & Roster Sync
Once `Code.gs` is saved in the sheet's Apps Script editor:
- Reloading the spreadsheet adds the **🦘 Math Circle → Sync Participants to Students** menu (`onOpen`), and typing a new student name in `Participants!A1:A` immediately syncs it to `Students` (`onEdit`).
- On the first API call (or by running `doGet()` in the Apps Script editor), any missing `Students`, `Submissions`, and `Config` tabs are created automatically.
- Any student name in `Participants!A1:A` not yet in `Students` is appended with a unique `student_id`, a 4-digit plain-text PIN (leading zeros preserved), an animal avatar, and `active = TRUE`.
- `Participants` is never modified.
