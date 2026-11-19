import { APP_CONFIG } from '../config.js';
import { VALID_OPTIONS, rankSubmissions, triageQuestions } from './scoring.js';
import { escapeHtml } from './utils.js';

function tierClass(points) {
  if (points === 3) return 'tier-3';
  if (points === 4) return 'tier-4';
  return 'tier-5';
}

function rankBadgeClass(rank) {
  if (rank === 1) return 'top1';
  if (rank === 2) return 'top2';
  if (rank === 3) return 'top3';
  return '';
}

function renderRankingTab(pack, report, onOpenWhiteboard) {
  const students = report?.students || [];
  const activeStudents = students.filter((s) => s.active !== false);
  const submissions = report?.submissions || [];
  const ranked = rankSubmissions(students, submissions, pack);
  const questions = pack?.questions || [];

  const avgScore = ranked.length > 0
    ? (ranked.reduce((acc, r) => acc + r.totalScore, 0) / ranked.length).toFixed(1)
    : '—';

  const leaderboardRows = ranked.length === 0
    ? `<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--ink-muted);">No submissions yet for this week.</td></tr>`
    : ranked.map((r) => `
      <tr>
        <td><span class="rank-pill ${rankBadgeClass(r.rank)}">${r.rank}</span></td>
        <td><strong>${escapeHtml(r.avatar)} ${escapeHtml(r.studentName)}</strong></td>
        <td><strong>${r.totalScore}</strong> / ${r.maxScore}</td>
        <td>${r.score3pt} / 12</td>
        <td>${r.score4pt} / 16</td>
        <td>${r.score5pt} / 20</td>
        <td>${r.correctCount} ✓ · ${r.wrongCount} ✗ · ${r.blankCount} —</td>
      </tr>
    `).join('');

  const matrixHeaders = questions.map((q) => `
    <th class="matrix-cell">
      <button type="button" class="q-col-btn" data-whiteboard-q="${q.number}" title="Open Q${q.number} on Whiteboard">
        #${q.number}<br/><small>${q.points}pt</small>
      </button>
    </th>
  `).join('');

  const matrixRows = ranked.length === 0
    ? ''
    : ranked.map((r) => {
      const cells = questions.map((q) => {
        const detail = r.perQuestion[String(q.number)] || { status: 'blank', selected: null };
        if (detail.status === 'correct') {
          return `<td class="matrix-cell cell-ok" title="#${q.number}: Correct (${detail.selected})">✓</td>`;
        }
        if (detail.status === 'wrong') {
          return `<td class="matrix-cell cell-wrong" title="#${q.number}: Picked ${detail.selected}, Answer ${detail.correctOption}">✗ ${escapeHtml(detail.selected)}</td>`;
        }
        return `<td class="matrix-cell cell-blank" title="#${q.number}: Blank">—</td>`;
      }).join('');
      return `
        <tr>
          <td><strong>${escapeHtml(r.avatar)} ${escapeHtml(r.studentName)}</strong></td>
          <td><strong>${r.totalScore}</strong></td>
          ${cells}
        </tr>
      `;
    }).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Class Ranking</h2>
          <p class="brand-subtitle">
            <strong>${submissions.length} of ${activeStudents.length}</strong> students submitted
            · Class average: <strong>${avgScore} / ${pack.maxScore}</strong>
          </p>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Student</th>
              <th>Score / ${pack.maxScore}</th>
              <th>3-pt</th>
              <th>4-pt</th>
              <th>5-pt</th>
              <th>Correct / Wrong / Blank</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h3>Student × Question Matrix</h3>
          <p class="brand-subtitle">Tap any question number header to project it on the Whiteboard tab.</p>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Total</th>
              ${matrixHeaders}
            </tr>
          </thead>
          <tbody>
            ${matrixRows || `<tr><td colspan="${questions.length + 2}" style="text-align:center; padding:20px; color:var(--ink-muted);">Waiting for first student submission.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderTriageTab(pack, report) {
  const submissions = report?.submissions || [];
  const triaged = triageQuestions(pack, submissions);

  const cards = triaged.map((q) => {
    const pct = q.submittedCount > 0 ? Math.round(q.accuracyRate * 100) : 0;
    const trapBadges = q.commonTraps.map(
      (t) => `<span class="tag-badge tag-trap">Common Trap: ${t.count} picked (${escapeHtml(t.option)})</span>`
    ).join('');

    const trapOpts = new Set(q.commonTraps.map((t) => t.option));
    const distPills = [...VALID_OPTIONS, 'blank'].map((opt) => {
      const count = q.optionCounts[opt] || 0;
      const isCorrect = opt === q.correctOption;
      const isTrap = trapOpts.has(opt);
      const cls = isCorrect ? 'correct-opt' : (isTrap ? 'trap-opt' : '');
      const label = opt === 'blank' ? 'Blank' : `(${opt})`;
      return `<div class="dist-pill ${cls}"><div>${label}${isCorrect ? ' ✓' : ''}</div><strong>${count}</strong></div>`;
    }).join('');

    return `
      <article class="triage-card ${q.solveTogether ? 'flagged' : ''}">
        <div class="triage-top">
          <div class="badge-row">
            <span class="problem-num-badge">#${q.number}</span>
            <span class="tier-label ${tierClass(q.points)}">${q.points} pts</span>
            <strong>${escapeHtml(q.title)}</strong>
            ${q.solveTogether ? `<span class="tag-badge tag-solve">Solve Together</span>` : ''}
            ${q.submittedCount > 0 && !q.solveTogether ? `<span class="tag-badge tag-ok">${pct}% correct</span>` : ''}
            ${trapBadges}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-open-wb="${q.number}">
            Open on Whiteboard →
          </button>
        </div>
        <p class="brand-subtitle" style="margin:0;">
          Missed by <strong>${q.missedCount}</strong> of ${q.submittedCount} submitted
          (${q.wrongCount} wrong, ${q.blankCount} blank) · ${escapeHtml(q.promptSummary)}
        </p>
        <div class="dist-bar">${distPills}</div>
      </article>
    `;
  }).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>"Solve Together" Whiteboard Agenda</h2>
          <p class="brand-subtitle">Questions sorted by missed count, wrong count, and point tier.</p>
        </div>
      </div>
      <div class="triage-list">${cards}</div>
    </section>
  `;
}

function renderWhiteboardTab(pack, report, state) {
  const questions = pack?.questions || [];
  const activeNum = state.whiteboardQuestionNum || questions[0]?.number;
  const q = questions.find((item) => item.number === activeNum) || questions[0];
  if (!q) return '';

  const triagedMap = new Map(
    triageQuestions(pack, report?.submissions || []).map((item) => [item.number, item])
  );
  const stats = triagedMap.get(q.number);
  const guide = q.teachingGuide || {};

  const strip = [3, 4, 5].map((pts) => {
    const group = questions.filter((item) => item.points === pts);
    const pills = group.map((item) => `
      <button
        type="button"
        class="q-pill ${item.number === q.number ? 'active' : ''}"
        data-wb-select="${item.number}"
      >#${item.number}</button>
    `).join('');
    return `
      <div class="tier-group">
        <span class="tier-label ${tierClass(pts)}">${pts} pts</span>
        ${pills}
      </div>
    `;
  }).join('');

  const guideHtml = state.revealGuide ? `
    <div class="guide-panel">
      <div class="panel-head" style="margin-bottom:10px;">
        <div class="badge-row">
          <span class="tag-badge tag-ok" style="font-size:0.95rem;">Verified Answer: (${escapeHtml(q.correctOption)})</span>
          ${stats && stats.submittedCount > 0 ? `<span class="status-pill">${stats.correctCount}/${stats.submittedCount} students solved</span>` : ''}
          ${(stats?.commonTraps || []).map((t) => `<span class="tag-badge tag-trap">${t.count} picked (${escapeHtml(t.option)})</span>`).join('')}
        </div>
      </div>
      <p class="guide-headline">Core Idea: ${escapeHtml(guide.headline || '')}</p>
      <div class="guide-cols">
        <div class="guide-box">
          <h4>Whiteboard Walkthrough</h4>
          <ol>${(guide.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
        </div>
        <div class="guide-box">
          <h4>Ask the Circle</h4>
          <ul>${(guide.askTheKids || []).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
          <h4 style="margin-top:14px;">Common Traps</h4>
          <p style="margin:0;">${escapeHtml(guide.commonTraps || '')}</p>
        </div>
      </div>
    </div>
  ` : '';

  return `
    <div class="q-strip-card">${strip}</div>
    <section class="problem-card">
      <div class="problem-head">
        <div class="problem-title-wrap">
          <span class="problem-num-badge">Question #${q.number}</span>
          <span class="tier-label ${tierClass(q.points)}">${q.points} Points</span>
          <h2 class="problem-name">${escapeHtml(q.title)}</h2>
        </div>
        <button type="button" class="btn ${state.revealGuide ? 'btn-secondary' : 'btn-sage'}" data-action="toggle-guide">
          ${state.revealGuide ? '🙈 Hide Solution & Guide' : '💡 Reveal AI Solution & 3rd-Grade Guide'}
        </button>
      </div>

      <div class="diagram-frame" data-action="zoom-diagram" data-img="${escapeHtml(q.imageUrl)}" data-title="Question #${q.number}: ${escapeHtml(q.title)}">
        <img src="${escapeHtml(q.imageUrl)}" alt="Question ${q.number}: ${escapeHtml(q.promptSummary || q.title)}" />
        <div class="zoom-hint">🔍 Tap diagram to zoom</div>
      </div>

      ${guideHtml}
    </section>
  `;
}

function renderRosterTab(packIndex, activeWeekId, report, storage, state) {
  const draftRoster = state.rosterDraft || [];
  const showPins = state.showPins;
  const configuredUrl = storage.getConfiguredAppsScriptUrl();
  const packs = packIndex?.packs || [];

  const rows = draftRoster.map((st, idx) => `
    <tr data-roster-idx="${idx}">
      <td>
        <input type="text" class="input-field input-avatar" data-field="avatar" value="${escapeHtml(st.avatar || '🦊')}" maxlength="4" aria-label="Avatar" />
      </td>
      <td>
        <input type="text" class="input-field" data-field="name" value="${escapeHtml(st.name || '')}" placeholder="Student full name" />
      </td>
      <td>
        <input type="text" class="input-field" data-field="studentId" value="${escapeHtml(st.studentId || '')}" placeholder="auto-slug" />
      </td>
      <td>
        <input
          type="${showPins ? 'text' : 'password'}"
          inputmode="numeric"
          maxlength="4"
          class="input-field input-pin"
          data-field="pin"
          value="${escapeHtml(st.pin || '')}"
          placeholder="0000"
        />
      </td>
      <td style="text-align:center;">
        <input type="checkbox" data-field="active" ${st.active !== false ? 'checked' : ''} aria-label="Active" style="width:22px; height:22px;" />
      </td>
    </tr>
  `).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Student Roster &amp; 4-Digit PINs</h2>
          <p class="brand-subtitle">Leading-zero PINs like <code>0412</code> are preserved as 4-character text.</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-show-pins">
            ${showPins ? '🙈 Hide PINs' : '👁️ Show PINs'}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="add-student-row">+ Add Student</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="save-roster">Save Roster to Sheet</button>
        </div>
      </div>

      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Avatar</th>
              <th>Name</th>
              <th>Student ID</th>
              <th>4-Digit PIN</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h3>Active Question Pack</h3>
          <p class="brand-subtitle">Switch which weekly Question Pack tablets open automatically.</p>
        </div>
      </div>
      <div class="settings-row">
        <select id="week-select" class="input-field" aria-label="Active Week Pack">
          ${packs.map((p) => `
            <option value="${escapeHtml(p.weekId)}" ${p.weekId === activeWeekId ? 'selected' : ''}>
              ${escapeHtml(p.title)} (${escapeHtml(p.weekId)})
            </option>
          `).join('')}
        </select>
        <button type="button" class="btn btn-secondary" data-action="apply-active-week">Set Active Week</button>
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h3>Google Sheet &amp; Apps Script Bridge</h3>
          <p class="brand-subtitle">
            Linked spreadsheet: <strong>Math Circle 2026/2027</strong> (<code>${escapeHtml(APP_CONFIG.spreadsheetId)}</code>)
          </p>
        </div>
        <a
          class="btn btn-secondary btn-sm"
          href="${escapeHtml(APP_CONFIG.sheetUrl)}"
          target="_blank"
          rel="noopener noreferrer"
          style="text-decoration:none;"
        >Open Google Sheet ↗</a>
      </div>

      ${!configuredUrl && APP_CONFIG.appsScriptUrl ? `
        <p class="brand-subtitle" style="margin:0 0 10px;">
          Local &amp; dev runs default to <strong>Local Server / Demo Mode</strong> so test submissions don&rsquo;t write to the live sheet.
        </p>
      ` : ''}

      <div class="settings-row">
        <input
          id="apps-script-url-input"
          type="url"
          class="input-field"
          placeholder="https://script.google.com/macros/s/.../exec"
          value="${escapeHtml(configuredUrl)}"
        />
        <button type="button" class="btn btn-sage" data-action="save-test-url">Save &amp; Test Connection</button>
        ${!configuredUrl && APP_CONFIG.appsScriptUrl ? `<button type="button" class="btn btn-secondary" data-action="connect-default-sheet">Connect Live Sheet</button>` : ''}
        ${configuredUrl ? `<button type="button" class="btn btn-ghost" data-action="clear-url">Disconnect / Use Local</button>` : ''}
      </div>
      ${state.connectionStatus ? `<p class="brand-subtitle" style="margin-top:10px;"><strong>${escapeHtml(state.connectionStatus)}</strong></p>` : ''}
    </section>
  `;
}

export function renderTeacherZone({
  appEl,
  pack,
  packIndex,
  activeWeekId,
  report,
  storage,
  pendingCount,
  teacherState,
  handlers
}) {
  const tabs = [
    { id: 'ranking', label: '1. Class Ranking & Matrix' },
    { id: 'triage', label: '2. Solve Together Agenda' },
    { id: 'whiteboard', label: '3. Whiteboard & AI Guide' },
    { id: 'roster', label: '4. Roster, PINs & Sheet Link' }
  ];

  let bodyHtml = '';
  if (teacherState.activeTab === 'ranking') {
    bodyHtml = renderRankingTab(pack, report, handlers.openWhiteboard);
  } else if (teacherState.activeTab === 'triage') {
    bodyHtml = renderTriageTab(pack, report);
  } else if (teacherState.activeTab === 'whiteboard') {
    bodyHtml = renderWhiteboardTab(pack, report, teacherState);
  } else {
    bodyHtml = renderRosterTab(packIndex, activeWeekId, report, storage, teacherState);
  }

  const syncBanner = pendingCount > 0 ? `
    <div class="sync-banner">
      <div><strong>Pending Sync (${pendingCount}):</strong> Local submissions waiting to sync from this tablet.</div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="retry-sync">Retry Sync Now</button>
    </div>
  ` : '';

  appEl.innerHTML = `
    <header class="top-header">
      <div class="top-header-inner">
        <div class="brand-block">
          <div class="brand-badge" aria-hidden="true">🍎</div>
          <div>
            <h1 class="brand-title">Teacher Zone · ${escapeHtml(pack.title)}</h1>
            <p class="brand-subtitle">${escapeHtml(storage.getBackendLabel())}</p>
          </div>
        </div>
        <div class="header-actions">
          <label class="status-pill" style="cursor:pointer;">
            <input type="checkbox" data-action="toggle-auto-refresh" ${teacherState.autoRefresh ? 'checked' : ''} />
            Auto-Refresh
          </label>
          <button type="button" class="btn btn-secondary btn-sm" data-action="refresh-report">↻ Refresh</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="exit-teacher">Exit to Student Picker</button>
        </div>
      </div>
    </header>

    <main class="container">
      ${syncBanner}
      <nav class="teacher-tabs" aria-label="Teacher Zone Sections">
        ${tabs.map((t) => `
          <button
            type="button"
            class="tab-btn ${teacherState.activeTab === t.id ? 'active' : ''}"
            data-tab="${t.id}"
          >${escapeHtml(t.label)}</button>
        `).join('')}
      </nav>
      ${bodyHtml}
    </main>
  `;

  appEl.querySelector('[data-action="exit-teacher"]')?.addEventListener('click', handlers.exitTeacher);
  appEl.querySelector('[data-action="refresh-report"]')?.addEventListener('click', handlers.refreshReport);
  appEl.querySelector('[data-action="retry-sync"]')?.addEventListener('click', handlers.retrySync);
  appEl.querySelector('[data-action="toggle-auto-refresh"]')?.addEventListener('change', (ev) => {
    handlers.toggleAutoRefresh(ev.target.checked);
  });

  appEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.switchTab(btn.dataset.tab));
  });
  appEl.querySelectorAll('[data-whiteboard-q]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.openWhiteboard(Number(btn.dataset.whiteboardQ)));
  });
  appEl.querySelectorAll('[data-open-wb]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.openWhiteboard(Number(btn.dataset.openWb)));
  });
  appEl.querySelectorAll('[data-wb-select]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.selectWhiteboardQuestion(Number(btn.dataset.wbSelect)));
  });
  appEl.querySelector('[data-action="toggle-guide"]')?.addEventListener('click', handlers.toggleGuide);
  appEl.querySelector('[data-action="zoom-diagram"]')?.addEventListener('click', (ev) => {
    const el = ev.currentTarget;
    handlers.openZoom(el.dataset.img, el.dataset.title);
  });

  // Roster tab handlers
  appEl.querySelector('[data-action="toggle-show-pins"]')?.addEventListener('click', handlers.toggleShowPins);
  appEl.querySelector('[data-action="add-student-row"]')?.addEventListener('click', handlers.addStudentRow);
  appEl.querySelector('[data-action="save-roster"]')?.addEventListener('click', handlers.saveRoster);
  appEl.querySelector('[data-action="apply-active-week"]')?.addEventListener('click', () => {
    const sel = appEl.querySelector('#week-select');
    if (sel) handlers.setActiveWeek(sel.value);
  });
  appEl.querySelector('[data-action="save-test-url"]')?.addEventListener('click', () => {
    const input = appEl.querySelector('#apps-script-url-input');
    handlers.saveAndTestUrl(input ? input.value : '');
  });
  appEl.querySelector('[data-action="connect-default-sheet"]')?.addEventListener('click', () => {
    const defaultUrl = APP_CONFIG.appsScriptUrl || '';
    const input = appEl.querySelector('#apps-script-url-input');
    if (input) input.value = defaultUrl;
    handlers.saveAndTestUrl(defaultUrl);
  });
  appEl.querySelector('[data-action="clear-url"]')?.addEventListener('click', handlers.clearUrl);

  appEl.querySelectorAll('tr[data-roster-idx] [data-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const idx = Number(input.closest('tr').dataset.rosterIdx);
      const field = input.dataset.field;
      const val = input.type === 'checkbox' ? input.checked : input.value;
      handlers.updateDraftField(idx, field, val);
    });
    input.addEventListener('change', () => {
      const idx = Number(input.closest('tr').dataset.rosterIdx);
      const field = input.dataset.field;
      const val = input.type === 'checkbox' ? input.checked : input.value;
      handlers.updateDraftField(idx, field, val);
    });
  });
}
