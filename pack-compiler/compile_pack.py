#!/usr/bin/env python3
"""Compile a Math Kangaroo competition PDF into a Question Pack for the webapp.

Uses pdftoppm (Poppler) and convert/identify (ImageMagick) with Python 3 stdlib
only. Detects horizontal divider rules across the question column, crops each
selected problem card (applying optional per-question diagram padding or banner
masking), writes pack.json, updates packs/index.json, and generates preview.html.
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
RULE_PROBE_CROP = "1385x3300+165+0"
RULE_DARK_THRESHOLD = 45
RULE_GAP_MERGE_PX = 20
RULE_MAX_THICKNESS_PX = 10
BANNER_MASK_RECT = (0, 0, 575, 140)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for the Question Pack compiler."""
    parser = argparse.ArgumentParser(
        description="Compile a Math Kangaroo PDF into a Question Pack."
    )
    parser.add_argument("--pdf", required=True, help="Path to source PDF file.")
    parser.add_argument(
        "--metadata", required=True, help="Path to question metadata JSON."
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
        help="Override weekId from metadata JSON.",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output pack directory (defaults to webapp/packs/<weekId>).",
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
    return parser.parse_args(argv)


def resolve_question_numbers(
    args: argparse.Namespace, metadata: dict
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

    part = args.part if args.part is not None else metadata.get("part")
    if part in PART_QUESTIONS:
        return list(PART_QUESTIONS[part])

    meta_numbers = [int(q["number"]) for q in metadata.get("questions", [])]
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


def _parse_pgm_p5(raw: bytes) -> list[int]:
    """Parse a binary P5 PGM byte stream and return pixel intensities."""
    lines = raw.split(b"\n", 3)
    if len(lines) < 4 or not lines[0].startswith(b"P5"):
        raise ValueError("Expected binary P5 PGM output from ImageMagick convert.")
    return list(lines[3])


def detect_page_dividers(page_png: Path) -> list[int]:
    """Detect y-coordinates of horizontal question divider rules on a page."""
    raw = subprocess.check_output(
        [
            "convert",
            str(page_png),
            "-crop",
            RULE_PROBE_CROP,
            "+repage",
            "-colorspace",
            "Gray",
            "-threshold",
            "60%",
            "-scale",
            "1x3300!",
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


def detect_all_bands(
    page_pngs: list[Path],
) -> list[tuple[int, Path, int, int]]:
    """Return ordered list of (question_number, page_png, y0, y1) bands."""
    bands: list[tuple[int, Path, int, int]] = []
    q_num = 1
    for page_idx, page_png in enumerate(page_pngs):
        divs = detect_page_dividers(page_png)
        start_idx = 1 if page_idx == 0 else 0
        if len(divs) - start_idx < 2:
            raise RuntimeError(
                f"Too few divider rules ({divs}) detected on page {page_idx + 1}: {page_png}"
            )
        for idx in range(start_idx, len(divs) - 1):
            bands.append((q_num, page_png, divs[idx], divs[idx + 1]))
            q_num += 1
    return bands


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
    trim_banner = bool(adjust.get("trimSectionBanner", False))

    base_top = y0 + VERTICAL_MARGIN
    base_bot = y1 - VERTICAL_MARGIN
    crop_top = max(0, base_top - pad_top)
    crop_bot = min(page_height, base_bot + pad_bottom)
    crop_height = crop_bot - crop_top
    if crop_height <= 0:
        raise ValueError(
            f"Invalid crop height ({crop_height}) for y0={y0}, y1={y1}."
        )

    split_rel_x = max(0, split_x - CROP_X)
    draw_ops: list[str] = []
    if pad_top > 0 and split_rel_x > 0:
        draw_ops.append(f"rectangle 0,0 {split_rel_x},{pad_top}")
    if pad_bottom > 0 and split_rel_x > 0:
        mask_y0 = max(0, crop_height - pad_bottom)
        draw_ops.append(f"rectangle 0,{mask_y0} {split_rel_x},{crop_height}")
    if trim_banner:
        bx0, by0, bx1, by1 = BANNER_MASK_RECT
        draw_ops.append(f"rectangle {bx0},{by0} {bx1},{by1}")

    dest_png.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "convert",
        str(page_png),
        "-crop",
        f"{CROP_WIDTH}x{crop_height}+{CROP_X}+{crop_top}",
        "+repage",
    ]
    if draw_ops:
        cmd.extend(["-fill", "white"])
        for rect in draw_ops:
            cmd.extend(["-draw", rect])
    cmd.extend(["-strip", str(dest_png)])

    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return get_image_dimensions(dest_png)


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
        cards.append(
            f"""
            <article class="card">
              <header class="card-head">
                <div class="badges">
                  <span class="badge qnum">Question #{q['number']}</span>
                  <span class="badge pts">{q['points']} pts</span>
                  <span class="badge ans">Answer: ({html.escape(q['correctOption'])})</span>
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


def compile_pack(
    pdf_path: Path,
    metadata_path: Path,
    part: int | None = None,
    questions_override: list[int] | None = None,
    week_id_override: str | None = None,
    out_dir: Path | None = None,
    index_file: Path | None = None,
    update_index: bool = True,
    set_default: bool = False,
    answer_key_path: Path | None = None,
) -> dict:
    """Run the full PDF-to-Question-Pack compilation pipeline."""
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

    target_dir = out_dir or (Path("webapp") / "packs" / week_id)
    images_dir = target_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mk_pack_") as tmp:
        tmp_dir = Path(tmp)
        page_pngs = render_pdf_pages(pdf_path, tmp_dir)
        bands = detect_all_bands(page_pngs)
        bands_by_num = {num: (page_png, y0, y1) for num, page_png, y0, y1 in bands}
        page_heights = {p: get_image_dimensions(p)[1] for p in page_pngs}

        compiled_questions: list[dict] = []
        for q_num in selected_numbers:
            if q_num not in bands_by_num:
                raise IndexError(
                    f"Question #{q_num} not found in detected bands (1..{len(bands)})."
                )
            page_png, y0, y1 = bands_by_num[q_num]
            q_meta = dict(meta_by_num[q_num])
            img_name = f"q{q_num:02d}.png"
            dest_png = images_dir / img_name
            w, h = crop_question_image(
                page_png=page_png,
                y0=y0,
                y1=y1,
                crop_adjust=q_meta.get("cropAdjust"),
                dest_png=dest_png,
                page_height=page_heights[page_png],
            )
            q_record = {
                "number": int(q_meta["number"]),
                "points": int(q_meta["points"]),
                "title": q_meta["title"],
                "promptSummary": q_meta["promptSummary"],
                "correctOption": str(q_meta["correctOption"]).strip().upper(),
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


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    for tool in ("pdftoppm", "convert", "identify"):
        if not shutil.which(tool):
            print(f"Error: required tool '{tool}' not found in PATH.", file=sys.stderr)
            return 1

    args = parse_args(argv)
    metadata_path = Path(args.metadata)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    selected_numbers = resolve_question_numbers(args, metadata)
    week_id = args.week_id or metadata["weekId"]
    out_dir = Path(args.out_dir) if args.out_dir else (Path("webapp") / "packs" / week_id)
    index_file = Path(args.index_file) if args.index_file else None
    answer_key_path = Path(args.answer_key) if args.answer_key else None

    pack_data = compile_pack(
        pdf_path=Path(args.pdf),
        metadata_path=metadata_path,
        part=args.part,
        questions_override=selected_numbers,
        week_id_override=week_id,
        out_dir=out_dir,
        index_file=index_file,
        update_index=not args.no_index,
        set_default=args.set_default,
        answer_key_path=answer_key_path,
    )
    print(
        f"Compiled pack '{pack_data['weekId']}' ({pack_data['questionCount']} questions, "
        f"maxScore={pack_data['maxScore']}) -> {out_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
