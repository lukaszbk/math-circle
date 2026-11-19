import {
  HOME_PLAYBOOKS,
  computeStudentClassMastery,
  getQuestionClassMeta
} from './questionClasses.js';
import { normalizeChoice } from './scoring.js';
import { escapeHtml } from './utils.js';

function tierClass(points) {
  if (points === 3) return 'tier-3';
  if (points === 4) return 'tier-4';
  return 'tier-5';
}

function getTimelineWeeks(packIndex, report) {
  const indexPacks = packIndex?.packs || [];
  const releasedSet = new Set(report?.releasedWeekIds || []);
  const unreleasedSet = new Set(report?.unreleasedSubmittedWeekIds || []);
  const relevant = new Set([...releasedSet, ...unreleasedSet]);

  const ordered = [];
  const seen = new Set();
  for (const p of indexPacks) {
    if (relevant.has(p.weekId)) {
      ordered.push({ weekId: p.weekId, title: p.title, maxScore: p.maxScore || 48 });
      seen.add(p.weekId);
    }
  }
  for (const wid of relevant) {
    if (!seen.has(wid)) {
      ordered.push({ weekId: wid, title: wid, maxScore: 48 });
      seen.add(wid);
    }
  }
  return ordered;
}

function shortWeekLabel(weekId, title) {
  const m = String(weekId || '').match(/^(\d{4})-g\d+-part(\d+)$/i);
  if (m) return `${m[1]} P${m[2]}`;
  return String(title || weekId).slice(0, 12);
}

