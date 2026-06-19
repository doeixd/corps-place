// Read-model builder for season show titles (the program/repertoire title a
// corps performs in a given season, shown on the prediction lineup). Source is
// the curated `corps_shows` table; placeholder titles are filtered out exactly
// as the live server-fn does. Shared by the app server-fn (fallback) and the
// emitter (READ_MODEL_PLAN §6) so the two can't drift.

import type { Client } from '@libsql/client';

export interface ShowRepertoireSummary {
  workTitle: string;
  composer: string | null;
  arranger: string | null;
}

export interface ShowInfoSummary {
  title: string;
  subtitle: string | null;
  description: string | null;
  sourceUrl: string | null;
  repertoire: ShowRepertoireSummary[];
}

const PLACEHOLDER_ARGS = ['%Repertoire not available%', '%No title yet%', '.'] as const;

// corps_key → show title, for one season.
export const buildShowTitlesForSeason = async (
  db: Client,
  season: string
): Promise<Record<string, string>> => {
  const result = await db.execute({
    sql: 'SELECT corps_key, title FROM corps_shows WHERE season = ? AND title NOT LIKE ? AND title NOT LIKE ? AND title != ?',
    args: [season, ...PLACEHOLDER_ARGS],
  });
  const titles: Record<string, string> = {};
  for (const row of result.rows as unknown as { corps_key: string; title: string }[]) {
    if (row.corps_key && row.title) titles[row.corps_key] = row.title;
  }
  return titles;
};

// All (season, corps_key, title) rows that pass the placeholder filter — the
// emitter materializes these into rm_show_titles for lookup by season.
export const buildAllShowTitles = async (
  db: Client
): Promise<{ season: string; corps_key: string; title: string }[]> => {
  const result = await db.execute({
    sql: 'SELECT season, corps_key, title FROM corps_shows WHERE title NOT LIKE ? AND title NOT LIKE ? AND title != ? ORDER BY season, corps_key',
    args: [...PLACEHOLDER_ARGS],
  });
  return (result.rows as unknown as { season: string; corps_key: string; title: string }[]).filter(
    (r) => r.season && r.corps_key && r.title
  );
};

const rowsToShowInfo = (
  rows: {
    season: string;
    corps_key: string;
    show_id: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    source_url: string | null;
    work_title: string | null;
    composer: string | null;
    arranger: string | null;
  }[]
): { season: string; corps_key: string; info: ShowInfoSummary }[] => {
  const byShow = new Map<
    string,
    { season: string; corps_key: string; info: ShowInfoSummary }
  >();

  for (const row of rows) {
    const existing =
      byShow.get(row.show_id) ??
      {
        season: row.season,
        corps_key: row.corps_key,
        info: {
          title: row.title,
          subtitle: row.subtitle,
          description: row.description,
          sourceUrl: row.source_url,
          repertoire: [],
        },
      };

    if (row.work_title) {
      existing.info.repertoire.push({
        workTitle: row.work_title,
        composer: row.composer,
        arranger: row.arranger,
      });
    }

    byShow.set(row.show_id, existing);
  }

  return [...byShow.values()].filter((r) => r.season && r.corps_key && r.info.title);
};

export const buildShowInfoForSeason = async (
  db: Client,
  season: string
): Promise<Record<string, ShowInfoSummary>> => {
  const result = await db.execute({
    sql: `
      SELECT cs.season, cs.corps_key, cs.show_id, cs.title, cs.subtitle, cs.description,
             cs.source_url, csr.work_title, csr.composer, csr.arranger
      FROM corps_shows cs
      LEFT JOIN corps_show_repertoire csr ON csr.show_id = cs.show_id
      WHERE cs.season = ?
        AND cs.title NOT LIKE ?
        AND cs.title NOT LIKE ?
        AND cs.title != ?
      ORDER BY cs.corps_key, csr.entry_id
    `,
    args: [season, ...PLACEHOLDER_ARGS],
  });
  const info: Record<string, ShowInfoSummary> = {};
  for (const row of rowsToShowInfo(result.rows as any[])) {
    info[row.corps_key] = row.info;
  }
  return info;
};

export const buildAllShowInfo = async (
  db: Client
): Promise<{ season: string; corps_key: string; info: ShowInfoSummary }[]> => {
  const result = await db.execute({
    sql: `
      SELECT cs.season, cs.corps_key, cs.show_id, cs.title, cs.subtitle, cs.description,
             cs.source_url, csr.work_title, csr.composer, csr.arranger
      FROM corps_shows cs
      LEFT JOIN corps_show_repertoire csr ON csr.show_id = cs.show_id
      WHERE cs.title NOT LIKE ?
        AND cs.title NOT LIKE ?
        AND cs.title != ?
      ORDER BY cs.season, cs.corps_key, csr.entry_id
    `,
    args: [...PLACEHOLDER_ARGS],
  });
  return rowsToShowInfo(result.rows as any[]);
};

