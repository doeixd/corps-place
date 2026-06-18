import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Schema + DB layer for the standalone DCX Museum scrape database (`dcx.db`).
 *
 * This DB is intentionally separate from `dci-relational.db`: it is a faithful,
 * queryable mirror of dcxmuseum.org's structured/text data (no media bytes).
 *
 * Contains:
 *   - `scrape_queue` — the durable, claimable work queue (survives stop/restart).
 *   - normalized content tables (corps, repertoire, scores, members, people,
 *     photos, assets, shows, publications).
 *
 * See sdk/docs/dcx-full-scrape-plan.md for the design.
 */

// ── DDL ────────────────────────────────────────────────────────────────────

const DDL: readonly string[] = [
  // Durable work queue. Durable = it lives on disk in dcx.db, so a kill/restart
  // resumes from exactly here. `lease_expires_at` makes a crashed worker's
  // claimed row reclaimable once the lease lapses.
  `CREATE TABLE IF NOT EXISTS scrape_queue (
     task_key         TEXT PRIMARY KEY,
     task_type        TEXT NOT NULL,
     params_json      TEXT,
     status           TEXT NOT NULL DEFAULT 'pending',
     priority         INTEGER NOT NULL DEFAULT 100,
     attempts         INTEGER NOT NULL DEFAULT 0,
     max_attempts     INTEGER NOT NULL DEFAULT 5,
     worker_id        TEXT,
     lease_expires_at INTEGER,
     http_status      INTEGER,
     last_error       TEXT,
     enqueued_at      INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_claimable
     ON scrape_queue (status, priority, enqueued_at)`,

  // 100 Corps — one row per DCX corps id.
  `CREATE TABLE IF NOT EXISTS corps (
     dcx_corps_id    TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     nickname        TEXT,
     city            TEXT,
     state           TEXT,
     country         TEXT,
     founded         TEXT,
     disbanded       TEXT,
     status          TEXT,
     division        TEXT,
     class           TEXT,
     circuit         TEXT,
     logo_url        TEXT,
     categories_json TEXT,
     history_text    TEXT,
     source_url      TEXT,
     scraped_at      INTEGER
   )`,

  // tab-7 external links per corps.
  `CREATE TABLE IF NOT EXISTS corps_links (
     dcx_corps_id TEXT NOT NULL,
     url          TEXT NOT NULL,
     label        TEXT,
     source_url   TEXT,
     PRIMARY KEY (dcx_corps_id, url)
   )`,

  // tab-1 / RepYear — one row per (corps, year, ordinal).
  `CREATE TABLE IF NOT EXISTS corps_repertoire (
     dcx_corps_id TEXT NOT NULL,
     year         INTEGER,
     ordinal      INTEGER,
     show_title   TEXT,
     work_title   TEXT,
     composer     TEXT,
     arranger     TEXT,
     source_url   TEXT,
     PRIMARY KEY (dcx_corps_id, year, ordinal)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rep_corps ON corps_repertoire (dcx_corps_id)`,

  // tab-4 Scores — one row per (corps, year, event).
  `CREATE TABLE IF NOT EXISTS corps_scores (
     dcx_corps_id TEXT NOT NULL,
     year         INTEGER,
     event_date   TEXT,
     event_name   TEXT,
     location     TEXT,
     placement    INTEGER,
     score        REAL,
     class        TEXT,
     source_url   TEXT,
     PRIMARY KEY (dcx_corps_id, year, event_name, event_date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_scores_corps ON corps_scores (dcx_corps_id)`,

  // tab-5 Members — people associated with a corps.
  `CREATE TABLE IF NOT EXISTS corps_members (
     dcx_corps_id TEXT NOT NULL,
     person_id    TEXT,
     name         TEXT NOT NULL,
     role         TEXT,
     years        TEXT,
     source_url   TEXT,
     PRIMARY KEY (dcx_corps_id, name, role, years)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_members_corps ON corps_members (dcx_corps_id)`,
  `CREATE INDEX IF NOT EXISTS idx_members_person ON corps_members (person_id)`,

  // 800 People.
  `CREATE TABLE IF NOT EXISTS people (
     dcx_person_id TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     category      TEXT,
     bio_text      TEXT,
     photo_url     TEXT,
     source_url    TEXT,
     scraped_at    INTEGER
   )`,

  // 700 Photos + tab-2 corps photos + 807 people photos.
  `CREATE TABLE IF NOT EXISTS photos (
     photo_id    TEXT PRIMARY KEY,
     image_url   TEXT NOT NULL,
     thumb_url   TEXT,
     caption     TEXT,
     year        INTEGER,
     photographer TEXT,
     owner_type  TEXT,
     owner_id    TEXT,
     source_url  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_photos_owner ON photos (owner_type, owner_id)`,

  // 900/1200 Memorabilia.
  `CREATE TABLE IF NOT EXISTS assets (
     asset_code   TEXT PRIMARY KEY,
     category     TEXT NOT NULL,
     title        TEXT,
     caption      TEXT,
     year         INTEGER,
     collection   TEXT,
     contributor  TEXT,
     corps_name   TEXT,
     dcx_corps_id TEXT,
     image_url    TEXT,
     thumb_url    TEXT,
     source_url   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_assets_category ON assets (category)`,

  // 200 Shows.
  `CREATE TABLE IF NOT EXISTS shows (
     show_id      TEXT PRIMARY KEY,
     year         INTEGER,
     show_date    TEXT,
     event_name   TEXT,
     location     TEXT,
     kind         TEXT,
     source_url   TEXT
   )`,
  // Many corps per show (the lineup).
  `CREATE TABLE IF NOT EXISTS show_corps (
     show_id      TEXT NOT NULL,
     dcx_corps_id TEXT,
     corps_name   TEXT NOT NULL,
     PRIMARY KEY (show_id, corps_name)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_showcorps_corps ON show_corps (dcx_corps_id)`,

  // Hall-of-Fame narrative pages (the halls are prose articles, not member rows).
  `CREATE TABLE IF NOT EXISTS hof_pages (
     view       TEXT PRIMARY KEY,
     name       TEXT,
     title      TEXT,
     body_text  TEXT,
     source_url TEXT,
     scraped_at INTEGER
   )`,

  // 1100 Publications.
  `CREATE TABLE IF NOT EXISTS publications (
     pub_id     TEXT PRIMARY KEY,
     collection TEXT,
     title      TEXT,
     issue      TEXT,
     year       INTEGER,
     image_url  TEXT,
     source_url TEXT
   )`,
];

