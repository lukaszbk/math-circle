import { APP_CONFIG } from '../config.js';
import { formatAnswersSummary } from './scoring.js';

const KEYS = {
  APPS_SCRIPT_URL: 'mk_apps_script_url',
  DISABLE_DEFAULT_SHEET: 'mk_disable_default_sheet',
  PENDING_QUEUE: 'mk_pending_sync_queue',
  DEMO_DB: 'mk_demo_db_v1',
  DRAFT_PREFIX: 'mk_draft_v1:',
  ROSTER_CACHE_PREFIX: 'mk_roster_cache_v1:',
  LOCAL_SUBMITTED_PREFIX: 'mk_local_submitted_v1:'
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

function normalizeParentPinString(pin) {
  if (pin === null || pin === undefined || pin === '') return '';
  const s = String(pin).trim();
  if (/^\d{1,6}$/.test(s)) {
    return s.padStart(6, '0');
  }
  return s;
}

function isExactParentPinMatch(enteredPin, storedPin) {
  if (enteredPin === null || enteredPin === undefined) return false;
  const raw = String(enteredPin).trim();
  const canonical = normalizeParentPinString(storedPin);
  return /^\d{6}$/.test(raw) && /^\d{6}$/.test(canonical) && raw === canonical;
}

function isWeakParentPin(pin) {
  return /^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321';
}

function generateUniqueParentPin(usedPins, teacherPin, deterministicKey = '') {
  const tPin = String(teacherPin || '885174').trim();
  if (deterministicKey) {
    let hash = 2166136261;
    const key = `mk-parent-pin:${deterministicKey}`;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    for (let step = 0; step < 5000; step++) {
      const candidate = String((hash + step * 7919) % 1000000).padStart(6, '0');
      if (!isWeakParentPin(candidate) && candidate !== tPin && !usedPins.has(candidate)) {
        usedPins.add(candidate);
        return candidate;
      }
    }
  }
  for (let attempt = 0; attempt < 5000; attempt++) {
    const candidate = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    if (!isWeakParentPin(candidate) && candidate !== tPin && !usedPins.has(candidate)) {
      usedPins.add(candidate);
      return candidate;
    }
  }
  throw new Error('Could not generate unique 6-digit Parent PIN.');
}

function computePercentileRounded(sortedScores, p) {
  if (!sortedScores || sortedScores.length === 0) return null;
  const idx = (sortedScores.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const val = sortedScores[lo] + (sortedScores[hi] - sortedScores[lo]) * frac;
  return Math.floor(val + 0.5);
}

function computeCohortStatsForWeek(weekSubs) {
  const n = weekSubs.length;
  if (n < 4) {
    return {
      cohortCount: n,
      minCohortMet: false,
      scoreP25: null,
      scoreMedian: null,
      scoreP75: null,
      avgPct3pt: null,
      avgPct4pt: null,
      avgPct5pt: null,
      optionCounts: null
    };
  }
  const scores = weekSubs.map((s) => Number(s.totalScore || 0)).sort((a, b) => a - b);
  let sum3 = 0;
  let sum4 = 0;
  let sum5 = 0;
  const qKeys = [];
  const seenQ = new Set();
  for (const sub of weekSubs) {
    sum3 += Number(sub.score3pt || 0);
    sum4 += Number(sub.score4pt || 0);
    sum5 += Number(sub.score5pt || 0);
    for (const k of Object.keys(sub.answers || {})) {
      const sk = String(k);
      if (!seenQ.has(sk)) {
        seenQ.add(sk);
        qKeys.push(sk);
      }
    }
  }

  const optionCounts = {};
  for (const qKey of qKeys) {
    const counts = { A: 0, B: 0, C: 0, D: 0, E: 0, blank: 0 };
    for (const sub of weekSubs) {
      const rawChoice = (sub.answers || {})[qKey];
      const choice = rawChoice ? String(rawChoice).trim().toUpperCase() : '';
      if (choice === 'A' || choice === 'B' || choice === 'C' || choice === 'D' || choice === 'E') {
        counts[choice] += 1;
      } else {
        counts.blank += 1;
      }
    }
    optionCounts[qKey] = counts;
  }

  return {
    cohortCount: n,
    minCohortMet: true,
    scoreP25: computePercentileRounded(scores, 0.25),
    scoreMedian: computePercentileRounded(scores, 0.50),
    scoreP75: computePercentileRounded(scores, 0.75),
    avgPct3pt: Math.floor((sum3 / (n * 12)) * 100 + 0.5),
    avgPct4pt: Math.floor((sum4 / (n * 16)) * 100 + 0.5),
    avgPct5pt: Math.floor((sum5 / (n * 20)) * 100 + 0.5),
    optionCounts
  };
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

function isStaticPublicHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h.endsWith('.github.io') ||
    h.endsWith('.pages.dev') ||
    h.endsWith('.web.app') ||
    h.endsWith('.firebaseapp.com') ||
    h.endsWith('.netlify.app') ||
    h.endsWith('.vercel.app')
  );
}

export function isLocalOrigin(loc) {
  if (!loc) return false;
  const protocol = String(loc.protocol || '').toLowerCase();
  if (protocol && !protocol.startsWith('http')) {
    return true;
  }
  const h = String(loc.hostname || '').toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.googlers.com') ||
    h.endsWith('.corp.google.com') ||
    h.endsWith('.cloudworkstations.dev')
  ) {
    return true;
  }
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) {
    return true;
  }
  const port = String(loc.port || '');
  if (port && port !== '80' && port !== '443') {
    return true;
  }
  return false;
}

