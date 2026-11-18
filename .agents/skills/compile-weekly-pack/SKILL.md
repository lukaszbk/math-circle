---
name: compile-weekly-pack
description: >-
  Compiles a Math Kangaroo competition PDF into a verified weekly Question Pack
  (cropped high-DPI PNGs, pack.json, preview.html, and updated index.json) with
  visual crop repair, blind first-principles problem solving before web search,
  published key cross-checking, and 3rd-grade whiteboard teaching guides.
  Activate when the user uploads or references a Math Kangaroo PDF or asks to
  prepare or compile a weekly Question Pack, Part 1, Part 2, or custom question set.
---

# Compile Weekly Math Kangaroo Question Pack

Use this 5-stage workflow whenever preparing a new weekly Question Pack from a Math Kangaroo PDF.
Never treat exit code `0` from cropping or a scraped online answer key as self-verifying: every crop must be visually audited and every problem must be solved from first principles *before* checking external sources.

## Stage 1 — Draft Page Rendering & Heuristic Cropping (`--crop-only`)

1. Locate or copy the source competition PDF into `pack-compiler/input/<file>.pdf` (ignored by git via `.gitignore`) or a scratch path.
2. Determine the target question selection and `weekId` (e.g., `2022-g34-part2`):
   - **Part 1 (`--part 1`):** Questions `1, 2, 3, 4` (3 pts), `9, 10, 11, 12` (4 pts), `17, 18, 19, 20` (5 pts).
   - **Part 2 (`--part 2`):** Questions `5, 6, 7, 8` (3 pts), `13, 14, 15, 16` (4 pts), `21, 22, 23, 24` (5 pts).
   - **Custom (`--questions 1,2,...`):** Explicit comma-separated list of paper question numbers.
3. Run `--crop-only` into a staging directory (default `/tmp/mk_draft_<weekId>` or pass `--draft-dir`):

```bash
python3 pack-compiler/compile_pack.py \
  --pdf pack-compiler/input/<file>.pdf \
  --part <1|2> \
  --week-id <weekId> \
  --crop-only \
  --draft-dir /tmp/mk_draft_<weekId>
```

4. `--crop-only` emits:
   - `pages/page-N.png` — Clean 300-DPI PNG render of every PDF page.
   - `pages/page-N-ruled.png` — Coordinate-ruled reference sheets with pixel grid lines every `100 px` (stronger lines every `500 px`) and coordinate labels along the top and left edges.
   - `crops/q<NN>.png` — Best-effort cropped problem cards for the requested questions.
   - `draft_manifest.json` — Page dimensions, detected divider `y` coordinates, total band count, any layout warnings, and file paths.
   - Note: `--crop-only` never fails hard when horizontal divider rules differ from 24 (e.g., unruled scans or two-column layouts); it records warnings in `draft_manifest.json` so you can read exact pixel boxes from `page-N-ruled.png`.

## Stage 2 — Mandatory Visual Crop Inspection & Edge-Case Repair

1. Read `draft_manifest.json` and inspect **every** generated `crops/q<NN>.png` using `read_file` (or inspect `pages/page-N-ruled.png` if automatic detection missed bands).
2. Confirm for all 12 selected questions:
   - Full prompt text, spatial diagrams, and all options `(A)–(E)` are completely unclipped with clean margins.
   - No neighboring question text, divider rules, section banners (`Problems X points each`), or page headers/footers bleed into the image.
3. For any imperfect crop, configure per-question overrides in `pack-compiler/packs/<weekId>.meta.json`:
   - **Relative adjustment (`cropAdjust`)** when horizontal divider bands are roughly right:
     - `trimSectionBanner: true` — Whitens the top-left section banner box (`Problems X points each`) without touching right-side diagrams.
     - `diagramPadTop` / `diagramPadBottom` with `diagramSplitX` (default `1500`) — Expands vertical bounds while whitening the left-hand text area above/below (`0..diagramSplitX - 120`) so tall right-side illustrations are preserved without neighboring question text.
     - `maskRects: [[x0, y0, x1, y1], ...]` — Explicit whiteout rectangles in cropped-image coordinates to erase stray fragments or headers.
   - **Explicit bounding box (`customBox`)** when a layout lacks standard horizontal divider rules, uses two columns, or needs exact placement read directly from `pages/page-N-ruled.png`:
     ```json
     "customBox": { "page": 2, "x": 120, "y": 400, "width": 2310, "height": 520 }
     ```
     (`page` is 1-based; `cropAdjust.maskRects` and `cropAdjust.trimSectionBanner` can still be combined with `customBox`.)
