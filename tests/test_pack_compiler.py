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


if __name__ == "__main__":
    unittest.main()
