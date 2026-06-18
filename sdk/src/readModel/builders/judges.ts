// Read-model builders for the judge directory & profile pages. Shared by
// JudgeDirectoryService (fallback) and the emitter (READ_MODEL_PLAN §4).

import type { Client } from '@libsql/client';
import { buildCorpsCanonicalMap } from './corpsAliases.js';

export type CaptionCount = { caption: string; count: number };

export type JudgeSummary = {
  judge_id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  assignment_count: number;
  seasons: readonly string[];
  /** Career assignment counts per caption (all-time), for the card ring.
   *  Optional so stale read-model rows (pre-schema-v4) parse cleanly. */
  captionBreakdown?: readonly CaptionCount[];
  /** Headshot URL, mirrors JudgeProfile.photo_url. Optional for the same reason. */
  photo_url?: string | null;
};

export type JudgeAssignment = {
  competition_slug: string;
  event_slug: string;
  event_name: string;
  season: string | null;
  start_date: string | null;
  caption_name: string;
  normalized_caption_name: string | null;
  judge_number: number | null;
};

export type JudgeCorpsScore = {
  corps_key: string;
  corps_name: string;
  corps_slug: string | null;
  corps_logo: string | null;
  corps_logo_dark: number | null;
  corps_logo_dark_url: string | null;
  competition_slug: string;
  event_slug: string;
  event_name: string;
  season: string | null;
  start_date: string | null;
  caption_name: string;
  score: number | null;
  rank: number | null;
};

/** Facts mined from the judge's bio prose (judge_bio_facts) — education/awards/performing
 *  history/current position/hometown. Parallel to staff bioFacts. */
export type JudgeBioFacts = {
  education: readonly { institution: string; degree: string | null; field: string | null; year: number | null }[];
  awards: readonly { name: string; year: number | null }[];
  performed: readonly { group: string; corps_key: string | null; startYear: number | null; endYear: number | null }[];
  currentPosition: { title: string; org: string } | null;
  hometown: string | null;
};

export type JudgeProfile = {
  judge_id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  biography: string | null;
  photo_url: string | null;
  assignments: readonly JudgeAssignment[];
  corpsScores: readonly JudgeCorpsScore[];
  seasons: readonly string[];
  bioFacts: JudgeBioFacts;
};

const EMPTY_JUDGE_FACTS: JudgeBioFacts = { education: [], awards: [], performed: [], currentPosition: null, hometown: null };
const jpJ = (s: string | null | undefined): any => { try { return JSON.parse(s ?? "{}"); } catch { return {}; } };

/** Read mined facts for one judge (judge_bio_facts); degrade to empty if the table is absent. */
const fetchJudgeBioFacts = async (db: Client, judgeId: string): Promise<JudgeBioFacts> => {
  const f: JudgeBioFacts = { education: [], awards: [], performed: [], currentPosition: null, hometown: null };
  try {
    const r = await db.execute({ sql: "SELECT fact_type, value, detail_json FROM judge_bio_facts WHERE judge_id=?", args: [judgeId] });
    const seen = new Set<string>();
    for (const row of r.rows as any[]) {
      const d = jpJ(row.detail_json), k = `${row.fact_type}|${String(row.value).toLowerCase()}`;
      if (seen.has(k)) continue; seen.add(k);
      if (row.fact_type === "education") f.education = [...f.education, { institution: row.value, degree: d.degree ?? null, field: d.field ?? null, year: d.year ?? null }];
      else if (row.fact_type === "award") f.awards = [...f.awards, { name: row.value, year: d.year ?? null }];
      else if (row.fact_type === "performed") f.performed = [...f.performed, { group: row.value, corps_key: d.corps_key ?? null, startYear: d.startYear ?? null, endYear: d.endYear ?? null }];
      else if (row.fact_type === "hometown" && !f.hometown) f.hometown = row.value;
      else if (row.fact_type === "position" && !f.currentPosition) f.currentPosition = { title: d.title ?? row.value, org: d.org ?? "" };
    }
  } catch { /* table not emitted yet */ }
  return f;
};

export const buildJudgeDirectory = async (db: Client): Promise<JudgeSummary[]> => {
  const [result, breakdownResult] = await Promise.all([
    db.execute({
      sql: `
      SELECT j.judge_id, j.display_name, j.first_name, j.last_name, j.photo_url,
        COUNT(ja.competition_slug) AS assignment_count,
        GROUP_CONCAT(DISTINCT COALESCE(e.season, c.season)) AS seasons_csv
      FROM judges j
      LEFT JOIN judge_assignments ja ON ja.judge_id = j.judge_id
      LEFT JOIN event_to_competition m ON m.competition_slug = ja.competition_slug
      LEFT JOIN events e ON e.slug = m.event_slug
      LEFT JOIN competitions c ON c.slug = ja.competition_slug
      WHERE j.judge_id NOT IN ('unknown-unknown-1', 'j-missing-1')
      GROUP BY j.judge_id
      ORDER BY j.display_name COLLATE NOCASE ASC
    `,
      args: [],
    }),
    // Per-judge career caption counts in one grouped pass (no N+1). Counts sum
    // to assignment_count since both tally judge_assignments rows.
    db.execute({
      sql: `
      SELECT judge_id, caption_name, COUNT(*) AS count
      FROM judge_assignments
      GROUP BY judge_id, caption_name
    `,
      args: [],
    }),
  ]);

  const breakdownByJudge = new Map<string, CaptionCount[]>();
  for (const row of breakdownResult.rows as unknown as Array<{
    judge_id: string;
    caption_name: string | null;
    count: number;
  }>) {
    if (!row.caption_name) continue;
    const list = breakdownByJudge.get(row.judge_id) ?? [];
    list.push({ caption: row.caption_name, count: row.count });
    breakdownByJudge.set(row.judge_id, list);
  }

  const rows = result.rows as unknown as Array<{
    judge_id: string;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    photo_url: string | null;
    assignment_count: number;
    seasons_csv: string | null;
  }>;
  return rows.map((r) => {
    const csv = r.seasons_csv;
    const seasons =
      typeof csv === 'string' && csv
        ? csv
            .split(',')
            .filter(Boolean)
            .sort((a, b) => b.localeCompare(a))
        : [];
    return {
      judge_id: r.judge_id,
      display_name: r.display_name,
      first_name: r.first_name,
      last_name: r.last_name,
      assignment_count: r.assignment_count,
      seasons,
      captionBreakdown: breakdownByJudge.get(r.judge_id) ?? [],
      photo_url: r.photo_url,
    };
  });
};

