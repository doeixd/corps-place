// Pure name-matching for profile claims (plan §4): compare the claimant's Google
// account name to the scraped profile display_name. The result is RECORDED on
// every claim ("for our records") and gates self-serve vs. moderator review.
// No server/Effect imports — unit-testable in isolation.

const STOP = new Set([
  'the', 'jr', 'sr', 'ii', 'iii', 'iv', 'mr', 'mrs', 'ms', 'dr', 'prof', 'mx',
]);

/** Lowercase, strip diacritics + punctuation, drop honorifics/suffixes → tokens. */
export const normalizeName = (s: string | null | undefined): string[] =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP.has(t));

/** Levenshtein distance (iterative, O(a·b)). */
const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
};

export type NameMatchTier = 'exact' | 'close' | 'weak';
export type NameMatchResult = { match: NameMatchTier; score: number };

/**
 * Similarity in [0,1] + a tier. Combines token-set overlap (handles reordering /
 * extra middle names) with a Levenshtein ratio on the joined tokens (handles
 * typos / minor spelling). Takes the max so either signal can carry the match.
 */
export const nameMatch = (claimant: string, profile: string): NameMatchResult => {
  const a = normalizeName(claimant);
  const b = normalizeName(profile);
  if (!a.length || !b.length) return { match: 'weak', score: 0 };

  const sa = new Set(a);
  const sb = new Set(b);
  const overlap = [...sa].filter((t) => sb.has(t)).length;
  const tokenScore = overlap / Math.max(sa.size, sb.size);

  const ja = a.join(' ');
  const jb = b.join(' ');
  const levScore = 1 - levenshtein(ja, jb) / Math.max(ja.length, jb.length);

  const score = Math.max(tokenScore, levScore);
  const match: NameMatchTier = score >= 0.92 ? 'exact' : score >= 0.8 ? 'close' : 'weak';
  return { match, score: Math.round(score * 100) / 100 };
};
