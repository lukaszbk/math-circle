import { APP_CONFIG } from '../config.js';
import { renderQrSvg } from './qr.js';
import {
  QUESTION_CLASSES,
  computeCohortClassStats,
  getQuestionClassMeta
} from './questionClasses.js';
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

function shortWeekLabel(weekId) {
  const m = String(weekId || '').match(/^(\d{4})-g\d+-part(\d+)$/i);
  if (m) return `${m[1]} P${m[2]}`;
  return String(weekId || '');
}

export function getParentPortalUrl(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc) return '?parent';
  const base = `${loc.origin || ''}${loc.pathname || '/'}`;
  return `${base}?parent`;
}

export function openPrintParentCardsModal({ students, onClose }) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const activeStudents = (students || []).filter((s) => s.active !== false);
  const parentUrl = getParentPortalUrl();

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    modalRoot.innerHTML = '';
    if (onClose) onClose();
  };
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') cleanup();
  };
  document.addEventListener('keydown', onKeyDown);

  const cardsHtml = activeStudents.length === 0
    ? `<p class="brand-subtitle">No active students in roster yet.</p>`
    : activeStudents.map((st) => {
      const pPin = String(st.parentPin || '000000').padStart(6, '0');
      const digitBoxes = pPin
        .split('')
        .map((d) => `<span class="pin-box">${escapeHtml(d)}</span>`)
        .join('');
      const qrSvg = renderQrSvg(parentUrl, {
        sizePx: 112,
        quiet: 4,
        label: `Parent Zone QR for ${st.name}`
      });
      return `
        <article class="parent-print-card">
          <div class="print-card-top">
            <div>
              <div class="print-card-eyebrow">🦘 Math Kangaroo Circle · Parent Zone</div>
              <h4 class="print-card-name">${escapeHtml(st.avatar || '🦊')} ${escapeHtml(st.name)}</h4>
            </div>
          </div>
          <div class="print-card-body">
            <div class="print-card-qr">${qrSvg}</div>
            <div class="print-card-info">
              <div class="print-pin-label">6-Digit Family Parent PIN</div>
              <div class="print-pin-boxes" aria-label="Parent PIN ${escapeHtml(pPin)}">${digitBoxes}</div>
              <p class="print-card-url">${escapeHtml(parentUrl)}</p>
              <p class="print-card-note">Scan QR &amp; enter your private PIN to view released scores, step-by-step solutions, and at-home practice ideas.</p>
            </div>
          </div>
        </article>
      `;
    }).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop print-modal-backdrop" role="dialog" aria-modal="true" aria-label="Print Parent Access Cards">
      <div class="modal-card zoom-modal print-modal-card">
        <div class="modal-head no-print">
          <div>
            <h3>🖨️ Printable Parent Zone Access Cards (${activeStudents.length})</h3>
            <p class="brand-subtitle">Cut along borders (2×4 per page). Each card shows one family's private 6-digit Parent PIN.</p>
          </div>
          <div class="header-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="trigger-print">🖨️ Print Cards</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="close-print-cards">Done</button>
          </div>
        </div>
        <div class="print-cards-grid">
          ${cardsHtml}
        </div>
      </div>
    </div>
  `;

  modalRoot.querySelector('[data-action="trigger-print"]')?.addEventListener('click', () => {
    window.print();
  });
  modalRoot.querySelector('[data-action="close-print-cards"]')?.addEventListener('click', cleanup);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('modal-backdrop')) cleanup();
  });
}

function renderRankingTab(pack, report) {
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
            <strong>${submissions.length} of ${activeStudents.length}</strong> active students submitted
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
    const qc = q.questionClass ? getQuestionClassMeta(q.questionClass) : null;
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
            ${qc ? `<span class="tag-badge class-pill">${escapeHtml(qc.icon)} ${escapeHtml(qc.shortLabel)}</span>` : ''}
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

function renderWhiteboardTab(pack, packsById, activeWeekId, report, state) {
  const wbWeekId = state.whiteboardWeekId || activeWeekId;
  const wbPack = (packsById && packsById[wbWeekId]) || pack;
  const questions = wbPack?.questions || [];
  const activeNum = state.whiteboardQuestionNum || questions[0]?.number;
  const q = questions.find((item) => item.number === activeNum) || questions[0];
  if (!q) return '';

  const isActiveWeek = wbPack.weekId === activeWeekId;
  const subList = isActiveWeek
    ? (report?.submissions || [])
    : (report?.allSubmissions || []).filter((s) => s.weekId === wbPack.weekId);

  const triagedMap = new Map(
    triageQuestions(wbPack, subList).map((item) => [item.number, item])
  );
  const stats = triagedMap.get(q.number);
  const guide = q.teachingGuide || {};
  const qc = q.questionClass ? getQuestionClassMeta(q.questionClass) : null;

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

  const previewBanner = !isActiveWeek ? `
    <div class="sync-banner" style="margin-bottom:14px;">
      <div>Viewing <strong>${escapeHtml(wbPack.title)}</strong> on Whiteboard (student tablets stay on ${escapeHtml(activeWeekId)}).</div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="wb-reset-week">Return to Active Week</button>
    </div>
  ` : '';

  return `
    ${previewBanner}
    <div class="q-strip-card">${strip}</div>
    <section class="problem-card">
      <div class="problem-head">
        <div class="problem-title-wrap">
          <span class="problem-num-badge">Question #${q.number}</span>
          <span class="tier-label ${tierClass(q.points)}">${q.points} Points</span>
          ${qc ? `<span class="tag-badge class-pill">${escapeHtml(qc.icon)} ${escapeHtml(qc.label)}</span>` : ''}
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
  const liveSheetUrl = report?.sheetUrl || '';
  const liveSheetName = report?.sheetName || '';
  const hasLiveSheetUrl = liveSheetUrl.startsWith('https://');

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
          type="text"
          inputmode="numeric"
          maxlength="4"
          autocomplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          class="input-field input-pin ${showPins ? '' : 'pin-masked'}"
          data-field="pin"
          value="${escapeHtml(st.pin || '')}"
          placeholder="0000"
          aria-label="Student 4-digit PIN"
        />
      </td>
      <td>
        <div class="parent-pin-cell">
          <input
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            class="input-field input-parent-pin ${showPins ? '' : 'pin-masked'}"
            data-field="parentPin"
            value="${escapeHtml(st.parentPin || '')}"
            placeholder="auto-6"
            aria-label="Parent 6-digit PIN"
          />
          <button type="button" class="btn btn-ghost btn-sm" data-regen-parent-pin="${idx}" title="Regenerate unique 6-digit Parent PIN" aria-label="Regenerate Parent PIN">🎲</button>
        </div>
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
          <h2>Student Roster, PINs &amp; Parent Access</h2>
          <p class="brand-subtitle">Leading-zero 4-digit Student PINs and unique 6-digit Parent PINs are preserved as plain text.</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-show-pins">
            ${showPins ? '🙈 Hide PINs' : '👁️ Show PINs'}
          </button>
          <button type="button" class="btn btn-sage btn-sm" data-action="print-parent-cards">🖨️ Print Parent Cards</button>
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
              <th>Student PIN (4)</th>
              <th>Parent PIN (6)</th>
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
            ${hasLiveSheetUrl
              ? `Connected spreadsheet: <strong>${escapeHtml(liveSheetName || 'Google Sheet')}</strong>`
              : 'Paste your deployed Apps Script Web App <code>/exec</code> URL to sync tablets with your Google Sheet.'}
          </p>
        </div>
        ${hasLiveSheetUrl ? `
          <a
            class="btn btn-secondary btn-sm"
            href="${escapeHtml(liveSheetUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            style="text-decoration:none;"
          >Open Google Sheet ↗</a>
        ` : ''}
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

