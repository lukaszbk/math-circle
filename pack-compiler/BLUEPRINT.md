# Weekly Question Pack Compiler & Agent Skill Blueprint (`pack-compiler/`)

## Purpose

Transforms a raw Math Kangaroo competition PDF into a ready-to-serve weekly Question Pack (`pack.json` + high-resolution cropped question images + verified solutions + 3rd-grade whiteboard teaching guides) through an **Agent Skill workflow** (`.agents/skills/compile-weekly-pack/SKILL.md`) backed by a flexible cropping and packaging helper (`pack-compiler/compile_pack.py`).

## Why an Agent Skill + Helper Script (Instead of Rigid Deterministic Parsing)

1. **Visual Fidelity for 3rd Graders:** Almost every Grades 3–4 Math Kangaroo problem relies on spatial diagrams, mirror grids, stacked boxes, colored shapes, or picture-based options `(A)–(E)`. Pure text extraction breaks the problems; high-DPI cropped images preserve them intact.
2. **Layout Drift Across Years:** Different competition years, scans, or regional editions vary in header spacing, watermarks, two-column blocks, missing divider rules, or tall diagrams crossing divider lines. Rather than assuming every PDF matches a single fixed geometry, `compile_pack.py` generates initial draft crops *and* ruled page renders, while the agent visually inspects every crop and iteratively refines per-question crop boxes or whiteout masks until all 12 images are clean.

## Half-Test Selection Rules

A standard Grades 3–4 Math Kangaroo paper has 24 questions across three 8-question point tiers (`1–8` worth 3 pts, `9–16` worth 4 pts, `17–24` worth 5 pts). Each weekly half-test selects 4 questions per section (12 questions, 48 points total):
- **Part 1 (`--part=1`, First Half):** Questions `1, 2, 3, 4` (3 pts), `9, 10, 11, 12` (4 pts), and `17, 18, 19, 20` (5 pts).
- **Part 2 (`--part=2`, Second Half):** Questions `5, 6, 7, 8` (3 pts), `13, 14, 15, 16` (4 pts), and `21, 22, 23, 24` (5 pts).
- Custom question lists (`--questions=1,2,3,4,...`) are also supported for special review weeks.

## Weekly Agent Skill Workflow (`/compile-weekly-pack`)

When the teacher provides a PDF and target part/week (e.g., *"Prepare 2022 Part 2"*), the agent follows five mandatory stages:

### Stage 1 — Draft Page Rendering & Heuristic Cropping (`--crop-only`)
- `compile_pack.py --crop-only` renders all PDF pages at 300 DPI (`page-1.png`…) plus coordinate-ruled reference images (`page-1-ruled.png`… with `x`/`y` pixel ticks every 100 px), attempts automatic horizontal-rule band detection, and writes draft question crops into a staging directory.
- If automatic rule detection does not match the expected question count (e.g., a scanned or unruled PDF layout), `--crop-only` still outputs the full 300-DPI page renders and ruled reference sheets instead of failing hard, allowing the agent to read exact pixel coordinates directly from the ruled pages.

### Stage 2 — Visual Crop Inspection & Edge-Case Repair
- The agent visually inspects **every** cropped question PNG (never trusting exit code `0` alone) to verify:
  - The complete prompt, diagram, and all options `(A)–(E)` are unclipped with clean margins.
  - Neighboring question text, divider lines, section banners (`Problems X points each`), and page headers/footers are excluded or masked.
- For any imperfect crop, the agent sets per-question overrides in `<week-id>.meta.json`—either relative adjustments (`cropAdjust`: `diagramPadTop`, `diagramPadBottom`, `diagramSplitX`, `trimSectionBanner`, `maskRects`) or an explicit bounding box (`customBox`: `{ page, x, y, width, height }`)—and re-runs cropping until visual inspection passes.

### Stage 3 — Blind First-Principles Solve (Before Any Search)
- **Strict Ordering Rule:** Before searching the web or consulting external keys, the agent must inspect each cropped 300-DPI diagram (zooming to 200%–300% on fine visual details such as mirror orientations, overlapping boxes, road junctions, or small corner icons) and write down its own independent derivation and candidate answer `(A)–(E)` for all 12 problems.
- Solving first prevents anchoring on noisy or mis-indexed online scrapes (where option letters sometimes permute across countries/languages).

### Stage 4 — Published Results Cross-Check & Discrepancy Resolution
- After completing its own 12 solutions, the agent searches for published Math Kangaroo answer keys and official solution writeups for that competition year and grade level (and checks `--answer-key` if supplied by the teacher).
- **Agreement:** Marks the answer verified.
- **Disagreement:** The agent zooms in on the cropped diagram, re-derives the problem from scratch comparing both candidate answers, determines whether the discrepancy came from a missed visual detail or a regional/erroneous web source, and **explicitly highlights the question and resolution in its human review summary**.
- **Unpublished / Not Found Online:** Performs a second distractor-elimination pass across all five choices `(A)–(E)` and explicitly flags the question in its summary so the teacher knows no external published key was available.

### Stage 5 — 3rd-Grade Guide Authoring, Classification & Final Pack Compilation
- Authors `pack-compiler/packs/<week-id>.meta.json` with:
  - Canonical Math Kangaroo `questionClass` (`spatial-3d`, `shapes-2d`, `logic-deduction`, `number-sense`, `patterns-simulation`, `counting-sets`, `measurement-time`) + optional differing `secondaryClass`.
  - Coaching notes written for 8–9 year olds and their families (`headline`, 3–5 concrete `steps`, `askTheKids` Socratic prompts, `commonTraps`, and hands-on tabletop `homeTip`).
- Runs `compile_pack.py --pdf ... --metadata ...` (or `--metadata-only` when updating metadata/guides without re-cropping existing PNGs) to validate `questionClass`/`secondaryClass`/`homeTip` and emit `webapp/packs/<week-id>/pack.json`, final `images/q<NN>.png`, `preview.html`, and updated `webapp/packs/index.json`.
- Reports the 12-question answer table, cross-check status per question (`Matched Published Key` / `Resolved Discrepancy` / `Self-Verified Only`), and link to `preview.html` for teacher sign-off.

## Initial Seed Pack (Week 1)

`2022-g34-part1` is compiled from **Math Kangaroo USA 2022 (Grades 3 and 4)** covering Part 1 (`Q1–Q4`, `Q9–Q12`, `Q17–Q20`).
