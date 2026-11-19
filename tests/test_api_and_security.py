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
            self.assertEqual(health["studentCount"], 6)

    def test_public_roster_never_leaks_pins(self) -> None:
        res = self._post_api({"action": "getPublicRoster", "weekId": "2022-g34-part1"})
        self.assertTrue(res["ok"])
        self.assertEqual(res["activeWeekId"], "2022-g34-part1")
        students = res["students"]
        self.assertEqual(len(students), 6)
        student_ids = {s["studentId"] for s in students}
        self.assertIn("lucja-nowak", student_ids)
        self.assertIn("sam-patel", student_ids)
        raw_text = json.dumps(res)
        for seed in serve.SEED_STUDENTS:
            self.assertNotIn(seed["pin"], raw_text)
            self.assertNotIn(seed["parentPin"], raw_text)
        self.assertNotIn("885174", raw_text)
        self.assertNotIn("teacher_pin", raw_text)
        self.assertNotIn("teacherPin", raw_text)
        self.assertNotIn("parentPin", raw_text)
        self.assertNotIn("parent_pin", raw_text)
        for st in students:
            self.assertNotIn("pin", st)
            self.assertNotIn("parentPin", st)
            self.assertNotIn("answers", st)
            self.assertIn("studentId", st)
            self.assertIn("name", st)
            self.assertIn("avatar", st)
            self.assertIn("hasSubmitted", st)

    def test_pin_verification_and_leading_zeros(self) -> None:
        bad = self._post_api(
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": "0000", "weekId": "2022-g34-part1"}
        )
        self.assertTrue(bad["ok"])
        self.assertFalse(bad["valid"])

        good = self._post_api(
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": "1357", "weekId": "2022-g34-part1"}
        )
        self.assertTrue(good["ok"])
        self.assertTrue(good["valid"])
        self.assertEqual(good["student"]["name"], "Alice Nguyen")

        # Update Alice's PIN to a leading-zero PIN "0412" via Teacher Zone endpoint.
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
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": "0412"}
        )
        self.assertTrue(ok_0412["valid"])

        bad_412_str = self._post_api(
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": "412"}
        )
        self.assertFalse(bad_412_str["valid"])

        bad_412_int = self._post_api(
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": 412}
        )
        self.assertFalse(bad_412_int["valid"])

    def test_submit_rejects_invalid_pin_and_upserts_idempotently(self) -> None:
        rejected = self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part1",
                "studentId": "alice-nguyen",
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
                "studentId": "alice-nguyen",
                "pin": "1357",
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
                "studentId": "alice-nguyen",
                "pin": "1357",
                "answers": {"1": "A", "2": "B"},
                "scoreSummary": {"totalScore": 6, "score3pt": 6},
            }
        )
        self.assertTrue(second["ok"])

        verified = self._post_api(
            {"action": "verifyStudentPin", "studentId": "alice-nguyen", "pin": "1357", "weekId": "2022-g34-part1"}
        )
        self.assertEqual(verified["existingAnswers"], {"1": "A", "2": "B"})

        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "weekId": "2022-g34-part1"})
        alice_subs = [s for s in report["submissions"] if s["studentId"] == "alice-nguyen"]
        self.assertEqual(len(alice_subs), 1)
        self.assertEqual(alice_subs[0]["totalScore"], 6)

    def test_concurrent_submissions_all_persist(self) -> None:
        expected = [
            ("alice-nguyen", "1357"),
            ("ben-carter", "2468"),
            ("claire-davis", "3691"),
            ("diego-morales", "4820"),
            ("lucja-nowak", "5739"),
            ("sam-patel", "7531"),
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

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(submit_one, expected))

        self.assertTrue(all(r["ok"] for r in results))
        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "weekId": "2022-g34-part1"})
        self.assertTrue(report["ok"])
        submitted_ids = {s["studentId"] for s in report["submissions"]}
        self.assertEqual(submitted_ids, {sid for sid, _ in expected})
        self.assertEqual(len(report["submissions"]), 6)

    def test_teacher_auth_and_participants_sync(self) -> None:
        denied = self._post_api({"action": "getTeacherReport", "teacherPin": "123456"})
        self.assertFalse(denied["ok"])

        ok_report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        self.assertTrue(ok_report["ok"])
        self.assertEqual(len(ok_report["students"]), 6)

        # Simulate adding a new name in Participants!A1:A; existing students stay untouched.
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        state["participants"].append("Maya Lin")
        self.state_file.write_text(json.dumps(state), encoding="utf-8")

        roster = self._post_api({"action": "getPublicRoster"})
        names = [s["name"] for s in roster["students"]]
        self.assertIn("Maya Lin", names)
        self.assertEqual(len(names), 7)
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

    def test_legacy_state_file_merges_new_seed_students_preserving_submissions(self) -> None:
        # Simulate an older /tmp/math_circle_state.json created when only 4 students existed.
        legacy_students = [dict(s) for s in serve.SEED_STUDENTS[:4]]
        legacy_state = {
            "teacherPin": "885174",
            "activeWeekId": "2022-g34-part1",
            "participants": [s["name"] for s in legacy_students],
            "students": legacy_students,
            "submissions": [
                {
                    "updatedAt": "2026-11-18T21:00:00Z",
                    "weekId": "2022-g34-part1",
                    "studentId": "diego-morales",
                    "studentName": "Diego Morales",
                    "totalScore": 48,
                    "maxScore": 48,
                    "answers": {"1": "A"},
                }
            ],
        }
        self.state_file.write_text(json.dumps(legacy_state), encoding="utf-8")

        roster = self._post_api({"action": "getPublicRoster", "weekId": "2022-g34-part1"})
        self.assertTrue(roster["ok"])
        self.assertEqual(len(roster["students"]), 6)
        by_id = {s["studentId"]: s for s in roster["students"]}
        self.assertIn("lucja-nowak", by_id)
        self.assertIn("sam-patel", by_id)
        self.assertTrue(by_id["diego-morales"]["hasSubmitted"])

        # Verify Łucja Nowak's exact seeded PIN (5739) works immediately.
        verify_lucja = self._post_api(
            {"action": "verifyStudentPin", "studentId": "lucja-nowak", "pin": "5739"}
        )
        self.assertTrue(verify_lucja["valid"])

        # Legacy state without parentPin/releasedWeekIds auto-upgrades cleanly.
        lucja_report = self._post_api({"action": "getParentReport", "parentPin": "084627"})
        self.assertTrue(lucja_report["ok"])
        self.assertTrue(lucja_report["valid"])
        self.assertEqual(lucja_report["student"]["studentId"], "lucja-nowak")

    def test_save_roster_parent_pin_validation_and_leading_zeros(self) -> None:
        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        students = report["students"]
        for st in students:
            self.assertRegex(st["parentPin"], r"^\d{6}$")

        # Leading-zero Parent PIN preserved; short string/int rejected on verify.
        students[0]["parentPin"] = "041289"
        saved = self._post_api({"action": "saveStudentRoster", "teacherPin": "885174", "students": students})
        self.assertTrue(saved["ok"])
        self.assertEqual(saved["students"][0]["parentPin"], "041289")

        bad_short = self._post_api({"action": "getParentReport", "parentPin": "41289"})
        self.assertTrue(bad_short["ok"])
        self.assertFalse(bad_short["valid"])
        bad_int = self._post_api({"action": "getParentReport", "parentPin": 41289})
        self.assertTrue(bad_int["ok"])
        self.assertFalse(bad_int["valid"])
        good_zero = self._post_api({"action": "getParentReport", "parentPin": "041289"})
        self.assertTrue(good_zero["ok"])
        self.assertTrue(good_zero["valid"])
        self.assertEqual(good_zero["student"]["studentId"], students[0]["studentId"])

        # Reject collision with another student's parentPin.
        dup_students = [dict(s) for s in saved["students"]]
        dup_students[1]["parentPin"] = "041289"
        dup_res = self._post_api({"action": "saveStudentRoster", "teacherPin": "885174", "students": dup_students})
        self.assertFalse(dup_res["ok"])
        self.assertIn("Duplicate Parent PIN", dup_res["error"])

        # Reject matching teacherPin.
        teacher_match = [dict(s) for s in saved["students"]]
        teacher_match[1]["parentPin"] = "885174"
        t_res = self._post_api({"action": "saveStudentRoster", "teacherPin": "885174", "students": teacher_match})
        self.assertFalse(t_res["ok"])
        self.assertIn("Teacher PIN", t_res["error"])

        # Auto-generate unique valid 6-digit parentPin when omitted on new row.
        added = [dict(s) for s in saved["students"]]
        added.append({"name": "New Kid", "pin": "1122", "avatar": "🐝", "active": True})
        added_res = self._post_api({"action": "saveStudentRoster", "teacherPin": "885174", "students": added})
        self.assertTrue(added_res["ok"])
        new_kid = added_res["students"][-1]
        self.assertRegex(new_kid["parentPin"], r"^\d{6}$")
        self.assertNotEqual(new_kid["parentPin"], "885174")
        all_ppins = [s["parentPin"] for s in added_res["students"]]
        self.assertEqual(len(set(all_ppins)), len(all_ppins))

    def test_release_gating_cohort_privacy_and_orphan_filtering(self) -> None:
        # Submit 3 active students + 1 orphaned deleted student + 1 inactive student on 2022-g34-part1
        report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174"})
        students = report["students"]
        students[5]["active"] = False  # mark sam-patel inactive
        self._post_api({"action": "saveStudentRoster", "teacherPin": "885174", "students": students})

        # Inject an orphaned submission and an inactive student submission directly in state.json
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        state["submissions"].append(
            {
                "updatedAt": "2026-11-19T01:00:00Z",
                "weekId": "2022-g34-part1",
                "studentId": "deleted-former-kid",
                "studentName": "Former Kid",
                "totalScore": 48,
                "maxScore": 48,
                "score3pt": 12,
                "score4pt": 16,
                "score5pt": 20,
                "correctCount": 12,
                "wrongCount": 0,
                "blankCount": 0,
                "answers": {"1": "A"},
            }
        )
        state["submissions"].append(
            {
                "updatedAt": "2026-11-19T01:05:00Z",
                "weekId": "2022-g34-part1",
                "studentId": "sam-patel",
                "studentName": "Sam Patel",
                "totalScore": 48,
                "maxScore": 48,
                "score3pt": 12,
                "score4pt": 16,
                "score5pt": 20,
                "correctCount": 12,
                "wrongCount": 0,
                "blankCount": 0,
                "answers": {"1": "A"},
            }
        )
        self.state_file.write_text(json.dumps(state), encoding="utf-8")

        # Inactive student's Parent PIN must be denied.
        inactive_parent = self._post_api({"action": "getParentReport", "parentPin": "719364"})
        self.assertTrue(inactive_parent["ok"])
        self.assertFalse(inactive_parent["valid"])

        # Submit 3 active students: Alice (30), Ben (40), Claire (20)
        for sid, pin, tot, s3, s4, s5, q1 in [
            ("alice-nguyen", "1357", 30, 6, 12, 12, "A"),
            ("ben-carter", "2468", 40, 12, 16, 12, "B"),
            ("claire-davis", "3691", 20, 6, 4, 10, "B"),
        ]:
            self._post_api(
                {
                    "action": "submitAnswers",
                    "weekId": "2022-g34-part1",
                    "studentId": sid,
                    "pin": pin,
                    "answers": {"1": q1},
                    "scoreSummary": {"totalScore": tot, "maxScore": 48, "score3pt": s3, "score4pt": s4, "score5pt": s5},
                }
            )

        # Before release: Teacher sees 3 active submissions (orphans & inactive excluded!).
        t_report = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "includeAllWeeks": True})
        self.assertEqual(len(t_report["submissions"]), 3)
        self.assertEqual({s["studentId"] for s in t_report["submissions"]}, {"alice-nguyen", "ben-carter", "claire-davis"})
        self.assertEqual(t_report["releasedWeekIds"], [])

        # Before release: Parent sees ONLY unreleasedSubmittedWeekIds, zero scores/answers.
        pre_parent = self._post_api({"action": "getParentReport", "parentPin": "284913"})
        self.assertTrue(pre_parent["valid"])
        self.assertEqual(pre_parent["releasedWeekIds"], [])
        self.assertEqual(pre_parent["submissionsByWeek"], {})
        self.assertEqual(pre_parent["cohortByWeek"], {})
        self.assertEqual(pre_parent["unreleasedSubmittedWeekIds"], ["2022-g34-part1"])
        self.assertNotIn("totalScore", json.dumps(pre_parent))

        # Invalid teacher PIN cannot release.
        bad_rel = self._post_api({"action": "setWeekReleased", "teacherPin": "000000", "weekId": "2022-g34-part1", "released": True})
        self.assertFalse(bad_rel["ok"])

        # Release 2022-g34-part1: cohortCount is 3 (< 4), so benchmarks MUST be suppressed!
        ok_rel = self._post_api({"action": "setWeekReleased", "teacherPin": "885174", "weekId": "2022-g34-part1", "released": True})
        self.assertTrue(ok_rel["ok"])
        self.assertEqual(ok_rel["releasedWeekIds"], ["2022-g34-part1"])

        small_cohort_parent = self._post_api({"action": "getParentReport", "parentPin": "284913"})
        self.assertEqual(small_cohort_parent["unreleasedSubmittedWeekIds"], [])
        self.assertIn("2022-g34-part1", small_cohort_parent["submissionsByWeek"])
        cohort_3 = small_cohort_parent["cohortByWeek"]["2022-g34-part1"]
        self.assertEqual(cohort_3["cohortCount"], 3)
        self.assertFalse(cohort_3["minCohortMet"])
        self.assertIsNone(cohort_3["scoreP25"])
        self.assertIsNone(cohort_3["scoreMedian"])
        self.assertIsNone(cohort_3["scoreP75"])
        self.assertIsNone(cohort_3["avgPct3pt"])
        self.assertIsNone(cohort_3["optionCounts"])

        # 4th active student (Diego = 10, omitting Q1 -> blank) meets MIN_COHORT_SIZE = 4!
        self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part1",
                "studentId": "diego-morales",
                "pin": "4820",
                "answers": {"2": "B"},
                "scoreSummary": {"totalScore": 10, "maxScore": 48, "score3pt": 6, "score4pt": 4, "score5pt": 0},
            }
        )
        # Also submit Diego on a 2nd unreleased week to test includeAllWeeks & multi-week gating.
        self._post_api(
            {
                "action": "submitAnswers",
                "weekId": "2022-g34-part2",
                "studentId": "diego-morales",
                "pin": "4820",
                "answers": {"5": "E"},
                "scoreSummary": {"totalScore": 3, "maxScore": 48, "score3pt": 3, "score4pt": 0, "score5pt": 0},
            }
        )

        # Scores: [10, 20, 30, 40]. P25 idx=0.75 -> 17.5 -> 18; Med idx=1.5 -> 25; P75 idx=2.25 -> 32.5 -> 33.
        diego_parent = self._post_api({"action": "getParentReport", "parentPin": "592741"})
        self.assertEqual(diego_parent["unreleasedSubmittedWeekIds"], ["2022-g34-part2"])
        self.assertNotIn("2022-g34-part2", diego_parent["submissionsByWeek"])
        c4 = diego_parent["cohortByWeek"]["2022-g34-part1"]
        self.assertEqual(c4["cohortCount"], 4)
        self.assertTrue(c4["minCohortMet"])
        self.assertEqual(c4["scoreP25"], 18)
        self.assertEqual(c4["scoreMedian"], 25)
        self.assertEqual(c4["scoreP75"], 33)
        # 3pt avg: (6+12+6+6)/(4*12)*100 = 30/48*100 = 62.5 -> 63
        self.assertEqual(c4["avgPct3pt"], 63)
        self.assertEqual(c4["optionCounts"]["1"], {"A": 1, "B": 2, "C": 0, "D": 0, "E": 0, "blank": 1})
        self.assertEqual(c4["optionCounts"]["2"], {"A": 0, "B": 1, "C": 0, "D": 0, "E": 0, "blank": 3})
        # Zero peer PII in cohortByWeek
        cohort_dump = json.dumps(diego_parent["cohortByWeek"])
        for peer in ("alice-nguyen", "Alice Nguyen", "ben-carter", "Ben Carter", "claire-davis", "Claire Davis"):
            self.assertNotIn(peer, cohort_dump)

        # Teacher multi-week report returns all 5 active submissions across both weeks (no orphan/inactive).
        t_all = self._post_api({"action": "getTeacherReport", "teacherPin": "885174", "includeAllWeeks": True})
        self.assertEqual(len(t_all["submissions"]), 4)
        self.assertEqual(len(t_all["allSubmissions"]), 5)
        self.assertEqual(t_all["releasedWeekIds"], ["2022-g34-part1"])

    def test_parent_pin_rate_limiting(self) -> None:
        now = [1000.0]
        store = serve.SheetStateStore(self.state_file, time_fn=lambda: now[0])
        for _ in range(10):
            res = store.dispatch({"action": "getParentReport", "parentPin": "999999"})
            self.assertTrue(res["ok"])
            self.assertFalse(res["valid"])

        # 11th attempt within 60s triggers rateLimited=True even if PIN is valid!
        locked = store.dispatch({"action": "getParentReport", "parentPin": "284913"})
        self.assertFalse(locked["ok"])
        self.assertTrue(locked.get("rateLimited"))

        # After 61s, window clears and valid PIN works again.
        now[0] += 61.0
        unlocked = store.dispatch({"action": "getParentReport", "parentPin": "284913"})
        self.assertTrue(unlocked["ok"])
        self.assertTrue(unlocked["valid"])
        self.assertEqual(unlocked["student"]["studentId"], "alice-nguyen")

    def test_seed_demo_submissions_populate_multi_week_and_match_pack_scores(self) -> None:
        seeded_state = Path(self.tmp_dir.name) / "seeded_state.json"
        seeded_server = serve.create_server(
            host="127.0.0.1",
            port=0,
            state_file=seeded_state,
            webapp_dir=REPO_ROOT / "webapp",
            quiet=True,
            seed_demo=True,
        )
        seeded_port = seeded_server.server_address[1]
        seeded_url = f"http://127.0.0.1:{seeded_port}/api"
        seeded_thread = threading.Thread(target=seeded_server.serve_forever, daemon=True)
        seeded_thread.start()

        def post_seeded(payload: dict) -> dict:
            req = urllib.request.Request(
                seeded_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "text/plain;charset=utf-8"},
                method="POST",
            )
            with self.opener.open(req, timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                return json.loads(resp.read().decode("utf-8"))

        try:
            teacher = post_seeded(
                {"action": "getTeacherReport", "teacherPin": "885174", "includeAllWeeks": True}
            )
            self.assertTrue(teacher["ok"])
            self.assertEqual(teacher["activeWeekId"], "2022-g34-part1")
            self.assertEqual(teacher["releasedWeekIds"], ["2021-g34-part1", "2022-g34-part1"])

            all_subs = teacher["allSubmissions"]
            weeks_present = {sub["weekId"] for sub in all_subs}
            self.assertEqual(weeks_present, {"2021-g34-part1", "2022-g34-part1", "2022-g34-part2"})

            by_week: dict[str, dict[str, dict]] = {}
            packs_by_week: dict[str, dict] = {}
            for wid in weeks_present:
                packs_by_week[wid] = json.loads(
                    (REPO_ROOT / "webapp" / "packs" / wid / "pack.json").read_text(encoding="utf-8")
                )
            for sub in all_subs:
                by_week.setdefault(sub["weekId"], {})[sub["studentId"]] = sub

            # Cohort coverage per week (Claire absent week 1; all 6 week 2; Sam absent week 3).
            self.assertNotIn("claire-davis", by_week["2021-g34-part1"])
            self.assertEqual(len(by_week["2021-g34-part1"]), 5)
            self.assertEqual(len(by_week["2022-g34-part1"]), 6)
            self.assertNotIn("sam-patel", by_week["2022-g34-part2"])
            self.assertEqual(len(by_week["2022-g34-part2"]), 5)

            # Verify every single seeded submission's graded scores and summary match pack.json 100%.
            for sub in all_subs:
                pack = packs_by_week[sub["weekId"]]
                answers = sub["answers"]
                exp_total = exp3 = exp4 = exp5 = exp_c = exp_w = exp_b = 0
                summary_parts = []
                for q in pack["questions"]:
                    pts = int(q["points"])
                    choice = answers.get(str(q["number"]))
                    summary_parts.append(f"{q['number']}:{choice if choice else '—'}")
                    if not choice:
                        exp_b += 1
                    elif choice == q["correctOption"]:
                        exp_c += 1
                        exp_total += pts
                        if pts == 3:
                            exp3 += pts
                        elif pts == 4:
                            exp4 += pts
                        elif pts == 5:
                            exp5 += pts
                    else:
                        exp_w += 1
                self.assertEqual(sub["totalScore"], exp_total)
                self.assertEqual(sub["maxScore"], pack["maxScore"])
                self.assertEqual(sub["score3pt"], exp3)
                self.assertEqual(sub["score4pt"], exp4)
                self.assertEqual(sub["score5pt"], exp5)
                self.assertEqual(sub["correctCount"], exp_c)
                self.assertEqual(sub["wrongCount"], exp_w)
                self.assertEqual(sub["blankCount"], exp_b)
                self.assertEqual(sub["answersSummary"], ", ".join(summary_parts))

            # Verify specific pedagogical callout conditions & shared traps.
            self.assertEqual(by_week["2022-g34-part1"]["alice-nguyen"]["blankCount"], 1)
            self.assertEqual(by_week["2022-g34-part1"]["lucja-nowak"]["blankCount"], 1)
            self.assertLess(by_week["2022-g34-part1"]["diego-morales"]["score3pt"], 12)
            self.assertEqual(by_week["2022-g34-part1"]["diego-morales"]["score5pt"], 20)

            # Verify Parent Zone views for Alice (284913) and Łucja (084627):
            # 2 released weeks visible + 2022-g34-part2 in unreleasedSubmittedWeekIds + minCohortMet=True.
            for ppin, sid in [("284913", "alice-nguyen"), ("084627", "lucja-nowak")]:
                p_report = post_seeded({"action": "getParentReport", "parentPin": ppin})
                self.assertTrue(p_report["ok"])
                self.assertTrue(p_report["valid"])
                self.assertEqual(p_report["student"]["studentId"], sid)
                self.assertEqual(p_report["releasedWeekIds"], ["2021-g34-part1", "2022-g34-part1"])
                self.assertEqual(p_report["unreleasedSubmittedWeekIds"], ["2022-g34-part2"])
                self.assertIn("2021-g34-part1", p_report["submissionsByWeek"])
                self.assertIn("2022-g34-part1", p_report["submissionsByWeek"])
                self.assertNotIn("2022-g34-part2", p_report["submissionsByWeek"])
                self.assertTrue(p_report["cohortByWeek"]["2021-g34-part1"]["minCohortMet"])
                self.assertTrue(p_report["cohortByWeek"]["2022-g34-part1"]["minCohortMet"])

            # Verify shared traps on Mirror Laser Maze (#2 = 'D') and Five Overtaking Cars (#9 = 'A').
            c_2022 = post_seeded({"action": "getParentReport", "parentPin": "284913"})["cohortByWeek"]["2022-g34-part1"]
            self.assertGreaterEqual(c_2022["optionCounts"]["2"]["D"], 3)
            self.assertGreaterEqual(c_2022["optionCounts"]["9"]["A"], 2)

            # Verify an existing empty state file auto-upgrades seamlessly when seed_demo=True.
            empty_state_file = Path(self.tmp_dir.name) / "empty_existing.json"
            serve.SheetStateStore(empty_state_file, seed_demo=False)
            upgraded_store = serve.SheetStateStore(
                empty_state_file, seed_demo=True, webapp_dir=REPO_ROOT / "webapp"
            )
            upgraded_teacher = upgraded_store.dispatch(
                {"action": "getTeacherReport", "teacherPin": "885174", "includeAllWeeks": True}
            )
            self.assertEqual(len(upgraded_teacher["allSubmissions"]), 16)
            self.assertEqual(upgraded_teacher["releasedWeekIds"], ["2021-g34-part1", "2022-g34-part1"])
        finally:
            seeded_server.shutdown()
            seeded_server.server_close()
            seeded_thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
