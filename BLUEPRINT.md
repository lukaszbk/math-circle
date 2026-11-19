# Math Kangaroo Circle — System Blueprint

## Purpose

Math Kangaroo Circle is a lightweight tablet web application for an after-school 3rd-grade math circle. Each weekly session covers half of a 24-question Math Kangaroo competition paper (12 questions total: four 3-point, four 4-point, and four 5-point problems).

The system supports the three phases of a weekly class:
1. **Independent Work (40 min):** Students read the visual problems and submit their answers on tablets under their own PIN-protected profile.
2. **Break Triage (5–10 min):** Answers sync automatically to a Google Sheet, scores are tallied, students are ranked, and the questions that caused the most trouble are surfaced for the teacher.
3. **Whiteboard Discussion:** The teacher uses the Teacher Zone to inspect answer distributions, common traps, and AI-prepared 3rd-grade explanations while solving the hardest problems together on the whiteboard.

## Architecture Overview

The system is intentionally split into three decoupled components so the classroom app has zero servers to maintain, loads instantaneously on shaky Wi-Fi, and uses a plain Google Sheet as its single source of truth for student rosters and submissions:

- **[`webapp/`](webapp/BLUEPRINT.md) — Static Tablet Web App:** A zero-build-dependency static ES Module JavaScript + Vanilla CSS single-page app hosted on static hosting (e.g., GitHub Pages, Firebase Hosting, or Cloudflare Pages) and runnable locally via any static file server (`python3 -m http.server`). Ships with the weekly Question Pack assets (cropped problem diagrams, answer keys, and AI teaching guides) with zero hardcoded student names or student PINs, and loads rosters dynamically from the Google Sheet backend over HTTPS (or `serve.py` / local `localStorage` during local dev/demo runs).
- **[`sheet-backend/`](sheet-backend/BLUEPRINT.md) — Google Sheet & Apps Script Bridge:** Bound to the *Math Circle 2026/2027* Google Sheet (`1uWyyPhBvUgaU1odlJQ20d9X6Io5icrF4EQMkDwDC-kE`), holding student profiles synced from `Participants`, 4-digit PINs, and historical weekly submissions, paired with a bound Google Apps Script Web App (`Code.gs`) that acts as a serverless JSON API without requiring students to sign into Google accounts or exposing API keys in the browser.
- **[`pack-compiler/`](pack-compiler/BLUEPRINT.md) & [`.agents/skills/compile-weekly-pack/`](pack-compiler/BLUEPRINT.md) — Agent-Driven Weekly PDF Ingestion:** Pairs a Jetski workspace skill (`/compile-weekly-pack`) with a flexible Python + Poppler/ImageMagick cropping and packaging helper (`pack-compiler/compile_pack.py`). Because competition PDFs vary across years and editions, the agent visually audits every draft crop (adjusting bounding boxes or masks when layouts differ), solves all 12 problems from first principles *before* cross-checking against published competition results, authors 3rd-grade whiteboard guides, and compiles `webapp/packs/<week-id>/` plus `preview.html`.

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
- A `pack.json` manifest listing the `weekId`, title, active scoring rule, and the 12 ordered questions. Each question record includes its **original paper number** (e.g., `1–4`, `9–12`, `17–20`), point value (`3`, `4`, or `5`), image path, short text summary, verified correct option (`A`–`E`), and structured Teacher Zone explanation notes (core idea, step-by-step whiteboard walkthrough, Socratic prompt for 3rd graders, and distractor trap explanations).

### Sheet API Contract (`webapp` ↔ `sheet-backend`)
All browser requests use `POST` with `Content-Type: text/plain;charset=utf-8` carrying a JSON payload so browsers never fail CORS preflight on Google Apps Script redirects:
- `getPublicRoster(weekId)` → Returns active students (`studentId`, `name`, `avatar`, `hasSubmitted`) without exposing student PINs.
- `verifyStudentPin(studentId, pin, weekId)` → Validates the 4-digit PIN and returns any existing answers submitted by that student for `weekId`.
- `submitAnswers(weekId, studentId, pin, answers, scoreSummary)` → Re-validates the student PIN, acquires a script lock, and upserts the student's submission row in the Google Sheet.
- `getTeacherReport(weekId, teacherPin)` → Validates the teacher PIN (`885174`) and returns all student submissions and full roster details for `weekId`.
- `saveStudentRoster(teacherPin, students)` → Validates the teacher PIN and updates student names, avatars, or 4-digit PINs in the `Students` sheet tab.

## Development Workflow & Human Code Review Exceptions

Following **Blueprint-Driven Engineering**:
1. Behavioral or architectural changes are proposed in `BLUEPRINT.md` first and reviewed in plain English before compiling to source code.
2. Source files (`.js`, `.css`, `.py`, `.gs`) are treated as compiled output verified by automated unit and integration tests (`python3 -m unittest`).
3. **Human Code Review Required (Classifier Exceptions):** Human code inspection is required only when changes touch:
   - **PIN authentication and secret boundaries** in `sheet-backend/` (ensuring student PINs and teacher PIN `885174` are never leaked via public roster endpoints).
   - **Concurrent Google Sheet write locking** in `sheet-backend/` (`LockService` acquisition around simultaneous end-of-class submissions).
   - **AI answer-key verification** when compiling a new weekly PDF Question Pack (confirming the 12 cropped images and 12 answer keys before class).