/** Create every table/index if missing. Idempotent. */
export const initSchema = Effect.fn("dcxDb.initSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const stmt of DDL) {
    yield* sql.unsafe(stmt);
  }
  yield* Effect.log("dcx.db schema ready", { tables: DDL.length });
});

// ── Upserts ──────────────────────────────────────────────────────────────────
// Parent rows (corps) COALESCE so a thin re-scrape never nulls an existing
// value. Child rows (repertoire/scores/members/photos) are the full current set
// for a corps, so INSERT OR REPLACE on their PK is the idempotent write.

import type { DcxCorpsDetail } from "./parseCorps.js";
import type { DcxAssetItem } from "./parseAssets.js";
import type { DcxShow } from "./parseShows.js";
import type { DcxBiography } from "./parsePeople.js";

const nz = (s: string | null): string | null => (s && s.length > 0 ? s : null);

/** Upsert a full corps-detail record (corps row + all child rows). */
export const upsertCorpsDetail = Effect.fn("dcxDb.upsertCorpsDetail")(function* (
  detail: DcxCorpsDetail,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = detail.dcxCorpsId;
  if (!id) return;
  const now = Date.now();

  // Parent: coalescing upsert.
  yield* sql`
    INSERT INTO corps
      (dcx_corps_id, name, nickname, city, state, country, founded, disbanded,
       status, division, class, circuit, logo_url, categories_json, history_text,
       source_url, scraped_at)
    VALUES
      (${id}, ${detail.name ?? id}, ${nz(detail.nickname)}, ${nz(detail.city)}, ${nz(detail.state)},
       ${nz(detail.country)}, ${nz(detail.founded)}, ${nz(detail.disbanded)},
       ${nz(detail.status)}, ${nz(detail.division)}, ${nz(detail.corpsClass)}, ${null},
       ${nz(detail.logoUrl)}, ${null}, ${nz(detail.historyText)}, ${sourceUrl}, ${now})
    ON CONFLICT(dcx_corps_id) DO UPDATE SET
      name         = COALESCE(excluded.name, corps.name),
      nickname     = COALESCE(excluded.nickname, corps.nickname),
      city         = COALESCE(excluded.city, corps.city),
      state        = COALESCE(excluded.state, corps.state),
      country      = COALESCE(excluded.country, corps.country),
      founded      = COALESCE(excluded.founded, corps.founded),
      disbanded    = COALESCE(excluded.disbanded, corps.disbanded),
      status       = COALESCE(excluded.status, corps.status),
      division     = COALESCE(excluded.division, corps.division),
      class        = COALESCE(excluded.class, corps.class),
      logo_url     = COALESCE(excluded.logo_url, corps.logo_url),
      history_text = COALESCE(excluded.history_text, corps.history_text),
      source_url   = excluded.source_url,
      scraped_at   = excluded.scraped_at
  `.pipe(Effect.asVoid);

  yield* Effect.forEach(
    detail.links,
    (l) =>
      sql`
        INSERT OR REPLACE INTO corps_links (dcx_corps_id, url, label, source_url)
        VALUES (${id}, ${l.url}, ${nz(l.label)}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );

  // tab-6 corps-owned memorabilia → assets table, category 'corps'.
  yield* Effect.forEach(
    detail.assets,
    (a) =>
      sql`
        INSERT OR REPLACE INTO assets
          (asset_code, category, title, caption, year, collection, contributor,
           corps_name, dcx_corps_id, image_url, thumb_url, source_url)
        VALUES (${a.assetCode}, ${"corps"}, ${nz(a.title)}, ${nz(a.caption)}, ${a.year},
                ${nz(a.collection)}, ${nz(a.contributor)}, ${detail.name ?? null}, ${id},
                ${a.imageUrl}, ${nz(a.thumbUrl)}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );

  // Children: full current set → replace by PK.
  yield* Effect.forEach(
    detail.repertoire,
    (r, ordinal) =>
      sql`
        INSERT OR REPLACE INTO corps_repertoire
          (dcx_corps_id, year, ordinal, show_title, work_title, composer, arranger, source_url)
        VALUES (${id}, ${r.year}, ${ordinal}, ${null},
                ${r.songs.join(" * ")}, ${null}, ${null}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );

  yield* Effect.forEach(
    detail.scores,
    (s) =>
      sql`
        INSERT OR REPLACE INTO corps_scores
          (dcx_corps_id, year, event_date, event_name, location, placement, score, class, source_url)
        VALUES (${id}, ${s.year}, ${null}, ${s.finalEventText ?? "(year summary)"},
                ${null}, ${s.finalPlacement}, ${s.finalScore ?? s.highScore}, ${null}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );

  yield* Effect.forEach(
    detail.members,
    (m) =>
      sql`
        INSERT OR REPLACE INTO corps_members
          (dcx_corps_id, person_id, name, role, years, source_url)
        VALUES (${id}, ${m.memberId}, ${m.name}, ${nz(m.role)}, ${nz(m.years)}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );

  yield* Effect.forEach(
    detail.photoGroups,
    (p, i) =>
      sql`
        INSERT OR REPLACE INTO photos
          (photo_id, image_url, thumb_url, caption, year, photographer, owner_type, owner_id, source_url)
        VALUES (${`corps-${id}-${p.year ?? i}`}, ${p.thumbUrl ?? ""}, ${p.thumbUrl},
                ${p.photoCount != null ? `${p.photoCount} photos` : null}, ${p.year}, ${null},
                ${"corps"}, ${id}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );
});

/** Upsert a memorabilia/publication gallery (standalone asset room). */
export const upsertAssetGallery = Effect.fn("dcxDb.upsertAssetGallery")(function* (
  items: ReadonlyArray<DcxAssetItem>,
  category: string,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    items,
    (a) =>
      sql`
        INSERT OR REPLACE INTO assets
          (asset_code, category, title, caption, year, collection, contributor,
           corps_name, dcx_corps_id, image_url, thumb_url, source_url)
        VALUES (${a.assetCode}, ${category}, ${nz(a.title)}, ${nz(a.caption)}, ${a.year},
                ${nz(a.collection)}, ${nz(a.contributor)}, ${nz(a.corpsName)}, ${nz(a.corpsId)},
                ${a.imageUrl}, ${nz(a.thumbUrl)}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );
});

/** Upsert shows-by-year (show rows + corps lineup). */
export const upsertShows = Effect.fn("dcxDb.upsertShows")(function* (
  shows: ReadonlyArray<DcxShow>,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    shows.filter((s) => s.showId),
    (s) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT OR REPLACE INTO shows
            (show_id, year, show_date, event_name, location, kind, source_url)
          VALUES (${s.showId}, ${s.year}, ${nz(s.date)}, ${nz(s.eventName)},
                  ${nz(s.location)}, ${"byyear"}, ${sourceUrl})
        `.pipe(Effect.asVoid);
        yield* Effect.forEach(
          s.corps,
          (c) =>
            sql`
              INSERT OR REPLACE INTO show_corps (show_id, dcx_corps_id, corps_name)
              VALUES (${s.showId}, ${c.corpsId}, ${c.corpsName})
            `.pipe(Effect.asVoid),
          { discard: true },
        );
      }),
    { discard: true },
  );
});

