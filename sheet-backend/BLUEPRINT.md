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
Stores the math circle roster. Can be edited either directly in Google Sheets or from the Teacher Zone UI. Existing 5-column `Students` tabs auto-upgrade on first run to add column `F` (`parent_pin`) and populate unique 6-digit parent PINs for every row.
- `student_id` — Stable slug/ID (e.g., `maya`, `leo`).
- `name` — Display name shown on the tablet profile picker.
- `pin` — 4-digit numeric string (formatted as plain text `'@'` so leading zeros like `0412` are preserved!).
- `avatar` — Emoji or avatar key for quick visual recognition by 3rd graders.
- `active` — `TRUE` or `FALSE` (inactive students are hidden from the tablet picker, excluded from active cohort benchmarks/rankings, and cannot log into Parent Zone without deleting historical rows).
- `parent_pin` — Unique 6-digit numeric string per student (formatted as plain text `'@'` preserving leading zeros), never matching `teacher_pin` and auto-avoiding weak PINs (`000000`–`999999` repeating, `123456`, `654321`).

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

### 3. `Config` Tab (Overrides & Release State)
- Stores key-value settings (`A:B`, optional human `notes` in `C`):
  - `teacher_pin` — Defaults to `885174` if unset.
  - `active_week_id` — Allows the teacher to switch the active week for all tablets simultaneously from Teacher Zone.
  - `released_week_ids` — Comma-separated list of `weekId`s unlocked for Parent Zone viewing (defaults to empty `""`; all weeks remain locked until explicitly released by the teacher via `setWeekReleased`).

## Core Behaviors & Edge Cases

- **Leading-Zero PIN Safety:** Both 4-digit student `pin` and 6-digit `parent_pin` cells are explicitly formatted (`'@'`) and compared as zero-padded strings (`"0412"`, `"084627"`), preventing spreadsheet number formatting from stripping leading zeros.
- **Privacy Boundary & Active-Cohort Filtering:**
  - `getPublicRoster` strips both `pin` and `parentPin` before returning JSON.
  - Student answers and class rankings are never returned without either that student's valid 4-digit PIN (raw answers only, single week) or the valid 6-digit Teacher PIN (`885174`).
  - `getParentReport` requires a matching active student's 6-digit `parentPin`, gates detailed scores/answers/cohort stats strictly to `released_week_ids` (returning only `unreleasedSubmittedWeekIds` for unreleased weeks), excludes orphaned submissions from inactive/deleted `student_id`s, and suppresses all cohort percentiles/averages/optionCounts whenever `cohortCount < 4` (`MIN_COHORT_SIZE = 4`).
- **Parent PIN Brute-Force Rate Limiting:** `Code.gs` enforces a 10-failed-attempt-per-60s lockout via `CacheService.getScriptCache()` (mirrored in `serve.py` and `storage.js`).
- **Simultaneous Submission Locking:** Every write action (`submitAnswers`, `saveStudentRoster`, `setActiveWeek`, `setWeekReleased`, and schema/sync writes) acquires `LockService.getScriptLock()` (up to 15 seconds) so simultaneous requests never corrupt or overwrite rows.
- **Idempotent Upsert per Week:** If a student logs back in and resubmits answers for the same `week_id`, `submitAnswers` updates their existing `(week_id, student_id)` row in-place rather than creating duplicate rows in rankings.
- **CORS Compatibility:** All actions are routed through `doPost(e)` accepting `text/plain;charset=utf-8` JSON bodies and returning `ContentService.createTextOutput(...).setMimeType(ContentService.MimeType.JSON)`, avoiding browser preflight `OPTIONS` failures on `script.google.com`.

## Human Review Requirement

Changes to PIN comparison logic, rate limiting, release gating, cohort privacy thresholds, or `LockService` write sections in `Code.gs` are flagged as **Security & Data Integrity Exceptions** requiring human review alongside automated tests.