// ── Full show detail (Show Detail Wiki, M1a) ─────────────────────────────────
// The rich page payload: the full corps_shows header plus every related table
// (repertoire, designers, movements, media, reviews, tags). This is the SCRAPED
// half of the overlay model (sdk/docs/show-detail-wiki-plan.md). Contributions
// (overrides/authored blocks) are merged on top of this at read time by the app,
// never here. Shared by the emitter (rm_show_detail) and the live server-fn
// fallback so they can't drift (READ_MODEL_PLAN §5).

export interface ShowDetailRepertoire {
  workTitle: string;
  composer: string | null;
  arranger: string | null;
  description: string | null;
  hyperlink: string | null;
  relatedCorpsKey: string | null;
  notes: string | null;
  source: string | null;
  sourceAuthority: number | null;
}
export interface ShowDetailDesigner {
  role: string;
  name: string;
  sourceUrl: string | null;
  source: string | null;
  sourceAuthority: number | null;
}
export interface ShowDetailMovement {
  ordinal: number;
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  source: string | null;
  sourceAuthority: number | null;
}
export interface ShowDetailMedia {
  mediaType: string | null;
  title: string | null;
  description: string | null;
  url: string;
  thumbnailUrl: string | null;
  attribution: string | null;
  source: string | null;
  sourceAuthority: number | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}
export interface ShowDetailReview {
  authorName: string | null;
  publication: string | null;
  rating: number | null;
  summary: string | null;
  content: string | null;
  sourceUrl: string | null;
}
export interface ShowDetail {
  showId: string;
  corpsKey: string;
  corpsName: string | null;
  season: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  premiereDate: string | null;
  venue: string | null;
  tagline: string | null;
  designerNotes: string | null;
  sourceUrl: string | null;
  source: string | null;
  sourceAuthority: number | null;
  tags: string[];
  repertoire: ShowDetailRepertoire[];
  designers: ShowDetailDesigner[];
  movements: ShowDetailMovement[];
  media: ShowDetailMedia[];
  reviews: ShowDetailReview[];
}

interface ShowHeaderRow {
  show_id: string;
  corps_key: string;
  corps_name: string | null;
  season: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  premiere_date: string | null;
  venue: string | null;
  tagline: string | null;
  designer_notes: string | null;
  source_url: string | null;
  source?: string | null;
  source_authority?: number | null;
}

const emptyDetailFromHeader = (h: ShowHeaderRow): ShowDetail => ({
  showId: h.show_id,
  corpsKey: h.corps_key,
  corpsName: h.corps_name,
  season: h.season,
  title: h.title,
  subtitle: h.subtitle,
  description: h.description,
  premiereDate: h.premiere_date,
  venue: h.venue,
  tagline: h.tagline,
  designerNotes: h.designer_notes,
  sourceUrl: h.source_url,
  source: h.source ?? null,
  sourceAuthority: h.source_authority == null ? null : Number(h.source_authority),
  tags: [],
  repertoire: [],
  designers: [],
  movements: [],
  media: [],
  reviews: [],
});

const HEADER_COLUMNS = `cs.show_id, cs.corps_key, cs.corps_name, cs.season, cs.title,
  cs.subtitle, cs.description, cs.premiere_date, cs.venue, cs.tagline,
  cs.designer_notes, cs.source_url`;

const tableColumnSet = async (db: Client, table: string): Promise<Set<string>> => {
  try {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    return new Set((info.rows as unknown as { name: string }[]).map((row) => row.name));
  } catch {
    return new Set();
  }
};

const optionalColumn = (
  columns: Set<string>,
  column: string,
  alias = column
): string => (columns.has(column) ? column : `NULL AS ${alias}`);