4. Re-run `compile_pack.py --crop-only --metadata pack-compiler/packs/<weekId>.meta.json ...` and visually verify every repaired crop via `read_file` before solving.

## Stage 3 — Blind First-Principles Solve (STRICT ORDERING — BEFORE ANY WEB SEARCH)

> **STRICT ORDERING RULE:** Complete and record all 12 independent derivations and candidate answers `(A)–(E)` **before** running `search_web` or reading any external or user-supplied answer key (`--answer-key`). Solving blind prevents anchoring on noisy web scrapes or regional choice-letter permutations.

1. Inspect each 300-DPI cropped PNG directly (`read_file`).
2. Whenever fine visual details matter—mirror angles, road junctions, overlapping boxes, cube edges, watermarks, or tiny corner icons (such as a small sun or hidden animal)—create a 200%–300% zoomed crop in scratch via ImageMagick and inspect it with `read_file`:
   ```bash
   convert <crop.png> -crop <W>x<H>+<X>+<Y> +repage -resize 250% /tmp/zoom_q<NN>.png
   ```
3. For all 12 selected questions, write down a concise step-by-step derivation and your candidate answer (`A`–`E`) before moving to Stage 4.

## Stage 4 — Published Results Cross-Check & Discrepancy Resolution

1. Now run `search_web` for published Math Kangaroo Écolier / Grades 3–4 answer keys and official solution writeups for that competition year (and compare against `--answer-key` if provided by the teacher).
2. Classify every question into one of three verification statuses:
   - **`Matched Published Key`** — Blind first-principles solve matches the published key/solution.
   - **`Resolved Discrepancy`** — Blind solve and published source initially disagreed. Zoom to 300% on the cropped diagram, re-derive from scratch comparing both options, and determine whether a missed visual detail caused the initial error OR whether the online source was for a different country/year/permuted option order. Document the exact resolution.
   - **`Self-Verified Only`** — No authoritative published key was found online. Perform a second independent distractor-elimination pass checking why all four wrong options `(A)–(E)` fail.
3. **Escalation Rule:** Explicitly highlight every `Resolved Discrepancy`, `Self-Verified Only`, or unresolved ambiguity item in your final report to the teacher before class.

## Stage 5 — 3rd-Grade Whiteboard Guide Authoring & Final Pack Assembly

1. Author `pack-compiler/packs/<weekId>.meta.json` matching this schema:

```json
{
  "weekId": "2022-g34-part2",
  "title": "Math Kangaroo 2022 (Grades 3–4) · Part 2",
  "subtitle": "Last 4 problems in each point section (Questions 5–8, 13–16, 21–24)",
  "competitionYear": 2022,
  "gradeBand": "Grades 3 and 4",
  "part": 2,
  "questions": [
    {
      "number": 5,
      "points": 3,
      "title": "Short Kid-Friendly Title",
      "promptSummary": "Concise plain-text summary for alt text and teacher triage cards.",
      "correctOption": "A",
      "cropAdjust": { "trimSectionBanner": true },
      "teachingGuide": {
        "headline": "One-sentence core mathematical idea in 3rd-grade language.",
        "steps": [
          "3–5 short, concrete whiteboard steps the teacher can draw or act out."
        ],
        "askTheKids": [
          "1–2 Socratic prompts to spark discussion."
        ],
        "commonTraps": "Explanation of the most tempting wrong choices."
      }
    }
  ]
}
```
*(Include optional `"customBox"` or `"cropAdjust"` fields where needed.)*

2. Run the final pack build (pass `--set-default` if this pack should become the active default in `webapp/packs/index.json`):

```bash
python3 pack-compiler/compile_pack.py \
  --pdf pack-compiler/input/<file>.pdf \
  --part <1|2> \
  --metadata pack-compiler/packs/<weekId>.meta.json \
  --out-dir webapp/packs/<weekId> \
  --set-default
```

3. Run the automated test suite:

```bash
python3 -m unittest discover -s tests -v
```

4. Present the teacher with:
   - A 12-row summary table (`#`, `Points`, `Title`, `Verified Answer`, `Cross-Check Status`),
   - Explicit callouts for any `Resolved Discrepancy` or `Self-Verified Only` questions,
   - Clickable file link to `webapp/packs/<weekId>/preview.html` for final visual sign-off.
