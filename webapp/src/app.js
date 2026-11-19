import { APP_CONFIG } from '../config.js';
import { renderParentZone } from './parentView.js';
import { openPinModal } from './pinModal.js';
import { VALID_OPTIONS, computeStudentScore, normalizeChoice } from './scoring.js';
import { StorageClient } from './storage.js';
import { openPrintParentCardsModal, renderTeacherZone } from './teacherView.js';
import { escapeHtml, showToast } from './utils.js';

const storage = new StorageClient(APP_CONFIG);

const state = {
  screen: 'home', // 'home' | 'student' | 'celebration' | 'teacher' | 'parent-gate' | 'parent'
  packIndex: null,
  packsById: {},
  activeWeekId: APP_CONFIG.defaultWeekId,
  pack: null,
  roster: [],
  rosterOfflineFallback: false,

  // Active student session (cleared on exit/submit)
  student: null,
  studentPin: null,
  answers: {},
  currentQuestionIdx: 0,
  celebrationInfo: null,

  // Parent session (cleared on Lock & Exit)
  parentPin: null,
  parentReport: null,
  parentState: {
    activeTab: 'scores',
    chartMode: 'trajectory',
    selectedWeekId: null,
    reviewFilter: null,
    revealedSolutions: {},
    highlightQuestionKey: null
  },

  // Teacher session
  teacherPin: null,
  teacherReport: null,
  teacherState: {
    activeTab: 'ranking',
    whiteboardWeekId: null,
    whiteboardQuestionNum: null,
    revealGuide: false,
    showPins: false,
    autoRefresh: false,
    rosterDraft: [],
    connectionStatus: ''
  },
  autoRefreshTimer: null
};

const appEl = document.getElementById('app');

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load ${path} (${res.status})`);
  }
  return res.json();
}

function isParentUrlRoute() {
  if (typeof window === 'undefined' || !window.location) return false;
  const params = new URLSearchParams(window.location.search || '');
  return params.has('parent') || params.get('zone') === 'parent' || window.location.hash === '#parent';
}

function clearParentUrlRoute() {
  if (typeof window === 'undefined' || !window.history?.replaceState || !isParentUrlRoute()) return;
  window.history.replaceState({}, '', window.location.pathname || './');
}

function tierClass(points) {
  if (points === 3) return 'tier-3';
  if (points === 4) return 'tier-4';
  return 'tier-5';
}

function openZoomModal(imageUrl, title) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  let zoomPct = 100;

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    modalRoot.innerHTML = '';
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') cleanup();
  };
  document.addEventListener('keydown', onKeyDown);

  const renderZoom = () => {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-card zoom-modal">
          <div class="zoom-toolbar">
            <strong>${escapeHtml(title)}</strong>
            <div class="header-actions">
              <button type="button" class="btn btn-secondary btn-sm ${zoomPct === 100 ? 'btn-primary' : ''}" data-zoom="100">Fit</button>
              <button type="button" class="btn btn-secondary btn-sm ${zoomPct === 145 ? 'btn-primary' : ''}" data-zoom="145">1.5×</button>
              <button type="button" class="btn btn-secondary btn-sm ${zoomPct === 200 ? 'btn-primary' : ''}" data-zoom="200">2×</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="close-zoom">Done</button>
            </div>
          </div>
          <div class="zoom-viewport">
            <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" style="width:${zoomPct}%;" />
          </div>
        </div>
      </div>
    `;
    modalRoot.querySelectorAll('[data-zoom]').forEach((btn) => {
      btn.addEventListener('click', () => {
        zoomPct = Number(btn.dataset.zoom);
        renderZoom();
      });
    });
    modalRoot.querySelector('[data-action="close-zoom"]')?.addEventListener('click', cleanup);
    modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('modal-backdrop')) cleanup();
    });
  };
  renderZoom();
}

function openReviewModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot || !state.pack) return;

  const questions = state.pack.questions;
  const blankQuestions = questions.filter((q) => !normalizeChoice(state.answers[String(q.number)]));
  let submitting = false;

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    modalRoot.innerHTML = '';
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape' && !submitting) cleanup();
  };
  document.addEventListener('keydown', onKeyDown);

  const renderModal = () => {
    const tiles = questions.map((q, idx) => {
      const choice = normalizeChoice(state.answers[String(q.number)]);
      return `
        <button type="button" class="review-tile ${choice ? 'filled' : 'blank'}" data-jump-idx="${idx}">
          <span style="font-size:0.85rem; color:var(--ink-muted); font-weight:700;">#${q.number} · ${q.points}pt</span>
          <strong style="font-size:1.2rem;">${choice ? `(${escapeHtml(choice)})` : 'Blank'}</strong>
        </button>
      `;
    }).join('');

    const warning = blankQuestions.length > 0
      ? `<div class="review-warning">You left ${blankQuestions.length} question${blankQuestions.length === 1 ? '' : 's'} blank — submit anyway or tap any tile to go back!</div>`
      : `<div class="status-pill connected" style="margin-bottom:14px;">All 12 questions answered! Ready to turn in.</div>`;

    modalRoot.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Review & Submit">
        <div class="modal-card wide">
          <div class="modal-head">
            <div>
              <h3>Review Your Answers</h3>
              <p class="brand-subtitle">${escapeHtml(state.student.avatar)} ${escapeHtml(state.student.name)} · Tap any question to change it</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="close-review" ${submitting ? 'disabled' : ''}>✕</button>
          </div>
          ${warning}
          <div class="review-grid">${tiles}</div>
          <div class="problem-footer">
            <button type="button" class="btn btn-secondary" data-action="close-review" ${submitting ? 'disabled' : ''}>Go Back</button>
            <button type="button" class="btn btn-primary" data-action="confirm-submit" ${submitting ? 'disabled' : ''}>
              ${submitting ? 'Saving Answers…' : 'Submit My Answers ✓'}
            </button>
          </div>
        </div>
      </div>
    `;

    modalRoot.querySelectorAll('[data-jump-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (submitting) return;
        state.currentQuestionIdx = Number(btn.dataset.jumpIdx);
        cleanup();
        render();
      });
    });

    modalRoot.querySelectorAll('[data-action="close-review"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!submitting) cleanup();
      });
    });

    modalRoot.querySelector('[data-action="confirm-submit"]')?.addEventListener('click', async () => {
      if (submitting) return;
      submitting = true;
      renderModal();
      await performStudentSubmit(cleanup);
      submitting = false;
    });
  };

  renderModal();
}

async function performStudentSubmit(closeModalFn) {
  const scoreSummary = computeStudentScore(state.pack, state.answers);
  const res = await storage.submitAnswers({
    weekId: state.activeWeekId,
    studentId: state.student.studentId,
    pin: state.studentPin,
    answers: { ...state.answers },
    scoreSummary
  });

  if (!res.ok) {
    showToast(res.error || 'Could not save submission. Please ask your teacher.', 'error');
    closeModalFn();
    return;
  }

  closeModalFn();
  state.celebrationInfo = {
    studentName: state.student.name,
    avatar: state.student.avatar,
    answeredCount: state.pack.questions.filter((q) => normalizeChoice(state.answers[String(q.number)])).length,
    totalQuestions: state.pack.questions.length,
    queuedOffline: Boolean(res.queuedOffline),
    message: res.message || ''
  };

  // Clear student credentials immediately so shared tablets stay safe.
  state.student = null;
  state.studentPin = null;
  state.answers = {};
  state.screen = 'celebration';
  await refreshRosterOnly();
  render();
}

async function ensurePackLoaded(weekId) {
  if (!weekId) return null;
  if (state.packsById[weekId]) return state.packsById[weekId];
  if (!state.packIndex) {
    state.packIndex = await fetchJson('packs/index.json');
  }
  const packEntry = (state.packIndex.packs || []).find((p) => p.weekId === weekId);
  const packUrl = packEntry ? packEntry.packUrl : `packs/${weekId}/pack.json`;
  const loaded = await fetchJson(packUrl);
  state.packsById[weekId] = loaded;
  return loaded;
}

async function ensurePacksLoaded(weekIds) {
  const unique = Array.from(new Set((weekIds || []).filter(Boolean)));
  await Promise.all(
    unique.map((wid) => ensurePackLoaded(wid).catch(() => null))
  );
}

async function ensureAllPacksLoaded() {
  if (!state.packIndex) {
    state.packIndex = await fetchJson('packs/index.json');
  }
  const allIds = (state.packIndex.packs || []).map((p) => p.weekId);
  await ensurePacksLoaded(allIds);
}

async function loadPackAndRoster(preferredWeekId = null) {
  if (!state.packIndex) {
    state.packIndex = await fetchJson('packs/index.json');
  }
  const rosterRes = await storage.getPublicRoster(preferredWeekId || '');
  const resolvedWeekId =
    preferredWeekId ||
    rosterRes.activeWeekId ||
    state.packIndex.defaultWeekId ||
    APP_CONFIG.defaultWeekId;

  const pack = await ensurePackLoaded(resolvedWeekId);
  state.pack = pack;
  state.activeWeekId = resolvedWeekId;
  state.roster = rosterRes.students || [];
  state.rosterOfflineFallback = Boolean(rosterRes.offlineFallback);
}

async function refreshRosterOnly() {
  const rosterRes = await storage.getPublicRoster(state.activeWeekId);
  state.roster = rosterRes.students || [];
  state.rosterOfflineFallback = Boolean(rosterRes.offlineFallback);
}

async function handleRetrySync() {
  const res = await storage.flushPendingQueue();
  if (res.syncedCount > 0) {
    showToast(`Synced ${res.syncedCount} saved submission${res.syncedCount === 1 ? '' : 's'} to the sheet!`, 'success');
    await refreshRosterOnly();
    if (state.screen === 'teacher' && state.teacherPin) {
      await loadTeacherReport();
    }
  } else if (res.remainingCount > 0) {
    showToast('Still waiting for Wi-Fi connection. Answers stay safe on this tablet.', 'error');
  }
  render();
}

function handleStudentCardTap(student) {
  openPinModal({
    title: `${student.avatar} ${student.name}`,
    subtitle: 'Enter your 4-digit secret PIN',
    pinLength: 4,
    verifyFn: async (pin) => {
      const res = await storage.verifyStudentPin(student.studentId, pin, state.activeWeekId);
      if (!res.ok) {
        return { ok: false, error: res.error || 'Could not verify PIN.' };
      }
      if (!res.valid) {
        return { ok: false, error: 'Oops! That PIN does not match. Try again.' };
      }
      return { ok: true, data: res };
    },
    onSuccess: (verifiedPin, verified) => {
      const serverAnswers = verified.data?.existingAnswers || {};
      const draft = storage.loadDraft(state.activeWeekId, student.studentId);
      const mergedAnswers = (draft && draft.answers && Object.keys(draft.answers).length > 0)
        ? { ...serverAnswers, ...draft.answers }
        : { ...serverAnswers };

      state.student = verified.data?.student || student;
      state.studentPin = verifiedPin;
      state.answers = mergedAnswers;
      state.currentQuestionIdx = 0;
      state.screen = 'student';
      render();
    }
  });
}

function handleParentZoneTap() {
  openPinModal({
    title: '👪 Parent Zone',
    subtitle: 'Enter your family’s 6-digit Parent PIN',
    pinLength: 6,
    verifyFn: async (pin) => {
      const res = await storage.getParentReport(pin);
      if (!res.ok) {
        return { ok: false, error: res.error || 'Could not verify Parent PIN.' };
      }
      if (!res.valid) {
        return { ok: false, error: 'That 6-digit Parent PIN did not match. Please try again.' };
      }
      const needWeeks = [...(res.releasedWeekIds || []), ...(res.unreleasedSubmittedWeekIds || [])];
      await ensurePacksLoaded(needWeeks);
      return { ok: true, report: res };
    },
    onSuccess: (verifiedPin, result) => {
      const report = result.report;
      const released = report.releasedWeekIds || [];
      state.parentPin = verifiedPin;
      state.parentReport = report;
      state.parentState = {
        activeTab: 'scores',
        chartMode: 'trajectory',
        selectedWeekId: released.length > 0 ? released[released.length - 1] : null,
        reviewFilter: null,
        revealedSolutions: {},
        highlightQuestionKey: null
      };
      state.screen = 'parent';
      render();
    }
  });
}

async function refreshParentReport() {
  if (!state.parentPin) return;
  const res = await storage.getParentReport(state.parentPin);
  if (!res.ok || !res.valid) {
    showToast(res.error || 'Could not refresh Parent Zone.', 'error');
    return;
  }
  const needWeeks = [...(res.releasedWeekIds || []), ...(res.unreleasedSubmittedWeekIds || [])];
  await ensurePacksLoaded(needWeeks);
  state.parentReport = res;
  const released = res.releasedWeekIds || [];
  if (released.length > 0 && !released.includes(state.parentState.selectedWeekId)) {
    state.parentState.selectedWeekId = released[released.length - 1];
  }
}

function handleTeacherZoneTap() {
  openPinModal({
    title: '🔒 Teacher Zone',
    subtitle: 'Enter 6-digit Teacher PIN',
    pinLength: 6,
    verifyFn: async (pin) => {
      const res = await storage.getTeacherReport(state.activeWeekId, pin, { includeAllWeeks: true });
      if (!res.ok) {
        return { ok: false, error: res.error || 'Incorrect Teacher PIN.' };
      }
      await ensureAllPacksLoaded();
      return { ok: true, report: res };
    },
    onSuccess: (verifiedPin, result) => {
      state.teacherPin = verifiedPin;
      applyTeacherReport(result.report);
      state.screen = 'teacher';
      render();
    }
  });
}

function applyTeacherReport(report) {
  state.teacherReport = report;
  state.teacherState.rosterDraft = (report.students || []).map((s) => ({ ...s }));
  if (!state.teacherState.whiteboardWeekId) {
    state.teacherState.whiteboardWeekId = state.activeWeekId;
  }
  if (!state.teacherState.whiteboardQuestionNum && state.pack?.questions?.length) {
    state.teacherState.whiteboardQuestionNum = state.pack.questions[0].number;
  }
}

async function loadTeacherReport() {
  if (!state.teacherPin) return;
  const res = await storage.getTeacherReport(state.activeWeekId, state.teacherPin, { includeAllWeeks: true });
  if (res.ok) {
    await ensureAllPacksLoaded();
    applyTeacherReport(res);
  } else {
    showToast(res.error || 'Could not refresh report.', 'error');
  }
}

function generateDraftUniqueParentPin(rosterDraft, excludeIdx) {
  const teacherPin = String(state.teacherPin || APP_CONFIG.defaultTeacherPin || '885174').trim();
  const used = new Set();
  rosterDraft.forEach((row, i) => {
    if (i !== excludeIdx && row.parentPin) {
      used.add(String(row.parentPin).trim());
    }
  });
  for (let attempt = 0; attempt < 5000; attempt++) {
    const candidate = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    const isWeak = /^(\d)\1{5}$/.test(candidate) || candidate === '123456' || candidate === '654321';
    if (!isWeak && candidate !== teacherPin && !used.has(candidate)) {
      return candidate;
    }
  }
  return '000000';
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function syncAutoRefreshTimer() {
  stopAutoRefresh();
  if (state.screen === 'teacher' && state.teacherState.autoRefresh) {
    state.autoRefreshTimer = window.setInterval(async () => {
      if (state.screen === 'teacher' && state.teacherPin) {
        await loadTeacherReport();
        render();
      }
    }, 15000);
  }
}

// ---- Render Screens ----

function renderHomeScreen() {
  const pendingCount = storage.getPendingQueue().length;
  const backendMode = storage.getBackendMode();
  const statusCls = backendMode === 'apps-script' || backendMode === 'local-api' ? 'connected' : 'warn';

  const syncBanner = pendingCount > 0 ? `
    <div class="sync-banner">
      <div>
        <strong>Pending Sync (${pendingCount})</strong> — Saved safely on this tablet while Wi-Fi was offline.
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="retry-sync">Retry Sync Now</button>
    </div>
  ` : '';

  const cards = state.roster.length > 0
    ? state.roster.map((st) => {
        let badge = `<span class="pending-dot">Tap to start</span>`;
        if (st.queuedOffline) {
          badge = `<span class="submitted-badge queued-badge">Saved Locally ⏳</span>`;
        } else if (st.hasSubmitted) {
          badge = `<span class="submitted-badge">Submitted ✓</span>`;
        }
        return `
          <button type="button" class="student-card ${st.hasSubmitted ? 'submitted' : ''}" data-student-id="${escapeHtml(st.studentId)}">
            <div class="student-avatar" aria-hidden="true">${escapeHtml(st.avatar)}</div>
            <div class="student-name">${escapeHtml(st.name)}</div>
            ${badge}
          </button>
        `;
      }).join('')
    : `
      <div class="panel-card" style="grid-column: 1 / -1; text-align: center; padding: 32px 24px; margin-bottom: 0;">
        <div class="loading-icon" aria-hidden="true">${state.rosterOfflineFallback ? '📡' : '🦘'}</div>
        <h3 style="margin: 0 0 8px;">${state.rosterOfflineFallback ? 'Tablet is offline' : 'No student profiles loaded yet'}</h3>
        <p class="brand-subtitle" style="max-width: 460px; margin: 0 auto;">
          ${state.rosterOfflineFallback
            ? 'This tablet does not have a cached student roster yet. Once connected, tap Refresh Roster above.'
            : 'Tap Refresh Roster to load students from the connected sheet, or add students in Teacher Zone.'}
        </p>
      </div>
    `;

  appEl.innerHTML = `
    <header class="top-header">
      <div class="top-header-inner">
        <div class="brand-block">
          <div class="brand-badge" aria-hidden="true">🦘</div>
          <div>
            <h1 class="brand-title">${escapeHtml(state.pack?.title || 'Math Kangaroo Circle')}</h1>
            <p class="brand-subtitle">${escapeHtml(state.pack?.subtitle || '')}</p>
          </div>
        </div>
        <div class="header-actions">
          <span class="status-pill ${statusCls}">${escapeHtml(storage.getBackendLabel())}</span>
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-parent">👪 Parent Zone</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-teacher">🔒 Teacher Zone</button>
        </div>
      </div>
    </header>

    <main class="container">
      ${syncBanner}
      <div class="picker-intro">
        <div>
          <h2>Who is solving today?</h2>
          <p>Tap your name and enter your 4-digit PIN to begin or update your answers.</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-action="refresh-home">↻ Refresh Roster</button>
      </div>
      <section class="student-grid" aria-label="Student Profiles">
        ${cards}
      </section>
    </main>
  `;

  appEl.querySelector('[data-action="open-parent"]')?.addEventListener('click', handleParentZoneTap);
  appEl.querySelector('[data-action="open-teacher"]')?.addEventListener('click', handleTeacherZoneTap);
  appEl.querySelector('[data-action="retry-sync"]')?.addEventListener('click', handleRetrySync);
  appEl.querySelector('[data-action="refresh-home"]')?.addEventListener('click', async () => {
    await refreshRosterOnly();
    render();
  });
  appEl.querySelectorAll('[data-student-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const student = state.roster.find((s) => s.studentId === card.dataset.studentId);
      if (student) handleStudentCardTap(student);
    });
  });
}

function renderParentGateScreen() {
  const backendMode = storage.getBackendMode();
  const statusCls = backendMode === 'apps-script' || backendMode === 'local-api' ? 'connected' : 'warn';

  appEl.innerHTML = `
    <header class="top-header">
      <div class="top-header-inner">
        <div class="brand-block">
          <div class="brand-badge" aria-hidden="true">👪</div>
          <div>
            <h1 class="brand-title">Math Kangaroo Circle · Parent Zone</h1>
            <p class="brand-subtitle">Weekly scores, step-by-step explanations &amp; home practice</p>
          </div>
        </div>
        <div class="header-actions">
          <span class="status-pill ${statusCls}">${escapeHtml(storage.getBackendLabel())}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="back-home">← Classroom Home</button>
        </div>
      </div>
    </header>

    <main class="container">
      <section class="celebrate-wrap" style="border-color: var(--border);">
        <div class="celebrate-emoji" aria-hidden="true">👪</div>
        <h2>Welcome, Math Circle Families!</h2>
        <p>Enter the private 6-digit Parent PIN from your child&rsquo;s printed Parent Access Card to view released test results and hands-on tabletop tips.</p>
        <div class="header-actions" style="justify-content: center;">
          <button type="button" class="btn btn-primary" data-action="unlock-parent">🔐 Enter 6-Digit Parent PIN</button>
          <button type="button" class="btn btn-secondary" data-action="back-home">← Classroom Home</button>
        </div>
      </section>
    </main>
  `;

  appEl.querySelector('[data-action="unlock-parent"]')?.addEventListener('click', handleParentZoneTap);
  appEl.querySelectorAll('[data-action="back-home"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearParentUrlRoute();
      state.screen = 'home';
      render();
    });
  });
}

function renderStudentWorkspace() {
  const questions = state.pack.questions;
  const idx = Math.max(0, Math.min(state.currentQuestionIdx, questions.length - 1));
  const q = questions[idx];
  const answeredCount = questions.filter((item) => normalizeChoice(state.answers[String(item.number)])).length;
  const selected = normalizeChoice(state.answers[String(q.number)]);

  const stripHtml = [3, 4, 5].map((pts) => {
    const group = questions.filter((item) => item.points === pts);
    const pills = group.map((item) => {
      const qIdx = questions.findIndex((x) => x.number === item.number);
      const ans = normalizeChoice(state.answers[String(item.number)]);
      const cls = `${qIdx === idx ? 'active' : ''} ${ans ? 'answered' : ''}`;
      return `
        <button type="button" class="q-pill ${cls}" data-nav-idx="${qIdx}">
          <span>#${item.number}</span>
          ${ans ? `<span class="q-pill-choice">${escapeHtml(ans)}</span>` : ''}
        </button>
      `;
    }).join('');
    return `
      <div class="tier-group">
        <span class="tier-label ${tierClass(pts)}">${pts} pts</span>
        ${pills}
      </div>
    `;
  }).join('');

  const choiceButtons = VALID_OPTIONS.map((opt) => `
    <button
      type="button"
      class="choice-btn ${selected === opt ? 'selected' : ''}"
      data-choice="${opt}"
      aria-pressed="${selected === opt ? 'true' : 'false'}"
    >(${opt})</button>
  `).join('');

  const isFirst = idx === 0;
  const isLast = idx === questions.length - 1;

  appEl.innerHTML = `
    <header class="top-header">
      <div class="top-header-inner">
        <div class="brand-block">
          <div class="brand-badge" aria-hidden="true">${escapeHtml(state.student.avatar)}</div>
          <div>
            <h1 class="brand-title">${escapeHtml(state.student.name)}</h1>
            <p class="brand-subtitle">${answeredCount} / ${questions.length} answered · ${escapeHtml(state.pack.title)}</p>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="exit-student">Exit</button>
          <button type="button" class="btn btn-primary" data-action="open-review">Review &amp; Submit</button>
        </div>
      </div>
    </header>

    <main class="container">
      <nav class="q-strip-card" aria-label="Questions by point value">
        ${stripHtml}
      </nav>

      <article class="problem-card">
        <div class="problem-head">
          <div class="problem-title-wrap">
            <span class="problem-num-badge">Question #${q.number}</span>
            <span class="tier-label ${tierClass(q.points)}">${q.points} Points</span>
            <h2 class="problem-name">${escapeHtml(q.title)}</h2>
          </div>
        </div>

        <div class="diagram-frame" data-action="zoom-diagram">
          <img src="${escapeHtml(q.imageUrl)}" alt="Question ${q.number}: ${escapeHtml(q.promptSummary || q.title)}" />
          <div class="zoom-hint">🔍 Tap diagram to zoom</div>
        </div>

        <div class="answer-section-label">Choose your answer for Question #${q.number}</div>
        <div class="choices-row">
          ${choiceButtons}
          <button
            type="button"
            class="choice-btn choice-blank-btn ${selected === null ? 'selected' : ''}"
            data-action="leave-blank"
          >Leave Blank</button>
        </div>

        <div class="problem-footer">
          <button type="button" class="btn btn-secondary" data-action="prev-q" ${isFirst ? 'disabled' : ''}>
            ← Previous
          </button>
          <span class="brand-subtitle">Tap a selected letter again to clear it</span>
          ${isLast
            ? `<button type="button" class="btn btn-primary" data-action="open-review">Review &amp; Submit →</button>`
            : `<button type="button" class="btn btn-sage" data-action="next-q">Next →</button>`
          }
        </div>
      </article>
    </main>
  `;

  appEl.querySelectorAll('[data-nav-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentQuestionIdx = Number(btn.dataset.navIdx);
      render();
    });
  });

  appEl.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const opt = btn.dataset.choice;
      const key = String(q.number);
      if (normalizeChoice(state.answers[key]) === opt) {
        state.answers[key] = null;
      } else {
        state.answers[key] = opt;
      }
      storage.saveDraft(state.activeWeekId, state.student.studentId, state.answers);
      render();
    });
  });

  appEl.querySelector('[data-action="leave-blank"]')?.addEventListener('click', () => {
    state.answers[String(q.number)] = null;
    storage.saveDraft(state.activeWeekId, state.student.studentId, state.answers);
    render();
  });

  appEl.querySelector('[data-action="zoom-diagram"]')?.addEventListener('click', () => {
    openZoomModal(q.imageUrl, `Question #${q.number}: ${q.title}`);
  });

  appEl.querySelector('[data-action="prev-q"]')?.addEventListener('click', () => {
    if (state.currentQuestionIdx > 0) {
      state.currentQuestionIdx -= 1;
      render();
    }
  });

  appEl.querySelector('[data-action="next-q"]')?.addEventListener('click', () => {
    if (state.currentQuestionIdx < questions.length - 1) {
      state.currentQuestionIdx += 1;
      render();
    }
  });

  appEl.querySelectorAll('[data-action="open-review"]').forEach((btn) => {
    btn.addEventListener('click', openReviewModal);
  });

  appEl.querySelector('[data-action="exit-student"]')?.addEventListener('click', () => {
    state.student = null;
    state.studentPin = null;
    state.answers = {};
    state.screen = 'home';
    render();
  });
}

