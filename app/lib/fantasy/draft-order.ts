/**
 * Draft-order resolution (Fantasy DCI plan Appendix E.1) — pure + deterministic.
 *
 * Quiz takers are ordered by `quizOrderDir`; non-takers (no quiz score) always
 * sort LAST, shuffled among themselves by a league-seeded RNG so it's stable and
 * reproducible. Used when the owner locks/starts the draft (M3) and to preview
 * order in the UI.
 */
import type { LeagueConfig } from './config';

export type DraftMember = {
  userId: string;
  quizScore: number | null;
  completedAt: string | null;
};

type QuizOrderDir = LeagueConfig['quizOrderDir'];

/** Hash a string to a 32-bit seed (xfnv1a). */
const hashSeed = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** mulberry32 PRNG — deterministic given a numeric seed. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Deterministic Fisher–Yates shuffle seeded by a string. */
export const seededShuffle = <T>(items: readonly T[], seed: string): T[] => {
  const rand = mulberry32(hashSeed(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Resolve round-1 draft order (E.1). `seed` is the league id (stable per league).
 * For `dir==='manual'`, `manualOrder` is the owner-provided user_id order; unknown
 * ids are dropped and any omitted members are appended (shuffled).
 */
export function resolveDraftOrder(
  members: readonly DraftMember[],
  dir: QuizOrderDir,
  seed: string,
  manualOrder?: readonly string[]
): string[] {
  const took = members.filter((m) => m.quizScore != null);
  const missed = members.filter((m) => m.quizScore == null);

  let ordered: string[];
  if (dir === 'manual' && manualOrder) {
    const known = new Set(members.map((m) => m.userId));
    ordered = manualOrder.filter((id) => known.has(id));
  } else if (dir === 'random') {
    ordered = seededShuffle(
      took.map((m) => m.userId),
      seed
    );
  } else {
    const sorted = [...took].sort((a, b) => {
      const sa = a.quizScore as number;
      const sb = b.quizScore as number;
      const byScore = dir === 'high_first' ? sb - sa : sa - sb;
      if (byScore !== 0) return byScore;
      // Tie: earlier finisher first, then user_id.
      const ca = a.completedAt ?? '';
      const cb = b.completedAt ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.userId < b.userId ? -1 : 1;
    });
    ordered = sorted.map((m) => m.userId);
  }

  // Append non-takers (and, for manual, any omitted members), shuffled, deduped.
  const seen = new Set(ordered);
  const tail = seededShuffle(
    (dir === 'manual' ? members : missed).map((m) => m.userId).filter((id) => !seen.has(id)),
    seed
  );
  for (const id of tail) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  return ordered;
}
