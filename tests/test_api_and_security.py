import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import serve  # noqa: E402


class TestApiAndSecurity(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory(prefix="mk_api_test_")
        self.state_file = Path(self.tmp_dir.name) / "state.json"
        self.server = serve.create_server(
            host="127.0.0.1",
            port=0,
            state_file=self.state_file,
            webapp_dir=REPO_ROOT / "webapp",
            quiet=True,
        )
        self.port = self.server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.tmp_dir.cleanup()

    def _post_api(self, payload: dict) -> dict:
        req = urllib.request.Request(
            f"{self.base_url}/api",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "text/plain;charset=utf-8"},
            method="POST",
        )
        with self.opener.open(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            return json.loads(resp.read().decode("utf-8"))

    def test_static_files_and_health(self) -> None:
        with self.opener.open(f"{self.base_url}/index.html", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("Math Kangaroo Circle", resp.read().decode("utf-8"))
        with self.opener.open(f"{self.base_url}/api", timeout=5) as resp:
            health = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(health["ok"])
            self.assertEqual(health["studentCount"], 9)

    def test_public_roster_never_leaks_pins(self) -> None:
        res = self._post_api({"action": "getPublicRoster", "weekId": "2022-g34-part1"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["activeWeekId"], "2022-g34-part1")
        students = res["students"]
        self.assertEqual(len(students), 9)
        raw_text = json.dumps(res)
        self.assertNotIn("2418", raw_text)
        self.assertNotIn("885174", raw_text)
        self.assertNotIn("teacher_pin", raw_text)
        self.assertNotIn("teacherPin", raw_text)
        for st in students:
            self.assertNotIn("pin", st)
            self.assertNotIn("answers", st)
            self.assertIn("studentId", st)
            self.assertIn("name", st)
            self.assertIn("avatar", st)
            self.assertIn("hasSubmitted", st)

    def test_pin_verification_and_leading_zeros(self) -> None:
        bad = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": "0000", "weekId": "2022-g34-part1"}
        )
        self.assertTrue(bad["ok"])
        self.assertFalse(bad["valid"])

        good = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": "2418", "weekId": "2022-g34-part1"}
        )
        self.assertTrue(good["ok"])
        self.assertTrue(good["valid"])
        self.assertEqual(good["student"]["name"], "Ada Guzhu")

        # Update Ada's PIN to a leading-zero PIN "0412" via Teacher Zone endpoint.
        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        updated_students = report["students"]
        updated_students[0]["pin"] = "0412"
        save_res = self._post_api(
            {"action": "saveStudentRoster", "teacherPin": "885174", "students": updated_students}
        )
        self.assertTrue(save_res["ok"])
        self.assertEqual(save_res["students"][0]["pin"], "0412")

        # Verify leading-zero PIN is preserved as "0412" and "412" / 412 are rejected.
        report_after = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        self.assertEqual(report_after["students"][0]["pin"], "0412")

        ok_0412 = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": "0412"}
        )
        self.assertTrue(ok_0412["valid"])

        bad_412_str = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": "412"}
        )
        self.assertFalse(bad_412_str["valid"])

        bad_412_int = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": 412}
        )
        self.assertFalse(bad_412_int["valid"])

    def test_submit_rejects_invalid_pin_and_upserts_idempotently(self) -> None:
        rejected = self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part1",
                "studentId": "ada-guzhu",
                "pin": "9999",
                "answers": {"1": "A"},
                "scoreSummary": {"totalScore": 3},
            }
        )
        self.assertFalse(rejected["ok"])

        first = self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part1",
                "studentId": "ada-guzhu",
                "pin": "2418",
                "answers": {"1": "A", "2": "D"},
                "scoreSummary": {"totalScore": 3, "score3pt": 3},
            }
        )
        self.assertTrue(first["ok"])

        # Resubmit revised answers for the same student and week.
        second = self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part1",
                "studentId": "ada-guzhu",
                "pin": "2418",
                "answers": {"1": "A", "2": "B"},
                "scoreSummary": {"totalScore": 6, "score3pt": 6},
            }
        )
        self.assertTrue(second["ok"])

        verified = self._post_api(
            {"action": "verifyStudentPin", "studentId": "ada-guzhu", "pin": "2418", "weekId": "2022-g34-part1"}
        )
        self.assertEqual(verified["existingAnswers"], {"1": "A", "2": "B"})

        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "weekId": "2022-g34-part1"})
        ada_subs = [s for s in report["submissions"] if s["studentId"] == "ada-guzhu"]
        self.assertEqual(len(ada_subs), 1)
        self.assertEqual(ada_subs[0]["totalScore"], 6)

    def test_concurrent_submissions_all_persist(self) -> None:
        expected = [
            ("ada-guzhu", "2418"),
            ("andrew-ahmadi", "5931"),
            ("berrit-martz", "7264"),
            ("camile-gauthier", "3847"),
            ("elliot-an", "6159"),
            ("elliot-huang", "8492"),
            ("hanna-bieniasz-krzywiec", "4726"),
            ("keshav-junnarkar", "9315"),
            ("ting-zhao", "1683"),
        ]

        def submit_one(item: tuple[str, str]) -> dict:
            sid, pin = item
            return self._post_api(
                {
                    "action": "submitAnswers",
                    "weekId": "2022-g34-part1",
                    "studentId": sid,
                    "pin": pin,
                    "answers": {"1": "A"},
                    "scoreSummary": {"totalScore": 3, "score3pt": 3},
                }
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
            results = list(pool.map(submit_one, expected))

        self.assertTrue(all(r["ok"] for r in results))
        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "weekId": "2022-g34-part1"})
        self.assertTrue(report["ok"])
        submitted_ids = {s["studentId"] for s in report["submissions"]}
        self.assertEqual(submitted_ids, {sid for sid, _ in expected})
        self.assertEqual(len(report["submissions"]), 9)

    def test_teacher_auth_and_participants_sync(self) -> None:
        denied = self._post_api({"action": "getTeacherReport", "teacherPin": "123456"})
        self.assertFalse(denied["ok"])

        ok_report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        self.assertTrue(ok_report["ok"])
        self.assertEqual(len(ok_report["students"]), 9)

        # Simulate adding a new name in Participants!A1:A; existing students stay untouched.
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        state["participants"].append("Maya Lin")
        self.state_file.write_text(json.dumps(state), encoding="utf-8")

        roster = self._post_api({"action": "getPublicRoster"})
        names = [s["name"] for s in roster["students"]]
        self.assertIn("Maya Lin", names)
        self.assertEqual(len(names), 10)
        synced_state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(synced_state["participants"][-1], "Maya Lin")
        maya = next(s for s in synced_state["students"] if s["name"] == "Maya Lin")
        self.assertEqual(maya["studentId"], "maya-lin")
        self.assertRegex(maya["pin"], r"^\d{4}$")

        # setActiveWeek rejects invalid teacher PIN and persists when valid.
        bad_week = self._post_api(
            {"action": "setActiveWeek", "teacherPin": "000000", "weekId": "2022-g34-part2"}
        )
        self.assertFalse(bad_week["ok"])

        good_week = self._post_api(
            {"action": "setActiveWeek", "teacherPin": "885174", "weekId": "2022-g34-part2"}
        )
        self.assertTrue(good_week["ok"])
        self.assertEqual(good_week["activeWeekId"], "2022-g34-part2")

        roster_after = self._post_api({"action": "getPublicRoster"})
        self.assertEqual(roster_after["activeWeekId"], "2022-g34-part2")


if __name__ == "__main__":
    unittest.main()
