#!/usr/bin/env python3
"""Compile a Math Kangaroo competition PDF into a Question Pack for the webapp.

Uses pdftoppm (Poppler) and convert/identify (ImageMagick) with Python 3 stdlib
only. Supports two workflows:
  1. Draft mode (--crop-only): renders 300-DPI pages, coordinate-ruled reference
     pages (100 px grid), best-effort draft crops, and draft_manifest.json.
  2. Final mode: crops selected questions (using automatic divider bands or
     per-question customBox + cropAdjust/maskRects overrides), writes pack.json,
     updates packs/index.json, and generates preview.html.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PART_QUESTIONS = {
    1: [1, 2, 3, 4, 9, 10, 11, 12, 17, 18, 19, 20],
    2: [5, 6, 7, 8, 13, 14, 15, 16, 21, 22, 23, 24],
}

CROP_X = 120
CROP_WIDTH = 2310
DEFAULT_SPLIT_X = 1500
VERTICAL_MARGIN = 6
RULE_PROBE_X = 165
RULE_PROBE_WIDTH = 1385
RULE_DARK_THRESHOLD = 45
RULE_GAP_MERGE_PX = 20
RULE_MAX_THICKNESS_PX = 10
BANNER_MASK_RECT = (0, 0, 575, 140)

QUESTION_CLASSES = {
    "spatial-3d": {
        "domain": "geometry-spatial",
        "domainLabel": "Geometry & Spatial",
        "label": "3D Spatial & Cubes",
        "shortLabel": "3D Spatial",
        "icon": "🧊",
    },
    "shapes-2d": {
        "domain": "geometry-spatial",
        "domainLabel": "Geometry & Spatial",
        "label": "2D Shapes, Symmetry & Paths",
        "shortLabel": "2D Shapes",
        "icon": "📐",
    },
    "logic-deduction": {
        "domain": "logic-reasoning",
        "domainLabel": "Logic & Reasoning",
        "label": "Deductive Logic & Constraints",
        "shortLabel": "Logic",
        "icon": "🧩",
    },
    "number-sense": {
        "domain": "number-arithmetic",
        "domainLabel": "Number & Arithmetic",
        "label": "Number Sense, Equations & Grids",
        "shortLabel": "Number Sense",
        "icon": "⚖️",
    },
    "patterns-simulation": {
        "domain": "combinatorics-patterns",
        "domainLabel": "Combinatorics & Patterns",
        "label": "Patterns, Cycles & Step Simulation",
        "shortLabel": "Simulation",
        "icon": "🔄",
    },
    "counting-sets": {
        "domain": "combinatorics-patterns",
        "domainLabel": "Combinatorics & Patterns",
        "label": "Systematic Counting & Sets",
        "shortLabel": "Counting & Sets",
        "icon": "🔢",
    },
    "measurement-time": {
        "domain": "measurement",
        "domainLabel": "Measurement & Time",
        "label": "Measurement, Clocks & Money",
        "shortLabel": "Measurement",
        "icon": "⏱️",
    },
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for the Question Pack compiler."""
    parser = argparse.ArgumentParser(
        description="Compile a Math Kangaroo PDF into a Question Pack."
    )
    parser.add_argument(
        "--pdf",
        default=None,
        help="Path to source PDF file (required unless --metadata-only is set).",
    )
    parser.add_argument(
        "--metadata",
        default=None,
        help="Path to question metadata JSON (required unless --crop-only is set).",
    )
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="Rebuild pack.json and preview.html using existing images/qNN.png without re-rendering PDF.",
    )
    parser.add_argument(
        "--part",
        type=int,
        choices=[1, 2],
        default=None,
        help="Half-test part (1 or 2). Ignored if --questions is provided.",
    )
    parser.add_argument(
        "--questions",
        default=None,
        help="Comma-separated custom question numbers (e.g. 1,2,3,4).",
    )
    parser.add_argument(
        "--week-id",
        default=None,
        help="Override weekId from metadata JSON (or name draft folder).",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output pack directory (defaults to webapp/packs/<weekId>).",
    )
    parser.add_argument(
        "--crop-only",
        action="store_true",
        help="Render pages, ruled grid sheets, best-effort draft crops, and draft_manifest.json.",
    )
    parser.add_argument(
        "--draft-dir",
        default=None,
        help="Staging directory for --crop-only (defaults to <out-dir>/draft or /tmp/mk_draft_<weekId>).",
    )
    parser.add_argument(
        "--index-file",
        default=None,
        help="Path to packs index.json (defaults to <out-dir>/../index.json).",
    )
    parser.add_argument(
        "--no-index",
        action="store_true",
        help="Skip updating packs index.json.",
    )
    parser.add_argument(
        "--set-default",
        action="store_true",
        help="Set this pack as defaultWeekId in index.json.",
    )
    parser.add_argument(
        "--answer-key",
        default=None,
        help="Optional JSON file mapping question numbers to official letters for cross-check.",
    )
    args = parser.parse_args(argv)
    if args.crop_only and args.metadata_only:
        parser.error("--crop-only and --metadata-only cannot be used together.")
    if not args.crop_only and not args.metadata:
        parser.error("--metadata is required unless --crop-only is set.")
    if not args.metadata_only and not args.pdf:
        parser.error("--pdf is required unless --metadata-only is set.")
    return args


