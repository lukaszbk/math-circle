import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "pack-compiler"))

import compile_pack  # noqa: E402


class TestPackCompiler(unittest.TestCase):
    PDF_PATH = REPO_ROOT / "pack-compiler" / "input" / "2022-g34.pdf"
    PACK_DIR = REPO_ROOT / "webapp" / "packs" / "2022-g34-part1"
    INDEX_PATH = REPO_ROOT / "webapp" / "packs" / "index.json"

    def test_detect_24_bands_in_source_pdf(self) -> None:
        self.assertTrue(self.PDF_PATH.is_file(), f"Missing PDF: {self.PDF_PATH}")
        with tempfile.TemporaryDirectory(prefix="mk_test_pdf_") as tmp:
            pages = compile_pack.render_pdf_pages(self.PDF_PATH, Path(tmp))
            self.assertEqual(len(pages), 4)
            bands = compile_pack.detect_all_bands(pages)
            self.assertEqual(len(bands), 24)
            self.assertEqual([b[0] for b in bands], list(range(1, 25)))
            for q_num, _page, y0, y1 in bands:
                self.assertLess(y0, y1, f"Invalid band bounds for Q{q_num}")

    def test_compiled_pack_manifest_and_images(self) -> None:
        pack_json_path = self.PACK_DIR / "pack.json"
        self.assertTrue(pack_json_path.is_file(), "Compiled pack.json missing")
        pack = json.loads(pack_json_path.read_text(encoding="utf-8"))

        self.assertEqual(pack["weekId"], "2022-g34-part1")
        self.assertEqual(pack["maxScore"], 48)
        self.assertEqual(pack["scoringRule"], "positive-only")
        self.assertEqual(pack["questionCount"], 12)

        expected_numbers = [1, 2, 3, 4, 9, 10, 11, 12, 17, 18, 19, 20]
        actual_numbers = [q["number"] for q in pack["questions"]]
        self.assertEqual(actual_numbers, expected_numbers)

        for q in pack["questions"]:
            num = q["number"]
            self.assertIn(q["points"], (3, 4, 5))
            self.assertIn(q["correctOption"], ("A", "B", "C", "D", "E"))
            self.assertTrue(q["title"].strip())
            self.assertTrue(q["promptSummary"].strip())

            expected_img_url = f"packs/2022-g34-part1/images/q{num:02d}.png"
            self.assertEqual(q["imageUrl"], expected_img_url)
            img_path = REPO_ROOT / "webapp" / expected_img_url
            self.assertTrue(img_path.is_file(), f"Missing image {img_path}")

            dims = subprocess.check_output(
                ["identify", "-format", "%w %h", str(img_path)],
                text=True,
            ).strip()
            w_str, h_str = dims.split()
            width, height = int(w_str), int(h_str)
            self.assertGreater(width, 0)
            self.assertGreater(height, 0)
            self.assertEqual(width, 2310)
            self.assertEqual(q["imageWidth"], width)
            self.assertEqual(q["imageHeight"], height)

            guide = q["teachingGuide"]
            self.assertIsInstance(guide, dict)
            self.assertTrue(guide.get("headline", "").strip())
            self.assertIsInstance(guide.get("steps"), list)
            self.assertGreaterEqual(len(guide["steps"]), 3)
            self.assertIsInstance(guide.get("askTheKids"), list)
            self.assertGreaterEqual(len(guide["askTheKids"]), 1)
            self.assertTrue(guide.get("commonTraps", "").strip())

    def test_preview_and_index_files_exist(self) -> None:
        preview = self.PACK_DIR / "preview.html"
        self.assertTrue(preview.is_file())
        html_text = preview.read_text(encoding="utf-8")
        self.assertIn("q01.png", html_text)
        self.assertIn("q20.png", html_text)

        self.assertTrue(self.INDEX_PATH.is_file())
        index_data = json.loads(self.INDEX_PATH.read_text(encoding="utf-8"))
        self.assertEqual(index_data.get("defaultWeekId"), "2022-g34-part1")
        week_ids = [p["weekId"] for p in index_data.get("packs", [])]
        self.assertIn("2022-g34-part1", week_ids)

    @staticmethod
    def _write_synthetic_unruled_pdf(pdf_path: Path) -> None:
        """Write a valid single-page PDF containing a small dark box (0 divider rules)."""
        stream = b"0 0 0 rg\n120 600 180 90 re f\n"
        objs = [
            b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
            f"4 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode("ascii")
            + stream
            + b"endstream\nendobj\n",
        ]
        header = b"%PDF-1.4\n"
        offsets = []
        body = bytearray()
        for obj in objs:
            offsets.append(len(header) + len(body))
            body.extend(obj)
        xref_start = len(header) + len(body)
        xref_lines = [f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii")]
        for off in offsets:
            xref_lines.append(f"{off:010d} 00000 n \n".encode("ascii"))
        trailer = (
            f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_start}\n%%EOF\n"
        ).encode("ascii")
        pdf_path.write_bytes(header + bytes(body) + b"".join(xref_lines) + trailer)

    def test_crop_only_generates_ruled_pages_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mk_crop_only_") as tmp:
            draft_dir = Path(tmp) / "draft"
            rc = compile_pack.main(
                [
                    "--pdf",
                    str(self.PDF_PATH),
                    "--part",
                    "1",
                    "--week-id",
                    "2022-g34-part1",
                    "--crop-only",
                    "--draft-dir",
                    str(draft_dir),
                ]
            )
            self.assertEqual(rc, 0)
            self.assertTrue((draft_dir / "pages" / "page-1.png").is_file())
            self.assertTrue((draft_dir / "pages" / "page-1-ruled.png").is_file())
            self.assertTrue((draft_dir / "crops" / "q01.png").is_file())
            manifest_path = draft_dir / "draft_manifest.json"
            self.assertTrue(manifest_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["bandCount"], 24)
            self.assertEqual(len(manifest["crops"]), 12)
            self.assertEqual(len(manifest["pages"]), 4)

    def test_custom_box_and_mask_rects_on_unruled_pdf(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mk_unruled_") as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "unruled.pdf"
            self._write_synthetic_unruled_pdf(pdf_path)

            # Verify --crop-only handles 0 detected dividers without failing.
            draft_dir = tmp_dir / "draft"
            rc = compile_pack.main(
                [
                    "--pdf",
                    str(pdf_path),
                    "--week-id",
                    "unruled-test",
                    "--crop-only",
                    "--draft-dir",
                    str(draft_dir),
                ]
            )
            self.assertEqual(rc, 0)
            manifest = json.loads((draft_dir / "draft_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["bandCount"], 0)
            self.assertTrue(manifest["warnings"])
            self.assertTrue((draft_dir / "pages" / "page-1-ruled.png").is_file())

            # Verify final compile_pack succeeds using customBox + maskRects.
            # Note: synthetic PDF box is at PDF coords x=[120..300], y=[600..690] (height 792)
            # -> 300 DPI image coords x=[500..1250], y=[425..800].
            meta_path = tmp_dir / "unruled.meta.json"
            meta = {
                "weekId": "unruled-test",
                "title": "Unruled Synthetic Test",
                "subtitle": "Custom box test",
                "competitionYear": 2026,
                "gradeBand": "Grades 3 and 4",
                "part": 1,
                "questions": [
                    {
                        "number": 1,
                        "points": 3,
                        "title": "Custom Box Question",
                        "promptSummary": "Synthetic unruled box test",
                        "correctOption": "A",
                        "customBox": {
                            "page": 1,
                            "x": 400,
                            "y": 350,
                            "width": 900,
                            "height": 500,
                        },
                        "cropAdjust": {
                            "maskRects": [[80, 50, 880, 480]]
                        },
                        "teachingGuide": {
                            "headline": "Use customBox when horizontal rules are absent.",
                            "steps": ["Read coordinates from page-1-ruled.png."],
                            "askTheKids": ["What does the mask cover?"],
                            "commonTraps": "None.",
                        },
                    }
                ],
            }
            meta_path.write_text(json.dumps(meta), encoding="utf-8")

            out_dir = tmp_dir / "out"
            pack_data = compile_pack.compile_pack(
                pdf_path=pdf_path,
                metadata_path=meta_path,
                questions_override=[1],
                out_dir=out_dir,
                update_index=False,
            )
            self.assertEqual(pack_data["questionCount"], 1)
            crop_png = out_dir / "images" / "q01.png"
            self.assertTrue(crop_png.is_file())
            self.assertEqual(compile_pack.get_image_dimensions(crop_png), (900, 500))

            # Mask covered the entire black rectangle; sample center pixel should be white (255).
            center_pgm = subprocess.check_output(
                [
                    "convert",
                    str(crop_png),
                    "-crop",
                    "1x1+300+200",
                    "+repage",
                    "-colorspace",
                    "Gray",
                    "-depth",
                    "8",
                    "pgm:-",
                ]
            )
            pixel_val = center_pgm.split(b"\n", 3)[3][0]
            self.assertGreaterEqual(pixel_val, 250)


if __name__ == "__main__":
    unittest.main()
