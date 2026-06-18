// Read-model builder for the event recap (released scores + caption breakdown).
// Shared by EventRecapService (fallback) and the emitter (READ_MODEL_PLAN §6).
// The caption fold (GE/Visual/Music subtotal math) is frozen here so the live
// query and the emitted rm_event_recap can't drift.

import type { Client } from '@libsql/client';

export interface CompetitionMetaRow {
  slug: string;
  event_name: string;
  date: string;
  scores_released: number;
}

interface CorpsScoreRow {
  corps_key: string;
  corps_name: string | null;
  total_score: number | null;
  rank: number | null;
  division_name: string | null;
}

interface CaptionScoreRow {
  corps_key: string;
  caption_name: string;
  score: number | null;
}

interface CategoryScoreRow {
  corps_key: string;
  category_name: string;
  score: number | null;
}

// A recap row in the shape the prediction table consumes (app's RecapRow has an
// index signature, so this structural shape is assignable to it).
export interface RecapRowOut {
  rank?: number;
  corps_key: string;
  corps: string;
  division?: string;
  total: number;
  GE: number;
  Visual: number;
  Music: number;
  GE1?: number;
  GE2?: number;
  VP?: number;
  VA?: number;
  CG?: number;
  MB?: number;
  MA?: number;
  MP?: number;
}

export interface EventRecap {
  meta: CompetitionMetaRow | null;
  scores: RecapRowOut[];
}

/**
 * Normalize a raw caption name from the DB into the canonical 2-letter key
 * used by the prediction table (GE1, GE2, VP, VA, CG, MB, MA, MP).
 */
const normalizeCaptionKey = (raw: string): string | undefined => {
  const n = raw.toLowerCase().trim();
  if (n.includes('general effect') && (n.includes('1') || n.includes('one'))) return 'GE1';
  if (n.includes('general effect') && (n.includes('2') || n.includes('two'))) return 'GE2';
  if (n === 'ge1') return 'GE1';
  if (n === 'ge2') return 'GE2';
  if (
    (n.includes('visual') && n.includes('proficiency')) ||
    n === 'visual proficiency' ||
    n === 'vp'
  )
    return 'VP';
  if ((n.includes('visual') && n.includes('analysis')) || n === 'visual analysis' || n === 'va')
    return 'VA';
  if (n.includes('color guard') || n === 'color guard' || n === 'cg') return 'CG';
  if (
    (n.includes('music') && n.includes('brass')) ||
    n === 'music - brass' ||
    n === 'music brass' ||
    n === 'brass'
  )
    return 'MB';
  if (
    (n.includes('music') && n.includes('analysis')) ||
    n === 'music - analysis' ||
    n === 'music analysis'
  )
    return 'MA';
  if (
    (n.includes('music') && n.includes('percussion')) ||
    n === 'music - percussion' ||
    n === 'music percussion' ||
    n === 'percussion'
  )
    return 'MP';
  return undefined;
};

