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
import os
from pathlib import Path
import random
import re
import threading
import unicodedata

DEFAULT_TEACHER_PIN = "885174"
DEFAULT_WEEK_ID = "2022-g34-part1"
DEFAULT_STATE_FILE = Path("/tmp/math_circle_state.json")
REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_WEBAPP_DIR = REPO_ROOT / "webapp"

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
    {"studentId": "ada-guzhu", "name": "Ada Guzhu", "pin": "2418", "avatar": "🦘", "active": True},
    {"studentId": "andrew-ahmadi", "name": "Andrew Ahmadi", "pin": "5931", "avatar": "🐨", "active": True},
    {"studentId": "berrit-martz", "name": "Berrit Martz", "pin": "7264", "avatar": "🐝", "active": True},
    {"studentId": "camile-gauthier", "name": "Camile Gauthier", "pin": "3847", "avatar": "🦊", "active": True},
    {"studentId": "elliot-an", "name": "Elliot An", "pin": "6159", "avatar": "🦉", "active": True},
    {"studentId": "elliot-huang", "name": "Elliot Huang", "pin": "8492", "avatar": "🐬", "active": True},
    {"studentId": "hanna-bieniasz-krzywiec", "name": "Hanna Bieniasz-Krzywiec", "pin": "4726", "avatar": "🐼", "active": True},
    {"studentId": "keshav-junnarkar", "name": "Keshav Junnarkar", "pin": "9315", "avatar": "🐢", "active": True},
    {"studentId": "ting-zhao", "name": "Ting Zhao", "pin": "1683", "avatar": "🦁", "active": True},
    {"studentId": "lukasz-bk", "name": "Łukasz BK", "pin": "5042", "avatar": "🐧", "active": True},
    {"studentId": "maria-bk", "name": "Maria BK", "pin": "6719", "avatar": "🦄", "active": True},
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


class SheetStateStore:
    """Thread-safe JSON persistence matching sheet-backend/Code.gs semantics."""

    def __init__(self, state_file: Path):
        self.state_file = Path(state_file)
        self._lock = threading.Lock()
        self._ensure_initialized()

    def _default_state(self) -> dict:
        return {
            "teacherPin": DEFAULT_TEACHER_PIN,
            "activeWeekId": DEFAULT_WEEK_ID,
            "participants": [s["name"] for s in SEED_STUDENTS],
            "students": [dict(s) for s in SEED_STUDENTS],
            "submissions": [],
        }

    def _ensure_initialized(self) -> None:
        with self._lock:
            if not self.state_file.is_file():
                self._write_locked(self._default_state())

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
        """Merge any new SEED_STUDENTS and append any name in participants not yet in students."""
        participants = data.setdefault("participants", [])
        students = data.setdefault("students", [])
        existing_names = {str(s.get("name", "")).strip().lower() for s in students}
        used_ids = {str(s.get("studentId", "")).strip() for s in students if s.get("studentId")}
        participant_names_lower = {str(p or "").strip().lower() for p in participants if str(p or "").strip()}
        changed = False

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
                students.append(dict(seed))
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
            students.append(
                {
                    "studentId": slugify_name(name, used_ids),
                    "name": name,
                    "pin": f"{random.randint(0, 9999):04d}",
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

    def _get_teacher_report(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False

        active_week = data.get("activeWeekId", DEFAULT_WEEK_ID)
        week_id = str(payload.get("weekId") or "").strip() or active_week
        students = [
            {
                "studentId": st["studentId"],
                "name": st["name"],
                "pin": normalize_student_pin(st.get("pin")),
                "avatar": st.get("avatar", "🦊"),
                "active": st.get("active", True) is not False,
            }
            for st in data.get("students", [])
        ]
        submissions = [
            dict(sub)
            for sub in data.get("submissions", [])
            if sub.get("weekId") == week_id
        ]
        return {
            "ok": True,
            "activeWeekId": active_week,
            "weekId": week_id,
            "students": students,
            "submissions": submissions,
        }, False

    def _save_student_roster(self, data: dict, payload: dict) -> tuple[dict, bool]:
        if not self._is_valid_teacher_pin(data, payload.get("teacherPin")):
            return {"ok": False, "error": "Incorrect Teacher PIN."}, False

        incoming = payload.get("students")
        if not isinstance(incoming, list):
            return {"ok": False, "error": "students array is required."}, False

        used_ids: set[str] = set()
        saved: list[dict] = []
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

            avatar = str(raw.get("avatar") or AVATAR_POOL[idx % len(AVATAR_POOL)]).strip() or "🦊"
            active = raw.get("active", True) is not False
            saved.append(
                {
                    "studentId": student_id,
                    "name": name,
                    "pin": pin,
                    "avatar": avatar,
                    "active": active,
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
) -> ReusableThreadingHTTPServer:
    """Create a configured ThreadingHTTPServer instance."""
    store = SheetStateStore(Path(state_file))
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
    args = parser.parse_args(argv)

    server = create_server(
        host=args.host,
        port=args.port,
        state_file=Path(args.state_file),
        webapp_dir=Path(args.webapp_dir),
    )
    actual_host, actual_port = server.server_address
    print(f"Math Kangaroo Circle server running at http://{actual_host}:{actual_port}")
    print(f"Serving static files from: {args.webapp_dir}")
    print(f"API state persisted at:    {args.state_file}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
