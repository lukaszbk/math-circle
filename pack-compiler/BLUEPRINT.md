# Weekly Question Pack Compiler Blueprint (`pack-compiler/`)

## Purpose

Transforms a raw Math Kangaroo competition PDF into a ready-to-serve weekly Question Pack (`pack.json` + high-resolution cropped question images + verified solutions + 3rd-grade whiteboard teaching guides).

## Why Build-Time Compilation with Cropped Visuals

In Grades 3–4 Math Kangaroo tests, almost every problem depends on spatial diagrams, mirror grids, stacked boxes, colored shapes, or picture-based answer options `(A)–(E)`. Pure text extraction breaks the problems. Rendering PDF pages at high DPI and cropping each problem's complete visual block guarantees 100% faithful diagrams for kids while pairing each question with structured AI solutions and teaching guides for the teacher.

## Half-Test Selection Rules

A standard Grades 3–4 Math Kangaroo paper has 24 questions across three 8-question point tiers (`1–8` worth 3 pts, `9–16` worth 4 pts, `17–24` worth 5 pts). Each weekly half-test selects 4 questions per section (12 questions, 48 points total):
- **Part 1 (`--part=1`, First Half):** Questions `1, 2, 3, 4` (3 pts), `9, 10, 11, 12` (4 pts), and `17, 18, 19, 20` (5 pts).
- **Part 2 (`--part=2`, Second Half):** Questions `5, 6, 7, 8` (3 pts), `13, 14, 15, 16` (4 pts), and `21, 22, 23, 24` (5 pts).
- Custom question lists (`--questions=1,2,3,4,...`) are also supported for special review weeks.

## Ingestion Pipeline Steps

Running `python3 pack-compiler/compile_pack.py --pdf <file.pdf> --part <1|2> --week-id <id> --metadata <metadata.json>`:

1. **Page Rendering:** Renders each PDF page at 300 DPI PNG via `pdftoppm` so text and line art remain crisp on high-density iPad/tablet screens.
2. **Question Bounding-Box Detection & Cropping:**
   - Automatically detects horizontal divider rules across the question column and expands vertical bounds on the right diagram side when tall illustrations extend slightly beyond rule lines (e.g., stacked boxes or 3D cube pyramids).
   - Outputs `q01.png`, `q02.png`, etc. into `webapp/packs/<week-id>/images/`.
3. **AI Multimodal Parsing, Solving & Pedagogical Authoring:**
   - Inspects each cropped question image to produce:
     - `promptSummary`: Concise plain-text transcription of the question for teacher tables and accessibility `alt` text.
     - `correctOption`: Independently solved and double-checked correct letter (`A`–`E`), cross-checked against an official answer key if provided (`--answer-key`).
     - `teachingGuide`: Written specifically for coaching 3rd graders (ages 8–9) at a whiteboard:
       - **Core Idea:** One-sentence intuition (e.g., *"Work backwards from the box you want to open"* or *"Follow reflections one mirror at a time"*).
       - **Whiteboard Walkthrough:** 3–5 short, visual steps the teacher can draw or act out on the board.
       - **Ask the Circle:** 1–2 Socratic prompts to get kids participating rather than passively listening.
       - **Common Traps:** Explanations of the most likely wrong choices so the teacher can quickly diagnose class mistakes during break.
4. **Verification Preview Sheet:**
   - Generates a single self-contained HTML contact sheet (`preview.html`) showing all 12 cropped images alongside their assigned answer key and teaching guide so the teacher (or agent) can visually confirm clean crops and accurate answers in under 30 seconds before publishing the new app version.

## Initial Seed Pack (Week 1)

The repository's first compiled Question Pack (`2022-g34-part1`) will be built from the attached **Math Kangaroo USA 2022 (Grades 3 and 4)** PDF covering Part 1: Questions `1–4`, `9–12`, and `17–20`.
