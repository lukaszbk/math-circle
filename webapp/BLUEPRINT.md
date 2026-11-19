# Tablet Web App Blueprint (`webapp/`)

## Purpose

Provides the touch-first tablet interface used by 3rd graders to view problems and submit answers, and by the teacher during break and whiteboard review to inspect rankings, identify problem spots, and view 3rd-grade teaching guides.

## Design & Technical Principles

- **Tablet-First Ergonomics:** Large touch targets (minimum 48×48 px), high-contrast legibility, custom on-screen numeric PIN pad (preventing OS virtual keyboard layout shifts), and tap-to-zoom question diagrams.
- **Original Question Numbering:** Questions always display their **exact number from the printed PDF** (e.g., `#1–#4`, `#9–#12`, `#17–#20` for Part 1; `#5–#8`, `#13–#16`, `#21–#24` for Part 2) alongside their point badge (`3 pts`, `4 pts`, `5 pts`), so students working from paper scratch sheets never misalign answers.
- **Clean Styling & Zero Build Lock-In:** Built with semantic HTML5, modular ES2022 JavaScript (`webapp/src/`), and Vanilla CSS custom properties (`webapp/styles/`), runnable directly from static files without bundlers.
- **Wi-Fi Drop Resilience:** Every answer tap saves immediately to local device storage (`localStorage`) scoped to `(weekId, studentId)`. If Google Sheet upload fails due to intermittent Wi-Fi, the submission stays queued locally on the tablet with a clear "Retry Sync" banner until confirmed by the Sheet backend.

## Core User Flows & Business Rules

### 1. Home Screen (Profile Picker) & URL Routing
- Displays the active week title (e.g., *"Math Kangaroo 2022 · Part 1"*) and a grid of student profile cards showing each student's name, friendly animal icon, and a subtle `"Submitted ✓"` badge if they already turned in answers this week.
- Includes discreet **"👪 Parent Zone"** and **"🔒 Teacher Zone"** buttons in the header.
- Visiting `?parent`, `?zone=parent`, or `#parent` routes directly to a clean mobile-friendly Parent Zone unlock screen and opens the 6-digit Parent PIN modal (keeping phone users off the kid profile picker if cancelled).

### 2. Student PIN Entry & Answer Input
- Tapping a student card opens a 4-digit numeric keypad. The PIN is verified against `sheet-backend`.
- Once unlocked, the student enters the **Test Workspace**:
  - **Navigation Strip:** 12 numbered pills grouped by section (`3 pts`, `4 pts`, `5 pts`), visually distinguishing answered vs. unanswered questions.
  - **Problem Display:** Shows the cropped official Math Kangaroo question image (including diagrams and visual choices) with pinch/tap zoom.
  - **Answer Selector:** Five large choice buttons (`A`, `B`, `C`, `D`, `E`) plus `"Leave Blank / Skip"`. Tapping an already-selected letter deselects it (returning to blank).
- **Review & Submit:**
  - Shows a 12-question summary grid and highlights any skipped questions (*"You left 2 questions blank — submit anyway or go back?"*).
  - Submitting uploads answers and computed scores to the Google Sheet, then displays a celebratory completion screen with a **"Done — Next Student"** button that immediately locks the session and returns to the Profile Picker (ideal for shared tablets).
  - **Anti-Spoiler Rule:** Confirmation screens do **not** reveal which answers were right or wrong or the final score prior to the whiteboard session, preventing spoilers among classmates.
  - **Corrections:** A student may log back in with their 4-digit PIN during the work period to revise and resubmit their answers; the latest submission replaces their earlier one for that week.

### 3. Scoring Rules
- **Positive-Only Sum:**
  - Correct answer: `+3`, `+4`, or `+5` points according to section (`48` points maximum for a 12-question half-test).
  - Wrong or blank answer: `0` points (no negative penalty).

### 4. Teacher Zone (Protected by PIN `885174`)
Entering `885174` on the Teacher keypad unlocks five focused tabs:

1. **Class Ranking & Answer Matrix:**
   - Shows submission progress (`X of Y students submitted`) with a one-tap **Refresh** button (plus optional auto-refresh during break).
   - Ranks submitted active students by **Total Score descending** (ties broken by 5-point score, then 4-point score, then alphabetical name; tied scores share the same rank number).
   - Displays a compact student × question matrix: green `✓` for correct, red letter (e.g., `✗ B`) showing the **exact wrong choice picked**, and muted `—` for blank.

2. **"Solve Together" Priority List:**
   - Automatically ranks all 12 questions by classroom difficulty to build the post-break whiteboard agenda (`missedCount` desc → `wrongCount` desc → `points` desc → `number` asc), displaying each problem's `questionClass` pill, A–E + Blank distribution bar, and **"Common Trap"** callouts.

3. **Whiteboard & AI Teaching Companion:**
   - Selecting any question opens a clean **Whiteboard Projection View** with its `questionClass` badge and a toggleable **Teacher Solution Guide** (`correctOption`, core idea, walkthrough steps, Socratic questions, common traps). Supports projecting questions from past weeks opened from Tab 5 without changing the global active week for tablets.

4. **Roster, PINs & Cards:**
   - Allows the teacher to add/edit student names, avatars, 4-digit student PINs, and unique 6-digit `parentPin`s (with per-row regenerate button and show/hide toggle), switch the active weekly pack, configure/test the Apps Script `/exec` URL, and open **🖨️ Print Parent Cards** (2×4 printable cards featuring an offline-generated SVG QR code to `?parent` from `qr.js` and 6 boxed PIN digits).

5. **Multi-Week & Topics:**
   - Per-pack **Parent Release Controls** (`🔒 Locked` ↔ `🔓 Released to Parents`).
   - **Class-Wide Accuracy by Math Kangaroo Class** (sorted weakest → strongest across all submitted packs, with clickable toughest-question chips jumping to Whiteboard).
   - **Student × Question-Class Mastery Heatmap** across all active students and practiced classes.

### 5. Parent Zone (Protected by Unique 6-Digit Family `parentPin`)
Mobile-first (`360px+`) family portal unlocked via the student's unique 6-digit `parentPin`. Unreleased submitted weeks appear only as `"✓ Submitted <Pack Title> in class — detailed review unlocks once released by the teacher"`, and class benchmarks are suppressed whenever `< 4` active students submitted:
1. **Scores & Progress:** Interactive SVG multi-week progression chart (`Trajectory + Class Band` over `P25–P75` + `Median`, toggleable to `3 / 4 / 5-Pt Stacked Bars`), clickable weeks, upleveled `0–48` cohort gauge (`🚀 Leading the Pack` / `🎯 Right in the Pack` / `🌱 Building Foundations`), deterministic habit callouts (positive-only blank tip, 3-pt warmup check), and `3 / 4 / 5-pt` Child vs. Class Average bars.
2. **Test Review:** Week switcher and `Needs Review` / `All 12` / `Solved ✓` filters, `questionClass` & upleveled class solve-rate badges, tap-to-zoom problem diagrams, deterministic Common Trap reassurance, and 2-stage Socratic coaching (`askTheKids` + `homeTip` upfront; `correctOption`, `headline`, `steps`, `commonTraps` revealed on demand).
3. **Work On at Home:** Cumulative Question-Class Skill Profile (`Focus Areas` & `Strong Areas`), curated screen-free 3rd-grade tabletop playbooks (`HOME_PLAYBOOKS`), and a Priority Re-Try Queue (3-pt & 4-pt foundations first) that jumps directly into Test Review.
