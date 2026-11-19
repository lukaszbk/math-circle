# Google Sheet Storage Backend Blueprint (`sheet-backend/`)

## Purpose

Uses a pre-defined Google Sheet as a transparent, human-editable database for student profiles and weekly test submissions, exposed to tablets via a zero-cost bound Google Apps Script Web App (`Code.gs`).

## Why a Bound Apps Script Bridge

- Third-grade students on shared or personal tablets cannot log into Google accounts, and a browser app cannot safely hold Google Cloud service-account private keys.
- Deploying a small bound Apps Script as a Web App (`Execute as: Teacher`, `Who has access: Anyone`) gives the static web app a secure HTTPS JSON endpoint backed directly by the teacher's Google Sheet, with zero cloud servers, zero billing, and zero OAuth popups for kids.

## Google Sheet Schema

Bound directly to the teacher's Google Sheet via **Extensions → Apps Script** (`SpreadsheetApp.getActiveSpreadsheet()`).

The existing **`Participants`** tab (listing student full names in column A) is preserved intact. Whenever a name is added in `Participants` (via an `onEdit` sheet trigger, the custom `Math Circle` sheet menu from `onOpen`, or on any web app API call), any name not yet present in `Students` is automatically appended to `Students` with a generated 4-digit PIN and `active = TRUE` (note: once `Code.gs` is pasted into the sheet's Apps Script editor).

The script also auto-initializes missing tabs and headers on first run:

### 1. `Students` Tab
Stores the math circle roster. Can be edited either directly in Google Sheets or from the Teacher Zone UI.
- `student_id` — Stable slug/ID (e.g., `maya`, `leo`).
- `name` — Display name shown on the tablet profile picker.
- `pin` — 4-digit numeric string (formatted as plain text so leading zeros like `0412` are preserved!).
- `avatar` — Emoji or avatar key for quick visual recognition by 3rd graders.
- `active` — `TRUE` or `FALSE` (inactive students are hidden from the tablet picker without deleting historical scores).

### 2. `Submissions` Tab
Stores one canonical row per `(week_id, student_id)` plus human-readable score breakdowns so the teacher can also inspect or chart progress across weeks directly in Sheets:
- `updated_at` — ISO-8601 timestamp of submission.
- `week_id` — Question Pack identifier (e.g., `2022-g34-part1`).
- `student_id` — Matches `Students.student_id`.
- `student_name` — Snapshot of student's display name.
- `total_score` — Computed score (e.g., `39`).
- `max_score` — Maximum possible score for the pack (e.g., `48`).
- `score_3pt`, `score_4pt`, `score_5pt` — Section subtotals.
- `correct_count`, `wrong_count`, `blank_count` — Summary counts out of 12.
- `answers_summary` — Compact human-readable string (e.g., `1:E, 2:B, 3:C, 4:C, ...`).
- `answers_json` — Canonical JSON map from original question number to selected option (`"A".."E"` or `null`).

### 3. `Config` Tab (Optional Overrides)
- Stores key-value settings such as `teacher_pin` (defaults to `885174` if unset) and `active_week_id` (allowing the teacher to switch the active week for all tablets simultaneously from the Teacher Zone).

## Core Behaviors & Edge Cases

- **Leading-Zero PIN Safety:** Student PIN cells are explicitly formatted and compared as zero-padded 4-character strings (`"0123"`), preventing spreadsheet number formatting from stripping leading zeros.
- **Privacy Boundary:** Public roster calls (`getPublicRoster`) strip `pin` values before returning JSON. Student answers and class rankings are never returned without either that student's valid 4-digit PIN (single student) or the valid 6-digit Teacher PIN (`885174`).
- **Simultaneous Submission Locking:** Every write action (`submitAnswers`, `saveStudentRoster`, `setActiveWeek`) acquires `LockService.getScriptLock()` (up to 15 seconds) before reading/updating rows so 10 tablets submitting at the end of the 40-minute timer never corrupt or overwrite rows.
- **Idempotent Upsert per Week:** If a student logs back in and resubmits answers for the same `week_id`, `submitAnswers` updates their existing `(week_id, student_id)` row in-place rather than creating duplicate rows in rankings.
- **CORS Compatibility:** All actions are routed through `doPost(e)` accepting `text/plain;charset=utf-8` JSON bodies and returning `ContentService.createTextOutput(...).setMimeType(ContentService.MimeType.JSON)`, avoiding browser preflight `OPTIONS` failures on `script.google.com`.

## Human Review Requirement

Changes to PIN comparison logic or `LockService` write sections in `Code.gs` are flagged as **Security & Data Integrity Exceptions** requiring human review alongside automated tests.
