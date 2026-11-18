# Tablet Web App Blueprint (`webapp/`)

## Purpose

Provides the touch-first tablet interface used by 3rd graders to view problems and submit answers, and by the teacher during break and whiteboard review to inspect rankings, identify problem spots, and view 3rd-grade teaching guides.

## Design & Technical Principles

- **Tablet-First Ergonomics:** Large touch targets (minimum 48×48 px), high-contrast legibility, custom on-screen numeric PIN pad (preventing OS virtual keyboard layout shifts), and tap-to-zoom question diagrams.
- **Original Question Numbering:** Questions always display their **exact number from the printed PDF** (e.g., `#1–#4`, `#9–#12`, `#17–#20` for Part 1; `#5–#8`, `#13–#16`, `#21–#24` for Part 2) alongside their point badge (`3 pts`, `4 pts`, `5 pts`), so students working from paper scratch sheets never misalign answers.
- **Clean Styling:** Built with semantic HTML, TypeScript, and modular Vanilla CSS custom properties (no heavy UI frameworks).
- **Wi-Fi Drop Resilience:** Every answer tap saves immediately to local device storage (`localStorage`) scoped to `(weekId, studentId)`. If Google Sheet upload fails due to intermittent Wi-Fi, the submission stays queued locally on the tablet with a clear "Retry Sync" banner until confirmed by the Sheet backend.

## Core User Flows & Business Rules

### 1. Home Screen (Profile Picker)
- Displays the active week title (e.g., *"Math Kangaroo 2022 · Part 1"*) and a grid of student profile cards showing each student's name, friendly animal icon, and a subtle `"Submitted ✓"` badge if they already turned in answers this week.
- Includes a discreet **"Teacher Zone"** button in the header/corner.

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
- **Default Scoring (Positive Sum):**
  - Correct answer: `+3`, `+4`, or `+5` points according to section (maximum `48` points for a 12-question half-test).
  - Wrong or blank answer: `0` points (no negative penalty for 3rd graders).
- *(Configurable per Question Pack if official Math Kangaroo penalty scoring — starting base points minus quarter-value wrong-answer deduction — is ever desired.)*

### 4. Teacher Zone (Protected by PIN `885174`)
Entering `885174` on the Teacher keypad unlocks four focused tabs:

1. **Class Ranking & Answer Matrix:**
   - Shows submission progress (`X of Y students submitted`) with a one-tap **Refresh** button (plus optional auto-refresh during break).
   - Ranks submitted students by **Total Score descending** (ties broken by 5-point score, then 4-point score, then alphabetical name; tied scores share the same rank number).
   - Displays a compact student × question matrix: green `✓` for correct, red letter (e.g., `✗ B`) showing the **exact wrong choice picked**, and muted `—` for blank.

2. **"Solve Together" Priority List:**
   - Automatically ranks all 12 questions by classroom difficulty to build the post-break whiteboard agenda:
     1. **Missed count** (wrong + blank) descending,
     2. **Wrong count** descending (active misconception prioritized over skipped),
     3. **Point value** descending (`5 > 4 > 3`),
     4. **Question number** ascending.
   - Flags any question missed by **≥ 40% of submitted students** (or ≥ 2 students in groups smaller than 5) with a **"Solve Together"** highlight badge.
   - Displays an **A–E + Blank distribution bar** per question and triggers a **"Common Trap"** callout whenever 2 or more students select the same wrong option (e.g., *"Trap Alert: 4 kids picked B"*).

3. **Whiteboard & AI Teaching Companion:**
   - Selecting any question opens a dedicated view with two modes:
     - **Whiteboard Projection View:** Clean, large view of the problem diagram and choices with the answer hidden, suitable for showing on a TV/projector or tablet at the board.
     - **Teacher Solution Guide (Toggle):** Reveals the verified correct answer, the core mathematical idea in 3rd-grade language, a concrete step-by-step whiteboard walkthrough, Socratic questions to ask the kids, and explanations of why the common wrong options fail.

4. **Roster & Week Selector:**
   - Allows the teacher to add/edit student names, avatars, and 4-digit PINs (synced directly to the Google Sheet `Students` tab) and switch between bundled weekly Question Packs.
