/**
 * Canonical Math Kangaroo (Grades 3–4 / Écolier) Question Classifications,
 * screen-free home playbooks, and multi-week mastery analytics helpers.
 */

import { normalizeChoice } from './scoring.js';

export const QUESTION_CLASSES = [
  {
    id: 'spatial-3d',
    domain: 'geometry-spatial',
    domainLabel: 'Geometry & Spatial',
    label: '3D Spatial & Cubes',
    shortLabel: '3D Spatial',
    icon: '🧊'
  },
  {
    id: 'shapes-2d',
    domain: 'geometry-spatial',
    domainLabel: 'Geometry & Spatial',
    label: '2D Shapes, Symmetry & Paths',
    shortLabel: '2D Shapes',
    icon: '📐'
  },
  {
    id: 'logic-deduction',
    domain: 'logic-reasoning',
    domainLabel: 'Logic & Reasoning',
    label: 'Deductive Logic & Constraints',
    shortLabel: 'Logic',
    icon: '🧩'
  },
  {
    id: 'number-sense',
    domain: 'number-arithmetic',
    domainLabel: 'Number & Arithmetic',
    label: 'Number Sense, Equations & Grids',
    shortLabel: 'Number Sense',
    icon: '⚖️'
  },
  {
    id: 'patterns-simulation',
    domain: 'combinatorics-patterns',
    domainLabel: 'Combinatorics & Patterns',
    label: 'Patterns, Cycles & Step Simulation',
    shortLabel: 'Simulation',
    icon: '🔄'
  },
  {
    id: 'counting-sets',
    domain: 'combinatorics-patterns',
    domainLabel: 'Combinatorics & Patterns',
    label: 'Systematic Counting & Sets',
    shortLabel: 'Counting & Sets',
    icon: '🔢'
  },
  {
    id: 'measurement-time',
    domain: 'measurement',
    domainLabel: 'Measurement & Time',
    label: 'Measurement, Clocks & Money',
    shortLabel: 'Measurement',
    icon: '⏱️'
  }
];

export const QUESTION_CLASS_MAP = Object.fromEntries(
  QUESTION_CLASSES.map((c) => [c.id, c])
);

export function getQuestionClassMeta(classId) {
  return QUESTION_CLASS_MAP[classId] || {
    id: classId || 'unknown',
    domain: 'general',
    domainLabel: 'Problem Solving',
    label: classId || 'General Problem Solving',
    shortLabel: classId || 'General',
    icon: '🏷️'
  };
}

