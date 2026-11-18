import json
from pathlib import Path
import re
import sys
import unittest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import serve  # noqa: E402


# Python reference specification matching webapp/src/scoring.js for parity checks.
def ref_compute_student_score(pack: dict, answers: dict) -> dict:
    total = 0
    s3 = s4 = s5 = 0
    correct = wrong = blank = 0
    for q in pack["questions"]:
        pts = int(q["points"])
        raw = answers.get(str(q["number"]), answers.get(q["number"]))
        choice = str(raw).strip().upper() if raw else None
        if choice not in ("A", "B", "C", "D", "E"):
            choice = None
        if choice is None:
            blank += 1
        elif choice == q["correctOption"]:
            correct += 1
            total += pts
            if pts == 3:
                s3 += pts
            elif pts == 4:
                s4 += pts
            elif pts == 5:
                s5 += pts
        else:
            wrong += 1
    return {
        "totalScore": total,
        "maxScore": pack["maxScore"],
        "score3pt": s3,
        "score4pt": s4,
        "score5pt": s5,
        "correctCount": correct,
        "wrongCount": wrong,
        "blankCount": blank,
    }


def ref_rank_submissions(students: list[dict], submissions: list[dict], pack: dict) -> list[dict]:
    by_id = {s["studentId"]: s for s in students}
    rows = []
    for sub in submissions:
        scored = ref_compute_student_score(pack, sub.get("answers", {}))
        st = by_id.get(sub["studentId"], {})
        rows.append(
            {
                "studentId": sub["studentId"],
                "studentName": sub.get("studentName") or st.get("name") or sub["studentId"],
                **scored,
            }
        )
    rows.sort(
        key=lambda r: (
            -r["totalScore"],
            -r["score5pt"],
            -r["score4pt"],
            r["studentName"].lower(),
        )
    )
    for idx, row in enumerate(rows):
        if idx == 0:
            row["rank"] = 1
        else:
            prev = rows[idx - 1]
            same_tie = (
                row["totalScore"] == prev["totalScore"]
                and row["score5pt"] == prev["score5pt"]
                and row["score4pt"] == prev["score4pt"]
            )
            row["rank"] = prev["rank"] if same_tie else idx + 1
    return rows


def ref_triage_questions(pack: dict, submissions: list[dict]) -> list[dict]:
    submitted_count = len(submissions)
    out = []
    for q in pack["questions"]:
        counts = {opt: 0 for opt in ("A", "B", "C", "D", "E", "blank")}
        correct = wrong = blank = 0
        for sub in submissions:
            raw = sub.get("answers", {}).get(str(q["number"]))
            choice = str(raw).strip().upper() if raw else None
            if choice not in ("A", "B", "C", "D", "E"):
                blank += 1
                counts["blank"] += 1
            else:
                counts[choice] += 1
                if choice == q["correctOption"]:
                    correct += 1
                else:
                    wrong += 1
        missed = wrong + blank
        solve_together = submitted_count > 0 and (
            (missed / submitted_count >= 0.4)
            or (submitted_count < 5 and missed >= 2)
            or (submitted_count == 1 and missed == 1)
        )
        traps = sorted(
            [
                {"option": opt, "count": counts[opt]}
                for opt in ("A", "B", "C", "D", "E")
                if opt != q["correctOption"] and counts[opt] >= 2
            ],
            key=lambda t: (-t["count"], t["option"]),
        )
        out.append(
            {
                "number": q["number"],
                "points": q["points"],
                "correctCount": correct,
                "wrongCount": wrong,
                "blankCount": blank,
                "missedCount": missed,
                "accuracyRate": (correct / submitted_count) if submitted_count else 0.0,
                "optionCounts": counts,
                "solveTogether": solve_together,
                "commonTraps": traps,
            }
        )
    out.sort(
        key=lambda item: (
            -item["missedCount"],
            -item["wrongCount"],
            -item["points"],
            item["number"],
        )
    )
    return out