// Normalize a corps name for duplicate detection, mirroring the SDK's identity
// resolution (strip "the"/"drum"/"corps"/punctuation). Used only to collapse
// rows that are the same corps under two different corps_keys (e.g. a Salesforce
// id and a slug-style key) — not to rewrite any stored value.
export const normalizeCorpsName = (name: string | null): string =>
  (name ?? '')
    .toLowerCase()
    .replace(/[.&]/g, ' ')
    .replace(/\b(the|drum|bugle|corps)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Collapse rows that are the same corps under different keys. Conservative: only
// merges when normalized name AND rank AND total_score all match, so genuinely
// distinct same-name units are never combined. Keeps the first occurrence
// (scoreRows are ordered by rank, corps_name).
const dedupeScoreRows = (scoreRows: readonly CorpsScoreRow[]): CorpsScoreRow[] => {
  const seen = new Set<string>();
  const out: CorpsScoreRow[] = [];
  for (const sr of scoreRows) {
    const sig = `${normalizeCorpsName(sr.corps_name)}|${sr.rank ?? ''}|${sr.total_score ?? ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(sr);
  }
  return out;
};

// Canonical key for a stored category_scores row. The GE/Visual/Music subtotals
// are published per-category, so we prefer them over recomputing from captions.
const normalizeCategoryKey = (raw: string): 'GE' | 'Visual' | 'Music' | undefined => {
  const n = raw.toLowerCase().trim();
  if (n.includes('general effect') || n === 'ge') return 'GE';
  if (n.includes('visual')) return 'Visual';
  if (n.includes('music')) return 'Music';
  return undefined;
};

const foldRecapRows = (
  rawScoreRows: readonly CorpsScoreRow[],
  captionRows: readonly CaptionScoreRow[],
  categoryRows: readonly CategoryScoreRow[]
): RecapRowOut[] => {
  const scoreRows = dedupeScoreRows(rawScoreRows);
  const categoriesByCorps = new Map<string, Map<'GE' | 'Visual' | 'Music', number>>();
  for (const row of categoryRows) {
    const key = normalizeCategoryKey(row.category_name);
    if (!key || row.score == null) continue;
    let map = categoriesByCorps.get(row.corps_key);
    if (!map) {
      map = new Map();
      categoriesByCorps.set(row.corps_key, map);
    }
    if (!map.has(key)) map.set(key, row.score);
  }
  const captionsByCorps = new Map<string, Map<string, number>>();
  for (const row of captionRows) {
    const key = normalizeCaptionKey(row.caption_name);
    if (!key || row.score == null) continue;
    let map = captionsByCorps.get(row.corps_key);
    if (!map) {
      map = new Map<string, number>();
      captionsByCorps.set(row.corps_key, map);
    }
    // If multiple rows map to the same key (e.g. duplicate judges averaged into
    // caption_scores), keep the existing value — caption_scores is already
    // aggregated at the caption level.
    if (!map.has(key)) {
      map.set(key, row.score);
    }
  }

  return scoreRows.map((sr) => {
    const caps = captionsByCorps.get(sr.corps_key) ?? new Map<string, number>();
    const ge1 = caps.get('GE1') ?? 0;
    const ge2 = caps.get('GE2') ?? 0;
    const vp = caps.get('VP') ?? 0;
    const va = caps.get('VA') ?? 0;
    const cg = caps.get('CG') ?? 0;
    const mb = caps.get('MB') ?? 0;
    const ma = caps.get('MA') ?? 0;
    const mp = caps.get('MP') ?? 0;

    // Prefer the published per-category subtotal (category_scores), which is
    // authoritative across both the standard DCI sheet (VP+VA+CG averaged) and
    // reduced sheets (e.g. brass-only "Cavalcade" events: GE1/GE2/VA/MA/MP that
    // sum directly). Fall back to the caption-sum formula only when a category
    // row is absent, so totals-only / partial events still render something.
    const cats = categoriesByCorps.get(sr.corps_key);
    const GE = Number((cats?.get('GE') ?? ge1 + ge2).toFixed(3));
    const Visual = Number((cats?.get('Visual') ?? (vp + va + cg) / 2).toFixed(3));
    const Music = Number((cats?.get('Music') ?? (mb + ma + mp) / 2).toFixed(3));
    // The published total_score is authoritative — a breakdown is often partial
    // (All-Age panels, totals-only 2013–2015 shows), and summing an incomplete
    // breakdown understates the score. Use total_score whenever present; fall
    // back to the caption sum only when there is no published total.
    const captionTotal = Number((GE + Visual + Music).toFixed(3));
    const total = sr.total_score != null && sr.total_score !== 0 ? sr.total_score : captionTotal;

    return {
      rank: sr.rank ?? undefined,
      corps_key: sr.corps_key,
      corps: sr.corps_name ?? sr.corps_key,
      division: sr.division_name ?? undefined,
      total,
      GE,
      Visual,
      Music,
      GE1: ge1 || undefined,
      GE2: ge2 || undefined,
      VP: vp || undefined,
      VA: va || undefined,
      CG: cg || undefined,
      MB: mb || undefined,
      MA: ma || undefined,
      MP: mp || undefined,
    };
  });
};

// Resolve an event/URL slug to its competition_slug via the mapping table,
// falling back to a direct competitions match, then the raw slug.
export const buildRecapCompetitionSlug = async (db: Client, slug: string): Promise<string> => {
  const result = await db.execute({
    sql: `
      SELECT COALESCE(
        (SELECT competition_slug FROM event_to_competition WHERE event_slug = ?),
        (SELECT slug FROM competitions WHERE slug = ?)
      ) AS competition_slug
    `,
    args: [slug, slug],
  });
  const rows = result.rows as unknown as { competition_slug: string | null }[];
  return rows[0]?.competition_slug ?? slug;
};

export const buildEventRecap = async (db: Client, slug: string): Promise<EventRecap> => {
  const competitionSlug = await buildRecapCompetitionSlug(db, slug);

  const metaResult = await db.execute({
    sql: `SELECT slug, event_name, date, scores_released FROM competitions WHERE slug = ? LIMIT 1`,
    args: [competitionSlug],
  });
  const metaRows = metaResult.rows as unknown as CompetitionMetaRow[];
  if (metaRows.length === 0) {
    return { meta: null, scores: [] };
  }
  const meta = metaRows[0];

  const scoreResult = await db.execute({
    // Display the canonical org name when a recorded name is an alias of another
    // corps (corps_aliases), so a recap entry recorded under a sparse variant
    // (e.g. "Skyliners") shows/links to the fleshed-out record ("New York
    // Skyliners"). corps_key is left untouched so the caption_scores join below
    // (keyed by the row's original corps_key) still matches; the frontend's
    // name-based corps lookup resolves the canonical directory row from the name.
    sql: `
      SELECT cs.corps_key,
        COALESCE(ca.canonical_name, cs.corps_name) AS corps_name,
        cs.total_score, cs.rank, cs.division_name
      FROM corps_scores cs
      LEFT JOIN corps_aliases ca
        ON lower(ca.alias_name) = lower(cs.corps_name)
      WHERE cs.competition_slug = ?
      ORDER BY cs.rank ASC, corps_name ASC
    `,
    args: [competitionSlug],
  });
  const scoreRows = scoreResult.rows as unknown as CorpsScoreRow[];
  if (scoreRows.length === 0) {
    return { meta, scores: [] };
  }

  const captionResult = await db.execute({
    sql: `
      SELECT corps_key, caption_name, score
      FROM caption_scores
      WHERE competition_slug = ?
    `,
    args: [competitionSlug],
  });
  const captionRows = captionResult.rows as unknown as CaptionScoreRow[];

  const categoryResult = await db.execute({
    sql: `
      SELECT corps_key, category_name, score
      FROM category_scores
      WHERE competition_slug = ?
    `,
    args: [competitionSlug],
  });
  const categoryRows = categoryResult.rows as unknown as CategoryScoreRow[];
  return { meta, scores: foldRecapRows(scoreRows, captionRows, categoryRows) };
};