function renderMultiWeekTab(packIndex, packsById, report) {
  const packs = packIndex?.packs || [];
  const students = report?.students || [];
  const activeStudents = students.filter((s) => s.active !== false);
  const activeIdSet = new Set(activeStudents.map((s) => s.studentId));
  const releasedSet = new Set(report?.releasedWeekIds || []);
  const allSubs = (report?.allSubmissions || report?.submissions || []).filter((s) => activeIdSet.has(s.studentId));

  // 1. Parent Release Controls
  const subCountByWeek = {};
  for (const sub of allSubs) {
    subCountByWeek[sub.weekId] = (subCountByWeek[sub.weekId] || 0) + 1;
  }

  const releaseCards = packs.map((p) => {
    const isReleased = releasedSet.has(p.weekId);
    const count = subCountByWeek[p.weekId] || 0;
    return `
      <div class="release-card ${isReleased ? 'released' : ''}">
        <div>
          <div class="badge-row" style="margin-bottom:4px;">
            <strong>${escapeHtml(p.title)}</strong>
            <span class="tag-badge ${isReleased ? 'tag-ok' : 'tag-trap'}">
              ${isReleased ? '🔓 Released to Parents' : '🔒 Locked'}
            </span>
          </div>
          <p class="brand-subtitle" style="margin:0;">
            ${count} of ${activeStudents.length} active students submitted · ${escapeHtml(p.weekId)}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-sm ${isReleased ? 'btn-secondary' : 'btn-primary'}"
          data-toggle-release="${escapeHtml(p.weekId)}"
          data-next-released="${isReleased ? '0' : '1'}"
        >${isReleased ? '🔒 Lock Results' : '🔓 Release to Parents'}</button>
      </div>
    `;
  }).join('');

  // 2. Class-Wide Question-Class Accuracy + 3. Student x Class Heatmap
  const cohortStats = computeCohortClassStats({
    packs: packsById,
    allSubmissions: allSubs,
    students
  });

  const classBarsHtml = cohortStats.classesSortedWeakestFirst.length === 0
    ? `<p class="brand-subtitle" style="margin:0;">No multi-week submissions recorded for active students yet.</p>`
    : cohortStats.classesSortedWeakestFirst.map((cls) => {
      const barCls = cls.accuracyPct >= 75 ? 'child' : (cls.accuracyPct >= 50 ? 'warn' : 'focus');
      const toughestChips = cls.questions.slice(0, 3).map((q) => `
        <button
          type="button"
          class="chip-btn"
          data-open-wb-week="${escapeHtml(q.weekId)}"
          data-open-wb-q="${q.number}"
          title="Open ${escapeHtml(q.weekTitle)} #${q.number} on Whiteboard"
        >${escapeHtml(shortWeekLabel(q.weekId))} #${q.number} (${q.accuracyPct}%)</button>
      `).join('');

      return `
        <article class="triage-card">
          <div class="triage-top">
            <div class="badge-row">
              <strong>${escapeHtml(cls.icon)} ${escapeHtml(cls.label)}</strong>
              <span class="brand-subtitle">(${cls.correct}/${cls.total} attempts · <strong>${cls.accuracyPct}%</strong>)</span>
            </div>
          </div>
          <div class="compare-bar-track" style="margin-bottom:10px;">
            <div class="compare-bar-fill ${barCls}" style="width:${cls.accuracyPct}%"></div>
          </div>
          <div class="badge-row">
            <span class="brand-subtitle" style="font-size:0.82rem;">Toughest:</span>
            ${toughestChips}
          </div>
        </article>
      `;
    }).join('');

  const practicedClassIds = new Set(cohortStats.classesSortedWeakestFirst.map((c) => c.id));
  const heatmapClasses = QUESTION_CLASSES.filter((qc) => practicedClassIds.has(qc.id));
  const displayCols = heatmapClasses.length > 0 ? heatmapClasses : QUESTION_CLASSES;

  const subsByStudentId = {};
  for (const sub of allSubs) {
    if (!subsByStudentId[sub.studentId]) subsByStudentId[sub.studentId] = [];
    subsByStudentId[sub.studentId].push(sub);
  }

  const heatmapRows = activeStudents.length === 0
    ? `<tr><td colspan="${displayCols.length + 3}" style="text-align:center; padding:20px; color:var(--ink-muted);">No active students in roster.</td></tr>`
    : activeStudents.map((st) => {
      const stSubs = subsByStudentId[st.studentId] || [];
      const wksCount = stSubs.length;
      const avgScore = wksCount > 0
        ? (stSubs.reduce((acc, s) => acc + Number(s.totalScore || 0), 0) / wksCount).toFixed(1)
        : '—';
      const stMap = cohortStats.byStudentId[st.studentId] || {};
      const cells = displayCols.map((qc) => {
        const b = stMap[qc.id];
        if (!b || b.total === 0) {
          return `<td class="matrix-cell cell-blank">—</td>`;
        }
        const cls = b.pct >= 75 ? 'cell-ok' : (b.pct >= 50 ? 'cell-warn' : 'cell-wrong');
        return `<td class="matrix-cell ${cls}" title="${escapeHtml(qc.label)}: ${b.correct}/${b.total}">${b.pct}%<br/><small>${b.correct}/${b.total}</small></td>`;
      }).join('');
      return `
        <tr>
          <td><strong>${escapeHtml(st.avatar)} ${escapeHtml(st.name)}</strong></td>
          <td class="matrix-cell">${wksCount}</td>
          <td class="matrix-cell"><strong>${avgScore}</strong></td>
          ${cells}
        </tr>
      `;
    }).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Parent Zone Release Controls</h2>
          <p class="brand-subtitle">Packs stay locked to families until you release them after class whiteboard review.</p>
        </div>
      </div>
      <div class="release-list">${releaseCards}</div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Class-Wide Accuracy by Math Kangaroo Class</h2>
          <p class="brand-subtitle">Sorted weakest → strongest across all submitted sessions. Click a tough question chip to project it on Whiteboard.</p>
        </div>
      </div>
      <div class="triage-list">${classBarsHtml}</div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Student × Question-Class Mastery Heatmap</h2>
          <p class="brand-subtitle">Cumulative accuracy per student across all submitted packs.</p>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Student</th>
              <th class="matrix-cell">Wks</th>
              <th class="matrix-cell">Avg</th>
              ${displayCols.map((qc) => `<th class="matrix-cell">${escapeHtml(qc.icon)}<br/>${escapeHtml(qc.shortLabel)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${heatmapRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

export function renderTeacherZone({
  appEl,
  pack,
  packIndex,
  packsById,
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
    { id: 'roster', label: '4. Roster, PINs & Cards' },
    { id: 'topics', label: '5. Multi-Week & Topics' }
  ];

  let bodyHtml = '';
  if (teacherState.activeTab === 'ranking') {
    bodyHtml = renderRankingTab(pack, report);
  } else if (teacherState.activeTab === 'triage') {
    bodyHtml = renderTriageTab(pack, report);
  } else if (teacherState.activeTab === 'whiteboard') {
    bodyHtml = renderWhiteboardTab(pack, packsById, activeWeekId, report, teacherState);
  } else if (teacherState.activeTab === 'topics') {
    bodyHtml = renderMultiWeekTab(packIndex, packsById, report);
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
    btn.addEventListener('click', () => handlers.openWhiteboard(Number(btn.dataset.whiteboardQ), activeWeekId));
  });
  appEl.querySelectorAll('[data-open-wb]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.openWhiteboard(Number(btn.dataset.openWb), activeWeekId));
  });
  appEl.querySelectorAll('[data-open-wb-week]').forEach((btn) => {
    btn.addEventListener('click', () => {
      handlers.openWhiteboard(Number(btn.dataset.openWbQ), btn.dataset.openWbWeek);
    });
  });
  appEl.querySelector('[data-action="wb-reset-week"]')?.addEventListener('click', () => {
    handlers.openWhiteboard(null, activeWeekId);
  });
  appEl.querySelectorAll('[data-wb-select]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.selectWhiteboardQuestion(Number(btn.dataset.wbSelect)));
  });
  appEl.querySelector('[data-action="toggle-guide"]')?.addEventListener('click', handlers.toggleGuide);
  appEl.querySelector('[data-action="zoom-diagram"]')?.addEventListener('click', (ev) => {
    const el = ev.currentTarget;
    handlers.openZoom(el.dataset.img, el.dataset.title);
  });

  // Tab 5 release toggles
  appEl.querySelectorAll('[data-toggle-release]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.toggleRelease;
      const nextReleased = btn.dataset.nextReleased === '1';
      handlers.setWeekReleased(wid, nextReleased);
    });
  });

  // Roster tab handlers
  appEl.querySelector('[data-action="toggle-show-pins"]')?.addEventListener('click', handlers.toggleShowPins);
  appEl.querySelector('[data-action="print-parent-cards"]')?.addEventListener('click', handlers.openPrintCards);
  appEl.querySelector('[data-action="add-student-row"]')?.addEventListener('click', handlers.addStudentRow);
  appEl.querySelector('[data-action="save-roster"]')?.addEventListener('click', handlers.saveRoster);
  appEl.querySelectorAll('[data-regen-parent-pin]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.regenerateDraftParentPin(Number(btn.dataset.regenParentPin)));
  });
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
