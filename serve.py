#!/usr/bin/env python3
"""Local development static server + Sheet-compatible JSON API for Math Kangaroo Circle.

Serves webapp/ as document root and implements the exact POST /api and GET /api
contract of sheet-backend/Code.gs with thread-safe locking and JSON persistence.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import random
import re
import threading
import time
import unicodedata

DEFAULT_TEACHER_PIN = "885174"
DEFAULT_WEEK_ID = "2022-g34-part1"
DEFAULT_SEED_RELEASED_WEEKS = ["2021-g34-part1", "2022-g34-part1"]
DEFAULT_STATE_FILE = Path("/tmp/math_circle_state.json")
REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_WEBAPP_DIR = REPO_ROOT / "webapp"
MIN_COHORT_SIZE = 4
PARENT_PIN_MAX_FAILS = 10
PARENT_PIN_WINDOW_SEC = 60.0

AVATAR_POOL = ["🦊", "🦁", "🐼", "🦉", "🐸", "🐢", "🦋", "🐙", "🐨", "🐝", "🐧", "🦄"]
PARTICIPANT_HEADER_WORDS = {
    "name",
    "names",
    "student",
    "students",
    "student name",
    "full name",
    "participant",
    "participants",
}

SEED_STUDENTS = [
    {"studentId": "alice-nguyen", "name": "Alice Nguyen", "pin": "1357", "parentPin": "284913", "avatar": "🦘", "active": True},
    {"studentId": "ben-carter", "name": "Ben Carter", "pin": "2468", "parentPin": "375824", "avatar": "🐨", "active": True},
    {"studentId": "claire-davis", "name": "Claire Davis", "pin": "3691", "parentPin": "461935", "avatar": "🦊", "active": True},
    {"studentId": "diego-morales", "name": "Diego Morales", "pin": "4820", "parentPin": "592741", "avatar": "🦉", "active": True},
    {"studentId": "lucja-nowak", "name": "Łucja Nowak", "pin": "5739", "parentPin": "084627", "avatar": "🐼", "active": True},
    {"studentId": "sam-patel", "name": "Sam Patel", "pin": "7531", "parentPin": "719364", "avatar": "🐢", "active": True},
]

# Pre-populated realistic multi-week class answers for local dev/demo testing.
# Scores, section breakdowns, and summaries are computed directly from pack.json.
SEED_DEMO_SUBMISSION_PLANS: list[tuple[str, str, str, dict[str, str]]] = [
    # ---- Week 1: 2021-g34-part1 (Released, 5/6 submitters; claire-davis absent) ----
    (
        "2021-g34-part1",
        "alice-nguyen",
        "2026-11-05T17:14:22+00:00",
        {"1": "C", "2": "C", "3": "B", "4": "B", "9": "B", "10": "E", "11": "C", "12": "C", "17": "D", "18": "E", "20": "A"},
    ),
    (
        "2021-g34-part1",
        "ben-carter",
        "2026-11-05T17:16:08+00:00",
        {"1": "C", "2": "C", "3": "B", "4": "E", "9": "B", "10": "E", "11": "C", "12": "C", "17": "C", "18": "E", "20": "E"},
    ),
    (
        "2021-g34-part1",
        "diego-morales",
        "2026-11-05T17:18:45+00:00",
        {"1": "C", "2": "C", "3": "D", "4": "E", "9": "A", "10": "E", "11": "E", "12": "E", "17": "D", "18": "E", "19": "D", "20": "E"},
    ),
    (
        "2021-g34-part1",
        "lucja-nowak",
        "2026-11-05T17:20:11+00:00",
        {"1": "C", "2": "D", "3": "B", "4": "E", "9": "A", "10": "E", "11": "C", "12": "C", "17": "D", "18": "E", "19": "D", "20": "A"},
    ),
    (
        "2021-g34-part1",
        "sam-patel",
        "2026-11-05T17:22:03+00:00",
        {"1": "A", "2": "C", "3": "B", "4": "B", "9": "B", "10": "E", "11": "E", "12": "C", "17": "D", "18": "E", "19": "D", "20": "A"},
    ),
    # ---- Week 2: 2022-g34-part1 (Released, activeWeekId, all 6 submitters) ----
    (
        "2022-g34-part1",
        "alice-nguyen",
        "2026-11-12T17:12:40+00:00",
        {"1": "A", "2": "B", "3": "C", "4": "C", "9": "B", "10": "C", "11": "C", "12": "B", "17": "B", "18": "D", "20": "E"},
    ),
    (
        "2022-g34-part1",
        "ben-carter",
        "2026-11-12T17:15:19+00:00",
        {"1": "A", "2": "D", "3": "C", "4": "D", "9": "A", "10": "C", "11": "C", "12": "B", "17": "B", "18": "A", "19": "B", "20": "E"},
    ),
    (
        "2022-g34-part1",
        "claire-davis",
        "2026-11-12T17:17:02+00:00",
        {"1": "A", "2": "D", "3": "C", "4": "C", "9": "C", "10": "C", "11": "A", "12": "B", "17": "C", "18": "D", "19": "E", "20": "C"},
    ),
    (
        "2022-g34-part1",
        "diego-morales",
        "2026-11-12T17:19:33+00:00",
        {"1": "A", "2": "B", "3": "B", "4": "C", "9": "A", "10": "C", "11": "A", "12": "B", "17": "B", "18": "D", "19": "E", "20": "E"},
    ),
    (
        "2022-g34-part1",
        "lucja-nowak",
        "2026-11-12T17:21:05+00:00",
        {"1": "A", "2": "D", "3": "C", "4": "C", "9": "B", "10": "C", "11": "A", "12": "B", "17": "B", "18": "D", "20": "C"},
    ),
    (
        "2022-g34-part1",
        "sam-patel",
        "2026-11-12T17:23:18+00:00",
        {"1": "A", "2": "B", "3": "C", "4": "C", "9": "A", "10": "C", "11": "A", "12": "B", "17": "B", "18": "D", "19": "E", "20": "E"},
    ),
    # ---- Week 3: 2022-g34-part2 (Submitted in class, NOT yet released; 5/6 submitters) ----
    (
        "2022-g34-part2",
        "alice-nguyen",
        "2026-11-19T17:11:15+00:00",
        {"5": "E", "6": "D", "7": "A", "8": "C", "13": "E", "14": "B", "15": "E", "16": "A", "21": "C", "22": "B", "23": "A", "24": "D"},
    ),
    (
        "2022-g34-part2",
        "ben-carter",
        "2026-11-19T17:14:49+00:00",
        {"5": "A", "6": "D", "7": "A", "8": "C", "13": "A", "14": "B", "15": "E", "16": "A", "21": "C", "22": "B", "23": "B"},
    ),
    (
        "2022-g34-part2",
        "claire-davis",
        "2026-11-19T17:16:30+00:00",
        {"5": "E", "6": "D", "7": "C", "8": "C", "13": "E", "14": "D", "15": "E", "16": "B", "21": "C", "22": "B", "23": "A", "24": "E"},
    ),
    (
        "2022-g34-part2",
        "diego-morales",
        "2026-11-19T17:18:12+00:00",
        {"5": "E", "6": "D", "7": "C", "8": "C", "13": "E", "14": "B", "15": "E", "16": "B", "21": "C", "22": "B", "23": "A", "24": "E"},
    ),
    (
        "2022-g34-part2",
        "lucja-nowak",
        "2026-11-19T17:20:44+00:00",
        {"5": "E", "6": "D", "7": "A", "8": "A", "13": "E", "14": "A", "15": "E", "16": "A", "21": "C", "22": "B", "23": "A", "24": "D"},
    ),
]


def normalize_student_pin(pin: object) -> str:
    """Normalize a stored/configured student PIN to a 4-char zero-padded string."""
    if pin is None or isinstance(pin, bool):
        return ""
    s = str(pin).strip()
    if re.fullmatch(r"\d{1,4}", s):
        return s.zfill(4)
    return s


def is_pin_match(entered_pin: object, stored_pin: object) -> bool:
    """Compare a 4-digit entered PIN strictly (e.g. '412' does NOT match '0412')."""
    if entered_pin is None or isinstance(entered_pin, bool):
        return False
    raw = str(entered_pin).strip()
    canonical = normalize_student_pin(stored_pin)
    return bool(re.fullmatch(r"\d{4}", raw) and re.fullmatch(r"\d{4}", canonical) and raw == canonical)


def normalize_parent_pin(pin: object) -> str:
    """Normalize a 6-digit parent PIN to a 6-char zero-padded string."""
    if pin is None or isinstance(pin, bool):
        return ""
    s = str(pin).strip()
    if not s:
        return ""
    if re.fullmatch(r"\d{1,6}", s):
        return s.zfill(6)
    return s


def is_parent_pin_match(entered_pin: object, stored_pin: object) -> bool:
    """Compare a 6-digit entered Parent PIN strictly (preserving leading zeros)."""
    if entered_pin is None or isinstance(entered_pin, bool):
        return False
    raw = str(entered_pin).strip()
    canonical = normalize_parent_pin(stored_pin)
    return bool(re.fullmatch(r"\d{6}", raw) and re.fullmatch(r"\d{6}", canonical) and raw == canonical)


def is_weak_parent_pin(pin: str) -> bool:
    """Reject trivial repeating or sequential 6-digit PINs when auto-generating."""
    return bool(re.fullmatch(r"(\d)\1{5}", pin) or pin in ("123456", "654321"))


def generate_unique_parent_pin(
    used_pins: set[str],
    teacher_pin: str = DEFAULT_TEACHER_PIN,
    deterministic_key: str = "",
) -> str:
    """Generate a unique non-weak 6-digit Parent PIN distinct from teacher_pin."""
    t_pin = str(teacher_pin or DEFAULT_TEACHER_PIN).strip()
    if deterministic_key:
        h = 2166136261
        key = f"mk-parent-pin:{deterministic_key}"
        for ch in key:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        for step in range(5000):
            candidate = f"{(h + step * 7919) % 1000000:06d}"
            if not is_weak_parent_pin(candidate) and candidate != t_pin and candidate not in used_pins:
                used_pins.add(candidate)
                return candidate
    for _ in range(5000):
        candidate = f"{random.randint(0, 999999):06d}"
        if not is_weak_parent_pin(candidate) and candidate != t_pin and candidate not in used_pins:
            used_pins.add(candidate)
            return candidate
    raise RuntimeError("Could not generate unique 6-digit Parent PIN.")


_TRANSLITERATE_MAP = str.maketrans({
    "ł": "l",
    "Ł": "L",
    "ß": "ss",
    "æ": "ae",
    "Æ": "AE",
    "ø": "o",
    "Ø": "O",
    "đ": "d",
    "Đ": "D",
    "œ": "oe",
    "Œ": "OE",
})


def slugify_name(name: str, used_ids: set[str]) -> str:
    """Generate a unique lowercase slug student_id from a display name."""
    transliterated = str(name or "").translate(_TRANSLITERATE_MAP)
    ascii_text = unicodedata.normalize("NFKD", transliterated).encode("ascii", "ignore").decode("ascii")
    base = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower().strip()).strip("-")
    if not base:
        base = "student"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def format_answers_summary(answers: dict) -> str:
    """Format answers dict into sorted '1:A, 2:—' summary string."""
    keys = sorted(answers.keys(), key=lambda k: (int(k) if str(k).isdigit() else 0, str(k)))
    parts = []
    for k in keys:
        val = answers[k]
        parts.append(f"{k}:{val if val else '—'}")
    return ", ".join(parts)


def _round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def _compute_percentile_rounded(sorted_scores: list[float], p: float) -> int | None:
    if not sorted_scores:
        return None
    idx = (len(sorted_scores) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    frac = idx - lo
    val = sorted_scores[lo] + (sorted_scores[hi] - sorted_scores[lo]) * frac
    return _round_half_up(val)


def compute_cohort_stats_for_week(week_subs: list[dict]) -> dict:
    """Compute anonymized class benchmarks matching Code.gs computeCohortStatsForWeek_."""
    n = len(week_subs)
    if n < MIN_COHORT_SIZE:
        return {
            "cohortCount": n,
            "minCohortMet": False,
            "scoreP25": None,
            "scoreMedian": None,
            "scoreP75": None,
            "avgPct3pt": None,
            "avgPct4pt": None,
            "avgPct5pt": None,
            "optionCounts": None,
        }

    scores = sorted(float(sub.get("totalScore") or 0) for sub in week_subs)
    sum3 = sum(float(sub.get("score3pt") or 0) for sub in week_subs)
    sum4 = sum(float(sub.get("score4pt") or 0) for sub in week_subs)
    sum5 = sum(float(sub.get("score5pt") or 0) for sub in week_subs)

    q_keys: list[str] = []
    seen_q: set[str] = set()
    for sub in week_subs:
        for k in (sub.get("answers") or {}).keys():
            sk = str(k)
            if sk not in seen_q:
                seen_q.add(sk)
                q_keys.append(sk)

    option_counts: dict[str, dict[str, int]] = {}
    for q_key in q_keys:
        counts = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0, "blank": 0}
        for sub in week_subs:
            raw_choice = (sub.get("answers") or {}).get(q_key)
            choice = str(raw_choice).strip().upper() if raw_choice else ""
            if choice in ("A", "B", "C", "D", "E"):
                counts[choice] += 1
            else:
                counts["blank"] += 1
        option_counts[q_key] = counts

    return {
        "cohortCount": n,
        "minCohortMet": True,
        "scoreP25": _compute_percentile_rounded(scores, 0.25),
        "scoreMedian": _compute_percentile_rounded(scores, 0.50),
        "scoreP75": _compute_percentile_rounded(scores, 0.75),
        "avgPct3pt": _round_half_up((sum3 / (n * 12)) * 100.0),
        "avgPct4pt": _round_half_up((sum4 / (n * 16)) * 100.0),
        "avgPct5pt": _round_half_up((sum5 / (n * 20)) * 100.0),
        "optionCounts": option_counts,
    }


def _grade_answers_against_pack(pack: dict, answers: dict) -> dict:
    """Compute exact positive-only score breakdown and summary matching webapp/src/scoring.js."""
    total_score = 0
    max_score = 0
    score3 = 0
    score4 = 0
    score5 = 0
    correct = 0
    wrong = 0
    blank = 0
    summary_parts: list[str] = []
    normalized_answers: dict[str, str] = {}

    for q in pack.get("questions", []):
        q_num = str(q["number"])
        pts = int(q["points"])
        max_score += pts
        correct_opt = str(q["correctOption"]).strip().upper()
        raw = answers.get(q_num, answers.get(q["number"]))
        choice = str(raw).strip().upper() if raw else ""
        if choice not in ("A", "B", "C", "D", "E"):
            blank += 1
            summary_parts.append(f"{q_num}:—")
        else:
            normalized_answers[q_num] = choice
            summary_parts.append(f"{q_num}:{choice}")
            if choice == correct_opt:
                correct += 1
                total_score += pts
                if pts == 3:
                    score3 += pts
                elif pts == 4:
                    score4 += pts
                elif pts == 5:
                    score5 += pts
            else:
                wrong += 1

    return {
        "totalScore": total_score,
        "maxScore": int(pack.get("maxScore") or max_score or 48),
        "score3pt": score3,
        "score4pt": score4,
        "score5pt": score5,
        "correctCount": correct,
        "wrongCount": wrong,
        "blankCount": blank,
        "answersSummary": ", ".join(summary_parts),
        "answers": normalized_answers,
    }


def build_seed_demo_submissions(webapp_dir: Path = DEFAULT_WEBAPP_DIR) -> list[dict]:
    """Load real pack.json manifests and compute exact multi-week demo submissions."""
    packs_dir = Path(webapp_dir) / "packs"
    pack_cache: dict[str, dict] = {}
    student_by_id = {st["studentId"]: st for st in SEED_STUDENTS}
    records: list[dict] = []

    for week_id, student_id, updated_at, raw_answers in SEED_DEMO_SUBMISSION_PLANS:
        if week_id not in pack_cache:
            pack_path = packs_dir / week_id / "pack.json"
            pack_cache[week_id] = json.loads(pack_path.read_text(encoding="utf-8"))
        pack = pack_cache[week_id]
        student = student_by_id[student_id]
        graded = _grade_answers_against_pack(pack, raw_answers)
        records.append(
            {
                "updatedAt": updated_at,
                "weekId": week_id,
                "studentId": student["studentId"],
                "studentName": student["name"],
                "totalScore": graded["totalScore"],
                "maxScore": graded["maxScore"],
                "score3pt": graded["score3pt"],
                "score4pt": graded["score4pt"],
                "score5pt": graded["score5pt"],
                "correctCount": graded["correctCount"],
                "wrongCount": graded["wrongCount"],
                "blankCount": graded["blankCount"],
                "answersSummary": graded["answersSummary"],
                "answers": graded["answers"],
            }
        )

    return records


class SheetStateStore:
    """Thread-safe JSON persistence matching sheet-backend/Code.gs semantics."""

    def __init__(
        self,
        state_file: Path,
        time_fn=None,
        seed_demo: bool = False,
        webapp_dir: Path = DEFAULT_WEBAPP_DIR,
    ):
        self.state_file = Path(state_file)
        self.seed_demo = bool(seed_demo)
        self.webapp_dir = Path(webapp_dir)
        self._lock = threading.Lock()
        self._time_fn = time_fn or time.monotonic
        self._parent_pin_fails: list[float] = []
        self._ensure_initialized()

    def _default_state(self) -> dict:
        if self.seed_demo:
            released = list(DEFAULT_SEED_RELEASED_WEEKS)
            submissions = build_seed_demo_submissions(self.webapp_dir)
        else:
            released = []
            submissions = []
        return {
            "teacherPin": DEFAULT_TEACHER_PIN,
            "activeWeekId": DEFAULT_WEEK_ID,
            "releasedWeekIds": released,
            "participants": [s["name"] for s in SEED_STUDENTS],
            "students": [dict(s) for s in SEED_STUDENTS],
            "submissions": submissions,
        }

    def _ensure_initialized(self) -> None:
        with self._lock:
            if not self.state_file.is_file():
                self._write_locked(self._default_state())
                return
            if self.seed_demo:
                data = self._read_locked()
                changed = self._sync_participants_locked(data)
                if not data.get("submissions"):
                    data["submissions"] = build_seed_demo_submissions(self.webapp_dir)
                    if not data.get("releasedWeekIds"):
                        data["releasedWeekIds"] = list(DEFAULT_SEED_RELEASED_WEEKS)
                    changed = True
                if changed:
                    self._write_locked(data)

    def reset_state(self) -> dict:
        """Overwrite state_file cleanly with fresh default (seeded or empty) state."""
        with self._lock:
            data = self._default_state()
            self._write_locked(data)
            return data

    def _read_locked(self) -> dict:
        if not self.state_file.is_file():
            data = self._default_state()
            self._write_locked(data)
            return data
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def _write_locked(self, data: dict) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_file.with_name(
            f".{self.state_file.name}.{threading.get_ident()}.tmp"
        )
        tmp_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp_path, self.state_file)

    def _sync_participants_locked(self, data: dict) -> bool:
        """Merge any new SEED_STUDENTS, ensure parentPins, and append Participants."""
        if not isinstance(data.get("releasedWeekIds"), list):
            data["releasedWeekIds"] = []
            changed = True
        else:
            changed = False

        teacher_pin = str(data.get("teacherPin") or DEFAULT_TEACHER_PIN).strip()
        participants = data.setdefault("participants", [])
        students = data.setdefault("students", [])
        existing_names = {str(s.get("name", "")).strip().lower() for s in students}
        used_ids = {str(s.get("studentId", "")).strip() for s in students if s.get("studentId")}
        used_parent_pins: set[str] = set()

        # Preserve already-valid unique parentPins; repair missing/duplicate/teacherPin ones.
        seed_by_id = {s["studentId"]: s for s in SEED_STUDENTS}
        for st in students:
            p_pin = normalize_parent_pin(st.get("parentPin"))
            if re.fullmatch(r"\d{6}", p_pin) and p_pin != teacher_pin and p_pin not in used_parent_pins:
                if st.get("parentPin") != p_pin:
                    st["parentPin"] = p_pin
                    changed = True
                used_parent_pins.add(p_pin)
            else:
                st["parentPin"] = ""

        for st in students:
            if not st.get("parentPin"):
                seed_match = seed_by_id.get(st.get("studentId", ""))
                preferred = seed_match["parentPin"] if seed_match else ""
                if preferred and preferred != teacher_pin and preferred not in used_parent_pins:
                    st["parentPin"] = preferred
                    used_parent_pins.add(preferred)
                else:
                    det_key = str(st.get("studentId") or st.get("name") or "")
                    st["parentPin"] = generate_unique_parent_pin(used_parent_pins, teacher_pin, det_key)
                changed = True

        participant_names_lower = {str(p or "").strip().lower() for p in participants if str(p or "").strip()}

        # Ensure newly added SEED_STUDENTS merge into pre-existing /tmp state files without wiping submissions.
        for seed in SEED_STUDENTS:
            seed_name_key = seed["name"].strip().lower()
            if seed_name_key not in participant_names_lower:
                participants.append(seed["name"])
                participant_names_lower.add(seed_name_key)
                changed = True
            if seed_name_key not in existing_names and seed["studentId"] not in used_ids:
                existing_names.add(seed_name_key)
                used_ids.add(seed["studentId"])
                new_seed = dict(seed)
                if new_seed["parentPin"] in used_parent_pins or new_seed["parentPin"] == teacher_pin:
                    new_seed["parentPin"] = generate_unique_parent_pin(used_parent_pins, teacher_pin)
                else:
                    used_parent_pins.add(new_seed["parentPin"])
                students.append(new_seed)
                changed = True

        for idx, raw_name in enumerate(participants):
            name = str(raw_name or "").strip()
            if not name:
                continue
            if idx == 0 and name.lower() in PARTICIPANT_HEADER_WORDS:
                continue
            if name.lower() in existing_names:
                continue
            existing_names.add(name.lower())
            sid = slugify_name(name, used_ids)
            students.append(
                {
                    "studentId": sid,
                    "name": name,
                    "pin": f"{random.randint(0, 9999):04d}",
                    "parentPin": generate_unique_parent_pin(used_parent_pins, teacher_pin, sid),
                    "avatar": AVATAR_POOL[len(students) % len(AVATAR_POOL)],
                    "active": True,
                }
            )
            changed = True
        return changed

    def health(self) -> dict:
        with self._lock:
            data = self._read_locked()
            if self._sync_participants_locked(data):
                self._write_locked(data)
            active_count = sum(1 for s in data["students"] if s.get("active", True))
            return {
                "ok": True,
                "service": "math-circle-local-server",
                "activeWeekId": data.get("activeWeekId", DEFAULT_WEEK_ID),
                "studentCount": active_count,
            }

    def dispatch(self, payload: dict) -> dict:
        action = str(payload.get("action") or "")
        handlers = {
            "getPublicRoster": self._get_public_roster,
            "verifyStudentPin": self._verify_student_pin,
            "submitAnswers": self._submit_answers,
            "getTeacherReport": self._get_teacher_report,
            "saveStudentRoster": self._save_student_roster,
            "setActiveWeek": self._set_active_week,
            "setWeekReleased": self._set_week_released,
            "getParentReport": self._get_parent_report,
        }
        handler = handlers.get(action)
        if not handler:
            return {"ok": False, "error": f"Unknown action: {action}"}
        with self._lock:
            data = self._read_locked()
            synced = self._sync_participants_locked(data)
            result, mutated = handler(data, payload)
            if synced or mutated:
                self._write_locked(data)
            return result

    def _get_public_roster(self, data: dict, payload: dict) -> tuple[dict, bool]:
        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        week_id = str(payload.get("weekId") or "").strip() or active_week
        submitted_ids = {
            sub["studentId"]
            for sub in data.get("submissions", [])
            if sub.get("weekId") == week_id
        }
        # SECURITY BOUNDARY: Never expose pin or answers in public roster.
        public_students = [
            {
                "studentId": st["studentId"],
                "name": st["name"],
                "avatar": st.get("avatar", "🦊"),
                "hasSubmitted": st["studentId"] in submitted_ids,
            }
            for st in data.get("students", [])
            if st.get("active", True) is not False
        ]
        return {
            "ok": True,
            "activeWeekId": active_week,
            "weekId": week_id,
            "students": public_students,
        }, False

    def _verify_student_pin(self, data: dict, payload: dict) -> tuple[dict, bool]:
        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        week_id = str(payload.get("weekId") or "").strip() or active_week
        student_id = str(payload.get("studentId") or "").strip()
        pin = payload.get("pin")

        student = next(
            (
                st
                for st in data.get("students", [])
                if st.get("studentId") == student_id and st.get("active", True) is not False
            ),
            None,
        )
        if not student or not is_pin_match(pin, student.get("pin")):
            return {"ok": True, "valid": False, "student": None, "existingAnswers": None}, False

        existing = next(
            (
                sub.get("answers")
                for sub in data.get("submissions", [])
                if sub.get("weekId") == week_id and sub.get("studentId") == student_id
            ),
            None,
        )
        return {
            "ok": True,
            "valid": True,
            "student": {
                "studentId": student["studentId"],
                "name": student["name"],
                "avatar": student.get("avatar", "🦊"),
            },
            "existingAnswers": existing,
        }, False

    def _submit_answers(self, data: dict, payload: dict) -> tuple[dict, bool]:
        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        week_id = str(payload.get("weekId") or "").strip() or active_week
        student_id = str(payload.get("studentId") or "").strip()
        pin = payload.get("pin")
        answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
        summary = payload.get("scoreSummary") if isinstance(payload.get("scoreSummary"), dict) else {}

        student = next(
            (
                st
                for st in data.get("students", [])
                if st.get("studentId") == student_id and st.get("active", True) is not False
            ),
            None,
        )
        if not student or not is_pin_match(pin, student.get("pin")):
            return {"ok": False, "error": "Invalid student or PIN."}, False

        now_iso = datetime.now(timezone.utc).isoformat()
        record = {
            "updatedAt": now_iso,
            "weekId": week_id,
            "studentId": student["studentId"],
            "studentName": student["name"],
            "totalScore": int(summary.get("totalScore") or 0),
            "maxScore": int(summary.get("maxScore") or 48),
            "score3pt": int(summary.get("score3pt") or 0),
            "score4pt": int(summary.get("score4pt") or 0),
            "score5pt": int(summary.get("score5pt") or 0),
            "correctCount": int(summary.get("correctCount") or 0),
            "wrongCount": int(summary.get("wrongCount") or 0),
            "blankCount": int(summary.get("blankCount") or 0),
            "answersSummary": str(summary.get("answersSummary") or format_answers_summary(answers)),
            "answers": dict(answers),
        }

        subs = data.setdefault("submissions", [])
        for idx, existing in enumerate(subs):
            if existing.get("weekId") == week_id and existing.get("studentId") == student_id:
                subs[idx] = record
                break
        else:
            subs.append(record)

        return {"ok": True, "updatedAt": now_iso, "weekId": week_id, "studentId": student_id}, True

    def _is_valid_teacher_pin(self, data: dict, teacher_pin: object) -> bool:
        expected = str(data.get("teacherPin") or DEFAULT_TEACHER_PIN).strip()
        if teacher_pin is None or isinstance(teacher_pin, bool):
            return False
        return str(teacher_pin).strip() == expected

    def _get_released_week_ids(self, data: dict) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for w in data.get("releasedWeekIds") or []:
            sw = str(w or "").strip()
            if sw and sw not in seen:
                seen.add(sw)
                out.append(sw)
        return out

    def _active_student_ids(self, data: dict) -> set[str]:
        return {
            st["studentId"]
            for st in data.get("students", [])
            if st.get("active", True) is not False
        }

    def _get_teacher_report(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False

        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        released_weeks = self._get_released_week_ids(data)
        week_id = str(payload.get("weekId") or "").strip() or active_week
        include_all_weeks = bool(payload.get("includeAllWeeks"))
        active_ids = self._active_student_ids(data)

        students = [
            {
                "studentId": st["studentId"],
                "name": st["name"],
                "pin": normalize_student_pin(st.get("pin")),
                "parentPin": normalize_parent_pin(st.get("parentPin")),
                "avatar": st.get("avatar", "🦊"),
                "active": st.get("active", True) is not False,
            }
            for st in data.get("students", [])
        ]
        submissions = [
            dict(sub)
            for sub in data.get("submissions", [])
            if sub.get("weekId") == week_id and sub.get("studentId") in active_ids
        ]
        result = {
            "ok": True,
            "activeWeekId": active_week,
            "weekId": week_id,
            "releasedWeekIds": released_weeks,
            "students": students,
            "submissions": submissions,
        }
        if include_all_weeks:
            result["allSubmissions"] = [
                dict(sub)
                for sub in data.get("submissions", [])
                if sub.get("studentId") in active_ids
            ]
        return result, False

    def _save_student_roster(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False

        incoming = payload.get("students")
        if not isinstance(incoming, list):
            return {"ok": False, "error": "students array is required."}, False

        teacher_pin = str(data.get("teacherPin") or DEFAULT_TEACHER_PIN).strip()
        used_ids: set[str] = set()
        used_parent_pins: set[str] = set()
        normalized_incoming: list[dict] = []

        for idx, raw in enumerate(incoming):
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            if not name:
                continue
            raw_id = str(raw.get("studentId") or "").strip()
            if raw_id and raw_id not in used_ids:
                student_id = raw_id
                used_ids.add(student_id)
            else:
                student_id = slugify_name(name, used_ids)

            pin = normalize_student_pin(raw.get("pin"))
            if not re.fullmatch(r"\d{4}", pin):
                return {"ok": False, "error": f"PIN for {name} must be exactly 4 digits."}, False

            raw_parent = raw.get("parentPin")
            parent_pin = ""
            if raw_parent is not None and str(raw_parent).strip() != "":
                parent_pin = normalize_parent_pin(raw_parent)
                if not re.fullmatch(r"\d{6}", parent_pin):
                    return {"ok": False, "error": f"Parent PIN for {name} must be exactly 6 digits."}, False
                if parent_pin == teacher_pin:
                    return {"ok": False, "error": f"Parent PIN for {name} cannot match the Teacher PIN."}, False
                if parent_pin in used_parent_pins:
                    return {
                        "ok": False,
                        "error": f"Duplicate Parent PIN for {name}. Each student needs a unique 6-digit Parent PIN.",
                    }, False
                used_parent_pins.add(parent_pin)

            avatar = str(raw.get("avatar") or AVATAR_POOL[len(normalized_incoming) % len(AVATAR_POOL)]).strip() or "🦊"
            active = raw.get("active", True) is not False
            normalized_incoming.append(
                {
                    "studentId": student_id,
                    "name": name,
                    "pin": pin,
                    "parentPin": parent_pin,
                    "avatar": avatar,
                    "active": active,
                }
            )

        saved: list[dict] = []
        for rec in normalized_incoming:
            final_parent_pin = rec["parentPin"] or generate_unique_parent_pin(used_parent_pins, teacher_pin)
            saved.append(
                {
                    "studentId": rec["studentId"],
                    "name": rec["name"],
                    "pin": rec["pin"],
                    "parentPin": final_parent_pin,
                    "avatar": rec["avatar"],
                    "active": rec["active"],
                }
            )

        data["students"] = saved
        return {"ok": True, "students": saved}, True

    def _set_active_week(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False
        week_id = str(payload.get("weekId") or "").strip()
        if not week_id:
            return {"ok": False, "error": "weekId is required."}, False
        data["activeWeekId"] = week_id
        return {"ok": True, "activeWeekId": week_id}, True

    def _set_week_released(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False
        week_id = str(payload.get("weekId") or "").strip()
        if not week_id:
            return {"ok": False, "error": "weekId is required."}, False
        released = bool(payload.get("released"))
        current = self._get_released_week_ids(data)
        next_list = [w for w in current if w != week_id]
        if released:
            next_list.append(week_id)
        data["releasedWeekIds"] = next_list
        return {"ok": True, "releasedWeekIds": next_list}, True

    def _get_parent_report(self, data: dict, payload: dict) -> tuple[dict, bool]:
        now = float(self._time_fn())
        cutoff = now - PARENT_PIN_WINDOW_SEC
        self._parent_pin_fails = [ts for ts in self._parent_pin_fails if ts > cutoff]
        if len(self._parent_pin_fails) >= PARENT_PIN_MAX_FAILS:
            return {
                "ok": False,
                "error": "Too many failed PIN attempts. Please wait a minute and try again.",
                "rateLimited": True,
            }, False

        entered_pin = payload.get("parentPin")
        matched = next(
            (
                st
                for st in data.get("students", [])
                if st.get("active", True) is not False
                and is_parent_pin_match(entered_pin, st.get("parentPin"))
            ),
            None,
        )
        if not matched:
            self._parent_pin_fails.append(now)
            return {"ok": True, "valid": False, "student": None}, False

        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        released_weeks = self._get_released_week_ids(data)
        released_set = set(released_weeks)
        active_ids = self._active_student_ids(data)

        subs_by_week_all: dict[str, list[dict]] = {}
        submissions_by_week: dict[str, dict] = {}
        unreleased_submitted: list[str] = []
        unreleased_seen: set[str] = set()

        for sub in data.get("submissions", []):
            sid = sub.get("studentId")
            wid = sub.get("weekId")
            if sid not in active_ids or not wid:
                continue
            subs_by_week_all.setdefault(wid, []).append(sub)
            if sid == matched["studentId"]:
                if wid in released_set:
                    submissions_by_week[wid] = dict(sub)
                elif wid not in unreleased_seen:
                    unreleased_seen.add(wid)
                    unreleased_submitted.append(wid)

        cohort_by_week = {
            wid: compute_cohort_stats_for_week(subs_by_week_all.get(wid, []))
            for wid in released_weeks
        }

        return {
            "ok": True,
            "valid": True,
            "activeWeekId": active_week,
            "releasedWeekIds": released_weeks,
            "student": {
                "studentId": matched["studentId"],
                "name": matched["name"],
                "avatar": matched.get("avatar", "🦊"),
            },
            "submissionsByWeek": submissions_by_week,
            "unreleasedSubmittedWeekIds": unreleased_submitted,
            "cohortByWeek": cohort_by_week,
        }, False


class MathCircleRequestHandler(SimpleHTTPRequestHandler):
    """Serves webapp/ static files and routes /api to SheetStateStore."""

    def __init__(self, *args, store: SheetStateStore, quiet: bool = False, **kwargs):
        self.store = store
        self.quiet = quiet
        super().__init__(*args, **kwargs)

    def log_message(self, format: str, *args) -> None:
        if not self.quiet:
            super().log_message(format, *args)

    def end_headers(self) -> None:
        if self.path.split("?", 1)[0] != "/api":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api":
            self._send_json(HTTPStatus.OK, self.store.health())
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object.")
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return

        result = self.store.dispatch(payload)
        self._send_json(HTTPStatus.OK, result)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def create_server(
    host: str = "127.0.0.1",
    port: int = 8000,
    state_file: Path = DEFAULT_STATE_FILE,
    webapp_dir: Path = DEFAULT_WEBAPP_DIR,
    quiet: bool = False,
    seed_demo: bool = False,
) -> ReusableThreadingHTTPServer:
    """Create a configured ThreadingHTTPServer instance."""
    store = SheetStateStore(
        Path(state_file),
        seed_demo=seed_demo,
        webapp_dir=Path(webapp_dir),
    )
    handler_cls = partial(
        MathCircleRequestHandler,
        directory=str(webapp_dir),
        store=store,
        quiet=quiet,
    )
    return ReusableThreadingHTTPServer((host, port), handler_cls)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run local Math Kangaroo Circle server.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default 8000).")
    parser.add_argument(
        "--state-file",
        default=str(DEFAULT_STATE_FILE),
        help="Path to JSON state file (default /tmp/math_circle_state.json).",
    )
    parser.add_argument(
        "--webapp-dir",
        default=str(DEFAULT_WEBAPP_DIR),
        help="Static webapp root directory.",
    )
    parser.add_argument(
        "--empty",
        action="store_true",
        help="Start without pre-populated multi-week demo submissions.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Overwrite --state-file with fresh demo (or --empty) state before starting.",
    )
    args = parser.parse_args(argv)

    seed_demo = not args.empty
    state_path = Path(args.state_file)
    webapp_path = Path(args.webapp_dir)
    if args.reset:
        SheetStateStore(
            state_path,
            seed_demo=seed_demo,
            webapp_dir=webapp_path,
        ).reset_state()

    server = create_server(
        host=args.host,
        port=args.port,
        state_file=state_path,
        webapp_dir=webapp_path,
        seed_demo=seed_demo,
    )
    actual_host, actual_port = server.server_address
    print(f"Math Kangaroo Circle server running at http://{actual_host}:{actual_port}")
    print(f"Serving static files from: {args.webapp_dir}")
    print(f"API state persisted at:    {args.state_file}")
    print(f"Demo dataset seeded:       {'yes' if seed_demo else 'no (--empty)'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
