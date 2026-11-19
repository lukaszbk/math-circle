# Math Kangaroo Circle — System Blueprint

## Purpose

Math Kangaroo Circle is a lightweight tablet web application for an after-school 3rd-grade math circle. Each weekly session covers half of a 24-question Math Kangaroo competition paper (12 questions total: four 3-point, four 4-point, and four 5-point problems).

The system supports the four phases of a weekly class:
1. **Independent Work (40 min):** Students read the visual problems and submit their answers on tablets under their own 4-digit PIN-protected profile.
2. **Break Triage (5–10 min):** Answers sync automatically to a Google Sheet, scores are tallied, students are ranked, and the questions that caused the most trouble are surfaced for the teacher.
3. **Whiteboard Discussion:** The teacher uses the Teacher Zone to inspect answer distributions, common traps, and AI-prepared 3rd-grade explanations while solving the hardest problems together on the whiteboard.
4. **At-Home Family Review (Parent Zone):** Once the teacher releases a week's results, families scan the QR code on their printed Parent Access Card (`?parent`) and enter their private 6-digit `parent_pin` to inspect score progression, anonymized class benchmarks, step-by-step Socratic coaching guides, and screen-free tabletop practice playbooks tailored to Math Kangaroo question classes.

## Architecture Overview

The system is intentionally split into three decoupled components so the classroom app has zero servers to maintain, loads instantaneously on shaky Wi-Fi, and uses a plain Google Sheet as its single source of truth for student rosters and submissions:

- **[`webapp/`](webapp/BLUEPRINT.md) — Static Tablet & Parent Web App:** A zero-build-dependency static ES Module JavaScript + Vanilla CSS single-page app hosted on static hosting (e.g., GitHub Pages, Firebase Hosting, or Cloudflare Pages) and runnable locally via any static file server (`python3 -m http.server`). Ships with the weekly Question Pack assets (cropped problem diagrams, answer keys, Question Class tags, and AI teaching/home guides) with zero hardcoded student names or PINs, and loads rosters dynamically from the Google Sheet backend over HTTPS (or `serve.py` / local `localStorage` during local dev/demo runs).
- **[`sheet-backend/`](sheet-backend/BLUEPRINT.md) — Google Sheet & Apps Script Bridge:** Bound to the teacher's Google Sheet via **Extensions → Apps Script**, holding student profiles synced from `Participants`, 4-digit student PINs, unique 6-digit family `parent_pin`s, parent-release state (`released_week_ids`), and historical weekly submissions, paired with a bound Google Apps Script Web App (`Code.gs`) that acts as a serverless JSON API without requiring students or parents to sign into Google accounts or exposing API keys in the browser.
- **[`pack-compiler/`](pack-compiler/BLUEPRINT.md) & [`.agents/skills/compile-weekly-pack/`](pack-compiler/BLUEPRINT.md) — Agent-Driven Weekly PDF Ingestion:** Pairs a Jetski workspace skill (`/compile-weekly-pack`) with a flexible Python + Poppler/ImageMagick cropping and packaging helper (`pack-compiler/compile_pack.py`). Because competition PDFs vary across years and editions, the agent visually audits every draft crop (adjusting bounding boxes or masks when layouts differ), solves all 12 problems from first principles *before* cross-checking against published competition results, tags each question with its canonical Math Kangaroo `questionClass` (+ optional `secondaryClass`), authors 3rd-grade whiteboard & `homeTip` guides, and compiles `webapp/packs/<week-id>/` plus `preview.html`.

## Repository Layout

- `BLUEPRINT.md` — System architecture, cross-cutting contracts, and review gates (this file).
- `index.html`, `.nojekyll`, & `.github/workflows/pages.yml` — Static hosting entrypoints so the repository runs directly from GitHub Pages (`https://<user>.github.io/math-circle/`) under either `Deploy from a branch (main / root)` or `GitHub Actions` with zero server infrastructure.
- `.agents/skills/compile-weekly-pack/` — Workspace skill (`SKILL.md`) guiding the agent through adaptive cropping, solve-first verification, cross-checking, and pack compilation.
- `webapp/` — Tablet student UI, Teacher Zone UI, scoring & triage logic, and bundled weekly Question Packs.
- `sheet-backend/` — Google Sheet tab specifications and bound Apps Script Web App source (`Code.gs`).
- `pack-compiler/` — PDF page rendering, draft/override cropping helper (`compile_pack.py`), weekly metadata specs, and human preview generator.