export const HOME_PLAYBOOKS = {
  'spatial-3d': {
    whyItMatters: 'Builds mental rotation and front/top/side projection skills used heavily in Grades 3–4 Math Kangaroo.',
    activities: [
      {
        title: 'LEGO / Sugar-Cube Floor Builder (10 min)',
        prompt: 'Build a small 3×3×2 block structure on the table, cover it with a bowl, and ask your child to sketch the top view or count hidden bottom-layer blocks.'
      },
      {
        title: 'Box-Net Detective',
        prompt: 'Unfold an empty cereal or cracker box flat, mark two faces with stickers, and predict which faces end up opposite each other before folding it back up.'
      }
    ]
  },
  'shapes-2d': {
    whyItMatters: 'Strengthens symmetry, clockwise vs. mirror orientation, and grid/path tracing without losing track.',
    activities: [
      {
        title: 'Fold-and-Punch Napkin Challenge (5 min)',
        prompt: 'Fold a square napkin or sticky note in half twice, point to one spot without cutting yet, and guess where all four holes will appear when unfolded.'
      },
      {
        title: 'Pocket-Mirror Laser Bounce',
        prompt: 'Draw a tiny 3×3 grid with diagonal slashes (/ and \\) and bounce a pencil tip across it—pausing at each mirror to ask which way a rolling ball would deflect.'
      }
    ]
  },
  'logic-deduction': {
    whyItMatters: 'Teaches kids how to lock in 1-choice clues first and cross out impossible options systematically.',
    activities: [
      {
        title: '5-Card Mystery Lineup (5–10 min)',
        prompt: 'Place 5 toys or face-up playing cards in a row and give 3 clues ("not on either end", "right next to the king") so your child eliminates impossible spots step by step.'
      },
      {
        title: 'Picky-First Clue Hunt',
        prompt: 'When reading any multi-clue riddle, practice asking: "Which single clue fits only ONE item?" before touching the open-ended clues.'
      }
    ]
  },
  'number-sense': {
    whyItMatters: 'Develops algebraic balance thinking, odd/even parity shortcuts, and friendly tens grouping instead of slow brute-force guessing.',
    activities: [
      {
        title: 'Seesaw Balance Equations (5 min)',
        prompt: 'Write quick gaps like "102 + □ = 99 + □" on scratch paper and ask how much heavier the right box needs to be—without adding the hundreds.'
      },
      {
        title: 'Magic 3×3 Sum Fixer',
        prompt: 'Copy a 3×3 grid summing to 15, secretly change one cell by 1, and challenge your child to spot the culprit by checking row and column totals.'
      }
    ]
  },
  'patterns-simulation': {
    whyItMatters: 'Prevents off-by-one slips during multi-step changes (swaps, overtaking, repeating cycles) by tracking state cleanly.',
    activities: [
      {
        title: 'Act-It-Out Token Tracker (5–10 min)',
        prompt: 'Use 5 numbered bottle caps or coins and act out sequential swaps or passes—saying the updated lineup aloud after every single move.'
      },
      {
        title: 'Super-Step Hop Count',
        prompt: 'On a chalk or paper number line, group repeating jumps (like "+2, +1, +1") with a loop so your child tracks both total distance and jump count separately.'
      }
    ]
  },
  'counting-sets': {
    whyItMatters: 'Helps students count systematically (tables, pairs, double-duty shapes) without missing cases or double-counting corners.',
    activities: [
      {
        title: 'Coin Combo Builder (5–10 min)',
        prompt: 'Lay out 4–5 distinct coins or numbered index cards and list EVERY subset that makes a target sum—checking for duplicates and missing sets.'
      },
      {
        title: 'Boundary Corner Count',
        prompt: 'Place Cheerios along the border of a 4×4 square napkin and compare "4 × side length" against the real count so your child sees corner overlap directly.'
      }
    ]
  },
  'measurement-time': {
    whyItMatters: 'Connects elapsed time, calendar cycles, coins, and perimeter reasoning to everyday hands-on anchors.',
    activities: [
      {
        title: 'Kitchen Timer & Analog Clock Jumps',
        prompt: 'Pick a start time on a clock face and count forward by 15-minute or 5-minute hops to a finish time instead of subtracting digits vertically.'
      },
      {
        title: 'Tape-Measure Room Loops',
        prompt: 'Walk around two different rectangular rugs or tables at home and compare perimeters by adding side lengths in friendly pairs.'
      }
    ]
  }
};

function roundHalfUp(val) {
  return Math.floor(val + 0.5);
}

/**
 * Computes cumulative per-question-class mastery and priority retry queue for a student
 * across all released weeks in which they submitted.
 */
