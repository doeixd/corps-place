import type { Client } from '@libsql/client';
import type { YearbookProfile, YearbookShow } from './yearbookExtract.js';

/**
 * Ingest a yearbook corps spread (the even show page + facing odd staff page) into
 * the scraped show tables as the HIGHEST-authority source (M10, step 3).
 *
 * The yearbook is authoritative and complete for a season's show, so it OWNS the
 * show's title/concept/repertoire/staff: it upserts the corps_shows row and
 * replaces that show's repertoire + designers with the yearbook's. All rows are
 * tagged source='dci-yearbook', source_authority=100. Writes ONLY scraped tables
 * (invariant I-15) — never contributions.db. Idempotent per (corps_key, season).
 */

export const YEARBOOK_SOURCE = 'dci-yearbook';
export const YEARBOOK_AUTHORITY = 100;

const tableColumns = async (db: Client, table: string): Promise<Set<string>> => {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return new Set((r.rows as unknown as { name: string }[]).map((x) => x.name));
};

/** Additively add source/source_authority columns to the show tables (idempotent). */
export const ensureYearbookProvenance = async (db: Client): Promise<void> => {
  for (const table of ['corps_shows', 'corps_show_repertoire', 'corps_show_designers']) {
    const have = await tableColumns(db, table);
    if (!have.has('source')) await db.execute(`ALTER TABLE ${table} ADD COLUMN source TEXT`);
    if (!have.has('source_authority'))
      await db.execute(`ALTER TABLE ${table} ADD COLUMN source_authority INTEGER`);
  }
};

export interface IngestSpreadInput {
  corpsKey: string;
  corpsName: string | null;
  season: string;
  show: YearbookShow;
  profile: YearbookProfile;
  /** Citation for provenance, e.g. "DCI 2017 Yearbook, p.64". */
  citation: string;
}

export interface IngestResult {
  showId: string;
  repertoire: number;
  staff: number;
  replacedExisting: boolean;
}

/**
 * Upsert one corps's yearbook show. Reuses an existing (corps_key, season) show_id
 * when present (so the yearbook overrides whatever lower-authority scrape was there)
 * else mints a deterministic `yb:{corps_key}:{season}` id. Replaces the show's
 * repertoire + designers wholesale with the yearbook's authoritative set. Leaves
 * other child tables (media/movements/reviews) untouched.
 */
export const ingestYearbookSpread = async (
  db: Client,
  input: IngestSpreadInput
): Promise<IngestResult> => {
  const { corpsKey, corpsName, season, show, profile, citation } = input;

  const existing = (
    await db.execute({
      sql: 'SELECT show_id FROM corps_shows WHERE corps_key = ? AND season = ? LIMIT 1',
      args: [corpsKey, season],
    })
  ).rows[0] as unknown as { show_id: string } | undefined;
  const showId = existing?.show_id ?? `yb:${corpsKey}:${season}`;
  const title = show.showTitle?.trim() || 'Repertoire not available';

  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO corps_shows
              (show_id, corps_key, corps_name, season, title, description, source_url, source, source_authority)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(show_id) DO UPDATE SET
              corps_name = excluded.corps_name, title = excluded.title,
              description = excluded.description, source_url = excluded.source_url,
              source = excluded.source, source_authority = excluded.source_authority`,
      args: [
        showId,
        corpsKey,
        corpsName,
        season,
        title,
        show.concept ?? null,
        citation,
        YEARBOOK_SOURCE,
        YEARBOOK_AUTHORITY,
      ],
    });

    // The yearbook owns this show's repertoire + staff: replace wholesale.
    await tx.execute({ sql: 'DELETE FROM corps_show_repertoire WHERE show_id = ?', args: [showId] });
    let ri = 0;
    for (const r of show.repertoire) {
      await tx.execute({
        sql: `INSERT INTO corps_show_repertoire
                (entry_id, show_id, work_title, composer, arranger, source, source_authority)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [`yb:${showId}:r${ri++}`, showId, r.title, r.composer ?? null, r.arranger ?? null, YEARBOOK_SOURCE, YEARBOOK_AUTHORITY],
      });
    }

    await tx.execute({ sql: 'DELETE FROM corps_show_designers WHERE show_id = ?', args: [showId] });
    let di = 0;
    for (const m of profile.staff) {
      const role = m.roles.length ? m.roles.join(', ') : (m.section ?? 'Staff');
      await tx.execute({
        sql: `INSERT INTO corps_show_designers
                (designer_id, show_id, corps_key, role, name, source_url, source, source_authority)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [`yb:${showId}:d${di++}`, showId, corpsKey, role, m.name, citation, YEARBOOK_SOURCE, YEARBOOK_AUTHORITY],
      });
    }

    await tx.commit();
    return { showId, repertoire: ri, staff: di, replacedExisting: Boolean(existing) };
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};
