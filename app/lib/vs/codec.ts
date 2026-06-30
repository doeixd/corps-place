// VS series ⇄ URL token codec (plan M4 / "URL encoding"). One `s` param, a
// comma-separated list of `~`-delimited tokens, so comparisons are shareable:
//   ?s=corps~blue-devils~2026,corps~blue-devils~2025,baseline~13,pred~bluecoats~2026-06-01
//
// INVARIANTS (see plan): decode(encode(x)) === x for valid series; malformed
// tokens are dropped, never thrown; the list is capped at VS_SERIES_CAP. Pure +
// client-safe.
import { VS_SERIES_CAP, type VsSeries } from './types';

const SLUG_RE = /^[a-z0-9-]+$/;
const SEASON_RE = /^\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Encode one series to its token, or null if it's malformed. */
export function vsSeriesToken(s: VsSeries): string | null {
  switch (s.kind) {
    case 'corps':
      return SLUG_RE.test(s.corpsSlug) && SEASON_RE.test(s.season)
        ? `corps~${s.corpsSlug}~${s.season}`
        : null;
    case 'baseline':
      return Number.isInteger(s.rank) && s.rank >= 1 && s.rank <= 25 ? `baseline~${s.rank}` : null;
    case 'prediction':
      return SLUG_RE.test(s.corpsSlug) && DATE_RE.test(s.asOf)
        ? `pred~${s.corpsSlug}~${s.asOf}`
        : null;
    case 'predicted':
      return SLUG_RE.test(s.corpsSlug) ? `forecast~${s.corpsSlug}` : null;
    default:
      return null;
  }
}

/** Encode a series list to the `s` param value (malformed series omitted). */
export function encodeVsSeries(series: VsSeries[]): string {
  return series
    .map(vsSeriesToken)
    .filter((t): t is string => t != null)
    .join(',');
}

/** Decode one token to a series, or null if malformed/unknown. */
function decodeToken(token: string): VsSeries | null {
  const [kind, a, b] = token.split('~');
  if (kind === 'corps') {
    return a && SLUG_RE.test(a) && b && SEASON_RE.test(b)
      ? { kind: 'corps', corpsSlug: a, season: b }
      : null;
  }
  if (kind === 'baseline') {
    const rank = Number(a);
    return Number.isInteger(rank) && rank >= 1 && rank <= 25 ? { kind: 'baseline', rank } : null;
  }
  if (kind === 'pred') {
    return a && SLUG_RE.test(a) && b && DATE_RE.test(b)
      ? { kind: 'prediction', corpsSlug: a, asOf: b }
      : null;
  }
  if (kind === 'forecast') {
    return a && SLUG_RE.test(a) ? { kind: 'predicted', corpsSlug: a } : null;
  }
  return null;
}

/** Decode the `s` param to a (deduped, capped) series list. Never throws. */
export function decodeVsSeries(s: string | null | undefined): VsSeries[] {
  if (!s) return [];
  const seen = new Set<string>();
  const out: VsSeries[] = [];
  for (const raw of s.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const series = decodeToken(token);
    if (!series) continue;
    const canon = vsSeriesToken(series);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    out.push(series);
    if (out.length >= VS_SERIES_CAP) break;
  }
  return out;
}