function renderCelebrationScreen() {
  const info = state.celebrationInfo || {};
  const offlineNote = info.queuedOffline
    ? `<div class="review-warning" style="margin-bottom:20px;">${escapeHtml(info.message || 'Saved safely on this tablet and will sync automatically when Wi-Fi returns.')}</div>`
    : `<p>Your answers are safely saved! Wait for the circle break to finish before we solve the trickiest puzzles together on the whiteboard.</p>`;

  appEl.innerHTML = `
    <main class="container">
      <section class="celebrate-wrap">
        <div class="celebrate-emoji" aria-hidden="true">🎉</div>
        <h2>Awesome work, ${escapeHtml(info.avatar || '')} ${escapeHtml(info.studentName || 'Math Explorer')}!</h2>
        <p>You turned in <strong>${info.answeredCount ?? 0} of ${info.totalQuestions ?? 12}</strong> answers.</p>
        ${offlineNote}
        <button type="button" class="btn btn-primary" data-action="done-next-student" style="min-width:240px;">
          Done — Next Student
        </button>
      </section>
    </main>
  `;

  appEl.querySelector('[data-action="done-next-student"]')?.addEventListener('click', async () => {
    state.celebrationInfo = null;
    state.screen = 'home';
    await refreshRosterOnly();
    render();
  });
}