class TestScoringParityAndStaticInvariants(unittest.TestCase):
    CODE_GS_PATH = REPO_ROOT / "sheet-backend" / "Code.gs"
    SCORING_JS_PATH = REPO_ROOT / "webapp" / "src" / "scoring.js"
    CONFIG_JS_PATH = REPO_ROOT / "webapp" / "config.js"
    PACK_JSON_PATH = REPO_ROOT / "webapp" / "packs" / "2022-g34-part1" / "pack.json"

    def test_code_gs_static_invariants(self) -> None:
        src = self.CODE_GS_PATH.read_text(encoding="utf-8")
        self.assertIn("LockService.getScriptLock", src)
        self.assertIn("'885174'", src)
        self.assertIn("setNumberFormat('@')", src)
        self.assertIn("ContentService.MimeType.JSON", src)
        self.assertIn("1uWyyPhBvUgaU1odlJQ20d9X6Io5icrF4EQMkDwDC-kE", src)

        # Ensure handleGetPublicRoster_ never exposes pin inside publicStudents.push({...})
        match = re.search(
            r"function handleGetPublicRoster_\(ss, payload\)\s*\{(?P<body>.*?)\n\}",
            src,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "handleGetPublicRoster_ function not found")
        body = match.group("body")
        push_match = re.search(r"publicStudents\.push\(\{(?P<obj>.*?)\}\);", body, re.DOTALL)
        self.assertIsNotNone(push_match)
        self.assertNotIn("pin", push_match.group("obj"))
        self.assertNotIn("answers", push_match.group("obj"))

        # Ensure syncParticipantsToStudents_ reads Participants but never writes to it.
        sync_match = re.search(
            r"function syncParticipantsToStudents_\(ss\)\s*\{(?P<body>.*?)\n\}",
            src,
            re.DOTALL,
        )
        self.assertIsNotNone(sync_match)
        self.assertNotIn("participantsSheet.getRange", sync_match.group("body").replace("participantsSheet.getRange(1, 1, participantsSheet.getLastRow(), 1).getValues()", ""))

    def test_scoring_js_contract_and_student_roster_parity(self) -> None:
        js_src = self.SCORING_JS_PATH.read_text(encoding="utf-8")
        for fn in ("computeStudentScore", "rankSubmissions", "triageQuestions", "normalizeChoice"):
            self.assertIn(f"export function {fn}", js_src)
        for token in (
            "b.totalScore !== a.totalScore",
            "b.score5pt !== a.score5pt",
            "b.score4pt !== a.score4pt",
            "exactScoreTie ? prev.rank : i + 1",
            "missedCount / submittedCount >= 0.4",
            "submittedCount < 5 && missedCount >= 2",
            "submittedCount === 1 && missedCount === 1",
            "b.missedCount !== a.missedCount",
            "b.wrongCount !== a.wrongCount",
            "b.points !== a.points",
            "a.number - b.number",
        ):
            self.assertIn(token, js_src)

        config_src = self.CONFIG_JS_PATH.read_text(encoding="utf-8")
        for st in serve.SEED_STUDENTS:
            self.assertIn(st["studentId"], config_src)
            self.assertIn(st["name"], config_src)
            self.assertIn(st["avatar"], config_src)
            # config.js must not expose student PINs
            self.assertNotIn(st["pin"], config_src)

    def test_positive_scoring_and_competition_ranks(self) -> None:
        pack = json.loads(self.PACK_JSON_PATH.read_text(encoding="utf-8"))
        all_correct = {str(q["number"]): q["correctOption"] for q in pack["questions"]}
        perfect = ref_compute_student_score(pack, all_correct)
        self.assertEqual(perfect["totalScore"], 48)
        self.assertEqual(perfect["score3pt"], 12)
        self.assertEqual(perfect["score4pt"], 16)
        self.assertEqual(perfect["score5pt"], 20)
        self.assertEqual(perfect["correctCount"], 12)
        self.assertEqual(perfect["wrongCount"], 0)
        self.assertEqual(perfect["blankCount"], 0)

        # Wrong & blank answers score 0 (no negative penalties).
        wrong_ans = {str(q["number"]): ("E" if q["correctOption"] != "E" else "A") for q in pack["questions"]}
        zero = ref_compute_student_score(pack, wrong_ans)
        self.assertEqual(zero["totalScore"], 0)
        self.assertEqual(zero["wrongCount"], 12)

        # Tie-breaking & competition rank 1, 2, 2, 4:
        # s1: all 12 correct = 48 (rank 1)
        # s2: misses Q1 (3pt) -> 45, 5pt=20, 4pt=16 (rank 2)
        # s3: misses Q2 (3pt) -> 45, 5pt=20, 4pt=16 (rank 2, exact score tie with s2!)
        # s4: misses Q9 (4pt) -> 44, 5pt=20, 4pt=12 (rank 4, NOT 3!)
        s2_ans = dict(all_correct, **{"1": None})
        s3_ans = dict(all_correct, **{"2": "E"})
        s4_ans = dict(all_correct, **{"9": None})
        ranked = ref_rank_submissions(
            serve.SEED_STUDENTS[:4],
            [
                {"studentId": "ada-guzhu", "studentName": "Ada Guzhu", "answers": all_correct},
                {"studentId": "camile-gauthier", "studentName": "Camile Gauthier", "answers": s3_ans},
                {"studentId": "andrew-ahmadi", "studentName": "Andrew Ahmadi", "answers": s2_ans},
                {"studentId": "berrit-martz", "studentName": "Berrit Martz", "answers": s4_ans},
            ],
            pack,
        )
        self.assertEqual([r["rank"] for r in ranked], [1, 2, 2, 4])
        # Andrew comes before Camile alphabetically on exact tie
        self.assertEqual([r["studentId"] for r in ranked], ["ada-guzhu", "andrew-ahmadi", "camile-gauthier", "berrit-martz"])

    def test_triage_sorting_and_common_traps(self) -> None:
        pack = json.loads(self.PACK_JSON_PATH.read_text(encoding="utf-8"))
        # 5 students:
        # Q19 (5pt, ans E): 3 wrong (2 picked B, 1 picked C), 1 blank -> missed=4, wrong=3
        # Q18 (5pt, ans D): 1 wrong (A), 3 blank -> missed=4, wrong=1 (loses tie to Q19 on wrongCount!)
        # Q2 (3pt, ans B): 2 picked D (trap!), 3 picked B -> missed=2 (2/5 = 0.4 -> solveTogether=True!)
        base = {str(q["number"]): q["correctOption"] for q in pack["questions"]}
        subs = [
            {"studentId": "s1", "answers": {**base, "19": "B", "18": "A", "2": "D"}},
            {"studentId": "s2", "answers": {**base, "19": "B", "18": None, "2": "D"}},
            {"studentId": "s3", "answers": {**base, "19": "C", "18": None}},
            {"studentId": "s4", "answers": {**base, "19": None, "18": None}},
            {"studentId": "s5", "answers": {**base}},
        ]
        triaged = ref_triage_questions(pack, subs)
        self.assertEqual([t["number"] for t in triaged[:3]], [19, 18, 2])
        q19 = triaged[0]
        self.assertTrue(q19["solveTogether"])
        self.assertEqual(q19["commonTraps"], [{"option": "B", "count": 2}])
        q2 = triaged[2]
        self.assertTrue(q2["solveTogether"])
        self.assertEqual(q2["commonTraps"], [{"option": "D", "count": 2}])

        # Single-student submission edge case: 1 missed -> solveTogether=True
        single = ref_triage_questions(pack, [{"studentId": "s1", "answers": {**base, "17": "E"}}])
        self.assertEqual(single[0]["number"], 17)
        self.assertTrue(single[0]["solveTogether"])


if __name__ == "__main__":
    unittest.main()
