import { APP_CONFIG } from '../config.js';
import { openPinModal } from './pinModal.js';
import { VALID_OPTIONS, computeStudentScore, normalizeChoice } from './scoring.js';
import { StorageClient } from './storage.js';
import { renderTeacherZone } from './teacherView.js';
import { escapeHtml, showToast } from './utils.js';

const storage = new StorageClient(APP_CONFIG);

const state = {
  screen: 'home', // 'home' | 'student' | 'celebration' | 'teacher'
  packIndex: null,
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

  // Teacher session
  teacherPin: null,
  teacherReport: null,
  teacherState: {
    activeTab: 'ranking',
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

  const packEntry = (state.packIndex.packs || []).find((p) => p.weekId === resolvedWeekId);
  const packUrl = packEntry ? packEntry.packUrl : `packs/${resolvedWeekId}/pack.json`;

  if (!state.pack || state.pack.weekId !== resolvedWeekId) {
    state.pack = await fetchJson(packUrl);
  }
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

function handleTeacherZoneTap() {
  openPinModal({
    title: '🔒 Teacher Zone',
    subtitle: 'Enter 6-digit Teacher PIN',
    pinLength: 6,
    verifyFn: async (pin) => {
      const res = await storage.getTeacherReport(state.activeWeekId, pin);
      if (!res.ok) {
        return { ok: false, error: res.error || 'Incorrect Teacher PIN.' };
      }
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
  if (!state.teacherState.whiteboardQuestionNum && state.pack?.questions?.length) {
    state.teacherState.whiteboardQuestionNum = state.pack.questions[0].number;
  }
}

async function loadTeacherReport() {
  if (!state.teacherPin) return;
  const res = await storage.getTeacherReport(state.activeWeekId, state.teacherPin);
  if (res.ok) {
    applyTeacherReport(res);
  } else {
    showToast(res.error || 'Could not refresh report.', 'error');
  }
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
  if (state.screen === 'teacher' && state.teacherPin && state.pack) {
    renderTeacherZone({
      appEl,
      pack: state.pack,
      packIndex: state.packIndex,
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
        openWhiteboard: (qNum) => {
          state.teacherState.activeTab = 'whiteboard';
          state.teacherState.whiteboardQuestionNum = qNum;
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
            avatar: '🦊',
            active: true
          });
          render();
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
          state.teacherState.whiteboardQuestionNum = state.pack?.questions?.[0]?.number || null;
          state.teacherState.revealGuide = false;
          showToast(`Active week set to ${weekId}.`, 'success');
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
