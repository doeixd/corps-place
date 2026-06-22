/**
 * Pure quiz logic (Fantasy DCI plan Appendix E.3).
 *
 * Question-set composition and scoring with NO DB and NO secrets — the server-fn
 * layer pulls questions and persists attempts; here we only decide how many of
 * each difficulty to serve and how to score answers. Correct answers live only in
 * the scoring input (server-side); they are never part of what's sent to a client.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Difficulty → score weight (E.3). */
export const DIFFICULTY_WEIGHT: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };

export type DifficultyCounts = { easy: number; medium: number; hard: number };

/**
 * How many questions of each difficulty to serve (E.3 default mix 40/40/20),
 * clamped to availability and backfilled from other buckets when one is short.
 * The returned counts always sum to `min(count, total available)`.
 */
export function planQuestionCounts(count: number, avail: DifficultyCounts): DifficultyCounts {
  const total = avail.easy + avail.medium + avail.hard;
  const cap = Math.max(0, Math.min(count, total));

  let easy = Math.min(avail.easy, Math.round(cap * 0.4));
  let medium = Math.min(avail.medium, Math.round(cap * 0.4));
  let hard = Math.min(avail.hard, cap - easy - medium);

  let remaining = cap - (easy + medium + hard);
  const room = (): DifficultyCounts => ({
    easy: avail.easy - easy,
    medium: avail.medium - medium,
    hard: avail.hard - hard,
  });
  // Backfill any shortfall, preferring medium → easy → hard.
  for (const bucket of ['medium', 'easy', 'hard'] as const) {
    while (remaining > 0 && room()[bucket] > 0) {
      if (bucket === 'easy') easy++;
      else if (bucket === 'medium') medium++;
      else hard++;
      remaining--;
    }
  }
  return { easy, medium, hard };
}

export type ServedQuestion = { difficulty: Difficulty; correctIndex: number };

export type QuizScore = { raw: number; max: number; weighted: number };

/**
 * Score an attempt (E.3): sum difficulty weights of correct answers over the sum
 * of all served weights. `weighted` is in 0..1. A missing/blank answer (undefined
 * or -1) simply scores 0 for that question.
 */
export function scoreQuiz(
  served: readonly ServedQuestion[],
  answers: readonly number[]
): QuizScore {
  let raw = 0;
  let max = 0;
  served.forEach((q, i) => {
    const w = DIFFICULTY_WEIGHT[q.difficulty];
    max += w;
    if (answers[i] === q.correctIndex) raw += w;
  });
  return { raw, max, weighted: max > 0 ? raw / max : 0 };
}