export function computeStudentClassMastery({ packs, submissionsByWeek, cohortByWeek = {} }) {
  const packMap = Array.isArray(packs)
    ? Object.fromEntries(packs.map((p) => [p.weekId, p]))
    : (packs || {});

  const classAgg = {};
  for (const qc of QUESTION_CLASSES) {
    classAgg[qc.id] = {
      ...qc,
      correct: 0,
      wrong: 0,
      blank: 0,
      total: 0,
      pointsEarned: 0,
      pointsPossible: 0,
      classCorrect: 0,
      classTotal: 0
    };
  }

  const priorityRetryQueue = [];
  const subsEntries = Object.entries(submissionsByWeek || {});

  for (const [weekId, sub] of subsEntries) {
    const pack = packMap[weekId];
    if (!pack || !Array.isArray(pack.questions) || !sub) continue;

    const cohort = cohortByWeek[weekId] || null;
    const answers = sub.answers || {};

    for (const q of pack.questions) {
      const qClass = q.questionClass;
      if (!qClass || !classAgg[qClass]) continue;

      const agg = classAgg[qClass];
      const pts = Number(q.points || 0);
      const selected = normalizeChoice(answers[String(q.number)] ?? answers[q.number]);
      const correctOption = normalizeChoice(q.correctOption);

      agg.total += 1;
      agg.pointsPossible += pts;

      let status = 'blank';
      if (!selected) {
        agg.blank += 1;
        status = 'blank';
      } else if (selected === correctOption) {
        agg.correct += 1;
        agg.pointsEarned += pts;
        status = 'correct';
      } else {
        agg.wrong += 1;
        status = 'wrong';
      }

      let classSolveRate = null;
      if (cohort && cohort.minCohortMet && cohort.cohortCount > 0) {
        const qCounts = (cohort.optionCounts && cohort.optionCounts[String(q.number)]) || null;
        const cCorrect = qCounts ? Number(qCounts[correctOption] || 0) : 0;
        agg.classCorrect += cCorrect;
        agg.classTotal += cohort.cohortCount;
        classSolveRate = cCorrect / cohort.cohortCount;
      }

      if (status !== 'correct') {
        priorityRetryQueue.push({
          weekId,
          weekTitle: pack.title || weekId,
          number: Number(q.number),
          points: pts,
          title: q.title || `Question #${q.number}`,
          questionClass: qClass,
          secondaryClass: q.secondaryClass || null,
          status,
          selected,
          correctOption,
          classSolveRate
        });
      }
    }
  }

  const practiced = Object.values(classAgg)
    .filter((entry) => entry.total > 0)
    .map((entry) => ({
      ...entry,
      missed: entry.wrong + entry.blank,
      pct: roundHalfUp((entry.correct / entry.total) * 100),
      classPct: entry.classTotal > 0 ? roundHalfUp((entry.classCorrect / entry.classTotal) * 100) : null
    }));

  const below75 = practiced
    .filter((c) => c.pct < 75)
    .sort((a, b) => {
      if (a.pct !== b.pct) return a.pct - b.pct;
      if (b.missed !== a.missed) return b.missed - a.missed;
      return a.id.localeCompare(b.id);
    });

  let focusAreas = below75.slice(0, 3);
  if (focusAreas.length === 0) {
    focusAreas = practiced
      .filter((c) => c.pct < 100)
      .sort((a, b) => {
        if (a.pct !== b.pct) return a.pct - b.pct;
        if (b.missed !== a.missed) return b.missed - a.missed;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 2);
  }

  const focusIds = new Set(focusAreas.map((c) => c.id));
  const strongAreas = practiced
    .filter((c) => !focusIds.has(c.id))
    .sort((a, b) => {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.total !== a.total) return b.total - a.total;
      return a.id.localeCompare(b.id);
    });

  priorityRetryQueue.sort((a, b) => {
    if (a.points !== b.points) return a.points - b.points;
    const rateA = a.classSolveRate ?? -1;
    const rateB = b.classSolveRate ?? -1;
    if (rateB !== rateA) return rateB - rateA;
    if (a.weekId !== b.weekId) return b.weekId.localeCompare(a.weekId);
    return a.number - b.number;
  });

  return {
    practiced,
    focusAreas,
    strongAreas,
    priorityRetryQueue
  };
}

/**
 * Computes class-wide Question Class accuracy and per-student mastery heatmap
 * across all submitted weeks for Teacher Zone Tab 5.
 */
