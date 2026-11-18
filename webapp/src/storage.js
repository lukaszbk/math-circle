import { APP_CONFIG } from '../config.js';
import { formatAnswersSummary } from './scoring.js';

const KEYS = {
  APPS_SCRIPT_URL: 'mk_apps_script_url',
  PENDING_QUEUE: 'mk_pending_sync_queue',
  DEMO_DB: 'mk_demo_db_v1',
  DRAFT_PREFIX: 'mk_draft_v1:',
  ROSTER_CACHE_PREFIX: 'mk_roster_cache_v1:',
  LOCAL_SUBMITTED_PREFIX: 'mk_local_submitted_v1:'
};

// Demo-mode PINs matching the local serve.py pre-seeded roster so static preview works out of the box.
const DEMO_SEED_PINS = {
  'ada-guzhu': '2418',
  'andrew-ahmadi': '5931',
  'berrit-martz': '7264',
  'camile-gauthier': '3847',
  'elliot-an': '6159',
  'elliot-huang': '8492',
  'hanna-bieniasz-krzywiec': '4726',
  'keshav-junnarkar': '9315',
  'ting-zhao': '1683',
  'lukasz-bk': '5042',
  'maria-bk': '6719'
};

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizePinString(pin) {
  if (pin === null || pin === undefined) return '';
  const s = String(pin).trim();
  if (/^\d{1,4}$/.test(s)) {
    return s.padStart(4, '0');
  }
  return s;
}

function isExactPinMatch(enteredPin, storedPin) {
  if (enteredPin === null || enteredPin === undefined) return false;
  const raw = String(enteredPin).trim();
  const canonical = normalizePinString(storedPin);
  return /^\d{4}$/.test(raw) && /^\d{4}$/.test(canonical) && raw === canonical;
}