## End-to-End Data Contracts

### Question Pack Contract (`pack-compiler` → `webapp`)
Each weekly session is identified by a `weekId` (for example, `2022-g34-part1`). A Question Pack directory contains:
- Cropped, high-resolution PNG images of every selected question (preserving all Math Kangaroo diagrams, colors, grids, and visual answer choices).
- A `pack.json` manifest listing the `weekId`, title, active scoring rule, and the 12 ordered questions. Each question record includes its **original paper number** (e.g., `1–4`, `9–12`, `17–20`), point value (`3`, `4`, or `5`), canonical Math Kangaroo `questionClass` (`spatial-3d`, `shapes-2d`, `logic-deduction`, `number-sense`, `patterns-simulation`, `counting-sets`, `measurement-time`) + optional `secondaryClass`, image path, short text summary, verified correct option (`A`–`E`), and structured Teacher/Parent explanation notes (core idea, step-by-step whiteboard walkthrough, Socratic prompts for 3rd graders, distractor trap explanations, and hands-on tabletop `homeTip`).

### Sheet API Contract (`webapp` ↔ `sheet-backend`)
All browser requests use `POST` with `Content-Type: text/plain;charset=utf-8` carrying a JSON payload so browsers never fail CORS preflight on Google Apps Script redirects:
- `getPublicRoster(weekId)` → Returns active students (`studentId`, `name`, `avatar`, `hasSubmitted`) without exposing student PINs or `parentPin`s.
- `verifyStudentPin(studentId, pin, weekId)` → Validates the 4-digit PIN and returns any existing answers submitted by that student for `weekId`.
- `submitAnswers(weekId, studentId, pin, answers, scoreSummary)` → Re-validates the student PIN, acquires a script lock, and upserts the student's submission row in the Google Sheet.
- `getTeacherReport(weekId, teacherPin, includeAllWeeks)` → Validates the teacher PIN (`885174`) and returns active-student submissions for `weekId` (plus `allSubmissions` across all weeks when `includeAllWeeks: true`), `releasedWeekIds`, and full roster details (including 4-digit `pin` and 6-digit `parentPin`).
- `saveStudentRoster(teacherPin, students)` → Validates the teacher PIN and updates student names, avatars, 4-digit student PINs, and unique 6-digit `parentPin`s in the `Students` sheet tab.
- `setActiveWeek(teacherPin, weekId)` → Validates the teacher PIN and updates `Config.active_week_id`.
- `setWeekReleased(teacherPin, weekId, released)` → Validates the teacher PIN and toggles `weekId` in `Config.released_week_ids`.
- `getParentReport(parentPin)` → Rate-limited (10 failed attempts / 60s via `CacheService`) lookup matching a single active student's unique 6-digit `parentPin`; returns that student's released submissions (`submissionsByWeek`), `unreleasedSubmittedWeekIds` (status-only, zero score/answer leakage), and anonymized active-cohort benchmarks (`cohortByWeek`, suppressed whenever `cohortCount < 4`).

## Development Workflow & Human Code Review Exceptions

Following **Blueprint-Driven Engineering**:
1. Behavioral or architectural changes are proposed in `BLUEPRINT.md` first and reviewed in plain English before compiling to source code.
2. Source files (`.js`, `.css`, `.py`, `.gs`) are treated as compiled output verified by automated unit and integration tests (`python3 -m unittest`).
3. **Human Code Review Required (Classifier Exceptions):** Human code inspection is required only when changes touch:
   - **PIN authentication, rate limiting, release gating, and secret boundaries** in `sheet-backend/` (ensuring student PINs, parent PINs, teacher PIN `885174`, unreleased results, and small-cohort `< 4` benchmarks are never leaked).
   - **Concurrent Google Sheet write locking** in `sheet-backend/` (`LockService` acquisition around simultaneous end-of-class submissions, schema upgrades, roster saves, and config updates).
   - **AI answer-key verification** when compiling a new weekly PDF Question Pack (confirming the 12 cropped images and 12 answer keys before class).