// Fetch every related table once and group child rows into their parent show by
// show_id (no giant cartesian join). `whereSql`/`args` scope it to one show or all.
const assembleDetails = async (
  db: Client,
  whereSql: string,
  args: (string | number)[]
): Promise<ShowDetail[]> => {
  const [showCols, repCols, designerCols, movementCols, mediaCols] = await Promise.all([
    tableColumnSet(db, 'corps_shows'),
    tableColumnSet(db, 'corps_show_repertoire'),
    tableColumnSet(db, 'corps_show_designers'),
    tableColumnSet(db, 'corps_show_movements'),
    tableColumnSet(db, 'corps_show_media'),
  ]);
  const headerColumns = `${HEADER_COLUMNS}, ${optionalColumn(showCols, 'source')}, ${optionalColumn(
    showCols,
    'source_authority'
  )}`;
  const headers = (
    await db.execute({
      sql: `SELECT ${headerColumns} FROM corps_shows cs WHERE ${whereSql}`,
      args,
    })
  ).rows as unknown as ShowHeaderRow[];
  if (headers.length === 0) return [];

  const byId = new Map<string, ShowDetail>();
  for (const h of headers) byId.set(h.show_id, emptyDetailFromHeader(h));

  // Scope the child queries to the same set of shows via the parent's WHERE.
  const childScope = `show_id IN (SELECT cs.show_id FROM corps_shows cs WHERE ${whereSql})`;

  const [rep, des, mov, med, rev, tag] = await Promise.all([
    db.execute({
      sql: `SELECT show_id, work_title, composer, arranger, description, hyperlink,
              related_corps_key, notes, ${optionalColumn(repCols, 'source')},
              ${optionalColumn(repCols, 'source_authority')} FROM corps_show_repertoire
            WHERE ${childScope} ORDER BY entry_id`,
      args,
    }),
    db.execute({
      sql: `SELECT show_id, role, name, source_url, ${optionalColumn(designerCols, 'source')},
              ${optionalColumn(designerCols, 'source_authority')} FROM corps_show_designers
            WHERE ${childScope} ORDER BY rowid`,
      args,
    }),
    db.execute({
      sql: `SELECT show_id, ordinal, title, description, source_url,
              ${optionalColumn(movementCols, 'source')},
              ${optionalColumn(movementCols, 'source_authority')} FROM corps_show_movements
            WHERE ${childScope} ORDER BY ordinal`,
      args,
    }),
    db.execute({
      sql: `SELECT show_id, media_type, title, description, url, thumbnail_url,
              attribution, ${optionalColumn(mediaCols, 'source')},
              ${optionalColumn(mediaCols, 'source_authority')}, published_at, duration_seconds
            FROM corps_show_media
            WHERE ${childScope} ORDER BY rowid`,
      args,
    }),
    db.execute({
      sql: `SELECT show_id, author_name, publication, rating, summary, content, source_url
            FROM corps_show_reviews WHERE ${childScope} ORDER BY rowid`,
      args,
    }),
    db.execute({
      sql: `SELECT show_id, tag FROM corps_show_tags WHERE ${childScope} ORDER BY tag`,
      args,
    }),
  ]);

  for (const r of rep.rows as any[]) {
    byId.get(r.show_id)?.repertoire.push({
      workTitle: r.work_title,
      composer: r.composer,
      arranger: r.arranger,
      description: r.description,
      hyperlink: r.hyperlink,
      relatedCorpsKey: r.related_corps_key,
      notes: r.notes,
      source: r.source ?? null,
      sourceAuthority: r.source_authority == null ? null : Number(r.source_authority),
    });
  }
  for (const r of des.rows as any[]) {
    byId.get(r.show_id)?.designers.push({
      role: r.role,
      name: r.name,
      sourceUrl: r.source_url,
      source: r.source ?? null,
      sourceAuthority: r.source_authority == null ? null : Number(r.source_authority),
    });
  }
  for (const r of mov.rows as any[]) {
    byId.get(r.show_id)?.movements.push({
      ordinal: Number(r.ordinal),
      title: r.title,
      description: r.description,
      sourceUrl: r.source_url,
      source: r.source ?? null,
      sourceAuthority: r.source_authority == null ? null : Number(r.source_authority),
    });
  }
  for (const r of med.rows as any[]) {
    byId.get(r.show_id)?.media.push({
      mediaType: r.media_type,
      title: r.title,
      description: r.description,
      url: r.url,
      thumbnailUrl: r.thumbnail_url,
      attribution: r.attribution,
      source: r.source ?? null,
      sourceAuthority: r.source_authority == null ? null : Number(r.source_authority),
      publishedAt: r.published_at,
      durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    });
  }
  for (const r of rev.rows as any[]) {
    byId.get(r.show_id)?.reviews.push({
      authorName: r.author_name,
      publication: r.publication,
      rating: r.rating === null ? null : Number(r.rating),
      summary: r.summary,
      content: r.content,
      sourceUrl: r.source_url,
    });
  }
  for (const r of tag.rows as any[]) byId.get(r.show_id)?.tags.push(r.tag);

  return [...byId.values()];
};

const NON_PLACEHOLDER = `cs.title NOT LIKE ? AND cs.title NOT LIKE ? AND cs.title != ?`;

// One show by its stable business key (server-fn fallback path, dev/relational).
export const buildShowDetail = async (
  db: Client,
  corpsKey: string,
  season: string
): Promise<ShowDetail | null> => {
  const details = await assembleDetails(
    db,
    `cs.corps_key = ? AND cs.season = ? AND ${NON_PLACEHOLDER}`,
    [corpsKey, season, ...PLACEHOLDER_ARGS]
  );
  return details[0] ?? null;
};

// Every show, for the emitter to materialize into rm_show_detail.
export const buildAllShowDetail = async (
  db: Client
): Promise<{ season: string; corps_key: string; detail: ShowDetail }[]> => {
  const details = await assembleDetails(db, NON_PLACEHOLDER, [...PLACEHOLDER_ARGS]);
  return details
    .filter((d) => d.season && d.corpsKey && d.title)
    .map((d) => ({ season: d.season, corps_key: d.corpsKey, detail: d }));
};