def resolve_question_numbers(
    args: argparse.Namespace, metadata: dict | None
) -> list[int]:
    """Determine ordered question numbers from --questions, --part, or metadata."""
    if args.questions:
        numbers = [
            int(item.strip())
            for item in args.questions.split(",")
            if item.strip()
        ]
        if not numbers:
            raise ValueError("--questions must contain at least one question number.")
        return numbers

    meta = metadata or {}
    part = args.part if args.part is not None else meta.get("part")
    if part in PART_QUESTIONS:
        return list(PART_QUESTIONS[part])

    meta_numbers = [int(q["number"]) for q in meta.get("questions", [])]
    if meta_numbers:
        return meta_numbers
    raise ValueError("Specify --part (1 or 2), --questions, or questions in metadata.")


def _page_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"(\d+)$", path.stem)
    return (int(match.group(1)) if match else 0, path.name)


def render_pdf_pages(pdf_path: Path, work_dir: Path) -> list[Path]:
    """Render all PDF pages at 300 DPI PNG via pdftoppm."""
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    work_dir.mkdir(parents=True, exist_ok=True)
    for stale in work_dir.glob("page-*.png"):
        stale.unlink()
    prefix = work_dir / "page"
    subprocess.run(
        ["pdftoppm", "-png", "-r", "300", str(pdf_path), str(prefix)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    pages = sorted(work_dir.glob("page-*.png"), key=_page_sort_key)
    if not pages:
        raise RuntimeError(f"pdftoppm produced no page PNGs for {pdf_path}")
    return pages


def get_image_dimensions(image_path: Path) -> tuple[int, int]:
    """Return (width, height) of an image via ImageMagick identify."""
    out = subprocess.check_output(
        ["identify", "-format", "%w %h", str(image_path)],
        text=True,
    ).strip()
    width_str, height_str = out.split()
    return int(width_str), int(height_str)


def render_ruled_page(page_png: Path, dest_png: Path) -> Path:
    """Render a coordinate-ruled reference PNG with 100 px grid lines and labels."""
    width, height = get_image_dimensions(page_png)
    cmds: list[str] = []

    for x in range(100, width, 100):
        is_major = x % 500 == 0
        color = "rgba(217,93,57,0.58)" if is_major else "rgba(31,111,97,0.28)"
        stroke_w = 2 if is_major else 1
        cmds.append(f"stroke {color} stroke-width {stroke_w} line {x},0 {x},{height}")

    for y in range(100, height, 100):
        is_major = y % 500 == 0
        color = "rgba(217,93,57,0.58)" if is_major else "rgba(31,111,97,0.28)"
        stroke_w = 2 if is_major else 1
        cmds.append(f"stroke {color} stroke-width {stroke_w} line 0,{y} {width},{y}")

    cmds.append("stroke none fill rgba(180,35,20,0.95) font-size 22")
    for x in range(100, width, 100):
        cmds.append(f"text {x + 4},26 '{x}'")
    for y in range(100, height, 100):
        cmds.append(f"text 6,{y - 6} '{y}'")

    dest_png.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["convert", str(page_png), "-draw", " ".join(cmds), "-strip", str(dest_png)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return dest_png


def _parse_pgm_p5(raw: bytes) -> list[int]:
    """Parse a binary P5 PGM byte stream and return pixel intensities (0..255)."""
    lines = raw.split(b"\n", 3)
    if len(lines) < 4 or not lines[0].startswith(b"P5"):
        raise ValueError("Expected binary P5 PGM output from ImageMagick convert.")
    maxval = int(lines[2].strip())
    data = lines[3]
    if maxval == 255:
        return list(data)
    if maxval <= 0:
        return list(data)
    return [round(b * 255 / maxval) for b in data]


def detect_page_dividers(page_png: Path) -> list[int]:
    """Detect y-coordinates of horizontal question divider rules on a page."""
    width, height = get_image_dimensions(page_png)
    probe_x = RULE_PROBE_X if width > RULE_PROBE_X else 0
    probe_w = min(RULE_PROBE_WIDTH, max(1, width - probe_x))
    probe_crop = f"{probe_w}x{height}+{probe_x}+0"

    raw = subprocess.check_output(
        [
            "convert",
            str(page_png),
            "-crop",
            probe_crop,
            "+repage",
            "-colorspace",
            "Gray",
            "-threshold",
            "60%",
            "-scale",
            f"1x{height}!",
            "-depth",
            "8",
            "pgm:-",
        ]
    )
    pixels = _parse_pgm_p5(raw)
    dark_rows = [y for y, val in enumerate(pixels) if val < RULE_DARK_THRESHOLD]

    clusters: list[list[int]] = []
    for y in dark_rows:
        if not clusters or y - clusters[-1][-1] > RULE_GAP_MERGE_PX:
            clusters.append([y])
        else:
            clusters[-1].append(y)

    return [
        round(sum(cluster) / len(cluster))
        for cluster in clusters
        if len(cluster) <= RULE_MAX_THICKNESS_PX
    ]


def detect_all_bands_with_diagnostics(
    page_pngs: list[Path], strict: bool = False
) -> tuple[list[tuple[int, Path, int, int]], list[dict], list[str]]:
    """Detect question bands and collect per-page diagnostics and layout warnings."""
    bands: list[tuple[int, Path, int, int]] = []
    page_diagnostics: list[dict] = []
    warnings: list[str] = []
    q_num = 1

    for page_idx, page_png in enumerate(page_pngs):
        width, height = get_image_dimensions(page_png)
        divs = detect_page_dividers(page_png)
        start_idx = 1 if page_idx == 0 else 0
        usable = len(divs) - start_idx
        page_band_count = max(0, usable - 1)

        if usable < 2:
            msg = (
                f"Page {page_idx + 1}: detected {len(divs)} horizontal divider rule(s) "
                f"({divs}); expected at least {start_idx + 2} to form bands."
            )
            if strict:
                raise RuntimeError(f"{msg} ({page_png})")
            warnings.append(msg)
        else:
            for idx in range(start_idx, len(divs) - 1):
                bands.append((q_num, page_png, divs[idx], divs[idx + 1]))
                q_num += 1

        page_diagnostics.append(
            {
                "page": page_idx + 1,
                "width": width,
                "height": height,
                "dividers": divs,
                "bandCount": page_band_count,
            }
        )

    return bands, page_diagnostics, warnings


def detect_all_bands(
    page_pngs: list[Path], strict: bool = True
) -> list[tuple[int, Path, int, int]]:
    """Return ordered list of (question_number, page_png, y0, y1) bands."""
    bands, _diag, _warnings = detect_all_bands_with_diagnostics(page_pngs, strict=strict)
    return bands


def _build_mask_draw_ops(
    crop_adjust: dict | None,
    pad_top: int = 0,
    pad_bottom: int = 0,
    crop_height: int = 0,
    split_x: int = DEFAULT_SPLIT_X,
    crop_x: int = CROP_X,
) -> list[str]:
    """Build ImageMagick whiteout rectangle operations in cropped-image coordinates."""
    adjust = crop_adjust or {}
    draw_ops: list[str] = []
    split_rel_x = max(0, split_x - crop_x)

    if pad_top > 0 and split_rel_x > 0:
        draw_ops.append(f"rectangle 0,0 {split_rel_x},{pad_top}")
    if pad_bottom > 0 and split_rel_x > 0:
        mask_y0 = max(0, crop_height - pad_bottom)
        draw_ops.append(f"rectangle 0,{mask_y0} {split_rel_x},{crop_height}")
    if adjust.get("trimSectionBanner"):
        bx0, by0, bx1, by1 = BANNER_MASK_RECT
        draw_ops.append(f"rectangle {bx0},{by0} {bx1},{by1}")

    for rect in adjust.get("maskRects") or []:
        if not isinstance(rect, (list, tuple)) or len(rect) != 4:
            raise ValueError(f"Each maskRect must be [x0, y0, x1, y1]; got {rect!r}")
        rx0, ry0, rx1, ry1 = (int(v) for v in rect)
        draw_ops.append(f"rectangle {rx0},{ry0} {rx1},{ry1}")

    return draw_ops


def _run_crop_convert(
    page_png: Path,
    crop_x: int,
    crop_y: int,
    crop_width: int,
    crop_height: int,
    draw_ops: list[str],
    dest_png: Path,
) -> tuple[int, int]:
    """Execute ImageMagick crop + optional whiteout masks and return (w, h)."""
    if crop_width <= 0 or crop_height <= 0:
        raise ValueError(
            f"Invalid crop dimensions {crop_width}x{crop_height}+{crop_x}+{crop_y}."
        )
    dest_png.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "convert",
        str(page_png),
        "-crop",
        f"{crop_width}x{crop_height}+{crop_x}+{crop_y}",
        "+repage",
    ]
    if draw_ops:
        cmd.extend(["-fill", "white"])
        for rect in draw_ops:
            cmd.extend(["-draw", rect])
    cmd.extend(["-strip", str(dest_png)])
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return get_image_dimensions(dest_png)


def crop_question_image(
    page_png: Path,
    y0: int,
    y1: int,
    crop_adjust: dict | None,
    dest_png: Path,
    page_height: int = 3300,
) -> tuple[int, int]:
    """Crop a single question band with optional padding and whiteout masks."""
    adjust = crop_adjust or {}
    pad_top = int(adjust.get("diagramPadTop", 0))
    pad_bottom = int(adjust.get("diagramPadBottom", 0))
    split_x = int(adjust.get("diagramSplitX", DEFAULT_SPLIT_X))

    base_top = y0 + VERTICAL_MARGIN
    base_bot = y1 - VERTICAL_MARGIN
    crop_top = max(0, base_top - pad_top)
    crop_bot = min(page_height, base_bot + pad_bottom)
    crop_height = crop_bot - crop_top
    if crop_height <= 0:
        raise ValueError(
            f"Invalid crop height ({crop_height}) for y0={y0}, y1={y1}."
        )

    draw_ops = _build_mask_draw_ops(
        crop_adjust=adjust,
        pad_top=pad_top,
        pad_bottom=pad_bottom,
        crop_height=crop_height,
        split_x=split_x,
        crop_x=CROP_X,
    )
    return _run_crop_convert(
        page_png=page_png,
        crop_x=CROP_X,
        crop_y=crop_top,
        crop_width=CROP_WIDTH,
        crop_height=crop_height,
        draw_ops=draw_ops,
        dest_png=dest_png,
    )


def crop_custom_box(
    page_png: Path,
    custom_box: dict,
    crop_adjust: dict | None,
    dest_png: Path,
) -> tuple[int, int]:
    """Crop an explicit customBox {page, x, y, width, height} plus optional masks."""
    x = int(custom_box["x"])
    y = int(custom_box["y"])
    width = int(custom_box["width"])
    height = int(custom_box["height"])
    draw_ops = _build_mask_draw_ops(
        crop_adjust=crop_adjust,
        crop_height=height,
        crop_x=x,
    )
    return _run_crop_convert(
        page_png=page_png,
        crop_x=x,
        crop_y=y,
        crop_width=width,
        crop_height=height,
        draw_ops=draw_ops,
        dest_png=dest_png,
    )


def validate_question_metadata(q_meta: dict) -> tuple[str, str | None]:
    """Validate required questionClass, optional secondaryClass, and teachingGuide.homeTip."""
    q_num = q_meta.get("number")
    q_class = str(q_meta.get("questionClass") or "").strip()
    if q_class not in QUESTION_CLASSES:
        raise ValueError(
            f"Question #{q_num} has invalid or missing questionClass {q_class!r}; "
            f"expected one of {sorted(QUESTION_CLASSES.keys())}."
        )
    sec_raw = q_meta.get("secondaryClass")
    sec_class = str(sec_raw).strip() if sec_raw else None
    if sec_class is not None:
        if sec_class not in QUESTION_CLASSES:
            raise ValueError(
                f"Question #{q_num} has invalid secondaryClass {sec_class!r}; "
                f"expected one of {sorted(QUESTION_CLASSES.keys())}."
            )
        if sec_class == q_class:
            raise ValueError(
                f"Question #{q_num} secondaryClass {sec_class!r} must differ from questionClass."
            )
    guide = q_meta.get("teachingGuide")
    if not isinstance(guide, dict) or not str(guide.get("homeTip") or "").strip():
        raise ValueError(
            f"Question #{q_num} teachingGuide.homeTip must be a non-empty string."
        )
    return q_class, sec_class


def validate_answer_key(
    selected_questions: list[dict], answer_key_path: Path | None
) -> None:
    """Cross-check metadata correctOption values against an optional answer key JSON."""
    if not answer_key_path:
        return
    raw_key = json.loads(answer_key_path.read_text(encoding="utf-8"))
    for q in selected_questions:
        q_key = str(q["number"])
        expected = raw_key.get(q_key) or raw_key.get(q["number"])
        if expected and str(expected).strip().upper() != q["correctOption"]:
            raise ValueError(
                f"Answer mismatch on Q{q['number']}: metadata={q['correctOption']} vs key={expected}"
            )


def update_packs_index(
    index_path: Path, pack_data: dict, set_default: bool = False
) -> None:
    """Create or update webapp/packs/index.json with the compiled pack summary."""
    if index_path.is_file():
        index_obj = json.loads(index_path.read_text(encoding="utf-8"))
    else:
        index_obj = {"defaultWeekId": pack_data["weekId"], "packs": []}

    summary = {
        "weekId": pack_data["weekId"],
        "title": pack_data["title"],
        "subtitle": pack_data.get("subtitle", ""),
        "competitionYear": pack_data.get("competitionYear"),
        "gradeBand": pack_data.get("gradeBand", ""),
        "part": pack_data.get("part"),
        "questionCount": pack_data["questionCount"],
        "maxScore": pack_data["maxScore"],
        "packUrl": f"packs/{pack_data['weekId']}/pack.json",
    }

    packs = [
        p for p in index_obj.get("packs", []) if p.get("weekId") != summary["weekId"]
    ]
    packs.append(summary)
    packs.sort(key=lambda item: (item.get("competitionYear") or 0, item.get("weekId", "")))
    index_obj["packs"] = packs

    if set_default or not index_obj.get("defaultWeekId"):
        index_obj["defaultWeekId"] = summary["weekId"]

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        json.dumps(index_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def build_preview_html(pack_data: dict) -> str:
    """Generate a self-contained visual verification sheet (preview.html)."""
    cards: list[str] = []
    for q in pack_data["questions"]:
        guide = q.get("teachingGuide", {})
        steps_html = "".join(
            f"<li>{html.escape(step)}</li>" for step in guide.get("steps", [])
        )
        ask_html = "".join(
            f"<li>{html.escape(prompt)}</li>"
            for prompt in guide.get("askTheKids", [])
        )
        rel_img = f"images/q{int(q['number']):02d}.png"
        cls_info = QUESTION_CLASSES.get(q.get("questionClass", ""), {})
        cls_badge = (
            f'<span class="badge qcls">{html.escape(cls_info.get("icon", "🏷️"))} {html.escape(cls_info.get("label", q.get("questionClass", "")))}</span>'
            if q.get("questionClass")
            else ""
        )
        sec_info = QUESTION_CLASSES.get(q.get("secondaryClass", ""), {})
        sec_badge = (
            f'<span class="badge qsec">+ {html.escape(sec_info.get("shortLabel", q.get("secondaryClass", "")))}</span>'
            if q.get("secondaryClass")
            else ""
        )
        home_tip = guide.get("homeTip", "")
        home_tip_html = (
            f'<h3>Try at Home</h3><p>{html.escape(home_tip)}</p>'
            if home_tip
            else ""
        )
        cards.append(
            f"""
            <article class="card">
              <header class="card-head">
                <div class="badges">
                  <span class="badge qnum">Question #{q['number']}</span>
                  <span class="badge pts">{q['points']} pts</span>
                  <span class="badge ans">Answer: ({html.escape(q['correctOption'])})</span>
                  {cls_badge}
                  {sec_badge}
                </div>
                <h2>{html.escape(q.get('title', ''))}</h2>
                <p class="summary">{html.escape(q.get('promptSummary', ''))}</p>
              </header>
              <div class="img-wrap">
                <img src="{html.escape(rel_img)}" alt="Question {q['number']}" loading="lazy" />
              </div>
              <section class="guide">
                <p class="headline"><strong>Core Idea:</strong> {html.escape(guide.get('headline', ''))}</p>
                <div class="cols">
                  <div>
                    <h3>Whiteboard Walkthrough</h3>
                    <ol>{steps_html}</ol>
                  </div>
                  <div>
                    <h3>Ask the Circle</h3>
                    <ul>{ask_html}</ul>
                    <h3>Common Traps</h3>
                    <p>{html.escape(guide.get('commonTraps', ''))}</p>
                    {home_tip_html}
                  </div>
                </div>
              </section>
            </article>
            """
        )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Preview: {html.escape(pack_data['title'])}</title>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #FAF7F2;
      color: #1E242B;
      margin: 0;
      padding: 24px;
      line-height: 1.45;
    }}
    .wrap {{ max-width: 1080px; margin: 0 auto; }}
    .page-head {{
      background: #fff;
      border: 1px solid #E6DDD0;
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }}
    .page-head h1 {{ margin: 0 0 6px; font-size: 1.5rem; }}
    .page-head p {{ margin: 0; color: #5B6572; }}
    .card {{
      background: #fff;
      border: 1px solid #E6DDD0;
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 24px;
      box-shadow: 0 2px 8px rgba(30, 36, 43, 0.04);
    }}
    .card-head h2 {{ margin: 8px 0 4px; font-size: 1.2rem; }}
    .summary {{ margin: 0 0 12px; color: #5B6572; font-size: 0.95rem; }}
    .badges {{ display: flex; flex-wrap: wrap; gap: 8px; }}
    .badge {{
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 0.85rem;
    }}
    .qnum {{ background: #ECE7DF; color: #1E242B; }}
    .pts {{ background: #FDF2E4; color: #A85A14; }}
    .ans {{ background: #E6F4F1; color: #1F6F61; }}
    .qcls {{ background: #F2ECE1; color: #1E242B; border: 1px solid #CFC4B2; }}
    .qsec {{ background: #FCECE7; color: #B94827; }}
    .img-wrap {{
      border: 1px solid #E6DDD0;
      border-radius: 10px;
      padding: 12px;
      background: #fff;
      text-align: center;
      margin-bottom: 16px;
    }}
    .img-wrap img {{ max-width: 100%; height: auto; display: block; margin: 0 auto; }}
    .guide {{ background: #FAF7F2; border-radius: 10px; padding: 14px 18px; }}
    .headline {{ margin: 0 0 10px; color: #1F6F61; }}
    .cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }}
    .cols h3 {{ margin: 0 0 6px; font-size: 0.95rem; }}
    .cols ol, .cols ul, .cols p {{ margin: 0 0 10px; padding-left: 18px; font-size: 0.9rem; }}
    .cols p {{ padding-left: 0; }}
    @media (max-width: 760px) {{ .cols {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="page-head">
      <h1>{html.escape(pack_data['title'])} — Crop &amp; Answer Verification Sheet</h1>
      <p>{html.escape(pack_data.get('subtitle', ''))} · {pack_data['questionCount']} questions · Max Score: {pack_data['maxScore']} ({html.escape(pack_data['scoringRule'])})</p>
    </header>
    {''.join(cards)}
  </div>
</body>
</html>
"""


def _crop_single_question(
    q_num: int,
    q_meta: dict,
    page_pngs: list[Path],
    page_heights: dict[Path, int],
    bands_by_num: dict[int, tuple[Path, int, int]],
    dest_png: Path,
) -> tuple[int, int]:
    """Crop one question via customBox if specified, else via detected divider band."""
    custom_box = q_meta.get("customBox")
    if custom_box:
        page_num = int(custom_box["page"])
        if page_num < 1 or page_num > len(page_pngs):
            raise IndexError(
                f"Question #{q_num} customBox page={page_num} out of range (1..{len(page_pngs)})."
            )
        return crop_custom_box(
            page_png=page_pngs[page_num - 1],
            custom_box=custom_box,
            crop_adjust=q_meta.get("cropAdjust"),
            dest_png=dest_png,
        )

    if q_num not in bands_by_num:
        raise IndexError(
            f"Question #{q_num} not found in detected bands (detected: {sorted(bands_by_num.keys())}) "
            "and no customBox override was provided."
        )
    page_png, y0, y1 = bands_by_num[q_num]
    return crop_question_image(
        page_png=page_png,
        y0=y0,
        y1=y1,
        crop_adjust=q_meta.get("cropAdjust"),
        dest_png=dest_png,
        page_height=page_heights[page_png],
    )


def run_crop_only(
    pdf_path: Path,
    draft_dir: Path,
    part: int | None = None,
    questions_override: list[int] | None = None,
    metadata_path: Path | None = None,
    week_id: str | None = None,
) -> dict:
    """Render 300-DPI pages, ruled sheets, best-effort draft crops, and draft_manifest.json."""
    metadata = (
        json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata_path is not None
        else {}
    )
    meta_by_num = {int(q["number"]): q for q in metadata.get("questions", [])}

    pages_dir = draft_dir / "pages"
    crops_dir = draft_dir / "crops"
    pages_dir.mkdir(parents=True, exist_ok=True)
    crops_dir.mkdir(parents=True, exist_ok=True)

    page_pngs = render_pdf_pages(pdf_path, pages_dir)
    page_heights = {p: get_image_dimensions(p)[1] for p in page_pngs}

    ruled_paths: list[Path] = []
    for page_png in page_pngs:
        ruled_png = pages_dir / f"{page_png.stem}-ruled.png"
        render_ruled_page(page_png, ruled_png)
        ruled_paths.append(ruled_png)

    bands, page_diagnostics, warnings = detect_all_bands_with_diagnostics(
        page_pngs, strict=False
    )
    bands_by_num = {num: (page_png, y0, y1) for num, page_png, y0, y1 in bands}

    if len(bands) != 24:
        warnings.append(
            f"Detected {len(bands)} total question band(s) across {len(page_pngs)} page(s); "
            "standard full paper has 24. Inspect ruled pages and add customBox where needed."
        )

    if questions_override is not None:
        target_numbers = questions_override
    elif part in PART_QUESTIONS:
        target_numbers = list(PART_QUESTIONS[part])
    elif metadata.get("questions"):
        target_numbers = [int(q["number"]) for q in metadata["questions"]]
    else:
        target_numbers = [b[0] for b in bands]

    crops: list[dict] = []
    for q_num in target_numbers:
        q_meta = dict(meta_by_num.get(q_num, {}))
        dest_png = crops_dir / f"q{q_num:02d}.png"
        if not q_meta.get("customBox") and q_num not in bands_by_num:
            warnings.append(
                f"Skipped Q{q_num}: no detected band and no customBox override."
            )
            continue
        w, h = _crop_single_question(
            q_num=q_num,
            q_meta=q_meta,
            page_pngs=page_pngs,
            page_heights=page_heights,
            bands_by_num=bands_by_num,
            dest_png=dest_png,
        )
        crops.append(
            {
                "number": q_num,
                "image": str(dest_png),
                "width": w,
                "height": h,
                "method": "customBox" if q_meta.get("customBox") else "dividerBand",
            }
        )

    pages_manifest = []
    for idx, diag in enumerate(page_diagnostics):
        pages_manifest.append(
            {
                **diag,
                "image": str(page_pngs[idx]),
                "ruledImage": str(ruled_paths[idx]),
            }
        )

    manifest = {
        "weekId": week_id or metadata.get("weekId") or pdf_path.stem,
        "pdf": str(pdf_path),
        "draftDir": str(draft_dir),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "bandCount": len(bands),
        "targetQuestions": target_numbers,
        "pages": pages_manifest,
        "crops": crops,
        "warnings": warnings,
    }
    (draft_dir / "draft_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest


def compile_pack(
    pdf_path: Path | None,
    metadata_path: Path,
    part: int | None = None,
    questions_override: list[int] | None = None,
    week_id_override: str | None = None,
    out_dir: Path | None = None,
    index_file: Path | None = None,
    update_index: bool = True,
    set_default: bool = False,
    answer_key_path: Path | None = None,
    metadata_only: bool = False,
) -> dict:
    """Run the PDF-to-Question-Pack compilation pipeline (or metadata-only rebuild)."""
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    week_id = week_id_override or metadata["weekId"]

    if questions_override is not None:
        selected_numbers = questions_override
    else:
        ns = argparse.Namespace(questions=None, part=part)
        selected_numbers = resolve_question_numbers(ns, metadata)

    meta_by_num = {int(q["number"]): q for q in metadata.get("questions", [])}
    missing_meta = [n for n in selected_numbers if n not in meta_by_num]
    if missing_meta:
        raise KeyError(
            f"Metadata {metadata_path} is missing entries for questions: {missing_meta}"
        )

    validated_classes: dict[int, tuple[str, str | None]] = {}
    for q_num in selected_numbers:
        validated_classes[q_num] = validate_question_metadata(meta_by_num[q_num])

    target_dir = out_dir or (Path("webapp") / "packs" / week_id)
    images_dir = target_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    compiled_questions: list[dict] = []
    if metadata_only:
        for q_num in selected_numbers:
            q_meta = dict(meta_by_num[q_num])
            img_name = f"q{q_num:02d}.png"
            dest_png = images_dir / img_name
            if not dest_png.is_file():
                raise FileNotFoundError(
                    f"Existing image missing for --metadata-only: {dest_png}"
                )
            w, h = get_image_dimensions(dest_png)
            q_class, sec_class = validated_classes[q_num]
            q_record = {
                "number": int(q_meta["number"]),
                "points": int(q_meta["points"]),
                "title": q_meta["title"],
                "promptSummary": q_meta["promptSummary"],
                "correctOption": str(q_meta["correctOption"]).strip().upper(),
                "questionClass": q_class,
                **({"secondaryClass": sec_class} if sec_class else {}),
                "imageUrl": f"packs/{week_id}/images/{img_name}",
                "imageWidth": w,
                "imageHeight": h,
                "teachingGuide": q_meta["teachingGuide"],
            }
            compiled_questions.append(q_record)
    else:
        if pdf_path is None:
            raise ValueError("pdf_path is required unless metadata_only=True.")
        with tempfile.TemporaryDirectory(prefix="mk_pack_") as tmp:
            tmp_dir = Path(tmp)
            page_pngs = render_pdf_pages(pdf_path, tmp_dir)
            page_heights = {p: get_image_dimensions(p)[1] for p in page_pngs}

            needs_bands = any(not meta_by_num[n].get("customBox") for n in selected_numbers)
            if needs_bands:
                bands, _diag, _warnings = detect_all_bands_with_diagnostics(
                    page_pngs, strict=False
                )
                bands_by_num = {num: (page_png, y0, y1) for num, page_png, y0, y1 in bands}
            else:
                bands_by_num = {}

            for q_num in selected_numbers:
                q_meta = dict(meta_by_num[q_num])
                img_name = f"q{q_num:02d}.png"
                dest_png = images_dir / img_name
                w, h = _crop_single_question(
                    q_num=q_num,
                    q_meta=q_meta,
                    page_pngs=page_pngs,
                    page_heights=page_heights,
                    bands_by_num=bands_by_num,
                    dest_png=dest_png,
                )
                q_class, sec_class = validated_classes[q_num]
                q_record = {
                    "number": int(q_meta["number"]),
                    "points": int(q_meta["points"]),
                    "title": q_meta["title"],
                    "promptSummary": q_meta["promptSummary"],
                    "correctOption": str(q_meta["correctOption"]).strip().upper(),
                    "questionClass": q_class,
                    **({"secondaryClass": sec_class} if sec_class else {}),
                    "imageUrl": f"packs/{week_id}/images/{img_name}",
                    "imageWidth": w,
                    "imageHeight": h,
                    "teachingGuide": q_meta["teachingGuide"],
                }
                compiled_questions.append(q_record)

    validate_answer_key(compiled_questions, answer_key_path)

    max_score = sum(q["points"] for q in compiled_questions)
    pack_data = {
        "weekId": week_id,
        "title": metadata["title"],
        "subtitle": metadata.get("subtitle", ""),
        "competitionYear": metadata.get("competitionYear"),
        "gradeBand": metadata.get("gradeBand", ""),
        "part": part if part is not None else metadata.get("part"),
        "maxScore": max_score,
        "scoringRule": "positive-only",
        "questionCount": len(compiled_questions),
        "compiledAt": datetime.now(timezone.utc).isoformat(),
        "questions": compiled_questions,
    }

    (target_dir / "pack.json").write_text(
        json.dumps(pack_data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (target_dir / "preview.html").write_text(
        build_preview_html(pack_data), encoding="utf-8"
    )

    if update_index:
        resolved_index = index_file or (target_dir.parent / "index.json")
        update_packs_index(resolved_index, pack_data, set_default=set_default)

    return pack_data


def _default_draft_week_id(pdf_path: Path) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", pdf_path.stem.lower()).strip("-")
    return slug or "draft"


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    args = parse_args(argv)
    required_tools = ("identify",) if args.metadata_only else ("pdftoppm", "convert", "identify")
    for tool in required_tools:
        if not shutil.which(tool):
            print(f"Error: required tool '{tool}' not found in PATH.", file=sys.stderr)
            return 1

    pdf_path = Path(args.pdf) if args.pdf else None
    metadata_path = Path(args.metadata) if args.metadata else None

    if args.crop_only:
        assert pdf_path is not None
        metadata = (
            json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata_path is not None
            else {}
        )
        week_id = (
            args.week_id
            or metadata.get("weekId")
            or _default_draft_week_id(pdf_path)
        )
        if args.draft_dir:
            draft_dir = Path(args.draft_dir)
        elif args.out_dir:
            draft_dir = Path(args.out_dir) / "draft"
        else:
            draft_dir = Path(tempfile.gettempdir()) / f"mk_draft_{week_id}"

        q_override = None
        if args.questions:
            q_override = [
                int(item.strip())
                for item in args.questions.split(",")
                if item.strip()
            ]
        manifest = run_crop_only(
            pdf_path=pdf_path,
            draft_dir=draft_dir,
            part=args.part,
            questions_override=q_override,
            metadata_path=metadata_path,
            week_id=week_id,
        )
        print(
            f"Draft crops for '{manifest['weekId']}' ({len(manifest['crops'])} cropped, "
            f"{manifest['bandCount']} bands across {len(manifest['pages'])} pages) -> {draft_dir}"
        )
        for warning in manifest["warnings"]:
            print(f"WARNING: {warning}", file=sys.stderr)
        return 0

    assert metadata_path is not None
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    selected_numbers = resolve_question_numbers(args, metadata)
    week_id = args.week_id or metadata["weekId"]
    out_dir = Path(args.out_dir) if args.out_dir else (Path("webapp") / "packs" / week_id)
    index_file = Path(args.index_file) if args.index_file else None
    answer_key_path = Path(args.answer_key) if args.answer_key else None

    pack_data = compile_pack(
        pdf_path=pdf_path,
        metadata_path=metadata_path,
        part=args.part,
        questions_override=selected_numbers,
        week_id_override=week_id,
        out_dir=out_dir,
        index_file=index_file,
        update_index=not args.no_index,
        set_default=args.set_default,
        answer_key_path=answer_key_path,
        metadata_only=args.metadata_only,
    )
    print(
        f"Compiled pack '{pack_data['weekId']}' ({pack_data['questionCount']} questions, "
        f"maxScore={pack_data['maxScore']}) -> {out_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
