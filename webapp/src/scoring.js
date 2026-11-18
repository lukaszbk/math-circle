/**
 * Pure domain scoring, student ranking, and classroom triage helpers.
 *
 * Scoring Rule ("positive-only"):
 *   - Correct option: +3, +4, or +5 points
 *   - Wrong or blank: 0 points (no negative penalty)
 *   - Max score: 48 points for a 12-question half-test
 */

export const VALID_OPTIONS = ['A', 'B', 'C', 'D', 'E'];

/**
 * Normalizes an answer selection to 'A'..'E' or null.
 */
export function normalizeChoice(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const upper = String(value).trim().toUpperCase();
  return VALID_OPTIONS.includes(upper) ? upper : null;
}

/**
 * Formats answers into a compact human-readable string sorted by question number.
 */
export function formatAnswersSummary(questions, answers) {
  const map = answers || {};
  return questions
    .map((q) => {
      const choice = normalizeChoice(map[String(q.number)] ?? map[q.number]);
      return `${q.number}:${choice ?? '—'}`;
    })
    .join(', ');
}

/**
 * Computes positive-only score breakdown for a single student submission.
 */
export function computeStudentScore(pack, answers) {
  const questions = (pack && Array.isArray(pack.questions)) ? pack.questions : [];
  const answerMap = answers || {};

  let totalScore = 0;
  let maxScore = 0;
  let score3pt = 0;
  let score4pt = 0;
  let score5pt = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let blankCount = 0;
  const perQuestion = {};

  for (const q of questions) {
    const pts = Number(q.points || 0);
    maxScore += pts;
    const selected = normalizeChoice(answerMap[String(q.number)] ?? answerMap[q.number]);
    const correctOption = normalizeChoice(q.correctOption);

    let status = 'blank';
    let earned = 0;
    if (!selected) {
      blankCount += 1;
      status = 'blank';
    } else if (selected === correctOption) {
      correctCount += 1;
      earned = pts;
      totalScore += pts;
      if (pts === 3) score3pt += pts;
      else if (pts === 4) score4pt += pts;
      else if (pts === 5) score5pt += pts;
      status = 'correct';
    } else {
      wrongCount += 1;
      status = 'wrong';
    }

    perQuestion[String(q.number)] = {
      number: Number(q.number),
      points: pts,
      selected,
      correctOption,
      status,
      earned
    };
  }

  return {
    totalScore,
    maxScore: pack?.maxScore ? Number(pack.maxScore) : maxScore,
    score3pt,
    score4pt,
    score5pt,
    correctCount,
    wrongCount,
    blankCount,
    answersSummary: formatAnswersSummary(questions, answerMap),
    perQuestion
  };
}

/**
 * Ranks submitted students by:
 *   1. totalScore descending
 *   2. score5pt descending
 *   3. score4pt descending
 *   4. studentName ascending (alphabetical)
 *
 * Assigns shared competition ranks (1, 2, 2, 4) when all score tie-breakers match.
 */
export function rankSubmissions(students, submissions, pack) {
  const studentMap = new Map();
  for (const st of (students || [])) {
    studentMap.set(st.studentId, st);
  }

  const rows = (submissions || []).map((sub) => {
    const studentInfo = studentMap.get(sub.studentId) || {};
    const answers = sub.answers || {};
    const computed = computeStudentScore(pack, answers);
    return {
      studentId: sub.studentId,
      studentName: sub.studentName || studentInfo.name || sub.studentId,
      avatar: studentInfo.avatar || '🦊',
      updatedAt: sub.updatedAt || '',
      answers,
      totalScore: computed.totalScore,
      maxScore: computed.maxScore,
      score3pt: computed.score3pt,
      score4pt: computed.score4pt,
      score5pt: computed.score5pt,
      correctCount: computed.correctCount,
      wrongCount: computed.wrongCount,
      blankCount: computed.blankCount,
      perQuestion: computed.perQuestion
    };
  });

  rows.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.score5pt !== a.score5pt) return b.score5pt - a.score5pt;
    if (b.score4pt !== a.score4pt) return b.score4pt - a.score4pt;
    return a.studentName.localeCompare(b.studentName, undefined, { sensitivity: 'base' });
  });

  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      rows[i].rank = 1;
    } else {
      const prev = rows[i - 1];
      const curr = rows[i];
      const exactScoreTie =
        curr.totalScore === prev.totalScore &&
        curr.score5pt === prev.score5pt &&
        curr.score4pt === prev.score4pt;
      rows[i].rank = exactScoreTie ? prev.rank : i + 1;
    }
  }

  return rows;
}

/**
 * Triages all questions in the pack across submitted students to build the
 * post-break "Solve Together" whiteboard agenda.
 *
 * Sorted by:
 *   1. missedCount (wrong + blank) descending
 *   2. wrongCount descending
 *   3. points descending
 *   4. number ascending
 */
export function triageQuestions(pack, submissions) {
  const questions = (pack && Array.isArray(pack.questions)) ? pack.questions : [];
  const subs = submissions || [];
  const submittedCount = subs.length;

  const triaged = questions.map((q) => {
    const correctOption = normalizeChoice(q.correctOption);
    const optionCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, blank: 0 };
    let correctCount = 0;
    let wrongCount = 0;
    let blankCount = 0;

    for (const sub of subs) {
      const ansMap = sub.answers || {};
      const choice = normalizeChoice(ansMap[String(q.number)] ?? ansMap[q.number]);
      if (!choice) {
        blankCount += 1;
        optionCounts.blank += 1;
      } else {
        optionCounts[choice] += 1;
        if (choice === correctOption) {
          correctCount += 1;
        } else {
          wrongCount += 1;
        }
      }
    }

    const missedCount = wrongCount + blankCount;
    const accuracyRate = submittedCount > 0 ? correctCount / submittedCount : 0;
    const solveTogether =
      submittedCount > 0 &&
      (missedCount / submittedCount >= 0.4 ||
        (submittedCount < 5 && missedCount >= 2) ||
        (submittedCount === 1 && missedCount === 1));

    const commonTraps = VALID_OPTIONS
      .filter((opt) => opt !== correctOption && optionCounts[opt] >= 2)
      .map((opt) => ({ option: opt, count: optionCounts[opt] }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.option.localeCompare(b.option);
      });

    return {
      ...q,
      number: Number(q.number),
      points: Number(q.points),
      correctOption,
      submittedCount,
      correctCount,
      wrongCount,
      blankCount,
      missedCount,
      accuracyRate,
      optionCounts,
      solveTogether,
      commonTraps
    };
  });

  triaged.sort((a, b) => {
    if (b.missedCount !== a.missedCount) return b.missedCount - a.missedCount;
    if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
    if (b.points !== a.points) return b.points - a.points;
    return a.number - b.number;
  });

  return triaged;
}