export const buildJudgeProfile = async (
  db: Client,
  judgeId: string
): Promise<JudgeProfile | null> => {
  const judgeResult = await db.execute({
    sql: `SELECT judge_id, display_name, first_name, last_name, biography, photo_url
          FROM judges WHERE judge_id = ? LIMIT 1`,
    args: [judgeId],
  });
  const judge = judgeResult.rows[0] as unknown as
    | {
        judge_id: string;
        display_name: string;
        first_name: string | null;
        last_name: string | null;
        biography: string | null;
        photo_url: string | null;
      }
    | undefined;
  if (!judge) return null;

  const [assignments, corpsScores] = await Promise.all([
    db.execute({
      sql: `
        SELECT ja.competition_slug,
          COALESCE(m.event_slug, ja.competition_slug) AS event_slug,
          COALESCE(e.event_name, e.name, c.event_name, ja.competition_slug) AS event_name,
          COALESCE(e.season, c.season) AS season,
          COALESCE(e.start_date, c.date) AS start_date,
          ja.caption_name,
          ja.normalized_caption_name,
          ja.judge_number
        FROM judge_assignments ja
        LEFT JOIN event_to_competition m ON m.competition_slug = ja.competition_slug
        LEFT JOIN events e ON e.slug = m.event_slug
        LEFT JOIN competitions c ON c.slug = ja.competition_slug
        WHERE ja.judge_id = ?
        ORDER BY COALESCE(e.start_date, c.date) DESC, ja.caption_name ASC
      `,
      args: [judgeId],
    }),
    db.execute({
      sql: `
        SELECT js.corps_key,
          COALESCE(c.name, js.corps_key) AS corps_name,
          c.slug AS corps_slug,
          c.corps_logo,
          c.corps_logo_dark,
          c.corps_logo_dark_url,
          js.competition_slug,
          COALESCE(m.event_slug, js.competition_slug) AS event_slug,
          COALESCE(e.event_name, e.name, comp.event_name, js.competition_slug) AS event_name,
          COALESCE(e.season, comp.season) AS season,
          COALESCE(e.start_date, comp.date) AS start_date,
          js.caption_name,
          js.score,
          js.rank
        FROM judge_scores js
        LEFT JOIN event_to_competition m ON m.competition_slug = js.competition_slug
        LEFT JOIN events e ON e.slug = m.event_slug
        LEFT JOIN competitions comp ON comp.slug = js.competition_slug
        LEFT JOIN corps c ON c.corps_key = js.corps_key
        WHERE js.judge_id = ?
        ORDER BY COALESCE(e.start_date, comp.date) DESC, c.name COLLATE NOCASE ASC, js.caption_name ASC
      `,
      args: [judgeId],
    }),
  ]);

  const assignmentRows = assignments.rows as unknown as JudgeAssignment[];
  const rawCorpsScoreRows = corpsScores.rows as unknown as JudgeCorpsScore[];

  // Collapse alias-sibling corps_keys to one canonical identity so a single org
  // groups once (not once per record) and its duplicated per-key scores fold
  // together. The slug/logo come from the most complete record in the group.
  const canon = await buildCorpsCanonicalMap(db);
  const seenScore = new Set<string>();
  const corpsScoreRows: JudgeCorpsScore[] = [];
  for (const r of rawCorpsScoreRows) {
    const rep = canon.get(r.corps_key);
    const mapped = rep
      ? {
          ...r,
          corps_key: rep.corps_key,
          corps_name: rep.name,
          corps_slug: rep.slug,
          corps_logo: rep.corps_logo,
          corps_logo_dark: rep.corps_logo_dark,
          corps_logo_dark_url: rep.corps_logo_dark_url,
        }
      : r;
    // After canonicalization the same recap recorded under two sibling keys
    // collapses to identical (corps, competition, caption) rows — keep one.
    const dedupeKey = `${mapped.corps_key}|${mapped.competition_slug}|${mapped.caption_name}`;
    if (seenScore.has(dedupeKey)) continue;
    seenScore.add(dedupeKey);
    corpsScoreRows.push(mapped);
  }

  const seasonSet = new Set<string>();
  for (const a of assignmentRows) {
    if (a.season) seasonSet.add(a.season);
  }
  const seasons = [...seasonSet].sort((a, b) => b.localeCompare(a));

  const bioFacts = await fetchJudgeBioFacts(db, judgeId);
  return {
    ...judge,
    assignments: assignmentRows,
    corpsScores: corpsScoreRows,
    seasons,
    bioFacts,
  };
};