function render() {
  syncAutoRefreshTimer();
  if (state.screen === 'student' && state.student && state.pack) {
    renderStudentWorkspace();
    return;
  }
  if (state.screen === 'celebration') {
    renderCelebrationScreen();
    return;
  }
  if (state.screen === 'parent' && state.parentPin && state.parentReport) {
    renderParentZone({
      appEl,
      packIndex: state.packIndex,
      packsById: state.packsById,
      report: state.parentReport,
      storage,
      parentState: state.parentState,
      handlers: {
        exitParent: async () => {
          state.parentPin = null;
          state.parentReport = null;
          state.parentState = {
            activeTab: 'scores',
            chartMode: 'trajectory',
            selectedWeekId: null,
            reviewFilter: null,
            revealedSolutions: {},
            highlightQuestionKey: null
          };
          clearParentUrlRoute();
          state.screen = 'home';
          await refreshRosterOnly();
          render();
        },
        refreshParentReport: async () => {
          await refreshParentReport();
          render();
          showToast('Parent report refreshed.');
        },
        switchTab: (tabId) => {
          state.parentState.activeTab = tabId;
          state.parentState.highlightQuestionKey = null;
          render();
        },
        setChartMode: (mode) => {
          state.parentState.chartMode = mode;
          render();
        },
        selectWeek: async (weekId) => {
          await ensurePackLoaded(weekId).catch(() => null);
          state.parentState.selectedWeekId = weekId;
          state.parentState.highlightQuestionKey = null;
          render();
        },
        setReviewFilter: (filter) => {
          state.parentState.reviewFilter = filter;
          state.parentState.highlightQuestionKey = null;
          render();
        },
        toggleRevealSolution: (key) => {
          state.parentState.revealedSolutions[key] = !state.parentState.revealedSolutions[key];
          render();
        },
        jumpToQuestionReview: async (weekId, qNum) => {
          await ensurePackLoaded(weekId).catch(() => null);
          state.parentState.selectedWeekId = weekId;
          state.parentState.activeTab = 'review';
          state.parentState.reviewFilter = 'needs-review';
          state.parentState.highlightQuestionKey = `${weekId}:${qNum}`;
          render();
          window.requestAnimationFrame(() => {
            const el = document.getElementById(`review-q-${weekId}-${qNum}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
              // Fallback to all if puzzle wasn't in needs-review filter
              state.parentState.reviewFilter = 'all';
              render();
              document.getElementById(`review-q-${weekId}-${qNum}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        },
        openZoom: (img, title) => openZoomModal(img, title)
      }
    });
    return;
  }
  if (state.screen === 'parent-gate') {
    renderParentGateScreen();
    return;
  }
  if (state.screen === 'teacher' && state.teacherPin && state.pack) {
    renderTeacherZone({
      appEl,
      pack: state.pack,
      packIndex: state.packIndex,
      packsById: state.packsById,
      activeWeekId: state.activeWeekId,
      report: state.teacherReport,
      storage,
      pendingCount: storage.getPendingQueue().length,
      teacherState: state.teacherState,
      handlers: {
        exitTeacher: async () => {
          state.teacherPin = null;
          state.teacherReport = null;
          state.teacherState.autoRefresh = false;
          state.teacherState.whiteboardWeekId = null;
          state.screen = 'home';
          await refreshRosterOnly();
          render();
        },
        refreshReport: async () => {
          await loadTeacherReport();
          render();
          showToast('Class report refreshed.');
        },
        retrySync: handleRetrySync,
        toggleAutoRefresh: (checked) => {
          state.teacherState.autoRefresh = checked;
          syncAutoRefreshTimer();
        },
        switchTab: (tabId) => {
          state.teacherState.activeTab = tabId;
          render();
        },
        openWhiteboard: async (qNum, wbWeekId) => {
          const targetWeek = wbWeekId || state.activeWeekId;
          const wbPack = await ensurePackLoaded(targetWeek).catch(() => state.pack);
          state.teacherState.activeTab = 'whiteboard';
          state.teacherState.whiteboardWeekId = targetWeek;
          state.teacherState.whiteboardQuestionNum = qNum || wbPack?.questions?.[0]?.number || null;
          state.teacherState.revealGuide = false;
          render();
        },
        selectWhiteboardQuestion: (qNum) => {
          state.teacherState.whiteboardQuestionNum = qNum;
          state.teacherState.revealGuide = false;
          render();
        },
        toggleGuide: () => {
          state.teacherState.revealGuide = !state.teacherState.revealGuide;
          render();
        },
        openZoom: (img, title) => openZoomModal(img, title),
        toggleShowPins: () => {
          state.teacherState.showPins = !state.teacherState.showPins;
          render();
        },
        addStudentRow: () => {
          state.teacherState.rosterDraft.push({
            studentId: '',
            name: '',
            pin: '0000',
            parentPin: generateDraftUniqueParentPin(state.teacherState.rosterDraft, -1),
            avatar: '🦊',
            active: true
          });
          render();
        },
        regenerateDraftParentPin: (idx) => {
          const row = state.teacherState.rosterDraft[idx];
          if (!row) return;
          row.parentPin = generateDraftUniqueParentPin(state.teacherState.rosterDraft, idx);
          render();
          showToast('Generated new 6-digit Parent PIN (remember to Save Roster).');
        },
        openPrintCards: () => {
          const savedStudents = state.teacherReport?.students || [];
          const normRow = (s) => `${s.studentId}|${s.name}|${s.pin}|${s.parentPin}|${s.avatar}|${s.active !== false}`;
          const draftChanged =
            savedStudents.length !== state.teacherState.rosterDraft.length ||
            savedStudents.some((s, i) => normRow(s) !== normRow(state.teacherState.rosterDraft[i] || {}));
          if (draftChanged) {
            showToast('Unsaved draft changes detected — showing currently saved PINs. Save Roster first if you edited PINs.', 'info', 4500);
          }
          openPrintParentCardsModal({ students: savedStudents });
        },
        updateDraftField: (idx, field, val) => {
          if (state.teacherState.rosterDraft[idx]) {
            state.teacherState.rosterDraft[idx][field] = val;
          }
        },
        saveRoster: async () => {
          const res = await storage.saveStudentRoster(state.teacherPin, state.teacherState.rosterDraft);
          if (!res.ok) {
            showToast(res.error || 'Could not save roster.', 'error');
            return;
          }
          showToast('Roster saved to sheet!', 'success');
          await loadTeacherReport();
          await refreshRosterOnly();
          render();
        },
        setActiveWeek: async (weekId) => {
          const res = await storage.setActiveWeek(state.teacherPin, weekId);
          if (!res.ok) {
            showToast(res.error || 'Could not change week.', 'error');
            return;
          }
          await loadPackAndRoster(weekId);
          await loadTeacherReport();
          state.teacherState.whiteboardWeekId = weekId;
          state.teacherState.whiteboardQuestionNum = state.pack?.questions?.[0]?.number || null;
          state.teacherState.revealGuide = false;
          showToast(`Active week set to ${weekId}.`, 'success');
          render();
        },
        setWeekReleased: async (weekId, released) => {
          const res = await storage.setWeekReleased(state.teacherPin, weekId, released);
          if (!res.ok) {
            showToast(res.error || 'Could not update parent release setting.', 'error');
            return;
          }
          await loadTeacherReport();
          showToast(
            released ? `Released ${weekId} to Parent Zone.` : `Locked ${weekId} in Parent Zone.`,
            'success'
          );
          render();
        },
        saveAndTestUrl: async (url) => {
          const test = await storage.testConnection(url);
          if (!test.ok) {
            state.teacherState.connectionStatus = `Connection failed: ${test.error}`;
            showToast(state.teacherState.connectionStatus, 'error');
            render();
            return;
          }
          storage.setTeacherAppsScriptUrl(url);
          state.teacherState.connectionStatus = `Connected! Found ${test.studentCount} active students (week: ${test.activeWeekId}).`;
          showToast('Connected to Google Sheet!', 'success');
          await loadPackAndRoster();
          await loadTeacherReport();
          render();
        },
        clearUrl: async () => {
          storage.setTeacherAppsScriptUrl('');
          state.teacherState.connectionStatus = 'Cleared custom URL. Using default local/demo backend.';
          await loadPackAndRoster();
          await loadTeacherReport();
          render();
        }
      }
    });
    return;
  }

  renderHomeScreen();
}

async function init() {
  try {
    await loadPackAndRoster();
    if (storage.getPendingQueue().length > 0 && storage.getBackendMode() !== 'demo-localstorage') {
      const flush = await storage.flushPendingQueue();
      if (flush.syncedCount > 0) {
        await refreshRosterOnly();
      }
    }
    window.addEventListener('online', () => {
      handleRetrySync();
    });

    if (isParentUrlRoute()) {
      state.screen = 'parent-gate';
      render();
      handleParentZoneTap();
      return;
    }

    render();
  } catch (err) {
    appEl.innerHTML = `
      <main class="loading-screen">
        <div class="loading-card">
          <div class="loading-icon" aria-hidden="true">⚠️</div>
          <h1>Could not start Math Kangaroo Circle</h1>
          <p>${escapeHtml(err?.message || String(err))}</p>
        </div>
      </main>
    `;
  }
}

init();