function slugifyName(name, usedIds) {
  let base = String(name || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'student';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export class StorageClient {
  constructor(config = APP_CONFIG) {
    this.config = config;
    // null = not probed yet, true = serve.py /api available, false = static file mode
    this._localApiAvailable = null;
  }

  getConfiguredAppsScriptUrl() {
    const saved = (localStorage.getItem(KEYS.APPS_SCRIPT_URL) || '').trim();
    if (saved) return saved;
    return (this.config.appsScriptUrl || '').trim();
  }

  setTeacherAppsScriptUrl(url) {
    const cleaned = String(url || '').trim();
    if (cleaned) {
      localStorage.setItem(KEYS.APPS_SCRIPT_URL, cleaned);
    } else {
      localStorage.removeItem(KEYS.APPS_SCRIPT_URL);
      this._localApiAvailable = null;
    }
  }

  getBackendMode() {
    if (this.getConfiguredAppsScriptUrl()) {
      return 'apps-script';
    }
    if (this._localApiAvailable === true) {
      return 'local-api';
    }
    if (this._localApiAvailable === false) {
      return 'demo-localstorage';
    }
    return window.location.protocol.startsWith('http') ? 'probing' : 'demo-localstorage';
  }

  getBackendLabel() {
    const mode = this.getBackendMode();
    if (mode === 'apps-script') return 'Google Sheet Connected';
    if (mode === 'local-api') return 'Local Class Server';
    if (mode === 'probing') return 'Connecting…';
    return 'Offline Demo Mode';
  }

  // ---- Draft & Local Queue Persistence ----

  _draftKey(weekId, studentId) {
    return `${KEYS.DRAFT_PREFIX}${weekId}:${studentId}`;
  }

  loadDraft(weekId, studentId) {
    return safeJsonParse(localStorage.getItem(this._draftKey(weekId, studentId)), null);
  }

  saveDraft(weekId, studentId, answers) {
    localStorage.setItem(
      this._draftKey(weekId, studentId),
      JSON.stringify({ answers: answers || {}, updatedAt: new Date().toISOString() })
    );
  }

  clearDraft(weekId, studentId) {
    localStorage.removeItem(this._draftKey(weekId, studentId));
  }

  getPendingQueue() {
    const list = safeJsonParse(localStorage.getItem(KEYS.PENDING_QUEUE), []);
    return Array.isArray(list) ? list : [];
  }

  _savePendingQueue(items) {
    localStorage.setItem(KEYS.PENDING_QUEUE, JSON.stringify(items));
  }

  enqueueSubmission(item) {
    const queue = this.getPendingQueue().filter(
      (entry) => !(entry.weekId === item.weekId && entry.studentId === item.studentId)
    );
    queue.push({ ...item, queuedAt: new Date().toISOString() });
    this._savePendingQueue(queue);
    this._markLocalSubmitted(item.weekId, item.studentId);
    return queue;
  }

  getQueuedSubmission(weekId, studentId) {
    return this.getPendingQueue().find(
      (entry) => entry.weekId === weekId && entry.studentId === studentId
    ) || null;
  }

  _markLocalSubmitted(weekId, studentId) {
    const key = `${KEYS.LOCAL_SUBMITTED_PREFIX}${weekId}`;
    const set = new Set(safeJsonParse(localStorage.getItem(key), []));
    set.add(studentId);
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  }

  _getLocalSubmittedSet(weekId) {
    const key = `${KEYS.LOCAL_SUBMITTED_PREFIX}${weekId}`;
    const arr = safeJsonParse(localStorage.getItem(key), []);
    return new Set(Array.isArray(arr) ? arr : []);
  }

  // ---- HTTP Transport ----

  async _postJson(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    const data = safeJsonParse(text, null);
    if (!data || typeof data.ok !== 'boolean') {
      throw new Error('Unexpected non-JSON response from backend.');
    }
    return data;
  }

  async _resolveEndpoint() {
    const appsUrl = this.getConfiguredAppsScriptUrl();
    if (appsUrl) {
      return { mode: 'apps-script', url: appsUrl };
    }
    if (!window.location.protocol.startsWith('http')) {
      this._localApiAvailable = false;
      return { mode: 'demo-localstorage', url: null };
    }
    if (this._localApiAvailable === false) {
      return { mode: 'demo-localstorage', url: null };
    }
    return { mode: 'local-api', url: '/api' };
  }

  async _callRemoteOrDemo(action, payload) {
    const endpoint = await this._resolveEndpoint();
    if (endpoint.mode === 'demo-localstorage') {
      return this._demoDispatch(action, payload);
    }

    try {
      const result = await this._postJson(endpoint.url, { action, ...payload });
      if (endpoint.mode === 'local-api') {
        this._localApiAvailable = true;
      }
      return result;
    } catch (err) {
      // If probing /api on a plain static file server (404/405/501), fall back to browser demo storage.
      if (
        endpoint.mode === 'local-api' &&
        this._localApiAvailable === null &&
        (err.status === 404 || err.status === 405 || err.status === 501 || err.message.includes('Unexpected non-JSON'))
      ) {
        this._localApiAvailable = false;
        return this._demoDispatch(action, payload);
      }
      throw err;
    }
  }

  // ---- Public API Actions ----

  async getPublicRoster(weekId) {
    const targetWeek = weekId || '';
    try {
      const res = await this._callRemoteOrDemo('getPublicRoster', { weekId: targetWeek });
      if (res.ok && Array.isArray(res.students)) {
        const effectiveWeek = res.weekId || res.activeWeekId || targetWeek || this.config.defaultWeekId;
        localStorage.setItem(
          `${KEYS.ROSTER_CACHE_PREFIX}${effectiveWeek}`,
          JSON.stringify({ activeWeekId: res.activeWeekId, students: res.students })
        );
        const queuedIds = new Set(
          this.getPendingQueue()
            .filter((q) => q.weekId === effectiveWeek)
            .map((q) => q.studentId)
        );
        return {
          ...res,
          students: res.students.map((st) => ({
            ...st,
            queuedOffline: queuedIds.has(st.studentId),
            hasSubmitted: Boolean(st.hasSubmitted || queuedIds.has(st.studentId))
          }))
        };
      }
      return res;
    } catch (err) {
      // Network error: serve cached or default roster so tablets still open cleanly.
      const fallbackWeek = targetWeek || this.config.defaultWeekId;
      const cached = safeJsonParse(localStorage.getItem(`${KEYS.ROSTER_CACHE_PREFIX}${fallbackWeek}`), null);
      const localSubmitted = this._getLocalSubmittedSet(fallbackWeek);
      const queuedIds = new Set(
        this.getPendingQueue()
          .filter((q) => q.weekId === fallbackWeek)
          .map((q) => q.studentId)
      );
      const baseStudents = cached?.students || this.config.demoStudents;
      return {
        ok: true,
        offlineFallback: true,
        error: err.message,
        activeWeekId: cached?.activeWeekId || fallbackWeek,
        weekId: fallbackWeek,
        students: baseStudents.map((st) => ({
          studentId: st.studentId,
          name: st.name,
          avatar: st.avatar,
          queuedOffline: queuedIds.has(st.studentId),
          hasSubmitted: Boolean(st.hasSubmitted || localSubmitted.has(st.studentId) || queuedIds.has(st.studentId))
        }))
      };
    }
  }

  async verifyStudentPin(studentId, pin, weekId) {
    const res = await this._callRemoteOrDemo('verifyStudentPin', { studentId, pin, weekId });
    if (res.ok && res.valid) {
      const queued = this.getQueuedSubmission(weekId, studentId);
      if (queued && queued.answers) {
        return { ...res, existingAnswers: queued.answers };
      }
    }
    return res;
  }

  async submitAnswers({ weekId, studentId, pin, answers, scoreSummary }) {
    const endpoint = await this._resolveEndpoint();
    if (endpoint.mode === 'demo-localstorage') {
      const res = this._demoDispatch('submitAnswers', { weekId, studentId, pin, answers, scoreSummary });
      if (res.ok) {
        this.clearDraft(weekId, studentId);
        this._markLocalSubmitted(weekId, studentId);
      }
      return res;
    }

    try {
      const res = await this._postJson(endpoint.url, {
        action: 'submitAnswers',
        weekId,
        studentId,
        pin,
        answers,
        scoreSummary
      });
      if (endpoint.mode === 'local-api') {
        this._localApiAvailable = true;
      }
      if (res.ok) {
        this.clearDraft(weekId, studentId);
        this._markLocalSubmitted(weekId, studentId);
        // Remove any superseded queued item for this student+week.
        const remaining = this.getPendingQueue().filter(
          (entry) => !(entry.weekId === weekId && entry.studentId === studentId)
        );
        this._savePendingQueue(remaining);
        return { ...res, queuedOffline: false };
      }

      // If lock timeout / busy sheet error, queue safely instead of losing work.
      if (String(res.error || '').toLowerCase().includes('busy')) {
        this.enqueueSubmission({ weekId, studentId, pin, answers, scoreSummary });
        this.clearDraft(weekId, studentId);
        return {
          ok: true,
          queuedOffline: true,
          message: 'Saved locally while classmates finish syncing.'
        };
      }
      return res;
    } catch (err) {
      if (
        endpoint.mode === 'local-api' &&
        this._localApiAvailable === null &&
        (err.status === 404 || err.status === 405 || err.status === 501)
      ) {
        this._localApiAvailable = false;
        const res = this._demoDispatch('submitAnswers', { weekId, studentId, pin, answers, scoreSummary });
        if (res.ok) this.clearDraft(weekId, studentId);
        return res;
      }

      // Wi-Fi dropped or server unreachable: queue locally!
      this.enqueueSubmission({ weekId, studentId, pin, answers, scoreSummary });
      this.clearDraft(weekId, studentId);
      return {
        ok: true,
        queuedOffline: true,
        message: 'Wi-Fi was busy — saved safely on this tablet and will sync automatically.'
      };
    }
  }

  async flushPendingQueue() {
    const queue = this.getPendingQueue();
    if (queue.length === 0) {
      return { syncedCount: 0, remainingCount: 0, errors: [] };
    }
    const endpoint = await this._resolveEndpoint();
    if (endpoint.mode === 'demo-localstorage') {
      return { syncedCount: 0, remainingCount: queue.length, errors: ['Offline demo mode active'] };
    }

    const stillPending = [];
    const errors = [];
    let syncedCount = 0;

    for (const item of queue) {
      try {
        const res = await this._postJson(endpoint.url, {
          action: 'submitAnswers',
          weekId: item.weekId,
          studentId: item.studentId,
          pin: item.pin,
          answers: item.answers,
          scoreSummary: item.scoreSummary
        });
        if (res.ok) {
          syncedCount += 1;
          this._markLocalSubmitted(item.weekId, item.studentId);
        } else if (String(res.error || '').toLowerCase().includes('invalid student or pin')) {
          // Drop stale item whose PIN changed rather than retrying forever.
          errors.push(`${item.studentId}: ${res.error}`);
        } else {
          stillPending.push(item);
          errors.push(res.error || 'Sync rejected');
        }
      } catch (err) {
        stillPending.push(item);
        errors.push(err.message);
      }
    }

    this._savePendingQueue(stillPending);
    return {
      syncedCount,
      remainingCount: stillPending.length,
      errors
    };
  }

  async getTeacherReport(weekId, teacherPin) {
    return this._callRemoteOrDemo('getTeacherReport', { weekId, teacherPin });
  }

  async saveStudentRoster(teacherPin, students) {
    return this._callRemoteOrDemo('saveStudentRoster', { teacherPin, students });
  }

  async setActiveWeek(teacherPin, weekId) {
    return this._callRemoteOrDemo('setActiveWeek', { teacherPin, weekId });
  }

  async testConnection(url) {
    const target = String(url || '').trim();
    if (!target) {
      return { ok: false, error: 'Please enter an Apps Script /exec URL.' };
    }
    try {
      const res = await this._postJson(target, { action: 'getPublicRoster' });
      if (!res.ok) {
        return { ok: false, error: res.error || 'Backend returned an error.' };
      }
      return {
        ok: true,
        studentCount: (res.students || []).length,
        activeWeekId: res.activeWeekId || this.config.defaultWeekId
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---- LocalStorage Demo Backend (Static Fallback) ----

  _loadDemoDb() {
    const existing = safeJsonParse(localStorage.getItem(KEYS.DEMO_DB), null);
    if (existing && Array.isArray(existing.students)) {
      return existing;
    }
    const seeded = {
      activeWeekId: this.config.defaultWeekId,
      teacherPin: this.config.defaultTeacherPin,
      students: this.config.demoStudents.map((st) => ({
        studentId: st.studentId,
        name: st.name,
        avatar: st.avatar,
        pin: DEMO_SEED_PINS[st.studentId] || '0000',
        active: true
      })),
      submissions: []
    };
    localStorage.setItem(KEYS.DEMO_DB, JSON.stringify(seeded));
    return seeded;
  }

  _saveDemoDb(db) {
    localStorage.setItem(KEYS.DEMO_DB, JSON.stringify(db));
  }

  _demoDispatch(action, payload) {
    const db = this._loadDemoDb();
    const activeWeekId = db.activeWeekId || this.config.defaultWeekId;
    const weekId = payload.weekId || activeWeekId;

    if (action === 'getPublicRoster') {
      const submitted = new Set(
        db.submissions.filter((s) => s.weekId === weekId).map((s) => s.studentId)
      );
      return {
        ok: true,
        activeWeekId,
        weekId,
        students: db.students
          .filter((s) => s.active !== false)
          .map((s) => ({
            studentId: s.studentId,
            name: s.name,
            avatar: s.avatar,
            hasSubmitted: submitted.has(s.studentId)
          }))
      };
    }

    if (action === 'verifyStudentPin') {
      const st = db.students.find((s) => s.studentId === payload.studentId && s.active !== false);
      if (!st || !isExactPinMatch(payload.pin, st.pin)) {
        return { ok: true, valid: false, student: null, existingAnswers: null };
      }
      const existingSub = db.submissions.find(
        (s) => s.weekId === weekId && s.studentId === st.studentId
      );
      return {
        ok: true,
        valid: true,
        student: { studentId: st.studentId, name: st.name, avatar: st.avatar },
        existingAnswers: existingSub ? existingSub.answers : null
      };
    }

    if (action === 'submitAnswers') {
      const st = db.students.find((s) => s.studentId === payload.studentId && s.active !== false);
      if (!st || !isExactPinMatch(payload.pin, st.pin)) {
        return { ok: false, error: 'Invalid student or PIN.' };
      }
      const nowIso = new Date().toISOString();
      const summary = payload.scoreSummary || {};
      const answers = payload.answers || {};
      const record = {
        updatedAt: nowIso,
        weekId,
        studentId: st.studentId,
        studentName: st.name,
        totalScore: Number(summary.totalScore || 0),
        maxScore: Number(summary.maxScore || 48),
        score3pt: Number(summary.score3pt || 0),
        score4pt: Number(summary.score4pt || 0),
        score5pt: Number(summary.score5pt || 0),
        correctCount: Number(summary.correctCount || 0),
        wrongCount: Number(summary.wrongCount || 0),
        blankCount: Number(summary.blankCount || 0),
        answersSummary: summary.answersSummary || formatAnswersSummary([], answers),
        answers
      };
      const idx = db.submissions.findIndex(
        (s) => s.weekId === weekId && s.studentId === st.studentId
      );
      if (idx >= 0) db.submissions[idx] = record;
      else db.submissions.push(record);
      this._saveDemoDb(db);
      return { ok: true, updatedAt: nowIso, weekId, studentId: st.studentId };
    }

    if (action === 'getTeacherReport') {
      if (String(payload.teacherPin || '').trim() !== db.teacherPin) {
        return { ok: false, error: 'Incorrect Teacher PIN.' };
      }
      return {
        ok: true,
        activeWeekId,
        weekId,
        students: db.students.map((s) => ({ ...s, pin: normalizePinString(s.pin) })),
        submissions: db.submissions.filter((s) => s.weekId === weekId)
      };
    }

    if (action === 'saveStudentRoster') {
      if (String(payload.teacherPin || '').trim() !== db.teacherPin) {
        return { ok: false, error: 'Incorrect Teacher PIN.' };
      }
      const usedIds = new Set();
      const nextStudents = [];
      for (const st of (payload.students || [])) {
        const name = String(st.name || '').trim();
        if (!name) continue;
        let sid = String(st.studentId || '').trim();
        if (!sid || usedIds.has(sid)) {
          sid = slugifyName(name, usedIds);
        } else {
          usedIds.add(sid);
        }
        const pin = normalizePinString(st.pin);
        if (!/^\d{4}$/.test(pin)) {
          return { ok: false, error: `PIN for ${name} must be exactly 4 digits.` };
        }
        nextStudents.push({
          studentId: sid,
          name,
          pin,
          avatar: String(st.avatar || '🦊').trim() || '🦊',
          active: st.active !== false
        });
      }
      db.students = nextStudents;
      this._saveDemoDb(db);
      return { ok: true, students: nextStudents };
    }

    if (action === 'setActiveWeek') {
      if (String(payload.teacherPin || '').trim() !== db.teacherPin) {
        return { ok: false, error: 'Incorrect Teacher PIN.' };
      }
      db.activeWeekId = String(payload.weekId || '').trim() || this.config.defaultWeekId;
      this._saveDemoDb(db);
      return { ok: true, activeWeekId: db.activeWeekId };
    }

    return { ok: false, error: `Unknown action: ${action}` };
  }
}