function renderTrajectorySvg(timeline, report, selectedWeekId) {
  const W = 640;
  const H = 248;
  const padL = 44;
  const padR = 28;
  const padT = 26;
  const padB = 52;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxY = 48;

  const yFor = (val) => padT + plotH - (Math.max(0, Math.min(maxY, val)) / maxY) * plotH;
  const n = timeline.length;
  const xFor = (idx) => (n === 1 ? padL + plotW / 2 : padL + (idx / (n - 1)) * plotW);

  const releasedSet = new Set(report?.releasedWeekIds || []);
  const subsByWeek = report?.submissionsByWeek || {};
  const cohortByWeek = report?.cohortByWeek || {};

  // Gridlines
  const gridTicks = [0, 12, 24, 36, 48];
  const gridSvg = gridTicks
    .map((tick) => {
      const y = yFor(tick).toFixed(1);
      return `
        <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#E5DDD0" stroke-width="1" />
        <text x="${padL - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5B6572" font-weight="700">${tick}</text>
      `;
    })
    .join('');

  // P25-P75 shaded ribbon across contiguous released weeks with minCohortMet
  let ribbonSvg = '';
  const bandSegments = [];
  let currentSeg = [];
  timeline.forEach((w, idx) => {
    const cohort = cohortByWeek[w.weekId];
    if (releasedSet.has(w.weekId) && cohort?.minCohortMet) {
      currentSeg.push({
        x: xFor(idx),
        p25: yFor(cohort.scoreP25),
        med: yFor(cohort.scoreMedian),
        p75: yFor(cohort.scoreP75)
      });
    } else if (currentSeg.length > 0) {
      bandSegments.push(currentSeg);
      currentSeg = [];
    }
  });
  if (currentSeg.length > 0) bandSegments.push(currentSeg);

  for (const seg of bandSegments) {
    if (seg.length === 1) {
      const pt = seg[0];
      const boxW = 36;
      const top = pt.p75;
      const h = Math.max(4, pt.p25 - pt.p75);
      ribbonSvg += `
        <rect x="${(pt.x - boxW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${boxW}" height="${h.toFixed(1)}" rx="6" fill="rgba(31,111,97,0.14)" />
        <line x1="${(pt.x - boxW / 2).toFixed(1)}" y1="${pt.med.toFixed(1)}" x2="${(pt.x + boxW / 2).toFixed(1)}" y2="${pt.med.toFixed(1)}" stroke="#1F6F61" stroke-width="2" stroke-dasharray="4,3" />
      `;
    } else {
      const upper = seg.map((p) => `${p.x.toFixed(1)},${p.p75.toFixed(1)}`).join(' ');
      const lower = [...seg].reverse().map((p) => `${p.x.toFixed(1)},${p.p25.toFixed(1)}`).join(' ');
      const medPts = seg.map((p) => `${p.x.toFixed(1)},${p.med.toFixed(1)}`).join(' ');
      ribbonSvg += `
        <polygon points="${upper} ${lower}" fill="rgba(31,111,97,0.14)" />
        <polyline points="${medPts}" fill="none" stroke="#1F6F61" stroke-width="2" stroke-dasharray="5,4" />
      `;
    }
  }

  // Student score line across submitted released weeks
  const studentPts = [];
  timeline.forEach((w, idx) => {
    const sub = subsByWeek[w.weekId];
    if (releasedSet.has(w.weekId) && sub) {
      studentPts.push({ x: xFor(idx), y: yFor(sub.totalScore), weekId: w.weekId, score: sub.totalScore });
    }
  });
  const lineSvg = studentPts.length >= 2
    ? `<polyline points="${studentPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#D95D39" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`
    : '';

  // Nodes & labels
  const nodesSvg = timeline
    .map((w, idx) => {
      const x = xFor(idx);
      const isReleased = releasedSet.has(w.weekId);
      const sub = subsByWeek[w.weekId];
      const isSelected = w.weekId === selectedWeekId;
      const xLabel = shortWeekLabel(w.weekId, w.title);

      if (!isReleased) {
        const yMid = yFor(24);
        return `
          <g class="chart-node-locked">
            <rect x="${(x - 24).toFixed(1)}" y="${(yMid - 14).toFixed(1)}" width="48" height="24" rx="12" fill="#FDF2E4" stroke="#E9BD82" stroke-width="1.5" />
            <text x="${x.toFixed(1)}" y="${(yMid + 2).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="#944D0E">🔒</text>
            <text x="${x.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#5B6572">${escapeHtml(xLabel)}</text>
            <text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#944D0E">In Review</text>
          </g>
        `;
      }

      if (!sub) {
        const yBase = yFor(0);
        return `
          <g class="chart-week-node" data-chart-week="${escapeHtml(w.weekId)}" role="button" tabindex="0">
            <circle cx="${x.toFixed(1)}" cy="${yBase.toFixed(1)}" r="6" fill="#FFFFFF" stroke="#5B6572" stroke-width="2" />
            <text x="${x.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#5B6572">${escapeHtml(xLabel)}</text>
            <text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="600" fill="#5B6572">Absent</text>
          </g>
        `;
      }

      const y = yFor(sub.totalScore);
      return `
        <g class="chart-week-node" data-chart-week="${escapeHtml(w.weekId)}" role="button" tabindex="0" style="cursor:pointer;">
          ${isSelected ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="rgba(217,93,57,0.22)" />` : ''}
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#D95D39" stroke="#FFFFFF" stroke-width="2.5" />
          <text x="${x.toFixed(1)}" y="${(y - 13).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="900" fill="#1E242B">${sub.totalScore}</text>
          <text x="${x.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="${isSelected ? '900' : '700'}" fill="${isSelected ? '#D95D39' : '#1E242B'}">${escapeHtml(xLabel)}</text>
        </g>
      `;
    })
    .join('');

  return `
    <div class="svg-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="progress-svg" role="img" aria-label="Score progression across weeks">
        ${gridSvg}
        ${ribbonSvg}
        ${lineSvg}
        ${nodesSvg}
      </svg>
      <div class="chart-legend">
        <span><i class="legend-dot child"></i>Your Child</span>
        <span><i class="legend-line median"></i>Class Middle</span>
        <span><i class="legend-band"></i>Middle 50% of Class</span>
        <span>🔒 In Review</span>
      </div>
    </div>
  `;
}

function renderStackedBarsSvg(timeline, report, selectedWeekId) {
  const W = 640;
  const H = 248;
  const padL = 44;
  const padR = 28;
  const padT = 26;
  const padB = 52;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxY = 48;

  const yFor = (val) => padT + plotH - (Math.max(0, Math.min(maxY, val)) / maxY) * plotH;
  const hFor = (pts) => (Math.max(0, pts) / maxY) * plotH;
  const n = timeline.length;
  const slotW = plotW / Math.max(1, n);
  const barW = Math.min(48, Math.max(24, slotW * 0.45));

  const releasedSet = new Set(report?.releasedWeekIds || []);
  const subsByWeek = report?.submissionsByWeek || {};

  const gridSvg = [0, 12, 24, 36, 48]
    .map((tick) => {
      const y = yFor(tick).toFixed(1);
      return `
        <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#E5DDD0" stroke-width="1" />
        <text x="${padL - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5B6572" font-weight="700">${tick}</text>
      `;
    })
    .join('');

  const barsSvg = timeline
    .map((w, idx) => {
      const cx = padL + slotW * (idx + 0.5);
      const bx = cx - barW / 2;
      const isReleased = releasedSet.has(w.weekId);
      const sub = subsByWeek[w.weekId];
      const isSelected = w.weekId === selectedWeekId;
      const xLabel = shortWeekLabel(w.weekId, w.title);

      if (!isReleased) {
        const yMid = yFor(24);
        return `
          <g>
            <rect x="${(cx - 22).toFixed(1)}" y="${(yMid - 12).toFixed(1)}" width="44" height="24" rx="12" fill="#FDF2E4" stroke="#E9BD82" stroke-width="1.5" />
            <text x="${cx.toFixed(1)}" y="${(yMid + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="#944D0E">🔒</text>
            <text x="${cx.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#5B6572">${escapeHtml(xLabel)}</text>
            <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#944D0E">In Review</text>
          </g>
        `;
      }

      if (!sub) {
        return `
          <g class="chart-week-node" data-chart-week="${escapeHtml(w.weekId)}" role="button" tabindex="0">
            <text x="${cx.toFixed(1)}" y="${(yFor(0) - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#5B6572">—</text>
            <text x="${cx.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#5B6572">${escapeHtml(xLabel)}</text>
            <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" font-weight="600" fill="#5B6572">Absent</text>
          </g>
        `;
      }

      const h3 = hFor(sub.score3pt);
      const h4 = hFor(sub.score4pt);
      const h5 = hFor(sub.score5pt);
      const y3 = yFor(sub.score3pt);
      const y4 = yFor(sub.score3pt + sub.score4pt);
      const y5 = yFor(sub.score3pt + sub.score4pt + sub.score5pt);

      return `
        <g class="chart-week-node" data-chart-week="${escapeHtml(w.weekId)}" role="button" tabindex="0" style="cursor:pointer;">
          ${isSelected ? `<rect x="${(bx - 4).toFixed(1)}" y="${(y5 - 4).toFixed(1)}" width="${(barW + 8).toFixed(1)}" height="${(h3 + h4 + h5 + 8).toFixed(1)}" rx="8" fill="none" stroke="#1E242B" stroke-width="2" />` : ''}
          ${h3 > 0 ? `<rect x="${bx.toFixed(1)}" y="${y3.toFixed(1)}" width="${barW.toFixed(1)}" height="${h3.toFixed(1)}" fill="#1F6F61" />` : ''}
          ${h4 > 0 ? `<rect x="${bx.toFixed(1)}" y="${y4.toFixed(1)}" width="${barW.toFixed(1)}" height="${h4.toFixed(1)}" fill="#E08E45" />` : ''}
          ${h5 > 0 ? `<rect x="${bx.toFixed(1)}" y="${y5.toFixed(1)}" width="${barW.toFixed(1)}" height="${h5.toFixed(1)}" fill="#D95D39" />` : ''}
          <text x="${cx.toFixed(1)}" y="${(y5 - 8).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="900" fill="#1E242B">${sub.totalScore}</text>
          <text x="${cx.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="${isSelected ? '900' : '700'}" fill="${isSelected ? '#D95D39' : '#1E242B'}">${escapeHtml(xLabel)}</text>
        </g>
      `;
    })
    .join('');

  return `
    <div class="svg-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="progress-svg" role="img" aria-label="Stacked section scores across weeks">
        ${gridSvg}
        ${barsSvg}
      </svg>
      <div class="chart-legend">
        <span><i class="legend-dot tier3"></i>3-Pt Section (12)</span>
        <span><i class="legend-dot tier4"></i>4-Pt Section (16)</span>
        <span><i class="legend-dot tier5"></i>5-Pt Section (20)</span>
      </div>
    </div>
  `;
}

function getCohortTierBadge(score, cohort) {
  if (!cohort || !cohort.minCohortMet) return null;
  if (score >= cohort.scoreP75) return { icon: '🚀', label: 'Leading the Pack', cls: 'tag-ok' };
  if (score >= cohort.scoreP25) return { icon: '🎯', label: 'Right in the Pack', cls: 'tag-trap' };
  return { icon: '🌱', label: 'Building Foundations', cls: 'tag-solve' };
}

function renderScoresTab({ packIndex, packsById, report, parentState }) {
  const releasedIds = report?.releasedWeekIds || [];
  const timeline = getTimelineWeeks(packIndex, report);
  const subsByWeek = report?.submissionsByWeek || {};
  const cohortByWeek = report?.cohortByWeek || {};

  const selectedWeekId = releasedIds.includes(parentState.selectedWeekId)
    ? parentState.selectedWeekId
    : releasedIds[releasedIds.length - 1];

  const selectedPack = packsById[selectedWeekId];
  const selectedSub = subsByWeek[selectedWeekId];
  const selectedCohort = cohortByWeek[selectedWeekId];
  const hasAnySmallCohort = releasedIds.some((wid) => cohortByWeek[wid] && !cohortByWeek[wid].minCohortMet);

  const chartHtml = timeline.length > 0
    ? (parentState.chartMode === 'stacked'
      ? renderStackedBarsSvg(timeline, report, selectedWeekId)
      : renderTrajectorySvg(timeline, report, selectedWeekId))
    : '';

  const weekPills = releasedIds.map((wid) => {
    const p = packsById[wid] || (packIndex?.packs || []).find((x) => x.weekId === wid);
    const label = shortWeekLabel(wid, p?.title || wid);
    return `
      <button
        type="button"
        class="btn btn-sm ${wid === selectedWeekId ? 'btn-primary' : 'btn-secondary'}"
        data-select-week="${escapeHtml(wid)}"
      >${escapeHtml(label)}</button>
    `;
  }).join('');

  let detailHtml = '';
  if (!selectedSub) {
    detailHtml = `
      <section class="panel-card">
        <div class="panel-head">
          <div>
            <h3>${escapeHtml(selectedPack?.title || selectedWeekId)}</h3>
            <p class="brand-subtitle">No submission recorded for ${escapeHtml(report.student.name)} in this session.</p>
          </div>
        </div>
      </section>
    `;
  } else {
    const maxScore = Number(selectedSub.maxScore || selectedPack?.maxScore || 48);
    const tierBadge = getCohortTierBadge(selectedSub.totalScore, selectedCohort);

    let gaugeHtml = `<p class="brand-subtitle" style="margin:10px 0 0;">Class benchmark appears once at least 4 classmates have submitted.</p>`;
    if (selectedCohort && selectedCohort.minCohortMet) {
      const p25Pct = (selectedCohort.scoreP25 / maxScore) * 100;
      const p75Pct = (selectedCohort.scoreP75 / maxScore) * 100;
      const medPct = (selectedCohort.scoreMedian / maxScore) * 100;
      const childPct = Math.max(0, Math.min(100, (selectedSub.totalScore / maxScore) * 100));
      gaugeHtml = `
        <div class="cohort-gauge-wrap">
          <div class="cohort-gauge-head">
            <span class="tag-badge ${tierBadge.cls}">${tierBadge.icon} ${escapeHtml(tierBadge.label)}</span>
            <span class="brand-subtitle">Class middle: <strong>${selectedCohort.scoreMedian}</strong> · Middle 50%: <strong>${selectedCohort.scoreP25}–${selectedCohort.scoreP75}</strong> (${selectedCohort.cohortCount} students)</span>
          </div>
          <div class="cohort-gauge-track" aria-label="Score ${selectedSub.totalScore} out of ${maxScore}">
            <div class="cohort-gauge-band" style="left:${p25Pct.toFixed(1)}%; width:${Math.max(2, p75Pct - p25Pct).toFixed(1)}%;"></div>
            <div class="cohort-gauge-median" style="left:${medPct.toFixed(1)}%;" title="Class middle: ${selectedCohort.scoreMedian}"></div>
            <div class="cohort-gauge-child" style="left:${childPct.toFixed(1)}%;" title="${escapeHtml(report.student.name)}: ${selectedSub.totalScore}"></div>
          </div>
          <div class="cohort-gauge-scale"><span>0</span><span>12</span><span>24</span><span>36</span><span>${maxScore}</span></div>
        </div>
      `;
    }

    const callouts = [];
    if (selectedSub.blankCount > 0) {
      callouts.push(`
        <div class="habit-callout warn">
          <strong>Positive-Only Scoring Tip:</strong> ${selectedSub.blankCount} question${selectedSub.blankCount === 1 ? ' was' : 's were'} left blank. Since wrong answers cost <strong>0 points</strong>, taking an educated guess on tough puzzles is always free upside!
        </div>
      `);
    }
    if (selectedSub.score3pt < 12) {
      const missed3 = Math.round((12 - selectedSub.score3pt) / 3);
      callouts.push(`
        <div class="habit-callout info">
          <strong>3-Point Warmup Check:</strong> Missed ${missed3} starter 3-point puzzle${missed3 === 1 ? '' : 's'}. Slowing down to double-check the first four problems often locks in quick points.
        </div>
      `);
    }
    if (selectedSub.correctCount === (selectedPack?.questionCount || 12)) {
      callouts.push(`
        <div class="habit-callout ok">
          <strong>Clean Sweep!</strong> Solved every single puzzle in this session. Check out the Home Extensions in Test Review or the 5-point challenges!
        </div>
      `);
    }

    const childPct3 = Math.round((selectedSub.score3pt / 12) * 100);
    const childPct4 = Math.round((selectedSub.score4pt / 16) * 100);
    const childPct5 = Math.round((selectedSub.score5pt / 20) * 100);
    const sections = [
      { label: '3-Point Puzzles', sub: `${selectedSub.score3pt} / 12 pts`, childPct: childPct3, classPct: selectedCohort?.avgPct3pt ?? null, cls: 'tier-3' },
      { label: '4-Point Puzzles', sub: `${selectedSub.score4pt} / 16 pts`, childPct: childPct4, classPct: selectedCohort?.avgPct4pt ?? null, cls: 'tier-4' },
      { label: '5-Point Puzzles', sub: `${selectedSub.score5pt} / 20 pts`, childPct: childPct5, classPct: selectedCohort?.avgPct5pt ?? null, cls: 'tier-5' }
    ];

    const sectionBars = sections.map((sec) => `
      <div class="section-compare-row">
        <div class="section-compare-meta">
          <span class="tier-label ${sec.cls}">${escapeHtml(sec.label)}</span>
          <strong>${escapeHtml(sec.sub)} (${sec.childPct}%)</strong>
        </div>
        <div class="compare-bars">
          <div class="compare-bar-track">
            <div class="compare-bar-fill child" style="width:${sec.childPct}%"></div>
          </div>
          ${sec.classPct !== null ? `
            <div class="compare-bar-track muted">
              <div class="compare-bar-fill class-avg" style="width:${sec.classPct}%"></div>
            </div>
            <span class="brand-subtitle" style="font-size:0.82rem;">Child ${sec.childPct}% vs. Class avg ${sec.classPct}%</span>
          ` : ''}
        </div>
      </div>
    `).join('');

    detailHtml = `
      <section class="panel-card">
        <div class="panel-head">
          <div>
            <h3>${escapeHtml(selectedPack?.title || selectedWeekId)}</h3>
            <p class="brand-subtitle">
              <strong>${selectedSub.correctCount}</strong> ✓ correct ·
              <strong>${selectedSub.wrongCount}</strong> ✗ missed ·
              <strong>${selectedSub.blankCount}</strong> — blank
            </p>
          </div>
          <div class="big-score-pill">
            <strong>${selectedSub.totalScore}</strong><span>/ ${maxScore}</span>
          </div>
        </div>
        ${gaugeHtml}
        ${callouts.length > 0 ? `<div class="habit-callouts">${callouts.join('')}</div>` : ''}
        <div class="section-compare-list">${sectionBars}</div>
      </section>
    `;
  }

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Score Progression</h2>
          <p class="brand-subtitle">Tap any released week to inspect its section breakdown.</p>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="btn btn-sm ${parentState.chartMode !== 'stacked' ? 'btn-primary' : 'btn-secondary'}"
            data-chart-mode="trajectory"
          >Trajectory + Class Band</button>
          <button
            type="button"
            class="btn btn-sm ${parentState.chartMode === 'stacked' ? 'btn-primary' : 'btn-secondary'}"
            data-chart-mode="stacked"
          >3 / 4 / 5-Pt Bars</button>
        </div>
      </div>
      ${chartHtml}
      ${hasAnySmallCohort ? `<p class="brand-subtitle" style="margin:8px 0 0;">Note: Class range band is shown once at least 4 classmates submit a session.</p>` : ''}
      ${releasedIds.length > 1 ? `<div class="week-pills-row">${weekPills}</div>` : ''}
    </section>
    ${detailHtml}
  `;
}

function getSolveRateBadge(q, cohort) {
  if (!cohort || !cohort.minCohortMet || !cohort.cohortCount) return null;
  const counts = (cohort.optionCounts && cohort.optionCounts[String(q.number)]) || null;
  const correctCount = counts ? Number(counts[q.correctOption] || 0) : 0;
  const pct = Math.floor((correctCount / cohort.cohortCount) * 100 + 0.5);
  if (pct >= 70) return { label: 'Solved by most of class', cls: 'tag-ok' };
  if (pct >= 35) return { label: 'Solved by ~half of class', cls: 'tag-trap' };
  return { label: 'Tough for class — Whiteboard puzzle', cls: 'tag-solve' };
}

function renderReviewTab({ packIndex, packsById, report, parentState }) {
  const releasedIds = report?.releasedWeekIds || [];
  const selectedWeekId = releasedIds.includes(parentState.selectedWeekId)
    ? parentState.selectedWeekId
    : releasedIds[releasedIds.length - 1];
  const pack = packsById[selectedWeekId];
  const sub = (report?.submissionsByWeek || {})[selectedWeekId];
  const cohort = (report?.cohortByWeek || {})[selectedWeekId];

  const weekSelectHtml = releasedIds.length > 1 ? `
    <select id="parent-review-week" class="input-field" style="max-width:340px;" aria-label="Select released session">
      ${releasedIds.map((wid) => {
        const p = packsById[wid] || (packIndex?.packs || []).find((x) => x.weekId === wid);
        return `<option value="${escapeHtml(wid)}" ${wid === selectedWeekId ? 'selected' : ''}>${escapeHtml(p?.title || wid)}</option>`;
      }).join('')}
    </select>
  ` : `<strong style="font-size:1.05rem;">${escapeHtml(pack?.title || selectedWeekId)}</strong>`;

  if (!pack) {
    return `<section class="panel-card"><p class="brand-subtitle">Loading puzzle pack…</p></section>`;
  }
  if (!sub) {
    return `
      <section class="panel-card">
        <div class="panel-head">${weekSelectHtml}</div>
        <p class="brand-subtitle">${escapeHtml(report.student.name)} did not submit answers for this session.</p>
      </section>
    `;
  }

  const questions = pack.questions || [];
  const answers = sub.answers || {};
  const enriched = questions.map((q) => {
    const selected = normalizeChoice(answers[String(q.number)] ?? answers[q.number]);
    const correctOption = normalizeChoice(q.correctOption);
    const status = !selected ? 'blank' : (selected === correctOption ? 'correct' : 'wrong');
    return { ...q, selected, correctOption, status };
  });

  const needsReviewCount = enriched.filter((q) => q.status !== 'correct').length;
  const solvedCount = enriched.length - needsReviewCount;
  const activeFilter = parentState.reviewFilter || (needsReviewCount > 0 ? 'needs-review' : 'all');

  const filtered = enriched.filter((q) => {
    if (activeFilter === 'needs-review') return q.status !== 'correct';
    if (activeFilter === 'solved') return q.status === 'correct';
    return true;
  });

  const cardsHtml = filtered.length === 0
    ? `<div class="panel-card"><p class="brand-subtitle" style="margin:0;">No puzzles match this filter — switch to <strong>All 12</strong> to view every problem.</p></div>`
    : filtered.map((q) => {
      const qc = getQuestionClassMeta(q.questionClass);
      const sec = q.secondaryClass ? getQuestionClassMeta(q.secondaryClass) : null;
      const solveBadge = getSolveRateBadge(q, cohort);
      const guide = q.teachingGuide || {};
      const revealKey = `${selectedWeekId}:${q.number}`;
      const isRevealed = Boolean(parentState.revealedSolutions?.[revealKey]);
      const isHighlighted = parentState.highlightQuestionKey === revealKey;

      let statusBadge = `<span class="tag-badge tag-ok">Solved ✓ (${escapeHtml(q.selected)})</span>`;
      if (q.status === 'wrong') {
        statusBadge = `<span class="tag-badge tag-solve">Picked (${escapeHtml(q.selected)})</span>`;
      } else if (q.status === 'blank') {
        statusBadge = `<span class="tag-badge tag-trap">Left Blank</span>`;
      }

      let trapBanner = '';
      if (q.status === 'wrong' && cohort?.minCohortMet && cohort.optionCounts) {
        const sameWrong = Number(cohort.optionCounts[String(q.number)]?.[q.selected] || 0);
        if (sameWrong >= 2) {
          trapBanner = `
            <div class="habit-callout warn" style="margin-bottom:12px;">
              <strong>Common Trap:</strong> Choice (${escapeHtml(q.selected)}) was a classic Math Kangaroo trap that caught several students in the group this week too!
            </div>
          `;
        }
      }

      let coachingHtml = '';
      if (q.status !== 'correct') {
        const stepsList = (guide.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
        const askList = (guide.askTheKids || []).map((a) => `<li>${escapeHtml(a)}</li>`).join('');
        coachingHtml = `
          <div class="guide-panel">
            <div class="guide-cols">
              <div class="guide-box">
                <h4>💬 Ask Your Child First</h4>
                <ul>${askList}</ul>
              </div>
              <div class="guide-box">
                <h4>🏠 Try at Home</h4>
                <p style="margin:0;">${escapeHtml(guide.homeTip || '')}</p>
              </div>
            </div>
            <div style="margin-top:14px;">
              <button type="button" class="btn btn-sm ${isRevealed ? 'btn-secondary' : 'btn-sage'}" data-reveal-q="${escapeHtml(revealKey)}">
                ${isRevealed ? '🙈 Hide Answer & Step-by-Step Solution' : '💡 Reveal Answer & Step-by-Step Solution'}
              </button>
            </div>
            ${isRevealed ? `
              <div class="revealed-solution">
                <div class="badge-row" style="margin-bottom:8px;">
                  <span class="tag-badge tag-ok">Verified Answer: (${escapeHtml(q.correctOption)})</span>
                </div>
                <p class="guide-headline">Core Idea: ${escapeHtml(guide.headline || '')}</p>
                <div class="guide-box" style="margin-bottom:10px;">
                  <h4>Step-by-Step Walkthrough</h4>
                  <ol>${stepsList}</ol>
                </div>
                <p class="brand-subtitle" style="margin:0;"><strong>Watch Out For:</strong> ${escapeHtml(guide.commonTraps || '')}</p>
              </div>
            ` : ''}
          </div>
        `;
      } else {
        const stepsList = (guide.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
        coachingHtml = `
          <div style="margin-top:12px;">
            <button type="button" class="btn btn-sm btn-secondary" data-reveal-q="${escapeHtml(revealKey)}">
              ${isRevealed ? '🙈 Hide Solution & Home Extension' : '💡 Show Solution & Home Extension'}
            </button>
            ${isRevealed ? `
              <div class="guide-panel" style="margin-top:10px;">
                <p class="guide-headline">Core Idea: ${escapeHtml(guide.headline || '')}</p>
                <div class="guide-cols">
                  <div class="guide-box">
                    <h4>Step-by-Step Walkthrough</h4>
                    <ol>${stepsList}</ol>
                  </div>
                  <div class="guide-box">
                    <h4>🏠 Try at Home Extension</h4>
                    <p style="margin:0;">${escapeHtml(guide.homeTip || '')}</p>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }

      return `
        <article id="review-q-${escapeHtml(selectedWeekId)}-${q.number}" class="panel-card review-puzzle-card ${isHighlighted ? 'highlighted' : ''}">
          <div class="problem-head">
            <div class="badge-row">
              <span class="problem-num-badge">#${q.number}</span>
              <span class="tier-label ${tierClass(q.points)}">${q.points} pts</span>
              <span class="tag-badge class-pill">${escapeHtml(qc.icon)} ${escapeHtml(qc.shortLabel)}</span>
              ${sec ? `<span class="tag-badge class-pill-sec">+ ${escapeHtml(sec.shortLabel)}</span>` : ''}
              ${statusBadge}
              ${solveBadge ? `<span class="tag-badge ${solveBadge.cls}">${escapeHtml(solveBadge.label)}</span>` : ''}
            </div>
          </div>
          <h3 style="margin:0 0 6px;">${escapeHtml(q.title)}</h3>
          <p class="brand-subtitle" style="margin:0 0 12px;">${escapeHtml(q.promptSummary)}</p>
          ${trapBanner}
          <div class="diagram-frame" data-action="zoom-diagram" data-img="${escapeHtml(q.imageUrl)}" data-title="Question #${q.number}: ${escapeHtml(q.title)}">
            <img src="${escapeHtml(q.imageUrl)}" alt="Question ${q.number}: ${escapeHtml(q.promptSummary || q.title)}" loading="lazy" />
            <div class="zoom-hint">🔍 Tap diagram to zoom</div>
          </div>
          ${coachingHtml}
        </article>
      `;
    }).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>${weekSelectHtml}</div>
        <div class="header-actions">
          <button type="button" class="btn btn-sm ${activeFilter === 'needs-review' ? 'btn-primary' : 'btn-secondary'}" data-review-filter="needs-review">
            Needs Review (${needsReviewCount})
          </button>
          <button type="button" class="btn btn-sm ${activeFilter === 'all' ? 'btn-primary' : 'btn-secondary'}" data-review-filter="all">
            All 12 (${enriched.length})
          </button>
          <button type="button" class="btn btn-sm ${activeFilter === 'solved' ? 'btn-primary' : 'btn-secondary'}" data-review-filter="solved">
            Solved ✓ (${solvedCount})
          </button>
        </div>
      </div>
    </section>
    ${cardsHtml}
  `;
}

function renderHomeFocusTab({ packsById, report }) {
  const mastery = computeStudentClassMastery({
    packs: packsById,
    submissionsByWeek: report?.submissionsByWeek || {},
    cohortByWeek: report?.cohortByWeek || {}
  });

  if (mastery.practiced.length === 0) {
    return `
      <section class="panel-card">
        <h2>Work On at Home</h2>
        <p class="brand-subtitle">Topic insights and home activities will appear after ${escapeHtml(report.student.name)} completes a released session.</p>
      </section>
    `;
  }

  const renderClassRow = (c, highlightCls) => `
    <div class="mastery-row">
      <div class="mastery-row-head">
        <span><strong>${escapeHtml(c.icon)} ${escapeHtml(c.label)}</strong> <small class="brand-subtitle">(${escapeHtml(c.domainLabel)})</small></span>
        <span><strong>${c.correct}/${c.total}</strong> (${c.pct}%)${c.classPct !== null ? ` · <span class="brand-subtitle">Class ${c.classPct}%</span>` : ''}</span>
      </div>
      <div class="compare-bar-track">
        <div class="compare-bar-fill ${highlightCls}" style="width:${c.pct}%"></div>
      </div>
    </div>
  `;

  const focusHtml = mastery.focusAreas.length > 0
    ? mastery.focusAreas.map((c) => renderClassRow(c, 'focus')).join('')
    : `<p class="brand-subtitle" style="margin:0;">🎉 Every practiced Math Kangaroo skill is at 100% across released sessions!</p>`;

  const strongHtml = mastery.strongAreas.length > 0
    ? mastery.strongAreas.map((c) => renderClassRow(c, 'child')).join('')
    : `<p class="brand-subtitle" style="margin:0;">Keep solving weekly sessions to build strong areas.</p>`;

  const playbookTargets = mastery.focusAreas.length > 0
    ? mastery.focusAreas
    : mastery.strongAreas.slice(0, 2);

  const playbooksHtml = playbookTargets.map((c) => {
    const pb = HOME_PLAYBOOKS[c.id];
    if (!pb) return '';
    return `
      <article class="playbook-card">
        <div class="badge-row" style="margin-bottom:8px;">
          <span class="tag-badge class-pill">${escapeHtml(c.icon)} ${escapeHtml(c.label)}</span>
        </div>
        <p class="brand-subtitle" style="margin:0 0 10px;">${escapeHtml(pb.whyItMatters)}</p>
        <div class="playbook-activities">
          ${pb.activities.map((act) => `
            <div class="playbook-act">
              <strong>${escapeHtml(act.title)}</strong>
              <p>${escapeHtml(act.prompt)}</p>
            </div>
          `).join('')}
        </div>
      </article>
    `;
  }).join('');

  const retryHtml = mastery.priorityRetryQueue.length === 0
    ? `<p class="brand-subtitle" style="margin:0;">No missed puzzles in released sessions right now!</p>`
    : mastery.priorityRetryQueue.map((item) => {
      const qc = getQuestionClassMeta(item.questionClass);
      return `
        <div class="retry-item">
          <div class="badge-row">
            <span class="problem-num-badge">#${item.number}</span>
            <span class="tier-label ${tierClass(item.points)}">${item.points} pts</span>
            <span class="tag-badge class-pill">${escapeHtml(qc.icon)} ${escapeHtml(qc.shortLabel)}</span>
            <strong>${escapeHtml(item.title)}</strong>
            <span class="brand-subtitle">${escapeHtml(shortWeekLabel(item.weekId, item.weekTitle))} · ${item.status === 'blank' ? 'Left Blank' : `Picked (${escapeHtml(item.selected)})`}</span>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-jump-review="${escapeHtml(item.weekId)}:${item.number}">
            Review Puzzle →
          </button>
        </div>
      `;
    }).join('');

  return `
    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Math Kangaroo Skill Profile</h2>
          <p class="brand-subtitle">Cumulative accuracy across all released sessions.</p>
        </div>
      </div>
      <div class="guide-cols">
        <div class="guide-box">
          <h4>🎯 Focus Areas</h4>
          ${focusHtml}
        </div>
        <div class="guide-box">
          <h4>💪 Strong Areas</h4>
          ${strongHtml}
        </div>
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Screen-Free Home Playbook</h2>
          <p class="brand-subtitle">5–10 minute tabletop activities tailored to your child's current focus skills.</p>
        </div>
      </div>
      <div class="playbook-grid">${playbooksHtml}</div>
    </section>

    <section class="panel-card">
      <div class="panel-head">
        <div>
          <h2>Priority Re-Try Queue</h2>
          <p class="brand-subtitle">3-point and 4-point foundations appear first for quick confidence wins.</p>
        </div>
      </div>
      <div class="retry-list">${retryHtml}</div>
    </section>
  `;
}

export function renderParentZone({
  appEl,
  packIndex,
  packsById,
  report,
  storage,
  parentState,
  handlers
}) {
  const student = report?.student || { name: 'Student', avatar: '🦊' };
  const releasedIds = report?.releasedWeekIds || [];
  const unreleasedIds = report?.unreleasedSubmittedWeekIds || [];

  const unreleasedBanners = unreleasedIds.map((wid) => {
    const p = packsById[wid] || (packIndex?.packs || []).find((x) => x.weekId === wid);
    return `
      <div class="sync-banner" style="background:var(--accent-sage-soft); border-color:#BCE2DA; color:var(--accent-sage-dark);">
        <div>✓ Submitted <strong>${escapeHtml(p?.title || wid)}</strong> in class — detailed review unlocks once released by the teacher.</div>
      </div>
    `;
  }).join('');

  let bodyHtml = '';
  if (releasedIds.length === 0) {
    bodyHtml = `
      <section class="panel-card" style="text-align:center; padding:34px 24px;">
        <div class="loading-icon" aria-hidden="true">🔒</div>
        <h2 style="margin:0 0 8px;">Results Are Still In Review</h2>
        <p class="brand-subtitle" style="max-width:520px; margin:0 auto;">
          Your teacher unlocks each weekly test's scores, step-by-step explanations, and home practice guide after the classroom whiteboard review.
        </p>
      </section>
    `;
  } else {
    const tabs = [
      { id: 'scores', label: '📈 Scores & Progress' },
      { id: 'review', label: '🔍 Test Review' },
      { id: 'home-focus', label: '🧩 Work On at Home' }
    ];
    let tabBody = '';
    if (parentState.activeTab === 'review') {
      tabBody = renderReviewTab({ packIndex, packsById, report, parentState });
    } else if (parentState.activeTab === 'home-focus') {
      tabBody = renderHomeFocusTab({ packsById, report });
    } else {
      tabBody = renderScoresTab({ packIndex, packsById, report, parentState });
    }
    bodyHtml = `
      <nav class="teacher-tabs" aria-label="Parent Zone Sections">
        ${tabs.map((t) => `
          <button
            type="button"
            class="tab-btn ${parentState.activeTab === t.id ? 'active' : ''}"
            data-parent-tab="${t.id}"
          >${escapeHtml(t.label)}</button>
        `).join('')}
      </nav>
      ${tabBody}
    `;
  }

  appEl.innerHTML = `
    <header class="top-header">
      <div class="top-header-inner">
        <div class="brand-block">
          <div class="brand-badge" aria-hidden="true">👪</div>
          <div>
            <h1 class="brand-title">Parent Zone · ${escapeHtml(student.avatar)} ${escapeHtml(student.name)}</h1>
            <p class="brand-subtitle">${escapeHtml(storage.getBackendLabel())}</p>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="refresh-parent">↻ Refresh</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="exit-parent">🔒 Lock &amp; Exit</button>
        </div>
      </div>
    </header>

    <main class="container">
      ${unreleasedBanners}
      ${bodyHtml}
    </main>
  `;

  appEl.querySelector('[data-action="exit-parent"]')?.addEventListener('click', handlers.exitParent);
  appEl.querySelector('[data-action="refresh-parent"]')?.addEventListener('click', handlers.refreshParentReport);

  appEl.querySelectorAll('[data-parent-tab]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.switchTab(btn.dataset.parentTab));
  });
  appEl.querySelectorAll('[data-chart-mode]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.setChartMode(btn.dataset.chartMode));
  });
  appEl.querySelectorAll('[data-select-week]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.selectWeek(btn.dataset.selectWeek));
  });
  appEl.querySelectorAll('[data-chart-week]').forEach((node) => {
    node.addEventListener('click', () => handlers.selectWeek(node.dataset.chartWeek));
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        handlers.selectWeek(node.dataset.chartWeek);
      }
    });
  });
  appEl.querySelector('#parent-review-week')?.addEventListener('change', (ev) => {
    handlers.selectWeek(ev.target.value);
  });
  appEl.querySelectorAll('[data-review-filter]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.setReviewFilter(btn.dataset.reviewFilter));
  });
  appEl.querySelectorAll('[data-reveal-q]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.toggleRevealSolution(btn.dataset.revealQ));
  });
  appEl.querySelectorAll('[data-jump-review]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [wid, qNum] = btn.dataset.jumpReview.split(':');
      handlers.jumpToQuestionReview(wid, Number(qNum));
    });
  });
  appEl.querySelectorAll('[data-action="zoom-diagram"]').forEach((el) => {
    el.addEventListener('click', () => handlers.openZoom(el.dataset.img, el.dataset.title));
  });
}