export function computeCohortClassStats({ packs, allSubmissions, students }) {
  const packMap = Array.isArray(packs)
    ? Object.fromEntries(packs.map((p) => [p.weekId, p]))
    : (packs || {});

  const activeStudents = (students || []).filter((s) => s.active !== false);
  const activeIds = new Set(activeStudents.map((s) => s.studentId));
  const validSubs = (allSubmissions || []).filter((sub) => activeIds.has(sub.studentId));

  const subsByWeek = new Map();
  for (const sub of validSubs) {
    if (!subsByWeek.has(sub.weekId)) subsByWeek.set(sub.weekId, []);
    subsByWeek.get(sub.weekId).push(sub);
  }

  const classMap = {};
  for (const qc of QUESTION_CLASSES) {
    classMap[qc.id] = {
      ...qc,
      correct: 0,
      wrong: 0,
      blank: 0,
      total: 0,
      questions: []
    };
  }

  const byStudentId = {};
  for (const st of activeStudents) {
    byStudentId[st.studentId] = {};
    for (const qc of QUESTION_CLASSES) {
      byStudentId[st.studentId][qc.id] = { correct: 0, total: 0, pct: null };
    }
  }

  for (const [weekId, weekSubs] of subsByWeek.entries()) {
    const pack = packMap[weekId];
    if (!pack || !Array.isArray(pack.questions)) continue;

    for (const q of pack.questions) {
      const qClass = q.questionClass;
      if (!qClass || !classMap[qClass]) continue;

      const correctOption = normalizeChoice(q.correctOption);
      let qCorrect = 0;
      let qWrong = 0;
      let qBlank = 0;

      for (const sub of weekSubs) {
        const ansMap = sub.answers || {};
        const selected = normalizeChoice(ansMap[String(q.number)] ?? ansMap[q.number]);
        const stBucket = byStudentId[sub.studentId]?.[qClass];
        if (stBucket) stBucket.total += 1;

        if (!selected) {
          qBlank += 1;
        } else if (selected === correctOption) {
          qCorrect += 1;
          if (stBucket) stBucket.correct += 1;
        } else {
          qWrong += 1;
        }
      }

      const qTotal = weekSubs.length;
      const clsEntry = classMap[qClass];
      clsEntry.correct += qCorrect;
      clsEntry.wrong += qWrong;
      clsEntry.blank += qBlank;
      clsEntry.total += qTotal;
      clsEntry.questions.push({
        weekId,
        weekTitle: pack.title || weekId,
        number: Number(q.number),
        points: Number(q.points),
        title: q.title || `Question #${q.number}`,
        correctCount: qCorrect,
        missedCount: qWrong + qBlank,
        submittedCount: qTotal,
        accuracyPct: qTotal > 0 ? roundHalfUp((qCorrect / qTotal) * 100) : 0
      });
    }
  }

  const classesSortedWeakestFirst = Object.values(classMap)
    .filter((entry) => entry.total > 0)
    .map((entry) => {
      entry.questions.sort((a, b) => {
        if (a.accuracyPct !== b.accuracyPct) return a.accuracyPct - b.accuracyPct;
        if (b.missedCount !== a.missedCount) return b.missedCount - a.missedCount;
        if (b.points !== a.points) return b.points - a.points;
        return a.number - b.number;
      });
      return {
        ...entry,
        accuracyPct: roundHalfUp((entry.correct / entry.total) * 100)
      };
    })
    .sort((a, b) => {
      if (a.accuracyPct !== b.accuracyPct) return a.accuracyPct - b.accuracyPct;
      return b.total - a.total;
    });

  for (const stMap of Object.values(byStudentId)) {
    for (const bucket of Object.values(stMap)) {
      if (bucket.total > 0) {
        bucket.pct = roundHalfUp((bucket.correct / bucket.total) * 100);
      }
    }
  }

  return {
    classesSortedWeakestFirst,
    byStudentId,
    totalSubmissionsCount: validSubs.length
  };
}