/** Upsert biography PDF documents (stored in publications, collection='biography'). */
export const upsertBiographies = Effect.fn("dcxDb.upsertBiographies")(function* (
  bios: ReadonlyArray<DcxBiography>,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    bios,
    (b) =>
      sql`
        INSERT OR REPLACE INTO publications (pub_id, collection, title, issue, year, image_url, source_url)
        VALUES (${b.docUrl}, ${"biography"}, ${nz(b.title)}, ${nz(b.contributor)}, ${null},
                ${b.docUrl}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );
});

/** Upsert a Hall-of-Fame narrative page. */
export const upsertHofPage = Effect.fn("dcxDb.upsertHofPage")(function* (
  view: string,
  name: string | null,
  title: string | null,
  bodyText: string | null,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR REPLACE INTO hof_pages (view, name, title, body_text, source_url, scraped_at)
    VALUES (${view}, ${nz(name)}, ${nz(title)}, ${nz(bodyText)}, ${sourceUrl}, ${Date.now()})
  `.pipe(Effect.asVoid);
});

/** Upsert RepYear per-year detail: composer + show title for (corps, year). */
export const upsertRepYear = Effect.fn("dcxDb.upsertRepYear")(function* (
  corpsId: string,
  year: number,
  title: string | null,
  position: number | null,
  score: number | null,
  songs: ReadonlyArray<{ workTitle: string; composer: string | null }>,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  // Replace this year's repertoire rows with the richer RepYear data.
  yield* sql`DELETE FROM corps_repertoire WHERE dcx_corps_id = ${corpsId} AND year = ${year}`.pipe(
    Effect.asVoid,
  );
  yield* Effect.forEach(
    songs,
    (s, ordinal) =>
      sql`
        INSERT OR REPLACE INTO corps_repertoire
          (dcx_corps_id, year, ordinal, show_title, work_title, composer, arranger, source_url)
        VALUES (${corpsId}, ${year}, ${ordinal}, ${nz(title)}, ${s.workTitle},
                ${nz(s.composer)}, ${null}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );
  // Fill placement/score on the matching year-summary score row if present.
  if (position !== null || score !== null) {
    yield* sql`
      UPDATE corps_scores SET placement = COALESCE(${position}, placement),
                              score = COALESCE(${score}, score)
       WHERE dcx_corps_id = ${corpsId} AND year = ${year}
    `.pipe(Effect.asVoid);
  }
});

import type { DcxPhotoGroup } from "./parsePhotos.js";

/** Upsert photo-room groups (one row per year/photographer group). */
export const upsertPhotoGroups = Effect.fn("dcxDb.upsertPhotoGroups")(function* (
  groups: ReadonlyArray<DcxPhotoGroup>,
  option: string,
  sourceUrl: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    groups,
    (g) =>
      sql`
        INSERT OR REPLACE INTO photos
          (photo_id, image_url, thumb_url, caption, year, photographer, owner_type, owner_id, source_url)
        VALUES (${`room-${option}-${g.year ?? 0}-${g.photographer ?? ""}-${g.corpsId ?? ""}`},
                ${g.thumbUrl ?? ""}, ${nz(g.thumbUrl)},
                ${g.photoCount != null ? `${g.photoCount} photos` : null}, ${g.year},
                ${nz(g.photographer)}, ${`room-${option}`}, ${nz(g.corpsId)}, ${sourceUrl})
      `.pipe(Effect.asVoid),
    { discard: true },
  );
});