export class StorageClient {
  constructor(config = APP_CONFIG) {
    this.config = config;
    // null = not probed yet, true = serve.py /api available, false = static file mode
    this._localApiAvailable =
      typeof window !== 'undefined' && isStaticPublicHost(window.location.hostname)
        ? false
        : null;
    this._demoParentFailTimestamps = [];
  }

  getConfiguredAppsScriptUrl() {
    const saved = (localStorage.getItem(KEYS.APPS_SCRIPT_URL) || '').trim();
    if (saved) return saved;
    if (localStorage.getItem(KEYS.DISABLE_DEFAULT_SHEET) === '1') {
      return '';
    }
    if (typeof window !== 'undefined' && isLocalOrigin(window.location)) {
      return '';
    }
    return (this.config.appsScriptUrl || '').trim();
  }

  setTeacherAppsScriptUrl(url) {
    const cleaned = String(url || '').trim();
    if (cleaned) {
      localStorage.setItem(KEYS.APPS_SCRIPT_URL, cleaned);
      localStorage.removeItem(KEYS.DISABLE_DEFAULT_SHEET);
    } else {
      localStorage.removeItem(KEYS.APPS_SCRIPT_URL);
      localStorage.setItem(KEYS.DISABLE_DEFAULT_SHEET, '1');
      this._localApiAvailable =
        typeof window !== 'undefined' && isStaticPublicHost(window.location.hostname)
          ? false
          : null;
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
    return typeof window !== 'undefined' && String(window.location?.protocol || '').startsWith('http')
      ? 'probing'
      : 'demo-localstorage';
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
    if (typeof window === 'undefined' || !String(window.location?.protocol || '').startsWith('http')) {
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
      const baseStudents = cached?.students || this.config.demoStudents || [];
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

  async getTeacherReport(weekId, teacherPin, { includeAllWeeks = false } = {}) {
    return this._callRemoteOrDemo('getTeacherReport', { weekId, teacherPin, includeAllWeeks });
  }

  async saveStudentRoster(teacherPin, students) {
    return this._callRemoteOrDemo('saveStudentRoster', { teacherPin, students });
  }

  async setActiveWeek(teacherPin, weekId) {
    return this._callRemoteOrDemo('setActiveWeek', { teacherPin, weekId });
  }

  async setWeekReleased(teacherPin, weekId, released) {
    return this._callRemoteOrDemo('setWeekReleased', { teacherPin, weekId, released });
  }

  async getParentReport(parentPin) {
    return this._callRemoteOrDemo('getParentReport', { parentPin });
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
      const teacherPin = String(existing.teacherPin || this.config.defaultTeacherPin || '885174').trim();
      const knownIds = new Set(existing.students.map((s) => s.studentId));
      const knownNames = new Set(existing.students.map((s) => String(s.name || '').trim().toLowerCase()));
      const usedParentPins = new Set();
      let changed = false;

      if (!Array.isArray(existing.releasedWeekIds)) {
        existing.releasedWeekIds = [];
        changed = true;
      }
      for (const st of existing.students) {
        const pPin = normalizeParentPinString(st.parentPin);
        if (/^\d{6}$/.test(pPin) && pPin !== teacherPin && !usedParentPins.has(pPin)) {
          if (st.parentPin !== pPin) {
            st.parentPin = pPin;
            changed = true;
          }
          usedParentPins.add(pPin);
        } else {
          st.parentPin = '';
        }
      }
      for (const st of existing.students) {
        if (!st.parentPin) {
          st.parentPin = generateUniqueParentPin(usedParentPins, teacherPin, st.studentId || st.name);
          changed = true;
        }
      }

      for (const st of (this.config.demoStudents || [])) {
        const nameKey = String(st.name || '').trim().toLowerCase();
        if (!knownIds.has(st.studentId) && !knownNames.has(nameKey)) {
          const explicitParent = normalizeParentPinString(st.parentPin);
          const parentPin = (/^\d{6}$/.test(explicitParent) && explicitParent !== teacherPin && !usedParentPins.has(explicitParent))
            ? (usedParentPins.add(explicitParent), explicitParent)
            : generateUniqueParentPin(usedParentPins, teacherPin, st.studentId || st.name);
          existing.students.push({
            studentId: st.studentId,
            name: st.name,
            avatar: st.avatar,
            pin: st.pin || '0000',
            parentPin,
            active: true
          });
          knownIds.add(st.studentId);
          knownNames.add(nameKey);
          changed = true;
        }
      }
      if (changed) {
        localStorage.setItem(KEYS.DEMO_DB, JSON.stringify(existing));
      }
      return existing;
    }
    const teacherPin = String(this.config.defaultTeacherPin || '885174').trim();
    const usedParentPins = new Set();
    const seeded = {
      activeWeekId: this.config.defaultWeekId,
      teacherPin,
      releasedWeekIds: [],
      students: (this.config.demoStudents || []).map((st) => {
        const explicitParent = normalizeParentPinString(st.parentPin);
        const parentPin = (/^\d{6}$/.test(explicitParent) && explicitParent !== teacherPin && !usedParentPins.has(explicitParent))
          ? (usedParentPins.add(explicitParent), explicitParent)
          : generateUniqueParentPin(usedParentPins, teacherPin, st.studentId || st.name);
        return {
          studentId: st.studentId,
          name: st.name,
          avatar: st.avatar,
          pin: st.pin || '0000',
          parentPin,
          active: true
        };
      }),
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
      const releasedWeekIds = Array.isArray(db.releasedWeekIds) ? [...db.releasedWeekIds] : [];
      const activeIds = new Set(db.students.filter((s) => s.active !== false).map((s) => s.studentId));
      const result = {
        ok: true,
        activeWeekId,
        weekId,
        releasedWeekIds,
        students: db.students.map((s) => ({
          ...s,
          pin: normalizePinString(s.pin),
          parentPin: normalizeParentPinString(s.parentPin)
        })),
        submissions: db.submissions.filter((s) => s.weekId === weekId && activeIds.has(s.studentId))
      };
      if (payload.includeAllWeeks) {
        result.allSubmissions = db.submissions.filter((s) => activeIds.has(s.studentId));
      }
      return result;
    }

    if (action === 'saveStudentRoster') {
      if (String(payload.teacherPin || '').trim() !== db.teacherPin) {
        return { ok: false, error: 'Incorrect Teacher PIN.' };
      }
      const teacherPin = String(db.teacherPin || '885174').trim();
      const usedIds = new Set();
      const usedParentPins = new Set();
      const normalizedIncoming = [];

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
        const rawParent = (st.parentPin !== undefined && st.parentPin !== null) ? String(st.parentPin).trim() : '';
        let parentPin = '';
        if (rawParent !== '') {
          parentPin = normalizeParentPinString(rawParent);
          if (!/^\d{6}$/.test(parentPin)) {
            return { ok: false, error: `Parent PIN for ${name} must be exactly 6 digits.` };
          }
          if (parentPin === teacherPin) {
            return { ok: false, error: `Parent PIN for ${name} cannot match the Teacher PIN.` };
          }
          if (usedParentPins.has(parentPin)) {
            return {
              ok: false,
              error: `Duplicate Parent PIN for ${name}. Each student needs a unique 6-digit Parent PIN.`
            };
          }
          usedParentPins.add(parentPin);
        }

        normalizedIncoming.push({
          studentId: sid,
          name,
          pin,
          parentPin,
          avatar: String(st.avatar || '🦊').trim() || '🦊',
          active: st.active !== false
        });
      }

      const nextStudents = normalizedIncoming.map((rec) => ({
        ...rec,
        parentPin: rec.parentPin || generateUniqueParentPin(usedParentPins, teacherPin)
      }));
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

    if (action === 'setWeekReleased') {
      if (String(payload.teacherPin || '').trim() !== db.teacherPin) {
        return { ok: false, error: 'Incorrect Teacher PIN.' };
      }
      const targetWeek = String(payload.weekId || '').trim();
      if (!targetWeek) {
        return { ok: false, error: 'weekId is required.' };
      }
      const released = Boolean(payload.released);
      const next = (Array.isArray(db.releasedWeekIds) ? db.releasedWeekIds : []).filter((w) => w !== targetWeek);
      if (released) next.push(targetWeek);
      db.releasedWeekIds = next;
      this._saveDemoDb(db);
      return { ok: true, releasedWeekIds: next };
    }

    if (action === 'getParentReport') {
      const now = Date.now();
      const cutoff = now - 60000;
      this._demoParentFailTimestamps = this._demoParentFailTimestamps.filter((ts) => ts > cutoff);
      if (this._demoParentFailTimestamps.length >= 10) {
        return {
          ok: false,
          error: 'Too many failed PIN attempts. Please wait a minute and try again.',
          rateLimited: true
        };
      }
      const matched = db.students.find(
        (s) => s.active !== false && isExactParentPinMatch(payload.parentPin, s.parentPin)
      );
      if (!matched) {
        this._demoParentFailTimestamps.push(now);
        return { ok: true, valid: false, student: null };
      }
      const releasedWeekIds = Array.isArray(db.releasedWeekIds) ? [...db.releasedWeekIds] : [];
      const releasedSet = new Set(releasedWeekIds);
      const activeIds = new Set(db.students.filter((s) => s.active !== false).map((s) => s.studentId));
      const subsByWeekAll = new Map();
      const submissionsByWeek = {};
      const unreleasedSubmittedWeekIds = [];
      const unreleasedSeen = new Set();

      for (const sub of db.submissions) {
        if (!activeIds.has(sub.studentId) || !sub.weekId) continue;
        if (!subsByWeekAll.has(sub.weekId)) subsByWeekAll.set(sub.weekId, []);
        subsByWeekAll.get(sub.weekId).push(sub);
        if (sub.studentId === matched.studentId) {
          if (releasedSet.has(sub.weekId)) {
            submissionsByWeek[sub.weekId] = { ...sub };
          } else if (!unreleasedSeen.has(sub.weekId)) {
            unreleasedSeen.add(sub.weekId);
            unreleasedSubmittedWeekIds.push(sub.weekId);
          }
        }
      }

      const cohortByWeek = {};
      for (const wid of releasedWeekIds) {
        cohortByWeek[wid] = computeCohortStatsForWeek(subsByWeekAll.get(wid) || []);
      }

      return {
        ok: true,
        valid: true,
        activeWeekId,
        releasedWeekIds,
        student: {
          studentId: matched.studentId,
          name: matched.name,
          avatar: matched.avatar || '🦊'
        },
        submissionsByWeek,
        unreleasedSubmittedWeekIds,
        cohortByWeek
      };
    }

    return { ok: false, error: `Unknown action: ${action}` };
  }
}
