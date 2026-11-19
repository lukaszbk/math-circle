import json
from pathlib import Path
import re
import shutil
import subprocess
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
    STORAGE_JS_PATH = REPO_ROOT / "webapp" / "src" / "storage.js"
    QUESTION_CLASSES_JS_PATH = REPO_ROOT / "webapp" / "src" / "questionClasses.js"
    QR_JS_PATH = REPO_ROOT / "webapp" / "src" / "qr.js"
    PARENT_VIEW_JS_PATH = REPO_ROOT / "webapp" / "src" / "parentView.js"
    TEACHER_VIEW_JS_PATH = REPO_ROOT / "webapp" / "src" / "teacherView.js"
    CONFIG_JS_PATH = REPO_ROOT / "webapp" / "config.js"
    PACK_JSON_PATH = REPO_ROOT / "webapp" / "packs" / "2022-g34-part1" / "pack.json"
    SKILL_MD_PATH = REPO_ROOT / ".agents" / "skills" / "compile-weekly-pack" / "SKILL.md"

    def test_code_gs_static_invariants(self) -> None:
        src = self.CODE_GS_PATH.read_text(encoding="utf-8")
        self.assertIn("LockService.getScriptLock", src)
        self.assertIn("CacheService.getScriptCache", src)
        self.assertIn("MIN_COHORT_SIZE = 4", src)
        self.assertIn("parent_pin", src)
        self.assertIn("released_week_ids", src)
        self.assertIn("handleGetParentReport_", src)
        self.assertIn("handleSetWeekReleased_", src)
        self.assertIn("'885174'", src)
        self.assertIn("setNumberFormat('@')", src)
        self.assertIn("ContentService.MimeType.JSON", src)
        self.assertNotIn("SPREADSHEET_ID", src)
        self.assertIn("SpreadsheetApp.getActiveSpreadsheet()", src)
        config_src = self.CONFIG_JS_PATH.read_text(encoding="utf-8")
        self.assertNotIn("spreadsheetId", config_src)
        self.assertNotIn("sheetUrl", config_src)
        self.assertNotIn("docs.google.com/spreadsheets", config_src)
        self.assertIn("function onOpen()", src)
        self.assertIn("function onEdit(e)", src)
        self.assertIn("syncParticipantsMenuAction", src)
        self.assertIn("replace(/ł/g, 'l')", src)
        self.assertIn("replace(/Ł/g, 'L')", src)

        # Ensure handleGetPublicRoster_ never exposes pin, parentPin, or answers inside publicStudents.push({...})
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
        self.assertNotIn("parentPin", push_match.group("obj"))
        self.assertNotIn("answers", push_match.group("obj"))

        # Ensure syncParticipantsToStudents_ reads Participants but never writes to it.
        sync_match = re.search(
            r"function syncParticipantsToStudents_\(ss\)\s*\{(?P<body>.*?)\n\}",
            src,
            re.DOTALL,
        )
        self.assertIsNotNone(sync_match)
        self.assertNotIn("participantsSheet.getRange", sync_match.group("body").replace("participantsSheet.getRange(1, 1, participantsSheet.getLastRow(), 1).getValues()", ""))

    def test_unicode_slugification_and_skill_runbook(self) -> None:
        # Python slugifier
        self.assertEqual(serve.slugify_name("Łucja Nowak", set()), "lucja-nowak")
        self.assertEqual(serve.slugify_name("Michał Kowalski", set()), "michal-kowalski")
        self.assertEqual(serve.slugify_name("Zażółć gęślą jaźń", set()), "zazolc-gesla-jazn")

        # JS storage slugifier static check
        storage_src = self.STORAGE_JS_PATH.read_text(encoding="utf-8")
        self.assertIn("replace(/ł/g, 'l')", storage_src)
        self.assertIn("replace(/Ł/g, 'L')", storage_src)
        self.assertIn(".normalize('NFD')", storage_src)

        # Workspace skill validation
        self.assertTrue(self.SKILL_MD_PATH.is_file(), "Missing compile-weekly-pack SKILL.md")
        skill_text = self.SKILL_MD_PATH.read_text(encoding="utf-8")
        fm_match = re.match(r"^---\n(.*?)\n---\n", skill_text, re.DOTALL)
        self.assertIsNotNone(fm_match, "SKILL.md missing YAML frontmatter")
        fm = fm_match.group(1)
        self.assertIn("name: compile-weekly-pack", fm)
        self.assertIn("description:", fm)
        for required_term in (
            "--crop-only",
            "customBox",
            "maskRects",
            "search_web",
            "Matched Published Key",
            "Resolved Discrepancy",
            "Self-Verified Only",
        ):
            self.assertIn(required_term, skill_text)

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
        storage_src = self.STORAGE_JS_PATH.read_text(encoding="utf-8")
        self.assertNotIn("DEMO_SEED_PINS", config_src)
        self.assertNotIn("DEMO_SEED_PINS", storage_src)
        for st in serve.SEED_STUDENTS:
            for src_text in (config_src, storage_src):
                self.assertNotIn(st["studentId"], src_text)
                self.assertNotIn(st["name"], src_text)
                self.assertNotIn(st["pin"], src_text)
                self.assertNotIn(st["parentPin"], src_text)

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
                {"studentId": "alice-nguyen", "studentName": "Alice Nguyen", "answers": all_correct},
                {"studentId": "claire-davis", "studentName": "Claire Davis", "answers": s3_ans},
                {"studentId": "ben-carter", "studentName": "Ben Carter", "answers": s2_ans},
                {"studentId": "diego-morales", "studentName": "Diego Morales", "answers": s4_ans},
            ],
            pack,
        )
        self.assertEqual([r["rank"] for r in ranked], [1, 2, 2, 4])
        # Ben comes before Claire alphabetically on exact tie
        self.assertEqual(
            [r["studentId"] for r in ranked],
            ["alice-nguyen", "ben-carter", "claire-davis", "diego-morales"],
        )

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

    def test_github_pages_static_hosting_entrypoints(self) -> None:
        root_index = REPO_ROOT / "index.html"
        nojekyll = REPO_ROOT / ".nojekyll"
        pages_yml = REPO_ROOT / ".github" / "workflows" / "pages.yml"
        self.assertTrue(root_index.is_file(), "Root index.html required for branch-mode GitHub Pages")
        self.assertTrue(nojekyll.is_file(), "Root .nojekyll required for GitHub Pages")
        self.assertTrue(pages_yml.is_file(), "GitHub Actions Pages workflow missing")

        root_html = root_index.read_text(encoding="utf-8")
        self.assertIn('<base href="./webapp/" />', root_html)
        self.assertIn('src="src/app.js"', root_html)
        self.assertIn('href="styles/main.css"', root_html)

        storage_js = (REPO_ROOT / "webapp" / "src" / "storage.js").read_text(encoding="utf-8")
        self.assertIn("isStaticPublicHost", storage_js)
        self.assertIn(".github.io", storage_js)

    def test_local_vs_production_sheet_isolation(self) -> None:
        storage_js = self.STORAGE_JS_PATH.read_text(encoding="utf-8")
        teacher_js = self.TEACHER_VIEW_JS_PATH.read_text(encoding="utf-8")

        # Static checks for storage.js isolation contract
        for token in (
            "DISABLE_DEFAULT_SHEET: 'mk_disable_default_sheet'",
            "export function isLocalOrigin(loc)",
            "!protocol.startsWith('http')",
            "h === 'localhost'",
            "h === '127.0.0.1'",
            "h === '::1'",
            "h === '[::1]'",
            "h === '0.0.0.0'",
            "h.endsWith('.localhost')",
            "h.endsWith('.local')",
            "h.endsWith('.googlers.com')",
            "h.endsWith('.corp.google.com')",
            "h.endsWith('.cloudworkstations.dev')",
            "/^10\\./.test(h)",
            "/^192\\.168\\./.test(h)",
            "/^172\\.(1[6-9]|2\\d|3[0-1])\\./.test(h)",
            "port !== '80' && port !== '443'",
            "localStorage.getItem(KEYS.DISABLE_DEFAULT_SHEET) === '1'",
            "isLocalOrigin(window.location)",
            "localStorage.setItem(KEYS.DISABLE_DEFAULT_SHEET, '1')",
            "localStorage.removeItem(KEYS.DISABLE_DEFAULT_SHEET)",
        ):
            self.assertIn(token, storage_js)

        # Static checks for teacherView.js Connect Live Sheet / Disconnect UI
        for token in (
            "!configuredUrl && APP_CONFIG.appsScriptUrl",
            'data-action="connect-default-sheet"',
            "Connect Live Sheet",
            'data-action="clear-url"',
            "#apps-script-url-input",
            "handlers.saveAndTestUrl(",
        ):
            self.assertIn(token, teacher_js)

        # Behavioral execution via Node ESM or GJS SpiderMonkey ESM
        node_bin = shutil.which("node")
        gjs_bin = shutil.which("gjs")
        if node_bin or gjs_bin:
            storage_uri = self.STORAGE_JS_PATH.as_uri()
            config_uri = self.CONFIG_JS_PATH.as_uri()
            printer = "console.log" if node_bin else "print"
            node_script = f"""
import {{ isLocalOrigin, StorageClient }} from {json.dumps(storage_uri)};
import {{ APP_CONFIG }} from {json.dumps(config_uri)};

function assert(cond, msg) {{
  if (!cond) throw new Error(msg || 'Assertion failed');
}}
function assertEq(a, b, msg) {{
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${{msg || 'Mismatch'}}: ${{ja}} !== ${{jb}}`);
}}

function makeLocalStorage() {{
  const map = new Map();
  return {{
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {{ map.set(String(k), String(v)); }},
    removeItem: (k) => {{ map.delete(String(k)); }},
    clear: () => {{ map.clear(); }}
  }};
}}

function setupEnv(loc) {{
  globalThis.localStorage = makeLocalStorage();
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  Object.defineProperty(globalThis.window, 'location', {{ value: loc, configurable: true, writable: true }});
}}

async function run() {{
  assertEq(APP_CONFIG.demoStudents, []);
  assert(!('spreadsheetId' in APP_CONFIG), 'no spreadsheetId');
  assert(!('sheetUrl' in APP_CONFIG), 'no sheetUrl');
  const prodLoc = {{ protocol: 'https:', hostname: 'lukaszbk.github.io', port: '' }};
  setupEnv(prodLoc);
  assertEq(isLocalOrigin(prodLoc), false);
  let client = new StorageClient(APP_CONFIG);
  assertEq(client.getConfiguredAppsScriptUrl(), APP_CONFIG.appsScriptUrl);
  assertEq(client.getBackendMode(), 'apps-script');

  const localOrigins = [
    {{ protocol: 'http:', hostname: 'localhost', port: '8080' }},
    {{ protocol: 'http:', hostname: '127.0.0.1', port: '8080' }},
    {{ protocol: 'http:', hostname: 'lukaszbk-jetski.c.googlers.com', port: '8080' }},
    {{ protocol: 'http:', hostname: '192.168.1.25', port: '8080' }},
    {{ protocol: 'file:', hostname: '', port: '' }}
  ];
  for (const loc of localOrigins) {{
    setupEnv(loc);
    assertEq(isLocalOrigin(loc), true, `Expected local origin for ${{JSON.stringify(loc)}}`);
    const c = new StorageClient(APP_CONFIG);
    assertEq(c.getConfiguredAppsScriptUrl(), '');
    assert(c.getBackendMode() !== 'apps-script', 'not apps-script on local');
  }}

  const localhostLoc = {{ protocol: 'http:', hostname: 'localhost', port: '8080' }};
  setupEnv(localhostLoc);
  client = new StorageClient(APP_CONFIG);
  assertEq(client.getConfiguredAppsScriptUrl(), '');
  client.setTeacherAppsScriptUrl(APP_CONFIG.appsScriptUrl);
  assertEq(client.getConfiguredAppsScriptUrl(), APP_CONFIG.appsScriptUrl);
  assertEq(client.getBackendMode(), 'apps-script');
  client.setTeacherAppsScriptUrl('');
  assertEq(client.getConfiguredAppsScriptUrl(), '');
  assertEq(client.getBackendMode(), 'probing');

  setupEnv(prodLoc);
  client = new StorageClient(APP_CONFIG);
  assertEq(client.getConfiguredAppsScriptUrl(), APP_CONFIG.appsScriptUrl);
  client.setTeacherAppsScriptUrl('');
  assertEq(client.getConfiguredAppsScriptUrl(), '');
  assertEq(client.getBackendMode(), 'demo-localstorage');
  const demoRoster = await client.getPublicRoster('2022-g34-part1');
  assertEq(demoRoster.ok, true);
  assertEq(demoRoster.students, []);
  {printer}('OK');
}}
await run();
"""
            if node_bin:
                res = subprocess.run(
                    [node_bin, "--input-type=module", "-e", node_script],
                    cwd=str(REPO_ROOT),
                    capture_output=True,
                    text=True,
                    check=False,
                )
            else:
                import tempfile
                with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as tf:
                    tf.write(node_script)
                    tf_path = tf.name
                try:
                    res = subprocess.run(
                        [gjs_bin, "-m", tf_path],
                        cwd=str(REPO_ROOT),
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                finally:
                    Path(tf_path).unlink(missing_ok=True)
            self.assertEqual(
                res.returncode,
                0,
                f"JS sheet isolation check failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}",
            )
            self.assertIn("OK", res.stdout)

    def test_qr_question_classes_and_views_js_parity(self) -> None:
        runtime_bin = shutil.which("node") or shutil.which("gjs")
        if not runtime_bin:
            self.skipTest("Neither node nor gjs available to execute ES module parity test.")
        is_node = Path(runtime_bin).name == "node"
        printer = "console.log" if is_node else "print"

        sys.path.insert(0, str(REPO_ROOT / "pack-compiler"))
        import compile_pack  # noqa: E402

        qc_uri = self.QUESTION_CLASSES_JS_PATH.as_uri()
        qr_uri = self.QR_JS_PATH.as_uri()
        storage_uri = self.STORAGE_JS_PATH.as_uri()
        config_uri = self.CONFIG_JS_PATH.as_uri()
        parent_uri = self.PARENT_VIEW_JS_PATH.as_uri()
        teacher_uri = self.TEACHER_VIEW_JS_PATH.as_uri()

        pack_data = json.loads(self.PACK_JSON_PATH.read_text(encoding="utf-8"))
        js_script = f"""
import {{ QUESTION_CLASSES, computeStudentClassMastery, computeCohortClassStats }} from {json.dumps(qc_uri)};
import {{ encodeQrMatrix, renderQrSvg }} from {json.dumps(qr_uri)};
import {{ StorageClient }} from {json.dumps(storage_uri)};
import {{ APP_CONFIG }} from {json.dumps(config_uri)};
import {{ renderParentZone }} from {json.dumps(parent_uri)};
import {{ renderTeacherZone, openPrintParentCardsModal }} from {json.dumps(teacher_uri)};

function assert(cond, msg) {{
  if (!cond) throw new Error(msg || 'Assertion failed');
}}

const map = new Map();
globalThis.localStorage = {{
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => {{ map.set(String(k), String(v)); }},
  removeItem: (k) => {{ map.delete(String(k)); }},
  clear: () => {{ map.clear(); }}
}};
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
Object.defineProperty(globalThis.window, 'location', {{
  value: {{ protocol: 'file:', origin: 'https://lukaszbk.github.io', pathname: '/math-circle/' }},
  configurable: true,
  writable: true
}});
const mockEl = () => ({{ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }});
const modalEl = mockEl();
const appEl = mockEl();
globalThis.document = {{
  getElementById: (id) => (id === 'modal-root' ? modalEl : appEl),
  addEventListener: () => {{}},
  removeEventListener: () => {{}}
}};

async function run() {{
  // 1. Test StorageClient demo backend Parent Zone + cohort stats parity
  const client = new StorageClient(APP_CONFIG);
  const roster = [
    {{ studentId: 's1', name: 'Kid 1', pin: '1111', parentPin: '012345', avatar: '🦊', active: true }},
    {{ studentId: 's2', name: 'Kid 2', pin: '2222', parentPin: '234567', avatar: '🐼', active: true }},
    {{ studentId: 's3', name: 'Kid 3', pin: '3333', parentPin: '345678', avatar: '🦁', active: true }},
    {{ studentId: 's4', name: 'Kid 4', pin: '4444', parentPin: '456789', avatar: '🦉', active: true }}
  ];
  const saved = await client.saveStudentRoster('885174', roster);
  assert(saved.ok, 'saveStudentRoster ok');
  await client.submitAnswers({{ weekId: '2022-g34-part1', studentId: 's1', pin: '1111', answers: {{ '1': 'A' }}, scoreSummary: {{ totalScore: 10, score3pt: 6, score4pt: 4, score5pt: 0 }} }});
  await client.submitAnswers({{ weekId: '2022-g34-part1', studentId: 's2', pin: '2222', answers: {{ '1': 'B' }}, scoreSummary: {{ totalScore: 20, score3pt: 6, score4pt: 4, score5pt: 10 }} }});
  await client.submitAnswers({{ weekId: '2022-g34-part1', studentId: 's3', pin: '3333', answers: {{ '1': 'B' }}, scoreSummary: {{ totalScore: 30, score3pt: 12, score4pt: 12, score5pt: 6 }} }});
  await client.submitAnswers({{ weekId: '2022-g34-part1', studentId: 's4', pin: '4444', answers: {{ '2': 'B' }}, scoreSummary: {{ totalScore: 40, score3pt: 6, score4pt: 16, score5pt: 18 }} }});
  await client.setWeekReleased('885174', '2022-g34-part1', true);
  const pRep = await client.getParentReport('012345');
  assert(pRep.ok && pRep.valid, 'getParentReport valid');
  const cohort = pRep.cohortByWeek['2022-g34-part1'];
  assert(cohort.scoreP25 === 18 && cohort.scoreMedian === 25 && cohort.scoreP75 === 33, 'percentiles match Python');
  assert(cohort.avgPct3pt === 63, 'avgPct3pt match Python');

  // 2. Test questionClasses.js mastery & cohort class stats
  const pack = {json.dumps(pack_data)};
  const mastery = computeStudentClassMastery({{
    packs: {{ '2022-g34-part1': pack }},
    submissionsByWeek: pRep.submissionsByWeek,
    cohortByWeek: pRep.cohortByWeek
  }});
  assert(mastery.practiced.length > 0, 'mastery practiced non-empty');
  assert(mastery.priorityRetryQueue.length === 11, '11 missed questions queued');
  assert(mastery.priorityRetryQueue[0].points === 3, '3-pt questions prioritized first');

  const tRep = await client.getTeacherReport('2022-g34-part1', '885174', {{ includeAllWeeks: true }});
  assert(tRep.allSubmissions.length === 4, 'includeAllWeeks returns 4');
  const tCohort = computeCohortClassStats({{ packs: {{ '2022-g34-part1': pack }}, allSubmissions: tRep.allSubmissions, students: tRep.students }});
  assert(tCohort.classesSortedWeakestFirst.length > 0, 'tCohort non-empty');

  // 3. Test rendering ParentZone, TeacherZone (all 5 tabs), and PrintCards without exceptions
  for (const tab of ['scores', 'review', 'home-focus']) {{
    renderParentZone({{
      appEl,
      packIndex: {{ packs: [pack] }},
      packsById: {{ '2022-g34-part1': pack }},
      report: pRep,
      storage: client,
      parentState: {{ activeTab: tab, chartMode: tab === 'scores' ? 'trajectory' : 'stacked', selectedWeekId: '2022-g34-part1', reviewFilter: 'needs-review', revealedSolutions: {{ '2022-g34-part1:2': true }}, highlightQuestionKey: null }},
      handlers: {{ exitParent: () => {{}}, refreshParentReport: () => {{}}, switchTab: () => {{}}, setChartMode: () => {{}}, selectWeek: () => {{}}, setReviewFilter: () => {{}}, toggleRevealSolution: () => {{}}, jumpToQuestionReview: () => {{}}, openZoom: () => {{}} }}
    }});
    assert(appEl.innerHTML.includes('Parent Zone'), `rendered parent tab ${{tab}}`);
  }}
  for (const tab of ['ranking', 'triage', 'whiteboard', 'roster', 'topics']) {{
    renderTeacherZone({{
      appEl,
      pack,
      packIndex: {{ packs: [pack] }},
      packsById: {{ '2022-g34-part1': pack }},
      activeWeekId: '2022-g34-part1',
      report: tRep,
      storage: client,
      pendingCount: 0,
      teacherState: {{ activeTab: tab, whiteboardWeekId: '2022-g34-part1', whiteboardQuestionNum: 1, revealGuide: true, showPins: true, autoRefresh: false, rosterDraft: tRep.students, connectionStatus: '' }},
      handlers: {{ exitTeacher: () => {{}}, refreshReport: () => {{}}, retrySync: () => {{}}, toggleAutoRefresh: () => {{}}, switchTab: () => {{}}, openWhiteboard: () => {{}}, selectWhiteboardQuestion: () => {{}}, toggleGuide: () => {{}}, openZoom: () => {{}}, toggleShowPins: () => {{}}, addStudentRow: () => {{}}, regenerateDraftParentPin: () => {{}}, openPrintCards: () => {{}}, updateDraftField: () => {{}}, saveRoster: () => {{}}, setActiveWeek: () => {{}}, setWeekReleased: () => {{}}, saveAndTestUrl: () => {{}}, clearUrl: () => {{}} }}
    }});
    assert(appEl.innerHTML.includes('Teacher Zone'), `rendered teacher tab ${{tab}}`);
  }}
  openPrintParentCardsModal({{ students: tRep.students }});
  assert(modalEl.innerHTML.includes('parent-print-card') && modalEl.innerHTML.includes('<svg'), 'rendered print cards with SVG QR');

  // 4. Test QR code encoding for short, standard ?parent, and V7+ long URLs
  const qrSamples = [
    'HI',
    'https://lukaszbk.github.io/math-circle/?parent',
    'https://example.github.io/very-long-math-kangaroo-circle-path-for-version-7-check/?parent&token=abcdef1234567890'
  ].map((s) => {{
    const m = encodeQrMatrix(s);
    const svg = renderQrSvg(s);
    assert(svg.startsWith('<svg') && svg.includes('viewBox='), 'valid SVG');
    return {{ text: s, version: m.version, size: m.size, rows: m.modules.map((r) => Array.from(r)) }};
  }});

  {printer}(JSON.stringify({{ questionClasses: QUESTION_CLASSES, qrSamples }}));
}}
await run();
"""
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as tf:
            tf.write(js_script)
            tf_path = tf.name
        try:
            cmd = [runtime_bin, tf_path] if is_node else [runtime_bin, "-m", tf_path]
            res = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, check=False)
        finally:
            Path(tf_path).unlink(missing_ok=True)

        self.assertEqual(res.returncode, 0, f"JS parity script failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}")
        payload = json.loads(res.stdout.strip().splitlines()[-1])

        # Verify QUESTION_CLASSES parity with compile_pack.py
        js_classes = {c["id"]: c for c in payload["questionClasses"]}
        self.assertEqual(set(js_classes.keys()), set(compile_pack.QUESTION_CLASSES.keys()))
        for cid, py_meta in compile_pack.QUESTION_CLASSES.items():
            for field in ("domain", "domainLabel", "label", "shortLabel", "icon"):
                self.assertEqual(js_classes[cid][field], py_meta[field], f"Mismatch on {cid}.{field}")

        # Verify ISO 18004 QR bitstream & Reed-Solomon syndromes on every JS-generated QR matrix
        for item in payload["qrSamples"]:
            decoded = self._decode_iso_qr(item["rows"])
            self.assertEqual(decoded, item["text"])

    @staticmethod
    def _decode_iso_qr(rows: list[list[int]]) -> str:
        gf_exp = [0] * 512
        gf_log = [0] * 256
        x = 1
        for i in range(255):
            gf_exp[i] = x
            gf_log[x] = i
            x <<= 1
            if x & 0x100:
                x ^= 0x11D
        for i in range(255, 512):
            gf_exp[i] = gf_exp[i - 255]

        def gf_mul(a: int, b: int) -> int:
            return 0 if a == 0 or b == 0 else gf_exp[gf_log[a] + gf_log[b]]

        specs = {
            1: (10, [(1, 16)], []),
            2: (16, [(1, 28)], [6, 18]),
            3: (26, [(1, 44)], [6, 22]),
            4: (18, [(2, 32)], [6, 26]),
            5: (24, [(2, 43)], [6, 30]),
            6: (16, [(4, 27)], [6, 34]),
            7: (18, [(4, 31)], [6, 22, 38]),
            8: (22, [(2, 38), (2, 39)], [6, 24, 42]),
            9: (22, [(3, 36), (2, 37)], [6, 26, 46]),
        }
        masks = [
            lambda r, c: (r + c) % 2 == 0,
            lambda r, c: r % 2 == 0,
            lambda r, c: c % 3 == 0,
            lambda r, c: (r + c) % 3 == 0,
            lambda r, c: (r // 2 + c // 3) % 2 == 0,
            lambda r, c: ((r * c) % 2 + (r * c) % 3) == 0,
            lambda r, c: (((r * c) % 2 + (r * c) % 3) % 2) == 0,
            lambda r, c: (((r + c) % 2 + (r * c) % 3) % 2) == 0,
        ]
        size = len(rows)
        version = (size - 17) // 4
        ec_len, groups, align = specs[version]

        fmt1 = 0
        for i in range(14, 8, -1):
            fmt1 = (fmt1 << 1) | rows[8][14 - i]
        fmt1 = (fmt1 << 1) | rows[8][7]
        fmt1 = (fmt1 << 1) | rows[8][8]
        fmt1 = (fmt1 << 1) | rows[7][8]
        for i in range(5, -1, -1):
            fmt1 = (fmt1 << 1) | rows[i][8]
        fmt2 = 0
        for i in range(14, 7, -1):
            fmt2 = (fmt2 << 1) | rows[size - 15 + i][8]
        for i in range(7, -1, -1):
            fmt2 = (fmt2 << 1) | rows[8][size - 1 - i]
        if fmt1 != fmt2:
            raise AssertionError(f"Format copy mismatch: {fmt1:#x} != {fmt2:#x}")
        raw_fmt = fmt1 ^ 0x5412
        mask_id = (raw_fmt >> 10) & 7

        func = [[False] * size for _ in range(size)]
        for tr, lc in [(0, 0), (0, size - 7), (size - 7, 0)]:
            for dr in range(-1, 8):
                for dc in range(-1, 8):
                    if 0 <= tr + dr < size and 0 <= lc + dc < size:
                        func[tr + dr][lc + dc] = True
        for i in range(8, size - 8):
            func[6][i] = func[i][6] = True
        for i in range(len(align)):
            for j in range(len(align)):
                if (i, j) in ((0, 0), (0, len(align) - 1), (len(align) - 1, 0)):
                    continue
                for dr in range(-2, 3):
                    for dc in range(-2, 3):
                        func[align[i] + dr][align[j] + dc] = True
        func[4 * version + 9][8] = True
        for i in range(9):
            if i != 6:
                func[8][i] = func[i][8] = True
        for i in range(size - 8, size):
            func[8][i] = True
            if i > size - 8:
                func[i][8] = True
        if version >= 7:
            for i in range(18):
                a, b = i // 3, size - 11 + (i % 3)
                func[a][b] = func[b][a] = True

        bits = []
        up = True
        col = size - 1
        while col >= 1:
            if col == 6:
                col = 5
            for step in range(size):
                r = size - 1 - step if up else step
                for off in range(2):
                    c = col - off
                    if not func[r][c]:
                        bits.append(rows[r][c] ^ (1 if masks[mask_id](r, c) else 0))
            up = not up
            col -= 2

        total_cw = sum(cnt * (cw + ec_len) for cnt, cw in groups)
        cw_bytes = [sum(bits[i * 8 + b] << (7 - b) for b in range(8)) for i in range(total_cw)]
        blocks_data = []
        blocks_ecc = []
        for cnt, cw in groups:
            for _ in range(cnt):
                blocks_data.append([0] * cw)
                blocks_ecc.append([0] * ec_len)
        idx = 0
        max_d = max(cw for _, cw in groups)
        for c_i in range(max_d):
            for blk in blocks_data:
                if c_i < len(blk):
                    blk[c_i] = cw_bytes[idx]
                    idx += 1
        for c_i in range(ec_len):
            for eb in blocks_ecc:
                eb[c_i] = cw_bytes[idx]
                idx += 1
        for bd, be in zip(blocks_data, blocks_ecc):
            full = bd + be
            for root in range(ec_len):
                s = 0
                for byte in full:
                    s = gf_mul(s, gf_exp[root]) ^ byte
                if s != 0:
                    raise AssertionError(f"Non-zero RS syndrome {s} at root {root}")

        stream = "".join(f"{b:08b}" for bd in blocks_data for b in bd)
        if stream[:4] != "0100":
            raise AssertionError(f"Expected Byte mode 0100, got {stream[:4]}")
        ln = int(stream[4:12], 2)
        return bytes(int(stream[12 + i * 8 : 20 + i * 8], 2) for i in range(ln)).decode("utf-8")


if __name__ == "__main__":
    unittest.main()
