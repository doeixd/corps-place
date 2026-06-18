import { SchemaParser } from "effect";
import { Effect, Option, Order, Ref, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import fs from "fs/promises";
import path from "path";

import { DciApi } from "./service.js";
import { makeDciApi } from "./client.js";
import * as Domain from "./domain.js";
import { DciDecodeError, type DciError } from "./errors.js";
import { scrapeAllData } from "./scraper.js";
import * as ExtraDomain from "./extraDomain.js";
import { buildSeasonDataset, type SeasonDataset } from "./season.js";
import {
  ALL_EXCLUSION_PATTERNS,
  firstExclusionMatch,
} from "./lineupClassification.js";
import {
  buildSeasonRankings,
  type RankingOptions,
  type SeasonRankingTimeline,
  type RankingEntry,
} from "./ranking.js";

const differenceInDays = (later: Date, earlier: Date) =>
  Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

const boolToInt = (value: boolean | null | undefined) => (value ? 1 : 0);

const toDciError = (cause: unknown, path: string): DciError =>
  cause instanceof DciDecodeError
    ? cause
    : new DciDecodeError({
        message: `Relational ingest failed at ${path}`,
        path,
        issues: cause,
      });

const normalizeKey = (value: string | undefined | null) => {
  if (!value) {
    return undefined;
  }
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  return lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const normalizeJudgeNamePart = (value: string | undefined | null) => {
  const normalized = normalizeKey(value);
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const normalizeCorpsNameForLookup = (name: string) =>
  name.trim().toLowerCase().replace(/the/g, "").replace(/\s+/g, "");

const normalizeCorpsNameForMatch = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/\bthe\b/g, "")
    .replace(/\bdrum\b/g, "")
    .replace(/\bbugle\b/g, "")
    .replace(/\bcorps\b/g, "")
    .replace(/[^a-z0-9]+/g, "");

const normalizeLocationForLookup = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const normalizeCorpsNameKey = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutThe = trimmed.replace(/^the\s+/i, "");
  return (
    normalizeKey(withoutThe) ?? normalizeKey(trimmed) ?? trimmed.toLowerCase()
  );
};

const makeCorpsKeyFromParts = (identifier?: string | null, name?: string) => {
  const direct = identifier?.trim();
  if (direct && direct.length > 0) {
    return direct.toLowerCase();
  }
  if (!name) {
    return undefined;
  }
  return normalizeCorpsNameKey(name) ?? name;
};

export const stripWaybackUrl = (value?: string | null) => {
  if (!value) {
    return value ?? null;
  }
  const marker = "https://web.archive.org/web/";
  if (!value.startsWith(marker)) {
    return value;
  }
  const stripped = value.slice(marker.length);
  const slashIndex = stripped.indexOf("/");
  if (slashIndex === -1) {
    return value;
  }
  return stripped.slice(slashIndex + 1);
};

const normalizeBooleanField = (value: unknown) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return null;
};

export const normalizeWaybackEvent = (raw: unknown) => {
  const event = (raw ?? {}) as Record<string, any>;
  const venue = event.venue as Record<string, any> | undefined;
  const seasonFallback = event.season ?? event.seasonName ?? event.year;
  const startDateValue =
    event.startDate ??
    event.date ??
    event.startTime ??
    event.start ??
    event.eventDate ??
    event.event_start_date ??
    event.start_date ??
    event.endDate ??
    event.endTime ??
    (seasonFallback ? `${seasonFallback}-01-01` : undefined);
  const eDTStartTimeForAPI =
    event.eDTStartTimeForAPI ??
    event.startTime ??
    (event.startDate ? `${event.startDate}T00:00:00.000+0000` : undefined) ??
    (event.date ? `${event.date}T00:00:00.000+0000` : undefined) ??
    (event.startTime ? event.startTime : undefined) ??
    (seasonFallback ? `${seasonFallback}-01-01T00:00:00.000+0000` : undefined);
  const slugValue =
    event.slug ?? normalizeKey(event.eventName ?? event.name ?? event.id) ?? "";
  const idValue = event.id ?? event.eventId ?? slugValue ?? "";
  const nameValue =
    event.name ?? event.eventName ?? slugValue ?? "Unknown Event";
  const normalized = {
    ...event,
    id: idValue,
    slug: slugValue,
    name: nameValue,
    startDate: startDateValue,
    schedules: event.schedules ?? undefined,
    eDTStartTimeForAPI: eDTStartTimeForAPI ?? "",
    tOCEvent: normalizeBooleanField(event.tOCEvent),
    eventSpecial: normalizeBooleanField(event.eventSpecial),
    yearbookSales: normalizeBooleanField(event.yearbookSales),
    mainGateSouvenirSales: normalizeBooleanField(event.mainGateSouvenirSales),
    marketplaceElectricity: normalizeBooleanField(event.marketplaceElectricity),
    tableChairsOnField: normalizeBooleanField(event.tableChairsOnField),
    micsOnField: normalizeBooleanField(event.micsOnField),
    boxOfficeVolunteers: normalizeBooleanField(event.boxOfficeVolunteers),
    buyTickets: stripWaybackUrl(event.buyTickets),
    buyGroupTickets: stripWaybackUrl(event.buyGroupTickets),
    eventImage: stripWaybackUrl(event.eventImage),
    eventImageThumb: stripWaybackUrl(event.eventImageThumb),
    ticketWatermark: stripWaybackUrl(event.ticketWatermark),
    liveStreamLink: stripWaybackUrl(event.liveStreamLink),
    ticketingMapImage: stripWaybackUrl(event.ticketingMapImage),
    streetMapImage: stripWaybackUrl(event.streetMapImage),
    venue: venue
      ? {
          ...venue,
          googleMapsStaticMap: stripWaybackUrl(venue.googleMapsStaticMap),
        }
      : venue,
  };
  return SchemaParser.decodeUnknownEffect(Domain.EventSchema)(normalized).pipe(
    Effect.mapError((cause) => toDciError(cause, "wayback.event")),
  );
};

export const normalizeWaybackEvents = (events: ReadonlyArray<unknown>) =>
  Effect.forEach(
    events,
    (event) =>
      normalizeWaybackEvent(event).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            `Skipping wayback event: ${JSON.stringify(cause)}`,
          ).pipe(Effect.as<Domain.Event | null>(null)),
        ),
      ),
    { concurrency: 5 },
  ).pipe(
    Effect.map((entries) =>
      entries.filter((entry): entry is Domain.Event => Boolean(entry)),
    ),
  );

const toJsonText = (value: unknown) =>
  value === undefined ? null : JSON.stringify(value);

type CorpsStaffMember = ExtraDomain.CorpsStaffMember;
type CorpsStaffAssignment = ExtraDomain.CorpsStaffAssignment;
type CorpsStaffAffiliation = ExtraDomain.CorpsStaffAffiliation;
type CorpsShow = ExtraDomain.CorpsShow;
type ShowMediaAsset = ExtraDomain.ShowMediaAsset;
type ShowRepertoireEntry = ExtraDomain.ShowRepertoireEntry;
type ShowReview = ExtraDomain.ShowReview;
type ShowDesigner = ExtraDomain.ShowDesigner;
type ShowMovement = ExtraDomain.ShowMovement;
type ShowAnnouncementScrape = ExtraDomain.ShowAnnouncementScrape;
type CorpsSeasonParticipation = ExtraDomain.CorpsSeasonParticipation;
type MediaAsset = ExtraDomain.MediaAsset;
type JudgeProfile = ExtraDomain.JudgeBioProfile;
type JudgeCorpsRelation = ExtraDomain.JudgeCorpsRelation;
type JudgeSeasonHighlight = ExtraDomain.JudgeSeasonHighlight;

const makeCorpsKey = (score: Domain.CorpsScore) =>
  makeCorpsKeyFromParts(score.orgGroupIdentifier, score.groupName);

const buildContactName = (contact?: Domain.CorpsContact | null) => {
  const first = contact?.firstName?.trim();
  const last = contact?.lastName?.trim();
  if (!first && !last) {
    return undefined;
  }
  return [first, last].filter(Boolean).join(" ");
};

const normalizeCorpsContactFields = (corps: Domain.Corps) => {
  const billing = corps.billingAddress ?? undefined;
  const contactName =
    corps.contactName ?? buildContactName(corps.contact ?? null);
  const contactEmail = corps.contactEmail ?? corps.contact?.email ?? undefined;
  const contactPhone = corps.contactPhone ?? corps.contact?.phone ?? undefined;
  const mainPhone = corps.mainPhone ?? corps.phone ?? undefined;
  const mainEmail = corps.mainEmail ?? corps.primaryEmail ?? undefined;
  const address = corps.address ?? billing?.street ?? undefined;
  const city = corps.city ?? billing?.city ?? corps.shippingCity ?? undefined;
  const state =
    corps.state ?? billing?.state ?? corps.shippingState ?? undefined;
  const zip = corps.zip ?? billing?.postalCode ?? undefined;
  const country =
    corps.country ?? billing?.country ?? corps.companyCountry ?? undefined;
  const latitude = corps.latitude ?? billing?.latitude ?? undefined;
  const longitude = corps.longitude ?? billing?.longitude ?? undefined;

  return {
    contactName,
    contactTitle: corps.contactTitle ?? corps.primaryContactTitle ?? undefined,
    contactEmail,
    contactPhone,
    mainPhone,
    mainEmail,
    address,
    city,
    state,
    zip,
    country,
    latitude,
    longitude,
    entityType: corps.entityType ?? undefined,
    linkedIn: corps.linkedIn ?? undefined,
    metaDescription: corps.metaDescription ?? undefined,
    metaTitle: corps.metaTitle ?? undefined,
    corpsMMDLLinkAudio: corps.corpsMMDLLinkAudio ?? undefined,
    corpsMMDLLinkVideo: corps.corpsMMDLLinkVideo ?? undefined,
    groupTicketsStatus: corps.groupTicketsStatus ?? undefined,
    primaryEmail: corps.primaryEmail ?? undefined,
    primaryContactTitle: corps.primaryContactTitle ?? undefined,
    phone: corps.phone ?? undefined,
    shippingCity: corps.shippingCity ?? undefined,
    shippingState: corps.shippingState ?? undefined,
    companyCountry: corps.companyCountry ?? undefined,
  };
};

const makeJudgeId = (judge: Domain.JudgeCaption) => {
  const first =
    normalizeJudgeNamePart(judge.JudgeFirstName ?? undefined) ?? "unknown";
  const last =
    normalizeJudgeNamePart(judge.JudgeLastName ?? undefined) ?? "unknown";
  // ALWAYS use -1 suffix for canonical ID (prevents duplicates)
  return `${first}-${last}-1`;
};

const judgeDisplayName = (judge: Domain.JudgeCaption) => {
  const first = judge.JudgeFirstName?.trim() ?? "";
  const last = judge.JudgeLastName?.trim() ?? "";
  const combined = `${first} ${last}`.trim();
  if (combined.length > 0 && normalizeJudgeNamePart(combined)) {
    return combined;
  }
  return "Unknown Judge";
};

const ensureIndex = (sql: SqlClient.SqlClient, statement: string) =>
  sql.unsafe(statement).pipe(Effect.asVoid);

const ensureColumns = (
  sql: SqlClient.SqlClient,
  table: string,
  columns: ReadonlyArray<string>,
) =>
  Effect.forEach(
    columns,
    (column) =>
      sql
        .unsafe(`ALTER TABLE ${table} ADD COLUMN ${column}`)
        .pipe(Effect.catch(() => Effect.void)),
    { discard: true },
  );

export const ensureRelationalSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = OFF`;

  const statements = [
    // --- VIEWS (Always safe to refresh) ---
    sql`DROP VIEW IF EXISTS judge_scores_enriched`,
    sql`DROP VIEW IF EXISTS corps_competition_results`,
    sql`DROP VIEW IF EXISTS season_ranking_entries_long`,
    sql`DROP VIEW IF EXISTS appearances`,
    sql`DROP VIEW IF EXISTS season_participation_view`,
    sql`DROP VIEW IF EXISTS event_schedules_with_event_order_and_corps_key_and_class_from_that_season`,
    sql`DROP VIEW IF EXISTS season_performing_corps`,
    sql`DROP VIEW IF EXISTS event_lineup_exclusions`,
    sql`DROP VIEW IF EXISTS scored_event_lineup`,
    sql`DROP VIEW IF EXISTS classified_event_lineup`,

    // --- CREATE TABLES (Root to Leaf) ---
    sql`CREATE TABLE IF NOT EXISTS competitions (
          slug TEXT PRIMARY KEY,
          season TEXT NOT NULL,
          event_name TEXT NOT NULL,
          location TEXT,
          date TEXT NOT NULL,
          competition_level TEXT,
          scores_released INTEGER NOT NULL DEFAULT 0,
          recap_released INTEGER NOT NULL DEFAULT 0,
          category_recap_released INTEGER NOT NULL DEFAULT 0,
          chief_judge TEXT,
          day_of_season INTEGER,
          days_till_finals INTEGER,
          percent_through REAL
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps (
          corps_key TEXT PRIMARY KEY,
          corps_id TEXT,
          org_group_identifier TEXT,
          name TEXT NOT NULL,
          slug TEXT,
          division_name TEXT,
          about TEXT,
          description TEXT,
          type TEXT,
          status TEXT,
          entity_type TEXT,
          -- Mirror of the legacy DCI API active flag (0/1), kept on ingest so
          -- the raw API shape round-trips. NOTE: it's unreliable for "is this corps
          -- fielding a unit this season" — it over-reports. The corps directory no
          -- longer trusts it; instead it derives active status from real 2026+
          -- performance lineups (see scored_event_lineup usage in
          -- app/lib/corps-directory.ts). Retained for API fidelity / back-compat.
          active INTEGER NOT NULL DEFAULT 0,
          is_other_type INTEGER NOT NULL DEFAULT 0,
          website TEXT,
          corps_logo TEXT,
          corps_photo TEXT,
          corps_mmdl_link_audio TEXT,
          corps_mmdl_link_video TEXT,
          display_city TEXT,
          latitude REAL,
          longitude REAL,
          address TEXT,
          city TEXT,
          state TEXT,
          zip TEXT,
          country TEXT,
          contact_name TEXT,
          contact_title TEXT,
          contact_email TEXT,
          contact_phone TEXT,
          main_phone TEXT,
          main_email TEXT,
          primary_email TEXT,
          primary_contact_title TEXT,
          phone TEXT,
          shipping_city TEXT,
          shipping_state TEXT,
          company_country TEXT,
          facebook TEXT,
          twitter TEXT,
          instagram TEXT,
          youtube TEXT,
          linked_in TEXT,
          dcx_museum_url TEXT,
          meta_description TEXT,
          meta_title TEXT,
          group_tickets_status TEXT,
          auditions_json TEXT
        )`,
    // Records which corps fields were set by hand (curation) so the website/API
    // ingest never clobbers them. See corpsCuration.ts + upsertCorpsProfile.
    sql`CREATE TABLE IF NOT EXISTS corps_curated_fields (
          corps_key TEXT NOT NULL,
          field TEXT NOT NULL,
          source TEXT,
          set_at TEXT NOT NULL,
          PRIMARY KEY (corps_key, field)
        )`,
    // Merch storefronts (one row per corps store or vendor) discovered by
    // scripts/scanMerch.ts and seeded by scripts/seedMerchStores.ts. See
    // docs/plans/MERCH_PLAN.md §5. cart_capability is 'prefill' (we can deep-link
    // a pre-filled cart) or 'link' (we can only link out to the product page).
    sql`CREATE TABLE IF NOT EXISTS merch_stores (
          store_id          TEXT PRIMARY KEY,
          corps_key         TEXT,
          name              TEXT NOT NULL,
          kind              TEXT NOT NULL,
          platform          TEXT,
          store_url         TEXT NOT NULL,
          cart_capability   TEXT,
          cart_url_template TEXT,
          product_count     INTEGER DEFAULT 0,
          last_synced_at    TEXT,
          sync_status       TEXT,
          -- Curated opt-out: 0 hides the store (and its products) from the merch
          -- surface without deleting data. Default 1 (listed). Set via
          -- scripts/setStoreListed.ts; preserved across seed re-runs.
          listed            INTEGER NOT NULL DEFAULT 1,
          -- High-quality storefront logo discovered by scripts/scanStoreLogos.ts
          -- (JSON-LD Organization logo / og:image / header logo). Used for groups
          -- with no corps logo (vendors); bytes are ingested into the media cache.
          store_logo        TEXT
        )`,
    // Products ingested per store by scripts/ingestMerch.ts (src/merchCatalog.ts
    // adapters → NormalizedProduct). product_id is hash(store_id + external_id)
    // so it's stable across syncs. variants_json/images_json hold JSON arrays.
    sql`CREATE TABLE IF NOT EXISTS merch_products (
          product_id           TEXT PRIMARY KEY,
          store_id             TEXT NOT NULL,
          external_id          TEXT,
          title                TEXT NOT NULL,
          description          TEXT,
          product_url          TEXT NOT NULL,
          image_url            TEXT,
          images_json          TEXT,
          price_min            REAL,
          price_max            REAL,
          currency             TEXT,
          available            INTEGER,
          variants_json        TEXT,
          cart_capability      TEXT,
          add_to_cart_template TEXT,
          category             TEXT,
          synced_at            TEXT
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_scores (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          corps_name TEXT NOT NULL,
          division_name TEXT,
          round TEXT,
          rank INTEGER,
          total_score REAL,
          subtotal_score REAL,
          subtotal_rank INTEGER,
          group_type_id TEXT,
          competition_type_id TEXT,
          PRIMARY KEY (competition_slug, corps_key),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS category_scores (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          category_name TEXT NOT NULL,
          category_initials TEXT,
          score REAL,
          rank INTEGER,
          PRIMARY KEY (competition_slug, corps_key, category_name),
          FOREIGN KEY (competition_slug, corps_key) REFERENCES corps_scores(competition_slug, corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS caption_scores (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          category_name TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          caption_initials TEXT,
          score REAL,
          rank INTEGER,
          PRIMARY KEY (competition_slug, corps_key, caption_name),
          FOREIGN KEY (competition_slug, corps_key, category_name) REFERENCES category_scores(competition_slug, corps_key, category_name) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS competition_types (
          type_id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS group_types (
          group_type_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          competition_type_id TEXT,
          FOREIGN KEY (competition_type_id) REFERENCES competition_types(type_id) ON DELETE SET NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS competition_group_types (
          competition_slug TEXT NOT NULL,
          group_type_id TEXT NOT NULL,
          PRIMARY KEY (competition_slug, group_type_id),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE,
          FOREIGN KEY (group_type_id) REFERENCES group_types(group_type_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS competition_corps (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          PRIMARY KEY (competition_slug, corps_key),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS competition_judges (
          competition_slug TEXT NOT NULL,
          judge_id TEXT NOT NULL,
          PRIMARY KEY (competition_slug, judge_id),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS judges (
          judge_id TEXT PRIMARY KEY,
          first_name TEXT,
          last_name TEXT,
          display_name TEXT,
          biography TEXT,
          photo_url TEXT,
          metadata_json TEXT
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_assignments (
          competition_slug TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          judge_id TEXT NOT NULL,
          judge_number INTEGER,
          judge_initials TEXT,
          PRIMARY KEY (competition_slug, caption_name, judge_id),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_scores (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          judge_id TEXT NOT NULL,
          score REAL,
          rank INTEGER,
          PRIMARY KEY (competition_slug, corps_key, caption_name, judge_id),
          FOREIGN KEY (competition_slug, corps_key) REFERENCES corps_scores(competition_slug, corps_key) ON DELETE CASCADE,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_links (
          judge_id TEXT NOT NULL,
          url TEXT NOT NULL,
          label TEXT,
          kind TEXT,
          PRIMARY KEY (judge_id, url),
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_corps_relations (
          relation_id TEXT PRIMARY KEY,
          judge_id TEXT NOT NULL,
          corps_key TEXT,
          corps_name TEXT,
          season TEXT,
          role TEXT,
          caption_group TEXT,
          notes TEXT,
          source_url TEXT,
          metadata_json TEXT,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE SET NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_highlights (
          highlight_id TEXT PRIMARY KEY,
          judge_id TEXT NOT NULL,
          season TEXT,
          summary TEXT,
          notable_corps_json TEXT,
          awards_json TEXT,
          source_url TEXT,
          metadata_json TEXT,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS subcaption_scores (
          competition_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          judge_id TEXT NOT NULL,
          subcaption_name TEXT NOT NULL,
          subcaption_initials TEXT,
          score REAL,
          rank INTEGER,
          PRIMARY KEY (competition_slug, corps_key, caption_name, judge_id, subcaption_name),
          FOREIGN KEY (competition_slug, corps_key) REFERENCES corps_scores(competition_slug, corps_key) ON DELETE CASCADE,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_staff (
          staff_id TEXT PRIMARY KEY,
          given_name TEXT,
          family_name TEXT,
          display_name TEXT,
          default_title TEXT,
          biography TEXT,
          photo_url TEXT,
          metadata_json TEXT
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_staff_links (
          staff_id TEXT NOT NULL,
          url TEXT NOT NULL,
          label TEXT,
          kind TEXT,
          PRIMARY KEY (staff_id, url),
          FOREIGN KEY (staff_id) REFERENCES corps_staff(staff_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_staff_assignments (
          assignment_id TEXT PRIMARY KEY,
          staff_id TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          season TEXT,
          title TEXT,
          role_type TEXT,
          start_year INTEGER,
          end_year INTEGER,
          start_date TEXT,
          end_date TEXT,
          notes TEXT,
          links_json TEXT,
          FOREIGN KEY (staff_id) REFERENCES corps_staff(staff_id) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_staff_affiliations (
          affiliation_id TEXT PRIMARY KEY,
          staff_id TEXT NOT NULL,
          related_corps_key TEXT NOT NULL,
          relation_type TEXT,
          notes TEXT,
          since_season TEXT,
          through_season TEXT,
          FOREIGN KEY (staff_id) REFERENCES corps_staff(staff_id) ON DELETE CASCADE
        )`,
    // Raw archive + review queue for cross-corps person-identity merges. A candidate
    // pair lands here as `needs-review`; `resolveStaffIdentity.ts` flips `resolved`
    // and applies the person_id merge/split. Never auto-merge below HIGH+corroborated.
    sql`CREATE TABLE IF NOT EXISTS corps_staff_review (
          review_id TEXT PRIMARY KEY,
          left_staff_id TEXT NOT NULL,
          right_staff_id TEXT NOT NULL,
          same_person INTEGER,
          confidence TEXT,
          action TEXT,
          rationale TEXT,
          supporting_evidence_json TEXT,
          resolved INTEGER NOT NULL DEFAULT 0,
          decided_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (left_staff_id) REFERENCES corps_staff(staff_id) ON DELETE CASCADE,
          FOREIGN KEY (right_staff_id) REFERENCES corps_staff(staff_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_shows (
          show_id TEXT PRIMARY KEY,
          corps_key TEXT NOT NULL,
          corps_name TEXT,
          season TEXT NOT NULL,
          title TEXT NOT NULL,
          subtitle TEXT,
          description TEXT,
          premiere_date TEXT,
          venue TEXT,
          tagline TEXT,
          designer_notes TEXT,
          source_url TEXT,
          metadata_json TEXT,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_show_tags (
          show_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (show_id, tag),
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_show_media (
          media_id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL,
          media_type TEXT,
          title TEXT,
          description TEXT,
          url TEXT NOT NULL,
          thumbnail_url TEXT,
          attribution TEXT,
          published_at TEXT,
          duration_seconds INTEGER,
          metadata_json TEXT,
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_show_repertoire (
          entry_id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL,
          work_title TEXT NOT NULL,
          composer TEXT,
          arranger TEXT,
          description TEXT,
          hyperlink TEXT,
          related_corps_key TEXT,
          notes TEXT,
          metadata_json TEXT,
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_show_reviews (
          review_id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL,
          author_name TEXT,
          author_profile_url TEXT,
          publication TEXT,
          published_at TEXT,
          rating REAL,
          summary TEXT,
          content TEXT,
          source_url TEXT,
          metadata_json TEXT,
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    // NEW: Show announcement scrape archive (mirrors corps_page_scrapes pattern)
    sql`CREATE TABLE IF NOT EXISTS show_announcement_scrapes (
          corps_key TEXT NOT NULL,
          source_url TEXT NOT NULL,
          source_type TEXT NOT NULL,
          scraped_at INTEGER NOT NULL,
          raw_html TEXT,
          parsed_json TEXT,
          http_status INTEGER,
          PRIMARY KEY (corps_key, source_url, scraped_at)
        )`,
    // NEW: Show designers (1:many per show)
    sql`CREATE TABLE IF NOT EXISTS corps_show_designers (
          designer_id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          role TEXT NOT NULL,
          name TEXT NOT NULL,
          source_url TEXT,
          scraped_at INTEGER,
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    // NEW: Show movements (ordered 1:many per show)
    sql`CREATE TABLE IF NOT EXISTS corps_show_movements (
          movement_id TEXT PRIMARY KEY,
          show_id TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          source_url TEXT,
          scraped_at INTEGER,
          FOREIGN KEY (show_id) REFERENCES corps_shows(show_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS season_participation (
          season TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          participation_id TEXT,
          corps_name TEXT,
          division TEXT,
          status TEXT,
          participation_type TEXT,
          first_appearance TEXT,
          last_appearance TEXT,
          notes TEXT,
          derived_from TEXT,
          metadata_json TEXT,
          PRIMARY KEY (season, corps_key),
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS media_assets (
          media_id TEXT PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          media_type TEXT,
          format TEXT,
          attribution TEXT,
          width INTEGER,
          height INTEGER,
          duration_seconds INTEGER,
          thumbnail_url TEXT,
          source_url TEXT,
          metadata_json TEXT
        )`,
    sql`CREATE TABLE IF NOT EXISTS season_rankings (
          season TEXT NOT NULL,
          snapshot_index INTEGER NOT NULL,
          competition_slug TEXT,
          competition_date TEXT,
          day_of_season INTEGER,
          days_till_finals INTEGER,
          percent_through REAL,
          PRIMARY KEY (season, snapshot_index),
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE SET NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS season_ranking_entries (
          season TEXT NOT NULL,
          snapshot_index INTEGER NOT NULL,
          metric TEXT NOT NULL,
          metric_position INTEGER NOT NULL,
          corps_key TEXT,
          corps_name TEXT NOT NULL,
          division_name TEXT,
          score REAL,
          percent_through REAL,
          competition_rank INTEGER,
          competition_slug TEXT,
          PRIMARY KEY (season, snapshot_index, metric, corps_name),
          FOREIGN KEY (season, snapshot_index) REFERENCES season_rankings(season, snapshot_index) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE SET NULL,
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE SET NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          event_name TEXT,
          slug TEXT NOT NULL,
          description TEXT,
          season TEXT,
          year TEXT,
          start_time TEXT,
          edt_start_time TEXT,
          fed TEXT,
          location_city TEXT,
          location_state TEXT,
          venue_city TEXT,
          venue_state TEXT,
          timezone TEXT,
          region_for_web TEXT,
          buy_tickets TEXT,
          buy_tickets_text TEXT,
          presenting_sponsor TEXT,
          small_logo TEXT,
          live_stream_link TEXT,
          tickets_on_sale TEXT,
          event_image_thumb TEXT,
          ticket_watermark TEXT,
          start_date TEXT NOT NULL,
          end_date TEXT,
          web_start_time TEXT,
          notes_general TEXT,
          notes_lineup_times TEXT,
          notes_individual_tickets TEXT,
          notes_group_tickets TEXT,
          min_ticket_price REAL,
          max_ticket_price REAL,
          individual_tickets_disclaimer TEXT,
          group_tickets_disclaimer TEXT,
          group_ticket_threshold REAL,
          group_price_1 REAL,
          group_price_4 REAL,
          group_price_5 REAL,
          group_price_6 REAL,
          min_group_ticket_price REAL,
          max_group_ticket REAL,
          buy_group_tickets TEXT,
          event_image TEXT,
          ticketing_map_image TEXT,
          street_map_image TEXT,
          meta_description TEXT,
          meta_title TEXT,
          category_for_web_calendar TEXT,
          toc_event INTEGER,
          entity_type TEXT,
          contract_date TEXT,
          tep_contract_date TEXT,
          contract_price_text TEXT,
          x1st_pay_text TEXT,
          x2nd_pt_text TEXT,
          balance_due_text TEXT,
          sound_check_time TEXT,
          staff_office TEXT,
          meal_room TEXT,
          judges_location TEXT,
          suites_in_use TEXT,
          press_box TEXT,
          marketing_location TEXT,
          flo_marching_location TEXT,
          tabulation_location TEXT,
          event_comp_type_pl TEXT,
          event_special INTEGER,
          sponsor_load_time TEXT,
          meal_information TEXT,
          water_station_location TEXT,
          sponsor_reception TEXT,
          evacuation_location TEXT,
          corps_parking TEXT,
          standstill_cancellation TEXT,
          corps_field_entry TEXT,
          front_ensemble_field_entry TEXT,
          corps_field_exit TEXT,
          front_ensemble_field_exit TEXT,
          corps_warm_up_location TEXT,
          announcer_location TEXT,
          prop_field_entry TEXT,
          prop_field_exit TEXT,
          prop_staging_area TEXT,
          tour_event_partner_contract_status TEXT,
          ticket_service_agreement_status TEXT,
          staff_parking TEXT,
          deposit_text TEXT,
          group_bus_parking TEXT,
          yearbook_sales INTEGER,
          main_gate_souvenir_sales INTEGER,
          contest_coordinator_cell TEXT,
          tep_primary_contact_email TEXT,
          travel_contact_email TEXT,
          marketplace_location TEXT,
          marketplace_electricity INTEGER,
          spectator_entrance TEXT,
          spectator_re_entry TEXT,
          box_office_will_call_location TEXT,
          concessions TEXT,
          emt_ambulance_location TEXT,
          table_chairs_on_field INTEGER,
          mics_on_field INTEGER,
          security TEXT,
          box_office_volunteers INTEGER,
          ticket_takers TEXT,
          ushers TEXT,
          key_locations_verification TEXT,
          corps_info_verification TEXT,
          parking_verification TEXT,
          key_times_verification TEXT,
          event_safety_information TEXT,
          season_values TEXT,
          bsa TEXT,
          bca TEXT,
          bsta TEXT,
          bpa TEXT,
          tep_name TEXT,
          print_marketplace_footprint_community TEXT,
          print_parking_lot_footprint_community TEXT,
          print_props_and_electrical_footprint_com TEXT,
          print_show_sheet_community TEXT
        )`,
    sql`CREATE TABLE IF NOT EXISTS page_content (
          url TEXT PRIMARY KEY,
          background_image TEXT
        )`,
    // NOTE: these event tables are NOT dropped — they hold ingested data and the
    // CREATEs below are IF NOT EXISTS. Dropping them here previously wiped live
    // lineup/participant/venue data whenever this schema-ensure ran against a DB
    // whose table schema was newer than this file. Rebuild via the ingest/backfill
    // scripts, not a destructive schema reset.
    sql`CREATE TABLE IF NOT EXISTS event_venues (
          venue_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          event_slug TEXT,
          name TEXT NOT NULL,
          address TEXT,
          zio_postcode TEXT,
          google_maps_static_map TEXT,
          venue_latitude REAL,
          venue_longitude REAL,
          venue_capacity_alternate TEXT,
          venue_total_capacity TEXT,
          field_hashmarks_type TEXT,
          goal_posts INTEGER,
          field_electricity INTEGER,
          american_flag_location TEXT,
          tunnel_height TEXT,
          videoboard INTEGER,
          access_to_stadium_box_office INTEGER,
          air_conditioning INTEGER,
          selling_windows_available TEXT,
          furniture_needs TEXT,
          main_box_office_location TEXT,
          field_electricity_locations TEXT,
          field_hashmarks INTEGER,
          gp_latitude REAL,
          gp_longitude REAL,
          gp_geocode_quality TEXT,
          gp_geocode_retrieval_time TEXT,
          clear_bag_venue INTEGER,
          merchandise_buyout_venue INTEGER,
          marketplace_location TEXT,
          bag_policy TEXT,
          spectator_entrance TEXT,
          spectator_re_entry TEXT,
          box_office_will_call_location TEXT,
          concessions TEXT,
          emt_ambulance_location TEXT,
          table_chairs_on_field INTEGER,
          mics_on_field INTEGER,
          sound_ordinance TEXT,
          ticket_takers TEXT,
          box_office_volunteers INTEGER,
          ushers TEXT,
          security TEXT,
          seat_numbering INTEGER,
          seat_size TEXT,
          marketplace_type TEXT,
          marketplace_electricity TEXT,
          bag_policy_description TEXT,
          cashless_stadium INTEGER,
          re_entry_credential_type TEXT,
          stadium_weather_shelter_policy TEXT,
          venue_operated_lightning_detection INTEGER,
          lightning_detection_system_name_type TEXT,
          programmed_lightning_radius TEXT,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS event_schedules (
          schedule_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          unit_name TEXT NOT NULL,
          display_city TEXT,
          time TEXT NOT NULL,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS event_participants (
          event_slug TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          participant_slug TEXT,
          participant_name TEXT,
          performance_order INTEGER,
          PRIMARY KEY (event_slug, participant_id),
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS event_lineup_entries (
          entry_id TEXT PRIMARY KEY,
          event_slug TEXT NOT NULL,
          participant_id TEXT,
          unit_name TEXT NOT NULL,
          display_city TEXT,
          time TEXT,
          performance_order INTEGER,
          is_non_performance INTEGER NOT NULL DEFAULT 0,
          is_exhibition INTEGER NOT NULL DEFAULT 0,
          source_scraped_at TEXT,
          source_url TEXT,
          lineup_index INTEGER,
          FOREIGN KEY (event_slug, participant_id) REFERENCES event_participants(event_slug, participant_id) ON DELETE SET NULL
        )`,
    sql`CREATE TABLE IF NOT EXISTS event_page_scrapes (
          event_slug TEXT NOT NULL,
          scraped_at TEXT NOT NULL,
          source_url TEXT,
          event_name TEXT,
          event_date_text TEXT,
          location_text TEXT,
          watch_live_link TEXT,
          buy_tickets_link TEXT,
          about_text TEXT,
          about_html TEXT,
          tickets_json TEXT,
          lineup_json TEXT,
          location_address TEXT,
          location_google_map_link TEXT,
          location_google_map_iframe TEXT,
          location_images_json TEXT,
          hero_image TEXT,
          PRIMARY KEY (event_slug, scraped_at)
        )`,
    sql`CREATE TABLE IF NOT EXISTS website_score_lists (
          season TEXT NOT NULL,
          page INTEGER NOT NULL,
          scraped_at TEXT NOT NULL,
          source_url TEXT,
          raw_html TEXT NOT NULL,
          parsed_json TEXT,
          entry_count INTEGER,
          PRIMARY KEY (season, page, scraped_at)
        )`,
    sql`CREATE TABLE IF NOT EXISTS website_recaps (
          recap_slug TEXT NOT NULL,
          season TEXT NOT NULL,
          scraped_at TEXT NOT NULL,
          source_url TEXT,
          event_name TEXT,
          event_date TEXT,
          location TEXT,
          chief_judge TEXT,
          raw_html TEXT NOT NULL,
          parsed_json TEXT,
          corps_count INTEGER,
          PRIMARY KEY (recap_slug, scraped_at)
        )`,

    sql`CREATE TABLE IF NOT EXISTS event_group_types (
          event_slug TEXT NOT NULL,
          group_type_id TEXT NOT NULL,
          PRIMARY KEY (event_slug, group_type_id),
          FOREIGN KEY (group_type_id) REFERENCES group_types(group_type_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS galleries (
          slug TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          published_date TEXT,
          created_at TEXT,
          presented_by TEXT,
          gallery_type INTEGER
        )`,
    sql`CREATE TABLE IF NOT EXISTS gallery_images (
          image_id TEXT PRIMARY KEY,
          gallery_slug TEXT NOT NULL,
          url TEXT NOT NULL,
          caption TEXT,
          copyright_name TEXT,
          copyright_url TEXT,
          copyright_description TEXT,
          copyright_abbrev TEXT,
          copyright_active INTEGER,
          copyright_is_default INTEGER,
          copyright_media_category INTEGER,
          FOREIGN KEY (gallery_slug) REFERENCES galleries(slug) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS gallery_tags (
          gallery_slug TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (gallery_slug, tag),
          FOREIGN KEY (gallery_slug) REFERENCES galleries(slug) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS gallery_corps (
          gallery_slug TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          PRIMARY KEY (gallery_slug, corps_key),
          FOREIGN KEY (gallery_slug) REFERENCES galleries(slug) ON DELETE CASCADE,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS sponsors (
          sponsor_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          link TEXT,
          logo TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          display_order INTEGER,
          created_at INTEGER,
          updated_at INTEGER
        )`,
    sql`CREATE TABLE IF NOT EXISTS past_champions (
          champion_id TEXT PRIMARY KEY,
          year TEXT NOT NULL,
          champion_name TEXT NOT NULL,
          city TEXT,
          score REAL,
          class TEXT NOT NULL,
          champion_type INTEGER
        )`,
    sql`CREATE TABLE IF NOT EXISTS scraper_progress (
          task_type TEXT NOT NULL,
          season TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload TEXT,
          PRIMARY KEY (task_type, season, corps_key)
        )`,
    sql`CREATE TABLE IF NOT EXISTS api_responses (
          endpoint_url TEXT PRIMARY KEY,
          endpoint_type TEXT NOT NULL,
          season TEXT,
          fetched_at TEXT NOT NULL,
          response_json TEXT NOT NULL,
          record_count INTEGER
        )`,
    sql`CREATE TABLE IF NOT EXISTS performance_classes (
          name TEXT PRIMARY KEY
        )`,
    // Maps event slugs (from the events table, which come from the DCI website)
    // to competition slugs (from the competitions table, which hold scores/recaps).
    // The two tables often have different slugs for the same real-world event —
    // e.g. events.slug = "2025-dci-all-age-world-championship-finals" but
    // competitions.slug = "2025-dci-all-age-world-championship". This mapping
    // is populated at ingest time and backfilled for existing data.
    sql`CREATE TABLE IF NOT EXISTS event_to_competition (
          event_slug TEXT PRIMARY KEY,
          competition_slug TEXT NOT NULL,
          match_method TEXT NOT NULL DEFAULT 'heuristic',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_slug) REFERENCES events(slug) ON DELETE CASCADE,
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE
        )`,
    sql`CREATE INDEX IF NOT EXISTS idx_event_to_competition_competition_slug
          ON event_to_competition(competition_slug)`,

    // --- CREATE VIEWS ---
    sql`CREATE VIEW IF NOT EXISTS judge_scores_enriched AS
        SELECT
          comp.season AS season,
          comp.slug AS competition_slug,
          comp.event_name AS event_name,
          comp.date AS competition_date,
          comp.location AS location,
          comp.day_of_season AS day_of_season,
          comp.days_till_finals AS days_till_finals,
          comp.percent_through AS percent_through,
          comp.competition_level AS competition_level,
          comp.scores_released AS scores_released,
          comp.recap_released AS recap_released,
          comp.category_recap_released AS category_recap_released,
          ('https://api.dci.org/api/v1/competitions/' || comp.slug) AS recap_api_url,
          cs.corps_key AS corps_key,
          cs.corps_name AS corps_name,
          cs.division_name AS division_name,
          cs.group_type_id AS group_type_id,
          cs.competition_type_id AS competition_type_id,
          cs.rank AS corps_rank,
          cs.total_score AS corps_total_score,
          js.caption_name AS caption_name,
          js.score AS judge_score,
          js.rank AS judge_rank,
          judges.judge_id AS judge_id,
          judges.display_name AS judge_name
        FROM judge_scores js
        JOIN competitions comp ON comp.slug = js.competition_slug
        JOIN corps_scores cs
          ON cs.competition_slug = js.competition_slug
         AND cs.corps_key = js.corps_key
        LEFT JOIN judges ON judges.judge_id = js.judge_id`,
    sql`CREATE VIEW IF NOT EXISTS corps_competition_results AS
        SELECT
          comp.season AS season,
          comp.slug AS competition_slug,
          comp.event_name AS event_name,
          comp.date AS competition_date,
          comp.location AS location,
          comp.day_of_season AS day_of_season,
          comp.days_till_finals AS days_till_finals,
          comp.percent_through AS percent_through,
          cs.corps_key AS corps_key,
          cs.corps_name AS corps_name,
          cs.division_name AS division_name,
          cs.rank AS corps_rank,
          cs.total_score AS total_score,
          cs.subtotal_score AS subtotal_score,
          cs.subtotal_rank AS subtotal_rank,
          cs.group_type_id AS group_type_id,
          cs.competition_type_id AS competition_type_id
        FROM corps_scores cs
        JOIN competitions comp ON comp.slug = cs.competition_slug`,
    sql`CREATE VIEW IF NOT EXISTS season_ranking_entries_long AS
        SELECT
          sr.season AS season,
          sr.snapshot_index AS snapshot_index,
          sr.competition_slug AS competition_slug,
          sr.competition_date AS competition_date,
          sr.day_of_season AS day_of_season,
          sr.days_till_finals AS days_till_finals,
          sr.percent_through AS percent_through,
          entries.metric AS metric,
          entries.metric_position AS metric_position,
          entries.corps_key AS corps_key,
          entries.corps_name AS corps_name,
          entries.division_name AS division_name,
          entries.score AS score,
          entries.percent_through AS entry_percent_through,
          entries.competition_rank AS competition_rank
        FROM season_rankings sr
        JOIN season_ranking_entries entries
          ON entries.season = sr.season
         AND entries.snapshot_index = sr.snapshot_index`,
    sql`CREATE VIEW IF NOT EXISTS season_participation_view AS
        SELECT DISTINCT
            e.season,
            cs.corps_key,
            MAX(cs.corps_name) AS corps_name,
            MAX(cs.division_name) AS division,
            'derived' AS status,
            MIN(e.start_date) AS first_appearance,
            MAX(e.start_date) AS last_appearance
        FROM corps_scores cs
        JOIN events e ON e.slug = cs.competition_slug
        GROUP BY e.season, cs.corps_key`,
    sql`CREATE VIEW IF NOT EXISTS season_participation_view AS
        SELECT DISTINCT
            e.season,
            cs.corps_key,
            MAX(cs.corps_name) AS corps_name,
            MAX(cs.division_name) AS division,
            'derived' AS status,
            MIN(e.start_date) AS first_appearance,
            MAX(e.start_date) AS last_appearance
        FROM corps_scores cs
        JOIN events e ON e.slug = cs.competition_slug
        GROUP BY e.season, cs.corps_key`,
    sql`CREATE VIEW IF NOT EXISTS appearances AS
        SELECT
          e.slug AS event_slug,
          e.event_id AS event_id,
          e.name AS event_name,
          e.start_date AS event_start_date,
          e.start_time AS event_start_time,
          e.edt_start_time AS event_edt_start_time,
          e.location_city AS location_city,
          e.location_state AS location_state,
          e.venue_city AS venue_city,
          e.venue_state AS venue_state,
          e.timezone AS timezone,
          c.slug AS competition_slug,
          c.event_name AS competition_event_name,
          c.date AS competition_date,
          c.season AS season,
          c.competition_level AS competition_level,
          c.scores_released AS scores_released,
          c.recap_released AS recap_released,
          c.category_recap_released AS category_recap_released,
          c.slug AS recap_id,
          es.schedule_id AS lineup_id,
          es.time AS performance_time,
          COALESCE(es.unit_name, cs.corps_name, co.name) AS lineup_unit_name,
          es.display_city AS lineup_display_city,
          cs.corps_key AS corps_key,
          cs.corps_name AS group_name,
          cs.division_name AS division_name,
          cs.total_score AS total_score,
          cs.subtotal_score AS subtotal_score,
          cs.rank AS rank,
          cs.round AS round,
          COALESCE(
            ele.performance_order,
            ep.performance_order,
            es.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY e.slug
              ORDER BY es.time IS NULL, es.time, cs.corps_key
            )
          ) AS performance_order_overall,
          COALESCE(
            ele.performance_order,
            ep.performance_order,
            es.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY e.slug, cs.division_name
              ORDER BY es.time IS NULL, es.time, cs.corps_key
            )
          ) AS performance_order_in_class,
          COUNT(*) OVER (
            PARTITION BY e.slug, cs.division_name
          ) AS number_of_performers_in_class
        FROM corps_scores cs
        JOIN competitions c ON c.slug = cs.competition_slug
        JOIN events e ON e.slug = c.slug
        LEFT JOIN corps co ON co.corps_key = cs.corps_key
        LEFT JOIN event_schedules es
          ON es.event_id = e.event_id
          AND (
            LOWER(REPLACE(REPLACE(es.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(cs.corps_name, ' ', ''), '-', ''))
            OR LOWER(REPLACE(REPLACE(es.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(co.name, ' ', ''), '-', ''))
          )
        LEFT JOIN event_lineup_entries ele
          ON ele.event_slug = e.slug
          AND (
            LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(cs.corps_name, ' ', ''), '-', ''))
            OR LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(co.name, ' ', ''), '-', ''))
          )
        LEFT JOIN event_participants ep
          ON ep.event_slug = e.slug
          AND ep.corps_key = cs.corps_key`,
    sql`CREATE VIEW IF NOT EXISTS event_schedules_with_event_order_and_corps_key_and_class_from_that_season AS
        WITH noise_keywords AS (
            SELECT 'gates open' AS kw UNION ALL SELECT 'intermission' UNION ALL 
            SELECT 'anthem' UNION ALL SELECT 'scores announced' UNION ALL 
            SELECT 'final scores' UNION ALL SELECT 'recognition' UNION ALL 
            SELECT 'ceremony' UNION ALL SELECT 'age-out' UNION ALL 
            SELECT 'age out' UNION ALL SELECT 'retreat' UNION ALL 
            SELECT 'welcome' UNION ALL SELECT 'preshow' UNION ALL 
            SELECT 'pre show' UNION ALL SELECT 'pre-show' UNION ALL 
            SELECT 'announcement' UNION ALL SELECT 'encore' UNION ALL 
            SELECT 'change' UNION ALL SELECT 'changeover' UNION ALL 
            SELECT 'score' UNION ALL SELECT 'annouced' UNION ALL 
            SELECT 'givaway' UNION ALL SELECT 'presentation' UNION ALL 
            SELECT 'spectator' UNION ALL SELECT 'judges meeting'
        ),
        normalized_corps AS (
            SELECT
                co.corps_key, co.name, co.slug, co.division_name, co.active, co.corps_id,
                replace(replace(replace(replace(lower(co.name), ' ', ''), '-', ''), '&', ''), '.', '') AS normalized_name
            FROM corps co
            WHERE co.name NOT LIKE '%(%)%'
        ),
        raw_schedules AS (
            SELECT 
                es.*,
                replace(replace(replace(replace(lower(es.unit_name), ' ', ''), '-', ''), '&', ''), '.', '') AS normalized_name
            FROM event_schedules es
            WHERE NOT EXISTS (
                SELECT 1 FROM noise_keywords nk 
                WHERE LOWER(es.unit_name) = nk.kw
            )
        ),
        filtered_schedules AS (
            SELECT rs.* FROM raw_schedules rs
            WHERE EXISTS (SELECT 1 FROM normalized_corps nc WHERE rs.normalized_name = nc.normalized_name OR rs.normalized_name LIKE '%' || nc.normalized_name || '%')
            OR NOT EXISTS (SELECT 1 FROM noise_keywords nk WHERE LOWER(rs.unit_name) LIKE '%' || nk.kw || '%')
        ),
        matches AS (
            SELECT
                fs.*,
                nc.corps_key AS nc_corps_key, nc.division_name AS nc_division,
                ROW_NUMBER() OVER (
                    PARTITION BY fs.schedule_id 
                    ORDER BY 
                        (fs.normalized_name = nc.normalized_name) DESC,
                        nc.active DESC,
                        nc.corps_id IS NOT NULL DESC
                ) as match_priority
            FROM filtered_schedules fs
            LEFT JOIN normalized_corps nc ON 
                fs.normalized_name = nc.normalized_name OR
                fs.normalized_name LIKE '%' || nc.normalized_name || '%'
        ),
        best_matches AS (
            SELECT * FROM matches WHERE match_priority = 1
        )
        SELECT
          e.season,
          e.slug AS event_slug,
          bm.unit_name,
          bm.time,
          bm.nc_corps_key AS corps_key,
          COALESCE(sp.division, cs.division_name, bm.nc_division) AS class_from_that_season,
          ROW_NUMBER() OVER (
            PARTITION BY e.slug
            ORDER BY bm.time IS NULL, bm.time, bm.schedule_id
          ) AS event_order
        FROM best_matches bm
        JOIN events e ON e.event_id = bm.event_id
        LEFT JOIN corps_scores cs
          ON cs.competition_slug = e.slug
         AND (cs.corps_key = bm.nc_corps_key OR cs.corps_name = bm.unit_name)
        LEFT JOIN season_participation_view sp ON sp.season = e.season AND sp.corps_key = bm.nc_corps_key`,

    // --- V7 CURRICULUM LEARNING TABLES ---
    sql`CREATE TABLE IF NOT EXISTS judge_elo_ratings (
          judge_id TEXT NOT NULL,
          season TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          elo_rating REAL NOT NULL DEFAULT 1500,
          confidence REAL NOT NULL DEFAULT 50,
          num_scores INTEGER NOT NULL DEFAULT 0,
          last_updated TEXT,
          PRIMARY KEY (judge_id, season, caption_name),
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS judge_elo_history (
          history_id INTEGER PRIMARY KEY AUTOINCREMENT,
          judge_id TEXT NOT NULL,
          season TEXT NOT NULL,
          competition_slug TEXT NOT NULL,
          caption_name TEXT NOT NULL,
          elo_before REAL NOT NULL,
          elo_after REAL NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_elo_ratings (
          corps_key TEXT NOT NULL,
          season TEXT NOT NULL,
          caption_name TEXT NOT NULL DEFAULT 'overall',
          elo_rating REAL NOT NULL DEFAULT 1500,
          confidence REAL NOT NULL DEFAULT 50,
          num_shows INTEGER NOT NULL DEFAULT 0,
          last_updated TEXT,
          PRIMARY KEY (corps_key, season, caption_name),
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS corps_elo_history (
          history_id INTEGER PRIMARY KEY AUTOINCREMENT,
          corps_key TEXT NOT NULL,
          season TEXT NOT NULL,
          competition_slug TEXT NOT NULL,
          caption_name TEXT,
          elo_before REAL NOT NULL,
          elo_after REAL NOT NULL,
          competition_date TEXT NOT NULL,
          FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
        )`,
    sql`CREATE TABLE IF NOT EXISTS ml_sequence_rows_v7 (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          season TEXT NOT NULL,
          competition_slug TEXT NOT NULL,
          competition_date TEXT NOT NULL,
          division_name TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          corps_id INTEGER,
          x_sequence_json TEXT NOT NULL,
          x_static_json TEXT NOT NULL,
          judge_indices_json TEXT NOT NULL,
          y_residuals_json TEXT NOT NULL,
          y_recap_json TEXT NOT NULL,
          y_total REAL NOT NULL,
          agnostic_show_id INTEGER NOT NULL DEFAULT 0,
          split TEXT NOT NULL CHECK(split IN ('train','val','test')),
          created_at TEXT NOT NULL,
          UNIQUE(season, competition_slug, division_name, corps_key)
        )`,
    sql`CREATE TABLE IF NOT EXISTS ml_sequence_rows_v9 (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          season TEXT NOT NULL,
          competition_slug TEXT NOT NULL,
          competition_date TEXT NOT NULL,
          division_name TEXT NOT NULL,
          corps_key TEXT NOT NULL,
          corps_id INTEGER,
          x_sequence_json TEXT NOT NULL,
          x_static_json TEXT NOT NULL,
          judge_indices_json TEXT NOT NULL,
          y_residuals_json TEXT NOT NULL,
          y_recap_json TEXT NOT NULL,
          y_total REAL NOT NULL,
          agnostic_show_id INTEGER NOT NULL DEFAULT 0,
          split TEXT NOT NULL CHECK(split IN ('train','val','test')),
          created_at TEXT NOT NULL,
          UNIQUE(season, competition_slug, division_name, corps_key)
        )`,
    sql`CREATE TABLE IF NOT EXISTS show_aggregates_v7 (
          competition_slug TEXT PRIMARY KEY,
          avg_total REAL NOT NULL,
          std_total REAL NOT NULL,
          avg_ge1 REAL NOT NULL,
          avg_ge2 REAL NOT NULL,
          avg_vp REAL NOT NULL,
          avg_va REAL NOT NULL,
          avg_cg REAL NOT NULL,
          avg_ma REAL NOT NULL,
          avg_mb REAL NOT NULL,
          avg_mp REAL NOT NULL,
          field_size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (competition_slug) REFERENCES competitions(slug) ON DELETE CASCADE
        )`,

    // Heuristic rules (as data) for classifying lineup rows. `category`:
    // 'schedule_item' = agenda/venue noise (not a performer), 'exhibition' =
    // real non-competing performer, 'model' = excluded from the prediction model.
    // Seeded from sdk/src/lineupClassification.ts via scripts/applyLineupClassification.ts.
    sql`CREATE TABLE IF NOT EXISTS domain_event_exclusion_patterns (
          pattern TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          applies_to_model INTEGER NOT NULL DEFAULT 1,
          category TEXT NOT NULL DEFAULT 'model'
        )`,

    // --- LINEUP CLASSIFICATION VIEWS ---
    // One row per lineup entry with pattern-driven classification. This is the
    // shared read model for app schedule display, model views, and audits.
    // Pattern priority: schedule_item > not_a_corps > alumni > exhibition > model.
    sql`CREATE VIEW IF NOT EXISTS classified_event_lineup AS
        WITH pattern_matches AS (
          SELECT
            ele.entry_id,
            p.pattern,
            p.category,
            p.reason,
            p.applies_to_model,
            row_number() OVER (
              PARTITION BY ele.entry_id
              ORDER BY
                CASE p.category
                  WHEN 'schedule_item' THEN 0
                  WHEN 'not_a_corps' THEN 1
                  WHEN 'alumni' THEN 2
                  WHEN 'exhibition' THEN 3
                  WHEN 'model' THEN 4
                  ELSE 99
                END,
                length(p.pattern) DESC,
                p.pattern
            ) AS match_rank
          FROM event_lineup_entries ele
          JOIN domain_event_exclusion_patterns p
            ON lower(ele.unit_name) LIKE p.pattern
        ),
        selected_pattern AS (
          SELECT entry_id, pattern, category, reason, applies_to_model
          FROM pattern_matches
          WHERE match_rank = 1
        )
        SELECT
          ele.event_slug,
          ele.entry_id,
          ele.lineup_index,
          ele.performance_order,
          ele.unit_name,
          ele.display_city,
          ele.time,
          ele.participant_id AS raw_participant_id,
          ep.corps_key AS raw_corps_key,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE ele.participant_id
          END AS participant_id,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE ep.corps_key
          END AS corps_key,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE ep.participant_slug
          END AS participant_slug,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE COALESCE(ep.participant_name, c.name, ele.unit_name)
          END AS participant_name,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE c.division_name
          END AS division_name,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE c.name
          END AS canonical_corps_name,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
            ELSE c.display_city
          END AS canonical_display_city,
          ele.is_exhibition,
          ele.is_non_performance AS stored_is_non_performance,
          sp.pattern AS pattern,
          sp.category AS pattern_category,
          sp.reason AS pattern_reason,
          sp.applies_to_model AS pattern_applies_to_model,
          CASE WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN 1 ELSE 0 END AS is_non_corps,
          CASE
            WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN 1
            ELSE ele.is_non_performance
          END AS effective_is_non_performance,
          CASE
            WHEN sp.category = 'schedule_item' THEN 'schedule_item'
            WHEN sp.category = 'not_a_corps' THEN 'not_a_corps'
            WHEN ele.is_non_performance = 1 THEN 'non_performance'
            WHEN COALESCE(ele.is_exhibition, 0) = 1 THEN 'exhibition'
            WHEN ele.participant_id IS NULL THEN 'unmatched_participant'
            WHEN ep.corps_key IS NULL OR c.corps_key IS NULL OR c.division_name IS NULL THEN 'unresolved_corps'
            WHEN sp.category = 'alumni' THEN 'legacy_or_alumni'
            WHEN sp.category = 'exhibition' THEN 'exhibition_keyword'
            WHEN sp.category = 'model' OR COALESCE(sp.applies_to_model, 0) = 1 THEN 'model_excluded'
            ELSE 'scored'
          END AS effective_exclusion_reason
        FROM event_lineup_entries ele
        LEFT JOIN event_participants ep
          ON ep.event_slug = ele.event_slug
         AND ep.participant_id = ele.participant_id
        LEFT JOIN corps c ON c.corps_key = ep.corps_key
        LEFT JOIN selected_pattern sp ON sp.entry_id = ele.entry_id`,

    // Real competing performances feeding the prediction model: strips
    // non-performances, exhibitions, and unresolved/exhibition/alumni units.
    sql`CREATE VIEW IF NOT EXISTS scored_event_lineup AS
        SELECT
          ele.event_slug,
          ele.entry_id,
          ele.unit_name,
          ele.display_city,
          ele.time,
          ele.performance_order,
          ele.participant_id,
          ele.corps_key,
          ele.participant_slug,
          ele.participant_name,
          ele.division_name,
          ele.canonical_corps_name,
          ele.canonical_display_city
        FROM classified_event_lineup ele
        WHERE ele.effective_is_non_performance = 0
          AND COALESCE(ele.is_exhibition, 0) = 0
          AND ele.participant_id IS NOT NULL
          AND ele.corps_key IS NOT NULL
          AND ele.division_name IS NOT NULL
          AND COALESCE(ele.pattern_applies_to_model, 0) = 0
          AND (ele.pattern_category IS NULL OR ele.pattern_category NOT IN ('alumni', 'exhibition', 'model'))`,

    // Audit/explainer: every lineup row excluded from scored_event_lineup, with
    // the reason it was dropped.
    sql`CREATE VIEW IF NOT EXISTS event_lineup_exclusions AS
        SELECT
          ele.event_slug,
          ele.entry_id,
          ele.unit_name,
          ele.display_city,
          ele.time,
          ele.performance_order,
          ele.participant_id,
          ele.effective_is_non_performance AS is_non_performance,
          ele.is_exhibition,
          ele.pattern_category,
          ele.pattern_reason,
          ele.effective_exclusion_reason AS exclusion_reason
        FROM classified_event_lineup ele
        WHERE ele.effective_is_non_performance = 1
           OR COALESCE(ele.is_exhibition, 0) = 1
           OR ele.participant_id IS NULL
           OR ele.corps_key IS NULL
           OR ele.division_name IS NULL
           OR COALESCE(ele.pattern_applies_to_model, 0) = 1
           OR ele.pattern_category IN ('alumni', 'exhibition', 'model')`,

    // Corps performing at any event per season — broader than scored_event_lineup
    // (includes exhibition/alumni/legacy/guest units), excluding only agenda/venue
    // schedule-item noise via the patterns table. Drives the corps directory's
    // default ("All") visibility. See app/lib/corps-directory.ts.
    sql`CREATE VIEW IF NOT EXISTS season_performing_corps AS
        SELECT DISTINCT e.season AS season, ele.corps_key AS corps_key
        FROM classified_event_lineup ele
        JOIN events e ON e.slug = ele.event_slug
        JOIN corps c ON c.corps_key = ele.corps_key
        WHERE ele.participant_id IS NOT NULL
          AND ele.corps_key IS NOT NULL
          AND ele.is_non_corps = 0`,
  ];

  yield* Effect.forEach(
    statements,
    (statement) => statement.pipe(Effect.asVoid),
    { concurrency: 1 },
  );

  yield* sql`PRAGMA foreign_keys = ON`;

  // Backfill the `category` column on DBs predating it, then seed the canonical
  // lineup-classification patterns (idempotent). This keeps the heuristic rules
  // the directory/views depend on self-contained in schema setup — no separate
  // seed script needed for a fresh build. Pre-existing rows (e.g. the model's
  // soundsport/showcase patterns) keep their category via the column default.
  yield* ensureColumns(sql, "domain_event_exclusion_patterns", [
    "category TEXT NOT NULL DEFAULT 'model'",
  ]);
  yield* ensureColumns(sql, "event_lineup_entries", [
    "source_scraped_at TEXT",
    "source_url TEXT",
    "lineup_index INTEGER",
  ]);
  // Canonical-person grouping key, separate from the per-source `staff_id`. Nullable
  // until the identity-resolution pass assigns it; the `/staff` profile groups by it.
  yield* ensureColumns(sql, "corps_staff", [
    "person_id TEXT",
  ]);
  yield* Effect.forEach(
    ALL_EXCLUSION_PATTERNS,
    (p) =>
      sql`INSERT INTO domain_event_exclusion_patterns (pattern, reason, applies_to_model, category)
            VALUES (${p.pattern}, ${p.reason}, 0, ${p.category})
            ON CONFLICT(pattern) DO UPDATE SET reason = excluded.reason, category = excluded.category`.pipe(
        Effect.asVoid,
      ),
    { discard: true },
  );

  yield* ensureColumns(sql, "events", [
    "event_name TEXT",
    "description TEXT",
    "season TEXT",
    "year TEXT",
    "start_time TEXT",
    "fed TEXT",
    "region_for_web TEXT",
    "group_price_4 REAL",
    "group_price_5 REAL",
    "group_price_6 REAL",
    "street_map_image TEXT",
    "category_for_web_calendar TEXT",
    "toc_event INTEGER",
    "entity_type TEXT",
    "contract_date TEXT",
    "tep_contract_date TEXT",
    "contract_price_text TEXT",
    "x1st_pay_text TEXT",
    "x2nd_pt_text TEXT",
    "balance_due_text TEXT",
    "sound_check_time TEXT",
    "staff_office TEXT",
    "meal_room TEXT",
    "judges_location TEXT",
    "suites_in_use TEXT",
    "press_box TEXT",
    "marketing_location TEXT",
    "flo_marching_location TEXT",
    "tabulation_location TEXT",
    "event_comp_type_pl TEXT",
    "event_special INTEGER",
    "sponsor_load_time TEXT",
    "meal_information TEXT",
    "water_station_location TEXT",
    "sponsor_reception TEXT",
    "evacuation_location TEXT",
    "corps_parking TEXT",
    "standstill_cancellation TEXT",
    "corps_field_entry TEXT",
    "front_ensemble_field_entry TEXT",
    "corps_field_exit TEXT",
    "front_ensemble_field_exit TEXT",
    "corps_warm_up_location TEXT",
    "announcer_location TEXT",
    "prop_field_entry TEXT",
    "prop_field_exit TEXT",
    "prop_staging_area TEXT",
    "tour_event_partner_contract_status TEXT",
    "ticket_service_agreement_status TEXT",
    "staff_parking TEXT",
    "deposit_text TEXT",
    "group_bus_parking TEXT",
    "yearbook_sales INTEGER",
    "main_gate_souvenir_sales INTEGER",
    "contest_coordinator_cell TEXT",
    "tep_primary_contact_email TEXT",
    "travel_contact_email TEXT",
    "marketplace_location TEXT",
    "marketplace_electricity INTEGER",
    "spectator_entrance TEXT",
    "spectator_re_entry TEXT",
    "box_office_will_call_location TEXT",
    "concessions TEXT",
    "emt_ambulance_location TEXT",
    "table_chairs_on_field INTEGER",
    "mics_on_field INTEGER",
    "security TEXT",
    "box_office_volunteers INTEGER",
    "ticket_takers TEXT",
    "ushers TEXT",
    "key_locations_verification TEXT",
    "corps_info_verification TEXT",
    "parking_verification TEXT",
    "key_times_verification TEXT",
    "event_safety_information TEXT",
    "season_values TEXT",
    "bsa TEXT",
    "bca TEXT",
    "bsta TEXT",
    "bpa TEXT",
    "tep_name TEXT",
    "print_marketplace_footprint_community TEXT",
    "print_parking_lot_footprint_community TEXT",
    "print_props_and_electrical_footprint_com TEXT",
    "print_show_sheet_community TEXT",
  ]);
  yield* ensureColumns(sql, "corps", [
    "description TEXT",
    "entity_type TEXT",
    "corps_mmdl_link_audio TEXT",
    "corps_mmdl_link_video TEXT",
    "address TEXT",
    "city TEXT",
    "state TEXT",
    "zip TEXT",
    "country TEXT",
    "contact_name TEXT",
    "contact_title TEXT",
    "contact_email TEXT",
    "contact_phone TEXT",
    "main_phone TEXT",
    "main_email TEXT",
    "primary_email TEXT",
    "primary_contact_title TEXT",
    "phone TEXT",
    "shipping_city TEXT",
    "shipping_state TEXT",
    "company_country TEXT",
    "linked_in TEXT",
    "dcx_museum_url TEXT",
    "meta_description TEXT",
    "meta_title TEXT",
    "group_tickets_status TEXT",
    // Derived flag (0/1): the logo is "primarily dark/grey", so its dark-mode
    // source is an auto-recolored variant of corps_logo. Set by
    // scripts/flagDarkLogos.ts; preserved across ingest (not in the upsert SET).
    "corps_logo_dark INTEGER",
    // Optional hand-made dark-background logo asset. When set it overrides the
    // auto-recolor as the dark-mode source (curated; empty for now).
    "corps_logo_dark_url TEXT",
    // Two brand accent colors (hex '#rrggbb'), the source the UI derives every
    // per-corps accent / chart color from (CORPS_COLORS_PLAN; see
    // src/corpsColors.ts). Auto-extracted from the logo by
    // scripts/extractCorpsColors.ts (color_source='auto') or hand-set by the
    // color editor (color_source='manual', also recorded in
    // corps_curated_fields so ingest never clobbers a manual pick). Preserved
    // across ingest (not in the upsert SET).
    "color_primary TEXT",
    "color_secondary TEXT",
    "color_source TEXT",
    // Merch / ecommerce footprint, populated by scripts/scanMerch.ts (see
    // merchScan.ts). has_merch is 0/1; merch_platform is the detected store
    // platform (shopify, woocommerce, squarespace, ...); merch_signals is a
    // JSON array of the signals that matched; merch_checked_at is an ISO
    // timestamp of the last scan. Derived data — not part of the API ingest.
    "merch_url TEXT",
    "merch_platform TEXT",
    "has_merch INTEGER",
    "merch_signals TEXT",
    "merch_checked_at TEXT",
  ]);

  yield* ensureColumns(sql, "event_venues", [
    "event_slug TEXT",
    "google_maps_static_map TEXT",
  ]);

  yield* ensureColumns(sql, "merch_stores", [
    "listed INTEGER NOT NULL DEFAULT 1",
  ]);

  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_merch_products_store ON merch_products(store_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_merch_products_available ON merch_products(available)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_merch_products_currency ON merch_products(currency)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_merch_stores_corps ON merch_stores(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_corps_scores_corps ON corps_scores(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_assignments_judge ON judge_assignments(judge_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_scores_judge ON judge_scores(judge_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_scores_competition ON judge_scores(competition_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_relations_judge ON judge_corps_relations(judge_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_relations_corps ON judge_corps_relations(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_highlights_judge ON judge_highlights(judge_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_staff_person ON corps_staff(person_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_staff_review_unresolved ON corps_staff_review(resolved)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_staff_assignments_corps ON corps_staff_assignments(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_staff_assignments_season ON corps_staff_assignments(season)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_staff_assignments_staff ON corps_staff_assignments(staff_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_shows_corps ON corps_shows(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_shows_corps_season ON corps_shows(corps_key, season)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_repertoire_show ON corps_show_repertoire(show_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_designers_show ON corps_show_designers(show_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_designers_role ON corps_show_designers(role)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_movements_show ON corps_show_movements(show_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_scrapes_corps ON show_announcement_scrapes(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_scrapes_type ON show_announcement_scrapes(source_type)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_type, owner_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_season_rankings_season ON season_rankings(season)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_season_ranking_entries_metric ON season_ranking_entries(season, metric)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_season_ranking_entries_corps ON season_ranking_entries(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_api_responses_type ON api_responses(endpoint_type)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_api_responses_season ON api_responses(season)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_venues_event ON event_venues(event_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_schedules_event ON event_schedules(event_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_participants_corps ON event_participants(corps_key)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_lineup_event ON event_lineup_entries(event_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_lineup_participant ON event_lineup_entries(participant_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_group_types_event ON event_group_types(event_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_group_types_group ON event_group_types(group_type_id)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_event_page_scrapes_event ON event_page_scrapes(event_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_gallery_images_gallery ON gallery_images(gallery_slug)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_past_champions_year ON past_champions(year)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_past_champions_class ON past_champions(class)",
  );

  // V7 Indexes
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_judge_elo_season ON judge_elo_ratings(season, caption_name)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_corps_elo_season ON corps_elo_ratings(season)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_corps_elo_history_date ON corps_elo_history(corps_key, season, competition_date)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_ml_v7_division ON ml_sequence_rows_v7(division_name)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_ml_v9_division ON ml_sequence_rows_v9(division_name)",
  );
  yield* ensureIndex(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_show_aggregates_v7_slug ON show_aggregates_v7(competition_slug)",
  );
});

const competitionOrder = Order.mapInput(
  Order.Number,
  (competition: Domain.Competition) => competition.date.getTime(),
);

interface IngestCounters {
  readonly competitions: Ref.Ref<number>;
  readonly recaps: Ref.Ref<number>;
  readonly corpsScores: Ref.Ref<number>;
  readonly judgeScores: Ref.Ref<number>;
  readonly subcaptionScores: Ref.Ref<number>;
}

const makeCounters = () =>
  Effect.all({
    competitions: Ref.make(0),
    recaps: Ref.make(0),
    corpsScores: Ref.make(0),
    judgeScores: Ref.make(0),
    subcaptionScores: Ref.make(0),
  });

const increment = (ref: Ref.Ref<number>, delta = 1) =>
  Ref.update(ref, (value) => value + delta);

const insertCompetition = (
  sql: SqlClient.SqlClient,
  season: string,
  competition: Domain.Competition,
  meta: { dayOfSeason: number; daysTillFinals: number; percentThrough: number },
) =>
  sql`
    INSERT INTO competitions (
      slug, season, event_name, location, date, competition_level,
      scores_released, recap_released, category_recap_released,
      chief_judge, day_of_season, days_till_finals, percent_through
    ) VALUES (
      ${competition.slug},
      ${season},
      ${competition.eventName},
      ${competition.location},
      ${competition.date.toISOString()},
      ${competition.competitionLevel},
      ${boolToInt(competition.scoresReleased)},
      ${boolToInt(competition.recapReleased)},
      ${boolToInt(competition.categoryRecapReleased)},
      ${competition.chiefJudge ?? null},
      ${meta.dayOfSeason},
      ${meta.daysTillFinals},
      ${meta.percentThrough}
    )
    ON CONFLICT(slug) DO UPDATE SET
      season=excluded.season,
      event_name=excluded.event_name,
      location=excluded.location,
      date=excluded.date,
      competition_level=excluded.competition_level,
      scores_released=excluded.scores_released,
      recap_released=excluded.recap_released,
      category_recap_released=excluded.category_recap_released,
      chief_judge=excluded.chief_judge,
      day_of_season=excluded.day_of_season,
      days_till_finals=excluded.days_till_finals,
      percent_through=excluded.percent_through
  `.pipe(Effect.asVoid);

const insertCorps = (
  sql: SqlClient.SqlClient,
  corpsKey: string,
  score: Domain.CorpsScore,
) =>
  sql`
    INSERT INTO corps (
      corps_key,
      org_group_identifier,
      name,
      division_name,
      active,
      is_other_type
    )
    VALUES (
      ${corpsKey},
      ${score.orgGroupIdentifier ?? null},
      ${score.groupName},
      ${score.divisionName},
      ${boolToInt(score.active)},
      ${boolToInt(score.isOtherType)}
    )
    ON CONFLICT(corps_key) DO UPDATE SET
      org_group_identifier=COALESCE(excluded.org_group_identifier, corps.org_group_identifier),
      name=excluded.name,
      division_name=excluded.division_name,
      active=excluded.active,
      is_other_type=excluded.is_other_type
  `.pipe(Effect.asVoid);

const upsertCorpsProfile = (sql: SqlClient.SqlClient, corps: Domain.Corps) => {
  const contactFields = normalizeCorpsContactFields(corps);
  return Effect.gen(function* () {
    const corpsKey =
      (yield* resolveCorpsKey(sql, corps.name, corps.slug)) ??
      normalizeCorpsNameKey(corps.name) ??
      corps.slug;
    if (!corpsKey) {
      return;
    }
    yield* sql`
        INSERT INTO corps (
          corps_key, corps_id, name, slug, about, description, type, status, entity_type,
          website, corps_logo, corps_photo, corps_mmdl_link_audio, corps_mmdl_link_video,
          display_city, latitude, longitude, address, city, state, zip, country,
          contact_name, contact_title, contact_email, contact_phone, main_phone, main_email,
          primary_email, primary_contact_title, phone, shipping_city, shipping_state,
          company_country, facebook, twitter, instagram, youtube, linked_in,
          meta_description, meta_title, group_tickets_status, auditions_json
        ) VALUES (
          ${corpsKey}, ${String(corps.id)}, ${corps.name}, ${corps.slug},
          ${corps.about ?? null}, ${corps.description ?? null}, ${corps.type ?? null},
          ${corps.status ?? null}, ${contactFields.entityType ?? null},
          ${corps.website ?? null}, ${corps.corpsLogo ?? null}, ${corps.corpsPhoto ?? null},
          ${contactFields.corpsMMDLLinkAudio ?? null}, ${contactFields.corpsMMDLLinkVideo ?? null},
          ${corps.displayCity ?? null}, ${contactFields.latitude ?? null},
          ${contactFields.longitude ?? null}, ${contactFields.address ?? null},
          ${contactFields.city ?? null}, ${contactFields.state ?? null},
          ${contactFields.zip ?? null}, ${contactFields.country ?? null},
          ${contactFields.contactName ?? null}, ${contactFields.contactTitle ?? null},
          ${contactFields.contactEmail ?? null}, ${contactFields.contactPhone ?? null},
          ${contactFields.mainPhone ?? null}, ${contactFields.mainEmail ?? null},
          ${contactFields.primaryEmail ?? null}, ${contactFields.primaryContactTitle ?? null},
          ${contactFields.phone ?? null}, ${contactFields.shippingCity ?? null},
          ${contactFields.shippingState ?? null}, ${contactFields.companyCountry ?? null},
          ${corps.facebook ?? null}, ${corps.twitter ?? null}, ${corps.instagram ?? null},
          ${corps.youtube ?? null}, ${contactFields.linkedIn ?? null},
          ${contactFields.metaDescription ?? null}, ${contactFields.metaTitle ?? null},
          ${contactFields.groupTicketsStatus ?? null}, ${toJsonText(corps.auditions)}
        )
        ON CONFLICT(corps_key) DO UPDATE SET
          corps_id=COALESCE(excluded.corps_id, corps.corps_id),
          name=excluded.name,
          slug=excluded.slug,
          -- Curated (hand-set) fields are never overwritten by ingest; see
          -- corpsCuration.ts. corps_logo additionally rejects the DCI generic
          -- "dci-splash" placeholder so a real logo is never lost to it.
          about=CASE
            WHEN EXISTS (SELECT 1 FROM corps_curated_fields cf WHERE cf.corps_key = corps.corps_key AND cf.field = 'about')
              THEN corps.about
            ELSE COALESCE(excluded.about, corps.about)
          END,
          description=COALESCE(excluded.description, corps.description),
          type=COALESCE(excluded.type, corps.type),
          status=COALESCE(excluded.status, corps.status),
          entity_type=COALESCE(excluded.entity_type, corps.entity_type),
          website=COALESCE(excluded.website, corps.website),
          corps_logo=CASE
            WHEN EXISTS (SELECT 1 FROM corps_curated_fields cf WHERE cf.corps_key = corps.corps_key AND cf.field = 'corps_logo')
              THEN corps.corps_logo
            WHEN excluded.corps_logo LIKE '%dci-splash%'
              THEN corps.corps_logo
            ELSE COALESCE(excluded.corps_logo, corps.corps_logo)
          END,
          corps_photo=COALESCE(excluded.corps_photo, corps.corps_photo),
          corps_mmdl_link_audio=COALESCE(excluded.corps_mmdl_link_audio, corps.corps_mmdl_link_audio),
          corps_mmdl_link_video=COALESCE(excluded.corps_mmdl_link_video, corps.corps_mmdl_link_video),
          display_city=CASE
            WHEN EXISTS (SELECT 1 FROM corps_curated_fields cf WHERE cf.corps_key = corps.corps_key AND cf.field = 'display_city')
              THEN corps.display_city
            ELSE COALESCE(excluded.display_city, corps.display_city)
          END,
          latitude=COALESCE(excluded.latitude, corps.latitude),
          longitude=COALESCE(excluded.longitude, corps.longitude),
          address=COALESCE(excluded.address, corps.address),
          city=COALESCE(excluded.city, corps.city),
          state=COALESCE(excluded.state, corps.state),
          zip=COALESCE(excluded.zip, corps.zip),
          country=COALESCE(excluded.country, corps.country),
          contact_name=COALESCE(excluded.contact_name, corps.contact_name),
          contact_title=COALESCE(excluded.contact_title, corps.contact_title),
          contact_email=COALESCE(excluded.contact_email, corps.contact_email),
          contact_phone=COALESCE(excluded.contact_phone, corps.contact_phone),
          main_phone=COALESCE(excluded.main_phone, corps.main_phone),
          main_email=COALESCE(excluded.main_email, corps.main_email),
          primary_email=COALESCE(excluded.primary_email, corps.primary_email),
          primary_contact_title=COALESCE(excluded.primary_contact_title, corps.primary_contact_title),
          phone=COALESCE(excluded.phone, corps.phone),
          shipping_city=COALESCE(excluded.shipping_city, corps.shipping_city),
          shipping_state=COALESCE(excluded.shipping_state, corps.shipping_state),
          company_country=COALESCE(excluded.company_country, corps.company_country),
          facebook=COALESCE(excluded.facebook, corps.facebook),
          twitter=COALESCE(excluded.twitter, corps.twitter),
          instagram=COALESCE(excluded.instagram, corps.instagram),
          youtube=COALESCE(excluded.youtube, corps.youtube),
          linked_in=COALESCE(excluded.linked_in, corps.linked_in),
          meta_description=COALESCE(excluded.meta_description, corps.meta_description),
          meta_title=COALESCE(excluded.meta_title, corps.meta_title),
          group_tickets_status=COALESCE(excluded.group_tickets_status, corps.group_tickets_status),
          auditions_json=COALESCE(excluded.auditions_json, corps.auditions_json)
      `.pipe(Effect.asVoid);
  });
};

const insertCorpsScore = (
  sql: SqlClient.SqlClient,
  competition: Domain.Competition,
  corpsKey: string,
  score: Domain.CorpsScore,
) => {
  const groupType = competition.groupTypes?.[0];
  return sql`
    INSERT INTO corps_scores (
      competition_slug,
      corps_key,
      corps_name,
      division_name,
      round,
      rank,
      total_score,
      subtotal_score,
      subtotal_rank,
      group_type_id,
      competition_type_id
    ) VALUES (
      ${competition.slug},
      ${corpsKey},
      ${score.groupName},
      ${score.divisionName},
      ${score.round ?? null},
      ${score.rank},
      ${score.totalScore},
      ${score.subtotalScore ?? null},
      ${score.subtotalRank ?? null},
      ${groupType?.id ?? null},
      ${groupType?.competitionType.id ?? null}
    )
    ON CONFLICT(competition_slug, corps_key) DO UPDATE SET
      corps_name=excluded.corps_name,
      division_name=excluded.division_name,
      round=excluded.round,
      rank=excluded.rank,
      total_score=excluded.total_score,
      subtotal_score=excluded.subtotal_score,
      subtotal_rank=excluded.subtotal_rank,
      group_type_id=excluded.group_type_id,
      competition_type_id=excluded.competition_type_id
  `.pipe(Effect.asVoid);
};

const insertCategoryScore = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  corpsKey: string,
  category: Domain.CategoryScore,
) =>
  sql`
    INSERT INTO category_scores (
      competition_slug,
      corps_key,
      category_name,
      category_initials,
      score,
      rank
    ) VALUES (
      ${competitionSlug},
      ${corpsKey},
      ${category.Name},
      ${category.Initials ?? null},
      ${category.Score},
      ${category.Rank}
    )
    ON CONFLICT(competition_slug, corps_key, category_name) DO UPDATE SET
      category_initials=excluded.category_initials,
      score=excluded.score,
      rank=excluded.rank
  `.pipe(Effect.asVoid);

const insertCaptionScore = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  corpsKey: string,
  categoryName: string,
  captionName: string,
  initials: string | null,
  score: number,
  rank: number,
) =>
  sql`
    INSERT INTO caption_scores (
      competition_slug,
      corps_key,
      category_name,
      caption_name,
      caption_initials,
      score,
      rank
    ) VALUES (
      ${competitionSlug},
      ${corpsKey},
      ${categoryName},
      ${captionName},
      ${initials},
      ${score},
      ${rank}
    )
    ON CONFLICT(competition_slug, corps_key, caption_name) DO UPDATE SET
      category_name=excluded.category_name,
      caption_initials=excluded.caption_initials,
      score=excluded.score,
      rank=excluded.rank
  `.pipe(Effect.asVoid);

const insertJudge = (
  sql: SqlClient.SqlClient,
  judgeId: string,
  judge: Domain.JudgeCaption,
) =>
  Effect.gen(function* () {
    // Extract current judge_number from API
    const currentJudgeNumber = judge.Judge ?? null;

    // Get existing metadata
    const existing = yield* sql<{ metadata_json: string | null }>`
        SELECT metadata_json FROM judges WHERE judge_id = ${judgeId}
      `.pipe(
      Effect.map((rows) => rows[0]?.metadata_json),
      Effect.catch(() => Effect.succeed(null)),
    );

    // Parse existing metadata
    const existingMetadata = existing ? JSON.parse(existing) : {};
    const seenNumbers = new Set(existingMetadata.seenJudgeNumbers ?? []);

    // Add current judge number if not null
    if (currentJudgeNumber !== null) {
      seenNumbers.add(currentJudgeNumber);
    }

    // Build updated metadata
    const updatedMetadata = {
      ...existingMetadata,
      seenJudgeNumbers: Array.from(seenNumbers).sort(
        (a, b) => (a as number) - (b as number),
      ),
    };

    // Upsert judge with updated metadata
    yield* sql`
      INSERT INTO judges (judge_id, first_name, last_name, display_name, metadata_json)
      VALUES (
        ${judgeId},
        ${judge.JudgeFirstName ?? null},
        ${judge.JudgeLastName ?? null},
        ${judgeDisplayName(judge)},
        ${JSON.stringify(updatedMetadata)}
      )
      ON CONFLICT(judge_id) DO UPDATE SET
        first_name=COALESCE(excluded.first_name, judges.first_name),
        last_name=COALESCE(excluded.last_name, judges.last_name),
        display_name=excluded.display_name,
        metadata_json=excluded.metadata_json
    `.pipe(Effect.asVoid);
  });

const insertJudgeAssignment = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  captionName: string,
  judgeId: string,
  judge: Domain.JudgeCaption,
) =>
  sql`
    INSERT INTO judge_assignments (
      competition_slug,
      caption_name,
      judge_id,
      judge_number,
      judge_initials
    ) VALUES (
      ${competitionSlug},
      ${captionName},
      ${judgeId},
      ${judge.Judge ?? null},
      ${judge.Initials ?? null}
    )
    ON CONFLICT(competition_slug, caption_name, judge_id) DO UPDATE SET
      judge_number=excluded.judge_number,
      judge_initials=excluded.judge_initials
  `.pipe(Effect.asVoid);

const insertJudgeScore = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  corpsKey: string,
  captionName: string,
  judgeId: string,
  judge: Domain.JudgeCaption,
) =>
  sql`
    INSERT INTO judge_scores (
      competition_slug,
      corps_key,
      caption_name,
      judge_id,
      score,
      rank
    ) VALUES (
      ${competitionSlug},
      ${corpsKey},
      ${captionName},
      ${judgeId},
      ${judge.Score},
      ${judge.Rank}
    )
    ON CONFLICT(competition_slug, corps_key, caption_name, judge_id) DO UPDATE SET
      score=excluded.score,
      rank=excluded.rank
  `.pipe(Effect.asVoid);

const insertSubcaptionScore = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  corpsKey: string,
  captionName: string,
  judgeId: string,
  breakdown: Domain.SubCaptionBreakdown,
) =>
  sql`
    INSERT INTO subcaption_scores (
      competition_slug,
      corps_key,
      caption_name,
      judge_id,
      subcaption_name,
      subcaption_initials,
      score,
      rank
    ) VALUES (
      ${competitionSlug},
      ${corpsKey},
      ${captionName},
      ${judgeId},
      ${breakdown.Name},
      ${breakdown.Initials ?? null},
      ${breakdown.Score},
      ${breakdown.Rank}
    )
    ON CONFLICT(competition_slug, corps_key, caption_name, judge_id, subcaption_name) DO UPDATE SET
      subcaption_initials=excluded.subcaption_initials,
      score=excluded.score,
      rank=excluded.rank
  `.pipe(Effect.asVoid);

// ============= NEW TABLES INSERT FUNCTIONS =============

const insertApiResponse = (
  sql: SqlClient.SqlClient,
  endpointUrl: string,
  endpointType: string,
  responseJson: string,
  options?: { season?: string; recordCount?: number },
) =>
  sql`
    INSERT INTO api_responses (
      endpoint_url,
      endpoint_type,
      season,
      fetched_at,
      response_json,
      record_count
    ) VALUES (
      ${endpointUrl},
      ${endpointType},
      ${options?.season ?? null},
      ${new Date().toISOString()},
      ${responseJson},
      ${options?.recordCount ?? null}
    )
    ON CONFLICT(endpoint_url) DO UPDATE SET
      endpoint_type=excluded.endpoint_type,
      season=excluded.season,
      fetched_at=excluded.fetched_at,
      response_json=excluded.response_json,
      record_count=excluded.record_count
  `.pipe(Effect.asVoid);

const insertCompetitionType = (
  sql: SqlClient.SqlClient,
  competitionType: Domain.CompetitionType,
) =>
  sql`
    INSERT INTO competition_types (type_id, name)
    VALUES (${String(competitionType.id)}, ${competitionType.name})
    ON CONFLICT(type_id) DO UPDATE SET name=excluded.name
  `.pipe(Effect.asVoid);

const insertGroupType = (
  sql: SqlClient.SqlClient,
  groupType: Domain.GroupType,
) =>
  sql`
    INSERT INTO group_types (group_type_id, name, competition_type_id)
    VALUES (${String(groupType.id)}, ${groupType.name}, ${String(groupType.competitionType.id)})
    ON CONFLICT(group_type_id) DO UPDATE SET
      name=excluded.name,
      competition_type_id=excluded.competition_type_id
  `.pipe(Effect.asVoid);

const insertCompetitionGroupType = (
  sql: SqlClient.SqlClient,
  competitionSlug: string,
  groupTypeId: string,
) =>
  sql`
    INSERT INTO competition_group_types (competition_slug, group_type_id)
    VALUES (${competitionSlug}, ${groupTypeId})
    ON CONFLICT(competition_slug, group_type_id) DO NOTHING
  `.pipe(Effect.asVoid);

const insertEventGroupType = (
  sql: SqlClient.SqlClient,
  eventSlug: string,
  groupTypeId: string,
) =>
  sql`
    INSERT INTO event_group_types (event_slug, group_type_id)
    VALUES (${eventSlug}, ${groupTypeId})
    ON CONFLICT(event_slug, group_type_id) DO NOTHING
  `.pipe(Effect.asVoid);

const lookupEventSlugForCompetition = (
  sql: SqlClient.SqlClient,
  competition: Domain.Competition,
) => {
  const eventName = competition.eventName.toLowerCase();
  const dateIso = competition.date.toISOString();
  return sql<{ slug: string }>`
    SELECT slug
    FROM events
    WHERE date(start_date) = date(${dateIso})
      AND (lower(name) = ${eventName} OR lower(event_name) = ${eventName})
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.slug),
    Effect.flatMap((slug) => {
      if (slug) {
        return Effect.succeed<string | undefined>(slug);
      }
      return sql<{ slug: string }>`
        SELECT slug
        FROM events
        WHERE lower(name) = ${eventName} OR lower(event_name) = ${eventName}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.slug));
    }),
    Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
  );
};

const normalizeWaybackCorpsRecord = (raw: unknown) => {
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const slug =
    (typeof record.slug === "string" && record.slug.trim()) ||
    normalizeKey(name) ||
    name.toLowerCase();
  return {
    corpsKey: normalizeCorpsNameKey(name) ?? slug,
    corpsId: record.id ? String(record.id) : null,
    name,
    type: typeof record.type === "string" ? record.type : null,
    about: typeof record.about === "string" ? record.about : null,
    description:
      typeof record.description === "string" ? record.description : null,
    website: typeof record.website === "string" ? record.website : null,
    facebook: typeof record.facebook === "string" ? record.facebook : null,
    twitter: typeof record.twitter === "string" ? record.twitter : null,
    instagram: typeof record.instagram === "string" ? record.instagram : null,
    youtube: typeof record.youtube === "string" ? record.youtube : null,
    address: typeof record.address === "string" ? record.address : null,
    city: typeof record.city === "string" ? record.city : null,
    state: typeof record.state === "string" ? record.state : null,
    zip: typeof record.zip === "string" ? record.zip : null,
    country: typeof record.country === "string" ? record.country : null,
    latitude: typeof record.latitude === "number" ? record.latitude : null,
    longitude: typeof record.longitude === "number" ? record.longitude : null,
    contactName:
      typeof record.contactName === "string" ? record.contactName : null,
    contactTitle:
      typeof record.contactTitle === "string" ? record.contactTitle : null,
    contactEmail:
      typeof record.contactEmail === "string" ? record.contactEmail : null,
    contactPhone:
      typeof record.contactPhone === "string" ? record.contactPhone : null,
    mainPhone: typeof record.mainPhone === "string" ? record.mainPhone : null,
    mainEmail: typeof record.mainEmail === "string" ? record.mainEmail : null,
  };
};

const upsertWaybackCorpsRecord = (
  sql: SqlClient.SqlClient,
  record: ReturnType<typeof normalizeWaybackCorpsRecord>,
) => {
  if (!record) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const corpsKey = yield* resolveCorpsKey(sql, record.name, record.corpsKey);
    if (!corpsKey) {
      return;
    }
    yield* sql`
        INSERT INTO corps (
          corps_key, corps_id, name, slug, type, about, description, website,
          facebook, twitter, instagram, youtube, display_city, latitude, longitude,
          address, city, state, zip, country, contact_name, contact_title,
          contact_email, contact_phone, main_phone, main_email
        ) VALUES (
          ${corpsKey}, ${record.corpsId}, ${record.name}, ${record.corpsKey},
          ${record.type}, ${record.about}, ${record.description}, ${record.website},
          ${record.facebook}, ${record.twitter}, ${record.instagram}, ${record.youtube},
          ${record.city && record.state ? `${record.city}, ${record.state}` : null},
          ${record.latitude}, ${record.longitude}, ${record.address}, ${record.city},
          ${record.state}, ${record.zip}, ${record.country}, ${record.contactName},
          ${record.contactTitle}, ${record.contactEmail}, ${record.contactPhone},
          ${record.mainPhone}, ${record.mainEmail}
        )
        ON CONFLICT(corps_key) DO UPDATE SET
          corps_id=COALESCE(excluded.corps_id, corps.corps_id),
          name=COALESCE(excluded.name, corps.name),
          slug=COALESCE(excluded.slug, corps.slug),
          type=COALESCE(excluded.type, corps.type),
          about=CASE
            WHEN EXISTS (SELECT 1 FROM corps_curated_fields cf WHERE cf.corps_key = corps.corps_key AND cf.field = 'about')
              THEN corps.about
            ELSE COALESCE(excluded.about, corps.about)
          END,
          description=COALESCE(excluded.description, corps.description),
          website=COALESCE(excluded.website, corps.website),
          facebook=COALESCE(excluded.facebook, corps.facebook),
          twitter=COALESCE(excluded.twitter, corps.twitter),
          instagram=COALESCE(excluded.instagram, corps.instagram),
          youtube=COALESCE(excluded.youtube, corps.youtube),
          display_city=CASE
            WHEN EXISTS (SELECT 1 FROM corps_curated_fields cf WHERE cf.corps_key = corps.corps_key AND cf.field = 'display_city')
              THEN corps.display_city
            ELSE COALESCE(excluded.display_city, corps.display_city)
          END,
          latitude=COALESCE(excluded.latitude, corps.latitude),
          longitude=COALESCE(excluded.longitude, corps.longitude),
          address=COALESCE(excluded.address, corps.address),
          city=COALESCE(excluded.city, corps.city),
          state=COALESCE(excluded.state, corps.state),
          zip=COALESCE(excluded.zip, corps.zip),
          country=COALESCE(excluded.country, corps.country),
          contact_name=COALESCE(excluded.contact_name, corps.contact_name),
          contact_title=COALESCE(excluded.contact_title, corps.contact_title),
          contact_email=COALESCE(excluded.contact_email, corps.contact_email),
          contact_phone=COALESCE(excluded.contact_phone, corps.contact_phone),
          main_phone=COALESCE(excluded.main_phone, corps.main_phone),
          main_email=COALESCE(excluded.main_email, corps.main_email)
      `.pipe(Effect.asVoid);
  });
};

export const ingestWaybackCorpsContacts = (
  sql: SqlClient.SqlClient,
  records: ReadonlyArray<unknown>,
) =>
  Effect.forEach(
    records,
    (record) =>
      upsertWaybackCorpsRecord(sql, normalizeWaybackCorpsRecord(record)),
    { concurrency: 5, discard: true },
  );

const insertEvent = (sql: SqlClient.SqlClient, event: Domain.Event) =>
  sql`
    INSERT INTO events (
      event_id, name, event_name, slug, description, season, year, start_time,
      edt_start_time, fed, location_city, location_state, venue_city, venue_state,
      timezone, region_for_web, buy_tickets, buy_tickets_text, presenting_sponsor,
      small_logo, live_stream_link, tickets_on_sale, event_image_thumb, ticket_watermark,
      start_date, end_date, web_start_time, notes_general, notes_lineup_times,
      notes_individual_tickets, notes_group_tickets, min_ticket_price, max_ticket_price,
      individual_tickets_disclaimer, group_tickets_disclaimer, group_ticket_threshold,
      group_price_1, group_price_4, group_price_5, group_price_6, min_group_ticket_price,
      max_group_ticket, buy_group_tickets, event_image, ticketing_map_image, street_map_image,
      meta_description, meta_title, category_for_web_calendar, toc_event, entity_type,
      contract_date, tep_contract_date, contract_price_text, x1st_pay_text, x2nd_pt_text,
      balance_due_text, sound_check_time, staff_office, meal_room, judges_location, suites_in_use,
      press_box, marketing_location, flo_marching_location, tabulation_location, event_comp_type_pl,
      event_special, sponsor_load_time, meal_information, water_station_location, sponsor_reception,
      evacuation_location, corps_parking, standstill_cancellation, corps_field_entry,
      front_ensemble_field_entry, corps_field_exit, front_ensemble_field_exit,
      corps_warm_up_location, announcer_location, prop_field_entry, prop_field_exit,
      prop_staging_area, tour_event_partner_contract_status, ticket_service_agreement_status,
      staff_parking, deposit_text, group_bus_parking, yearbook_sales, main_gate_souvenir_sales,
      contest_coordinator_cell, tep_primary_contact_email, travel_contact_email,
      marketplace_location, marketplace_electricity, spectator_entrance, spectator_re_entry,
      box_office_will_call_location, concessions, emt_ambulance_location, table_chairs_on_field,
      mics_on_field, security, box_office_volunteers, ticket_takers, ushers,
      key_locations_verification, corps_info_verification, parking_verification,
      key_times_verification, event_safety_information, season_values, bsa, bca, bsta, bpa,
      tep_name, print_marketplace_footprint_community, print_parking_lot_footprint_community,
      print_props_and_electrical_footprint_com, print_show_sheet_community
    ) VALUES (
      ${event.id}, ${event.name}, ${event.eventName ?? event.name}, ${event.slug},
      ${event.description ?? null}, ${event.season ?? null}, ${event.year ?? null},
      ${event.startTime ?? null}, ${event.eDTStartTimeForAPI}, ${event.fED ?? null},
      ${event.locationCity ?? null}, ${event.locationState ?? null},
      ${event.venueCity ?? null}, ${event.venueState ?? null},
      ${event.timeZone ?? null}, ${event.regionForWeb ?? null},
      ${event.buyTickets ?? null}, ${event.buyTicketsText ?? null},
      ${event.presentingSponsor ?? null}, ${event.smallLogo ?? null},
      ${event.liveStreamLink ?? null}, ${event.ticketsOnSale ?? null},
      ${event.eventImageThumb ?? null}, ${event.ticketWatermark ?? null},
      ${event.startDate.toISOString()}, ${event.endDate?.toISOString() ?? null},
      ${event.webStartTime ?? null}, ${event.notesGeneral ?? null},
      ${event.notesLineupTimes ?? null}, ${event.notesIndividualTickets ?? null},
      ${event.notesGroupTickets ?? null}, ${event.minTicketPrice ?? null},
      ${event.maxTicketPrice ?? null}, ${event.individualTicketsDisclaimer ?? null},
      ${event.groupTicketsDisclaimer ?? null}, ${event.groupTicketThreshold ?? null},
      ${event.groupPrice1 ?? null}, ${event.groupPrice4 ?? null},
      ${event.groupPrice5 ?? null}, ${event.groupPrice6 ?? null},
      ${event.minGroupTicketPrice ?? null}, ${event.maxGroupTicket ?? null},
      ${event.buyGroupTickets ?? null}, ${event.eventImage ?? null},
      ${event.ticketingMapImage ?? null}, ${event.streetMapImage ?? null},
      ${event.metaDescription ?? null}, ${event.metaTitle ?? null},
      ${event.categoryForWebCalendar ?? null}, ${boolToInt(event.tOCEvent)},
      ${event.entityType ?? null}, ${event.contractDae ?? null},
      ${event.tEPContractDate ?? null}, ${event.contractPriceText ?? null},
      ${event.x1stPayText ?? null}, ${event.x2ndPtText ?? null},
      ${event.balanceDueText ?? null}, ${event.soundCheckTime ?? null},
      ${event.staffOffice ?? null}, ${event.mealRoom ?? null},
      ${event.judgesLocation ?? null}, ${event.suitesInUse ?? null},
      ${event.pressBox ?? null}, ${event.marketingLocation ?? null},
      ${event.floMarchingLocation ?? null}, ${event.tabulationLocation ?? null},
      ${event.eventCompTypePL ?? null}, ${boolToInt(event.eventSpecial)},
      ${event.sponsorLoadTime ?? null}, ${event.mealInformation ?? null},
      ${event.waterStationLocation ?? null}, ${event.sponsorReception ?? null},
      ${event.evacuationLocation ?? null}, ${event.corpsParking ?? null},
      ${event.standstillCancellation ?? null}, ${event.corpsFieldEntry ?? null},
      ${event.frontEnsembleFieldEntry ?? null}, ${event.corpsFieldExit ?? null},
      ${event.frontEnsembleFieldExit ?? null}, ${event.corpsWarmUpLocation ?? null},
      ${event.announcerLocation ?? null}, ${event.propFieldEntry ?? null},
      ${event.propFieldExit ?? null}, ${event.propStagingArea ?? null},
      ${event.tourEventPartnerContractStatus ?? null},
      ${event.ticketServiceAgreementStatus ?? null}, ${event.staffParking ?? null},
      ${event.depositText ?? null}, ${event.groupBusParking ?? null},
      ${boolToInt(event.yearbookSales)}, ${boolToInt(event.mainGateSouvenirSales)},
      ${event.contestCoordinatorCell ?? null}, ${event.tEPPrimaryContactEmail ?? null},
      ${event.travelContactEmail ?? null}, ${event.marketplaceLocation ?? null},
      ${boolToInt(event.marketplaceElectricity)}, ${event.spectatorEntrance ?? null},
      ${event.spectatorReEntry ?? null}, ${event.boxOfficeWillCallLocation ?? null},
      ${event.concessions ?? null}, ${event.eMTAmbulanceLocation ?? null},
      ${boolToInt(event.tableChairsOnField)}, ${boolToInt(event.micsOnField)},
      ${event.security ?? null}, ${boolToInt(event.boxOfficeVolunteers)},
      ${event.ticketTakers ?? null}, ${event.ushers ?? null},
      ${event.keyLocationsVerification ?? null}, ${event.corpsInfoVerification ?? null},
      ${event.parkingVerification ?? null}, ${event.keyTimesVerification ?? null},
      ${event.eventSafetyInformation ?? null}, ${event.seasonValues ?? null},
      ${event.bSA ?? null}, ${event.bCA ?? null}, ${event.bSTA ?? null},
      ${event.bPA ?? null}, ${event.tEPName ?? null},
      ${event.printMarketplaceFootprintCommunity ?? null},
      ${event.printParkingLotFootprintCommunity ?? null},
      ${event.printPropsAndElectricalFootprintCom ?? null},
      ${event.printShowSheetCommunity ?? null}
    )
    ON CONFLICT(event_id) DO UPDATE SET
      name=excluded.name,
      event_name=excluded.event_name,
      slug=excluded.slug,
      description=excluded.description,
      season=excluded.season,
      year=excluded.year,
      start_time=excluded.start_time,
      edt_start_time=excluded.edt_start_time,
      fed=excluded.fed,
      location_city=excluded.location_city,
      location_state=excluded.location_state,
      venue_city=excluded.venue_city,
      venue_state=excluded.venue_state,
      timezone=excluded.timezone,
      region_for_web=excluded.region_for_web,
      buy_tickets=excluded.buy_tickets,
      buy_tickets_text=excluded.buy_tickets_text,
      presenting_sponsor=excluded.presenting_sponsor,
      small_logo=excluded.small_logo,
      live_stream_link=excluded.live_stream_link,
      tickets_on_sale=excluded.tickets_on_sale,
      event_image_thumb=excluded.event_image_thumb,
      ticket_watermark=excluded.ticket_watermark,
      start_date=excluded.start_date,
      end_date=excluded.end_date,
      web_start_time=excluded.web_start_time,
      notes_general=excluded.notes_general,
      notes_lineup_times=excluded.notes_lineup_times,
      notes_individual_tickets=excluded.notes_individual_tickets,
      notes_group_tickets=excluded.notes_group_tickets,
      min_ticket_price=excluded.min_ticket_price,
      max_ticket_price=excluded.max_ticket_price,
      individual_tickets_disclaimer=excluded.individual_tickets_disclaimer,
      group_tickets_disclaimer=excluded.group_tickets_disclaimer,
      group_ticket_threshold=excluded.group_ticket_threshold,
      group_price_1=excluded.group_price_1,
      group_price_4=excluded.group_price_4,
      group_price_5=excluded.group_price_5,
      group_price_6=excluded.group_price_6,
      min_group_ticket_price=excluded.min_group_ticket_price,
      max_group_ticket=excluded.max_group_ticket,
      buy_group_tickets=excluded.buy_group_tickets,
      event_image=excluded.event_image,
      ticketing_map_image=excluded.ticketing_map_image,
      street_map_image=excluded.street_map_image,
      meta_description=excluded.meta_description,
      meta_title=excluded.meta_title,
      category_for_web_calendar=excluded.category_for_web_calendar,
      toc_event=excluded.toc_event,
      entity_type=excluded.entity_type,
      contract_date=excluded.contract_date,
      tep_contract_date=excluded.tep_contract_date,
      contract_price_text=excluded.contract_price_text,
      x1st_pay_text=excluded.x1st_pay_text,
      x2nd_pt_text=excluded.x2nd_pt_text,
      balance_due_text=excluded.balance_due_text,
      sound_check_time=excluded.sound_check_time,
      staff_office=excluded.staff_office,
      meal_room=excluded.meal_room,
      judges_location=excluded.judges_location,
      suites_in_use=excluded.suites_in_use,
      press_box=excluded.press_box,
      marketing_location=excluded.marketing_location,
      flo_marching_location=excluded.flo_marching_location,
      tabulation_location=excluded.tabulation_location,
      event_comp_type_pl=excluded.event_comp_type_pl,
      event_special=excluded.event_special,
      sponsor_load_time=excluded.sponsor_load_time,
      meal_information=excluded.meal_information,
      water_station_location=excluded.water_station_location,
      sponsor_reception=excluded.sponsor_reception,
      evacuation_location=excluded.evacuation_location,
      corps_parking=excluded.corps_parking,
      standstill_cancellation=excluded.standstill_cancellation,
      corps_field_entry=excluded.corps_field_entry,
      front_ensemble_field_entry=excluded.front_ensemble_field_entry,
      corps_field_exit=excluded.corps_field_exit,
      front_ensemble_field_exit=excluded.front_ensemble_field_exit,
      corps_warm_up_location=excluded.corps_warm_up_location,
      announcer_location=excluded.announcer_location,
      prop_field_entry=excluded.prop_field_entry,
      prop_field_exit=excluded.prop_field_exit,
      prop_staging_area=excluded.prop_staging_area,
      tour_event_partner_contract_status=excluded.tour_event_partner_contract_status,
      ticket_service_agreement_status=excluded.ticket_service_agreement_status,
      staff_parking=excluded.staff_parking,
      deposit_text=excluded.deposit_text,
      group_bus_parking=excluded.group_bus_parking,
      yearbook_sales=excluded.yearbook_sales,
      main_gate_souvenir_sales=excluded.main_gate_souvenir_sales,
      contest_coordinator_cell=excluded.contest_coordinator_cell,
      tep_primary_contact_email=excluded.tep_primary_contact_email,
      travel_contact_email=excluded.travel_contact_email,
      marketplace_location=excluded.marketplace_location,
      marketplace_electricity=excluded.marketplace_electricity,
      spectator_entrance=excluded.spectator_entrance,
      spectator_re_entry=excluded.spectator_re_entry,
      box_office_will_call_location=excluded.box_office_will_call_location,
      concessions=excluded.concessions,
      emt_ambulance_location=excluded.emt_ambulance_location,
      table_chairs_on_field=excluded.table_chairs_on_field,
      mics_on_field=excluded.mics_on_field,
      security=excluded.security,
      box_office_volunteers=excluded.box_office_volunteers,
      ticket_takers=excluded.ticket_takers,
      ushers=excluded.ushers,
      key_locations_verification=excluded.key_locations_verification,
      corps_info_verification=excluded.corps_info_verification,
      parking_verification=excluded.parking_verification,
      key_times_verification=excluded.key_times_verification,
      event_safety_information=excluded.event_safety_information,
      season_values=excluded.season_values,
      bsa=excluded.bsa,
      bca=excluded.bca,
      bsta=excluded.bsta,
      bpa=excluded.bpa,
      tep_name=excluded.tep_name,
      print_marketplace_footprint_community=excluded.print_marketplace_footprint_community,
      print_parking_lot_footprint_community=excluded.print_parking_lot_footprint_community,
      print_props_and_electrical_footprint_com=excluded.print_props_and_electrical_footprint_com,
      print_show_sheet_community=excluded.print_show_sheet_community
  `.pipe(Effect.asVoid);

const makeEventVenueId = (eventId: string, venueName?: string | null) =>
  `${eventId}:${normalizeKey(venueName ?? "venue") ?? "venue"}`;

const insertEventVenue = (
  sql: SqlClient.SqlClient,
  event: Domain.Event,
  venue: Domain.EventVenue | Domain.EventVenueSummary,
) => {
  const venueCoordinates =
    "venueCoordinates" in venue ? venue.venueCoordinates : undefined;
  const summaryLatitude = "latitude" in venue ? venue.latitude : undefined;
  const summaryLongitude = "longitude" in venue ? venue.longitude : undefined;
  const gPGeolocation =
    "gPGeolocation" in venue ? venue.gPGeolocation : undefined;
  const googleMapsStaticMap =
    "googleMapsStaticMap" in venue ? venue.googleMapsStaticMap : undefined;
  const venueLatitude = venueCoordinates?.latitude ?? summaryLatitude ?? null;
  const venueLongitude =
    venueCoordinates?.longitude ?? summaryLongitude ?? null;

  return sql`
    INSERT INTO event_venues (
      venue_id, event_id, event_slug, name, address, zio_postcode,
      google_maps_static_map, venue_latitude, venue_longitude,
      venue_capacity_alternate, venue_total_capacity, field_hashmarks_type,
      goal_posts, field_electricity, american_flag_location, tunnel_height,
      videoboard, access_to_stadium_box_office, air_conditioning,
      selling_windows_available, furniture_needs, main_box_office_location,
      field_electricity_locations, field_hashmarks, gp_latitude, gp_longitude,
      gp_geocode_quality, gp_geocode_retrieval_time, clear_bag_venue,
      merchandise_buyout_venue, marketplace_location, bag_policy,
      spectator_entrance, spectator_re_entry, box_office_will_call_location,
      concessions, emt_ambulance_location, table_chairs_on_field, mics_on_field,
      sound_ordinance, ticket_takers, box_office_volunteers, ushers, security,
      seat_numbering, seat_size, marketplace_type, marketplace_electricity,
      bag_policy_description, cashless_stadium, re_entry_credential_type,
      stadium_weather_shelter_policy, venue_operated_lightning_detection,
      lightning_detection_system_name_type, programmed_lightning_radius
    ) VALUES (
      ${makeEventVenueId(event.id, venue.name)}, ${event.id}, ${event.slug},
      ${venue.name}, ${venue.address ?? null}, ${venue.zioPostcode ?? null},
      ${googleMapsStaticMap ?? null}, ${venueLatitude}, ${venueLongitude},
      ${"venueCapacityAlternate" in venue ? (venue.venueCapacityAlternate ?? null) : null},
      ${"venueTotalCapacity" in venue ? (venue.venueTotalCapacity ?? null) : null},
      ${"fieldHashmarksType" in venue ? (venue.fieldHashmarksType ?? null) : null},
      ${boolToInt("goalPosts" in venue ? venue.goalPosts : null)},
      ${boolToInt("fieldElectricity" in venue ? venue.fieldElectricity : null)},
      ${"americanFlagLocation" in venue ? (venue.americanFlagLocation ?? null) : null},
      ${"tunnelHeight" in venue ? (venue.tunnelHeight ?? null) : null},
      ${boolToInt("videoboard" in venue ? venue.videoboard : null)},
      ${boolToInt("accessToStadiumBoxOffice" in venue ? venue.accessToStadiumBoxOffice : null)},
      ${boolToInt("airConditioning" in venue ? venue.airConditioning : null)},
      ${"sellingWindowsAvailable" in venue ? (venue.sellingWindowsAvailable ?? null) : null},
      ${"furnitureNeeds" in venue ? (venue.furnitureNeeds ?? null) : null},
      ${"mainBoxOfficeLocation" in venue ? (venue.mainBoxOfficeLocation ?? null) : null},
      ${"fieldElectricityLocations" in venue ? (venue.fieldElectricityLocations ?? null) : null},
      ${boolToInt("fieldHashmarks" in venue ? venue.fieldHashmarks : null)},
      ${gPGeolocation?.latitude ?? null},
      ${gPGeolocation?.longitude ?? null},
      ${"gPGeocodeQuality" in venue ? (venue.gPGeocodeQuality ?? null) : null},
      ${"gPGeocodeRetrievalTime" in venue ? (venue.gPGeocodeRetrievalTime ?? null) : null},
      ${boolToInt("clearBagVenue" in venue ? venue.clearBagVenue : null)},
      ${boolToInt("merchandiseBuyoutVenue" in venue ? venue.merchandiseBuyoutVenue : null)},
      ${"marketplaceLocation" in venue ? (venue.marketplaceLocation ?? null) : null},
      ${"bagPolicy" in venue ? (venue.bagPolicy ?? null) : null},
      ${"spectatorEntrance" in venue ? (venue.spectatorEntrance ?? null) : null},
      ${"spectatorReEntry" in venue ? (venue.spectatorReEntry ?? null) : null},
      ${"boxOfficeWillCallLocation" in venue ? (venue.boxOfficeWillCallLocation ?? null) : null},
      ${"concessions" in venue ? (venue.concessions ?? null) : null},
      ${"eMTAmbulanceLocation" in venue ? (venue.eMTAmbulanceLocation ?? null) : null},
      ${boolToInt("tableChairsOnField" in venue ? venue.tableChairsOnField : null)},
      ${boolToInt("micsOnField" in venue ? venue.micsOnField : null)},
      ${"soundOrdinance" in venue ? (venue.soundOrdinance ?? null) : null},
      ${"ticketTakers" in venue ? (venue.ticketTakers ?? null) : null},
      ${boolToInt("boxOfficeVolunteers" in venue ? venue.boxOfficeVolunteers : null)},
      ${"ushers" in venue ? (venue.ushers ?? null) : null},
      ${"security" in venue ? (venue.security ?? null) : null},
      ${boolToInt("seatNumbering" in venue ? venue.seatNumbering : null)},
      ${"seatSize" in venue ? (venue.seatSize ?? null) : null},
      ${"marketplaceType" in venue ? (venue.marketplaceType ?? null) : null},
      ${"marketplaceElectricity" in venue ? (venue.marketplaceElectricity ?? null) : null},
      ${"bagPolicyDescription" in venue ? (venue.bagPolicyDescription ?? null) : null},
      ${boolToInt("cashlessStadium" in venue ? venue.cashlessStadium : null)},
      ${"reEntryCredentialType" in venue ? (venue.reEntryCredentialType ?? null) : null},
      ${"stadiumWeatherShelterPolicy" in venue ? (venue.stadiumWeatherShelterPolicy ?? null) : null},
      ${boolToInt("venueOperatedLightningDetection" in venue ? venue.venueOperatedLightningDetection : null)},
      ${"lightningDetectionSystemNameType" in venue ? (venue.lightningDetectionSystemNameType ?? null) : null},
      ${"programmedLightningRadius" in venue ? (venue.programmedLightningRadius ?? null) : null}
    )
    ON CONFLICT(venue_id) DO UPDATE SET
      event_id=excluded.event_id,
      event_slug=excluded.event_slug,
      name=excluded.name,
      address=excluded.address,
      zio_postcode=excluded.zio_postcode,
      google_maps_static_map=excluded.google_maps_static_map,
      venue_latitude=excluded.venue_latitude,
      venue_longitude=excluded.venue_longitude,
      venue_capacity_alternate=excluded.venue_capacity_alternate,
      venue_total_capacity=excluded.venue_total_capacity,
      field_hashmarks_type=excluded.field_hashmarks_type,
      goal_posts=excluded.goal_posts,
      field_electricity=excluded.field_electricity,
      american_flag_location=excluded.american_flag_location,
      tunnel_height=excluded.tunnel_height,
      videoboard=excluded.videoboard,
      access_to_stadium_box_office=excluded.access_to_stadium_box_office,
      air_conditioning=excluded.air_conditioning,
      selling_windows_available=excluded.selling_windows_available,
      furniture_needs=excluded.furniture_needs,
      main_box_office_location=excluded.main_box_office_location,
      field_electricity_locations=excluded.field_electricity_locations,
      field_hashmarks=excluded.field_hashmarks,
      gp_latitude=excluded.gp_latitude,
      gp_longitude=excluded.gp_longitude,
      gp_geocode_quality=excluded.gp_geocode_quality,
      gp_geocode_retrieval_time=excluded.gp_geocode_retrieval_time,
      clear_bag_venue=excluded.clear_bag_venue,
      merchandise_buyout_venue=excluded.merchandise_buyout_venue,
      marketplace_location=excluded.marketplace_location,
      bag_policy=excluded.bag_policy,
      spectator_entrance=excluded.spectator_entrance,
      spectator_re_entry=excluded.spectator_re_entry,
      box_office_will_call_location=excluded.box_office_will_call_location,
      concessions=excluded.concessions,
      emt_ambulance_location=excluded.emt_ambulance_location,
      table_chairs_on_field=excluded.table_chairs_on_field,
      mics_on_field=excluded.mics_on_field,
      sound_ordinance=excluded.sound_ordinance,
      ticket_takers=excluded.ticket_takers,
      box_office_volunteers=excluded.box_office_volunteers,
      ushers=excluded.ushers,
      security=excluded.security,
      seat_numbering=excluded.seat_numbering,
      seat_size=excluded.seat_size,
      marketplace_type=excluded.marketplace_type,
      marketplace_electricity=excluded.marketplace_electricity,
      bag_policy_description=excluded.bag_policy_description,
      cashless_stadium=excluded.cashless_stadium,
      re_entry_credential_type=excluded.re_entry_credential_type,
      stadium_weather_shelter_policy=excluded.stadium_weather_shelter_policy,
      venue_operated_lightning_detection=excluded.venue_operated_lightning_detection,
      lightning_detection_system_name_type=excluded.lightning_detection_system_name_type,
      programmed_lightning_radius=excluded.programmed_lightning_radius
  `.pipe(Effect.asVoid);
};

const insertEventSchedule = (
  sql: SqlClient.SqlClient,
  eventId: string,
  schedule: Domain.EventSchedule,
  index: number,
) =>
  sql`
    INSERT INTO event_schedules (schedule_id, event_id, unit_name, display_city, time, performance_order)
    VALUES (
      ${`${eventId}:${index}`}, ${eventId}, ${schedule.unitName},
      ${schedule.displayCity ?? null}, ${schedule.time ?? ""}, ${schedule.performanceOrder ?? null}
    )
    ON CONFLICT(schedule_id) DO UPDATE SET
      unit_name=excluded.unit_name,
      display_city=excluded.display_city,
      time=excluded.time,
      performance_order=excluded.performance_order
  `.pipe(Effect.asVoid);

const lookupCorpsById = (sql: SqlClient.SqlClient, participantId: string) =>
  sql<{ corps_key: string; name: string | null; slug: string | null }>`
    SELECT corps_key, name, slug FROM corps WHERE corps_id = ${participantId} LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catch(() =>
      Effect.succeed<
        | { corps_key: string; name: string | null; slug: string | null }
        | undefined
      >(undefined),
    ),
  );

const lookupCorpsKeyByName = (sql: SqlClient.SqlClient, name: string) =>
  Effect.gen(function* () {
    const direct = yield* sql<{ corps_key: string }>`
        SELECT corps_key FROM corps WHERE lower(name) = ${name.toLowerCase()}
        ORDER BY (slug IS NULL), (corps_logo IS NULL), corps_key
        LIMIT 1
      `.pipe(
      Effect.map((rows) => rows[0]?.corps_key),
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    );
    if (direct) {
      return direct;
    }
    const normalized = normalizeCorpsNameForMatch(name);
    const byName = yield* sql<{ corps_key: string }>`
        SELECT corps_key
        FROM corps
        WHERE replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(lower(name), 'the', ''),
                      'corps', ''
                    ),
                    'drum', ''
                  ),
                  'bugle', ''
                ),
                ' ', ''
              ),
              '-', ''
            ),
            '&', ''
          ),
          '.', ''
        ) = ${normalized}
        ORDER BY (slug IS NULL), (corps_logo IS NULL), corps_key
        LIMIT 1
      `.pipe(
      Effect.map((rows) => rows[0]?.corps_key),
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    );
    if (byName) {
      return byName;
    }
    return yield* lookupCorpsKeyByAlias(sql, name);
  });

const lookupCorpsKeyByAlias = (
  sql: SqlClient.SqlClient,
  name: string,
  location?: string | null,
) =>
  Effect.gen(function* () {
    const direct = name.trim().toLowerCase();
    const normalized = normalizeCorpsNameForMatch(name);
    const normalizedLocation = location
      ? normalizeLocationForLookup(location)
      : undefined;
    const query = normalizedLocation
      ? sql<{ corps_key: string }>`
          SELECT c.corps_key
          FROM corps_aliases a
          JOIN corps c ON lower(c.name) = lower(a.canonical_name)
          WHERE (
            lower(a.alias_key) = ${normalized}
            OR lower(a.alias_name) = ${direct}
            OR lower(a.canonical_name) = ${direct}
            OR replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(lower(a.alias_name), 'the', ''),
                          'corps', ''
                        ),
                        'drum', ''
                      ),
                      'bugle', ''
                    ),
                    ' ', ''
                  ),
                  '-', ''
                ),
                '&', ''
              ),
              '.', ''
            ) = ${normalized}
            OR replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(lower(a.canonical_name), 'the', ''),
                          'corps', ''
                        ),
                        'drum', ''
                      ),
                      'bugle', ''
                    ),
                    ' ', ''
                  ),
                  '-', ''
                ),
                '&', ''
              ),
              '.', ''
            ) = ${normalized}
          )
            AND replace(
              replace(
                replace(
                  replace(
                    replace(lower(coalesce(c.display_city, c.city, '')), ' ', ''),
                    ',',
                    ''
                  ),
                  '.',
                  ''
                ),
                '-',
                ''
              ),
              '&',
              ''
            ) = ${normalizedLocation}
          LIMIT 1
        `
      : sql<{ corps_key: string }>`
          SELECT c.corps_key
          FROM corps_aliases a
          JOIN corps c ON lower(c.name) = lower(a.canonical_name)
          WHERE (
            lower(a.alias_key) = ${normalized}
            OR lower(a.alias_name) = ${direct}
            OR lower(a.canonical_name) = ${direct}
            OR replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(lower(a.alias_name), 'the', ''),
                          'corps', ''
                        ),
                        'drum', ''
                      ),
                      'bugle', ''
                    ),
                    ' ', ''
                  ),
                  '-', ''
                ),
                '&', ''
              ),
              '.', ''
            ) = ${normalized}
            OR replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(lower(a.canonical_name), 'the', ''),
                          'corps', ''
                        ),
                        'drum', ''
                      ),
                      'bugle', ''
                    ),
                    ' ', ''
                  ),
                  '-', ''
                ),
                '&', ''
              ),
              '.', ''
            ) = ${normalized}
          )
          LIMIT 1
        `;
    return yield* query.pipe(
      Effect.map((rows) => rows[0]?.corps_key),
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    );
  });

const lookupCorpsKeyByNormalizedName = (
  sql: SqlClient.SqlClient,
  name: string,
) => {
  const normalized = normalizeCorpsNameForMatch(name);
  return sql<{ corps_key: string }>`
    SELECT corps_key
    FROM corps
    WHERE replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(lower(name), 'the', ''),
                  'corps', ''
                ),
                'drum', ''
              ),
              'bugle', ''
            ),
            ' ', ''
          ),
          '-', ''
        ),
        '&', ''
      ),
      '.', ''
    ) = ${normalized}
    -- Two records can share a normalized name (e.g. "Bushwackers Drum Corps"
    -- and "Bushwackers" both reduce to "bushwackers"). Without an ORDER BY the
    -- LIMIT 1 was nondeterministic, so different ingests resolved the same org
    -- to different corps_keys and split its scores across both. Prefer the most
    -- complete record (has slug, then logo) and tie-break on corps_key so every
    -- ingest deterministically lands on the same canonical key.
    ORDER BY (slug IS NULL), (corps_logo IS NULL), corps_key
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.corps_key),
    Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
  );
};

const lookupCorpsKeyByNormalizedNameAndCity = (
  sql: SqlClient.SqlClient,
  name: string,
  location: string,
) => {
  const normalizedName = normalizeCorpsNameForMatch(name);
  const normalizedLocation = normalizeLocationForLookup(location);
  return sql<{ corps_key: string }>`
    SELECT corps_key
    FROM corps
    WHERE replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(lower(name), 'the', ''),
                  'corps', ''
                ),
                'drum', ''
              ),
              'bugle', ''
            ),
            ' ', ''
          ),
          '-', ''
        ),
        '&', ''
      ),
      '.', ''
    ) = ${normalizedName}
      AND replace(
        replace(
          replace(
            replace(
              replace(lower(coalesce(display_city, city, '')), ' ', ''),
              ',', ''
            ),
            '.', ''
          ),
          '-', ''
        ),
        '&', ''
      ) = ${normalizedLocation}
    -- Deterministic canonical pick when several records share name+city (see
    -- lookupCorpsKeyByNormalizedName).
    ORDER BY (slug IS NULL), (corps_logo IS NULL), corps_key
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.corps_key),
    Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
  );
};

const lookupCorpsKeyBySlug = (sql: SqlClient.SqlClient, slug: string) =>
  sql<{ corps_key: string }>`
    SELECT corps_key FROM corps WHERE lower(slug) = ${slug.toLowerCase()} LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.corps_key),
    Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
  );

const resolveCorpsKey = (
  sql: SqlClient.SqlClient,
  name?: string | null,
  identifier?: string | null,
  location?: string | null,
) =>
  Effect.gen(function* () {
    const trimmedName = name?.trim();
    const trimmedLocation = location?.trim();
    if (trimmedName && trimmedLocation) {
      const byLocation = yield* lookupCorpsKeyByNormalizedNameAndCity(
        sql,
        trimmedName,
        trimmedLocation,
      );
      if (byLocation) {
        return byLocation;
      }
    }
    if (trimmedName) {
      const existing = yield* lookupCorpsKeyByNormalizedName(sql, trimmedName);
      if (existing) {
        return existing;
      }
      const aliased = yield* lookupCorpsKeyByAlias(
        sql,
        trimmedName,
        trimmedLocation,
      );
      if (aliased) {
        return aliased;
      }
    }
    const direct = identifier?.trim();
    if (direct && direct.length > 0) {
      const byId = yield* lookupCorpsById(sql, direct);
      if (byId?.corps_key) {
        return byId.corps_key;
      }
      const bySlug = yield* lookupCorpsKeyBySlug(sql, direct);
      if (bySlug) {
        return bySlug;
      }
      return direct.toLowerCase();
    }
    if (trimmedName) {
      return normalizeCorpsNameKey(trimmedName) ?? trimmedName.toLowerCase();
    }
    return undefined;
  });

const resolveExistingCorpsKey = (
  sql: SqlClient.SqlClient,
  name?: string | null,
  identifier?: string | null,
  location?: string | null,
) =>
  Effect.gen(function* () {
    const trimmedName = name?.trim();
    const trimmedLocation = location?.trim();
    if (trimmedName && trimmedLocation) {
      const byLocation = yield* lookupCorpsKeyByNormalizedNameAndCity(
        sql,
        trimmedName,
        trimmedLocation,
      );
      if (byLocation) {
        return byLocation;
      }
    }
    if (trimmedName) {
      const existing = yield* lookupCorpsKeyByNormalizedName(sql, trimmedName);
      if (existing) {
        return existing;
      }
      const aliased = yield* lookupCorpsKeyByAlias(
        sql,
        trimmedName,
        trimmedLocation,
      );
      if (aliased) {
        return aliased;
      }
    }
    const direct = identifier?.trim();
    if (direct && direct.length > 0) {
      const byId = yield* lookupCorpsById(sql, direct);
      if (byId?.corps_key) {
        return byId.corps_key;
      }
      const bySlug = yield* lookupCorpsKeyBySlug(sql, direct);
      if (bySlug) {
        return bySlug;
      }
    }
    return undefined;
  });

export interface MatchCorpsKeyParams {
  readonly name?: string | null;
  readonly identifier?: string | null;
  readonly location?: string | null;
}

export const matchCorpsKey = (
  sql: SqlClient.SqlClient,
  params: MatchCorpsKeyParams,
) => resolveCorpsKey(sql, params.name, params.identifier, params.location);

export const matchExistingCorpsKey = (
  sql: SqlClient.SqlClient,
  params: MatchCorpsKeyParams,
) =>
  resolveExistingCorpsKey(sql, params.name, params.identifier, params.location);

const insertEventParticipant = (
  sql: SqlClient.SqlClient,
  eventSlug: string,
  participantId: string,
  corpsKey: string,
  participantSlug?: string | null,
  participantName?: string | null,
  performanceOrder?: number | null,
) =>
  sql`
    INSERT INTO event_participants (
      event_slug, participant_id, corps_key, participant_slug, participant_name, performance_order
    ) VALUES (
      ${eventSlug}, ${participantId}, ${corpsKey}, ${participantSlug ?? null}, ${participantName ?? null}, ${performanceOrder ?? null}
    )
    ON CONFLICT(event_slug, participant_id) DO UPDATE SET
      corps_key=excluded.corps_key,
      participant_slug=excluded.participant_slug,
      participant_name=excluded.participant_name,
      performance_order=excluded.performance_order
  `.pipe(Effect.asVoid);

const insertEventLineupEntry = (
  sql: SqlClient.SqlClient,
  eventSlug: string,
  entryId: string,
  schedule: Domain.EventSchedule,
  participantId?: string,
  source?: {
    scrapedAt?: string;
    sourceUrl?: string;
    lineupIndex?: number;
    isNonPerformance?: boolean;
    isExhibition?: boolean;
  },
) =>
  sql`
    INSERT INTO event_lineup_entries (
      entry_id, event_slug, participant_id, unit_name, display_city, time, performance_order,
      is_non_performance, is_exhibition, source_scraped_at, source_url, lineup_index
    ) VALUES (
      ${entryId}, ${eventSlug}, ${participantId ?? null}, ${schedule.unitName},
      ${schedule.displayCity ?? null}, ${schedule.time ?? null}, ${schedule.performanceOrder ?? null},
      ${source?.isNonPerformance ? 1 : 0}, ${source?.isExhibition ? 1 : 0},
      ${source?.scrapedAt ?? null}, ${source?.sourceUrl ?? null}, ${source?.lineupIndex ?? null}
    )
    ON CONFLICT(entry_id) DO UPDATE SET
      participant_id=excluded.participant_id,
      unit_name=excluded.unit_name,
      display_city=excluded.display_city,
      time=excluded.time,
      performance_order=excluded.performance_order,
      is_non_performance=excluded.is_non_performance,
      is_exhibition=excluded.is_exhibition,
      source_scraped_at=excluded.source_scraped_at,
      source_url=excluded.source_url,
      lineup_index=excluded.lineup_index
  `.pipe(Effect.asVoid);

const insertLineupCorps = (
  sql: SqlClient.SqlClient,
  corpsKey: string,
  corpsName: string,
) =>
  sql`
    INSERT INTO corps (corps_key, name, slug)
    VALUES (${corpsKey}, ${corpsName}, ${normalizeKey(corpsName) ?? corpsKey})
    ON CONFLICT(corps_key) DO NOTHING
  `.pipe(Effect.asVoid);

export interface EventPageTicketInfo {
  readonly title?: string;
  readonly description?: string;
  readonly info?: string;
  readonly price?: string;
  readonly buyLink?: string;
}

export interface EventPageLineupEntry {
  readonly time?: string;
  readonly corpsName?: string;
  readonly corpsCity?: string;
  readonly order?: number;
  readonly isNonPerformance?: boolean;
  readonly isExhibition?: boolean;
}

/* ------------------------------------------------------------------ */
/*  corps_page_scrapes — archived dci.org corps page HTML (+ parsed)   */
/* ------------------------------------------------------------------ */

// Directory page (`/corps/`) is archived under this sentinel slug; profiles use
// their own dci.org slug. The pair (corps_slug, scraped_at) is the PK, so full
// scrape history is retained for replay / re-parse (time travel).
export const DIRECTORY_SCRAPE_SLUG = "__directory__";

export type CorpsPageType = "directory" | "profile";

export interface CorpsPageScrapeInput {
  readonly corpsSlug: string;
  readonly pageType: CorpsPageType;
  readonly sourceUrl: string;
  readonly httpStatus: number;
  readonly rawHtml: string;
  /** Parsed roster/profile (serialized to parsed_json); filled by the parser stage. */
  readonly parsed?: unknown;
  /** Defaults to now; pass the page's scrape time to keep raw+parsed on one row. */
  readonly scrapedAt?: string;
}

export interface CorpsPageScrapeRow {
  readonly corpsSlug: string;
  readonly scrapedAt: string;
  readonly sourceUrl: string | null;
  readonly pageType: string;
  readonly httpStatus: number | null;
  readonly rawHtml: string;
  readonly parsedJson: string | null;
}

// Archive (or update) one corps page scrape. Re-running for the same
// (corps_slug, scraped_at) backfills parsed_json without a new row, so the
// parser stage can enrich a raw archive in place.
export const upsertCorpsPageScrape = (
  sql: SqlClient.SqlClient,
  scrape: CorpsPageScrapeInput,
) => {
  const scrapedAt = scrape.scrapedAt ?? new Date().toISOString();
  return sql`
    INSERT INTO corps_page_scrapes (
      corps_slug, scraped_at, source_url, page_type, http_status, raw_html, parsed_json
    ) VALUES (
      ${scrape.corpsSlug}, ${scrapedAt}, ${scrape.sourceUrl}, ${scrape.pageType},
      ${scrape.httpStatus}, ${scrape.rawHtml},
      ${scrape.parsed === undefined ? null : toJsonText(scrape.parsed)}
    )
    ON CONFLICT(corps_slug, scraped_at) DO UPDATE SET
      source_url=excluded.source_url,
      page_type=excluded.page_type,
      http_status=excluded.http_status,
      raw_html=excluded.raw_html,
      parsed_json=COALESCE(excluded.parsed_json, corps_page_scrapes.parsed_json)
  `.pipe(Effect.asVoid);
};

// Latest archived scrape for a slug (directory sentinel or a corps slug), or
// undefined if never scraped. Used for staleness/cache checks.
export const getLatestCorpsPageScrape = (
  sql: SqlClient.SqlClient,
  corpsSlug: string,
) =>
  sql<{
    corps_slug: string;
    scraped_at: string;
    source_url: string | null;
    page_type: string;
    http_status: number | null;
    raw_html: string;
    parsed_json: string | null;
  }>`
    SELECT corps_slug, scraped_at, source_url, page_type, http_status, raw_html, parsed_json
    FROM corps_page_scrapes
    WHERE corps_slug = ${corpsSlug}
    ORDER BY scraped_at DESC
    LIMIT 1
  `.pipe(
    Effect.map((rows): CorpsPageScrapeRow | undefined => {
      const r = rows[0];
      return r
        ? {
            corpsSlug: r.corps_slug,
            scrapedAt: r.scraped_at,
            sourceUrl: r.source_url,
            pageType: r.page_type,
            httpStatus: r.http_status,
            rawHtml: r.raw_html,
            parsedJson: r.parsed_json,
          }
        : undefined;
    }),
  );

export interface EventPageScrape {
  readonly eventSlug: string;
  readonly eventName?: string;
  readonly eventDateText?: string;
  readonly locationText?: string;
  readonly locationCity?: string;
  readonly locationState?: string;
  readonly watchLiveLink?: string;
  readonly buyTicketsLink?: string;
  readonly about?: string;
  readonly aboutHtml?: string;
  readonly tickets?: ReadonlyArray<EventPageTicketInfo>;
  readonly lineup?: ReadonlyArray<EventPageLineupEntry>;
  readonly locationAddress?: string;
  readonly locationGoogleMapLink?: string;
  readonly locationGoogleMapIframe?: string;
  readonly locationImages?: ReadonlyArray<string>;
  readonly heroImage?: string;
  readonly scrapedAt?: string;
  readonly sourceUrl?: string;
}

const deriveLocationParts = (locationText?: string) => {
  if (!locationText) {
    return { city: undefined, state: undefined };
  }
  const [city, state] = locationText.split(",").map((part) => part.trim());
  return { city: city || undefined, state: state || undefined };
};

const insertEventPageScrapeRow = (
  sql: SqlClient.SqlClient,
  scrape: EventPageScrape,
  scrapedAt: string,
) =>
  sql`
    INSERT INTO event_page_scrapes (
      event_slug, scraped_at, source_url, event_name, event_date_text, location_text,
      watch_live_link, buy_tickets_link, about_text, about_html, tickets_json, lineup_json,
      location_address, location_google_map_link, location_google_map_iframe, location_images_json,
      hero_image
    ) VALUES (
      ${scrape.eventSlug}, ${scrapedAt}, ${scrape.sourceUrl ?? null},
      ${scrape.eventName ?? null}, ${scrape.eventDateText ?? null}, ${scrape.locationText ?? null},
      ${scrape.watchLiveLink ?? null}, ${scrape.buyTicketsLink ?? null},
      ${scrape.about ?? null}, ${scrape.aboutHtml ?? null},
      ${toJsonText(scrape.tickets ?? [])}, ${toJsonText(scrape.lineup ?? [])},
      ${scrape.locationAddress ?? null}, ${scrape.locationGoogleMapLink ?? null},
      ${scrape.locationGoogleMapIframe ?? null}, ${toJsonText(scrape.locationImages ?? [])},
      ${scrape.heroImage ?? null}
    )
    ON CONFLICT(event_slug, scraped_at) DO UPDATE SET
      source_url=excluded.source_url,
      event_name=excluded.event_name,
      event_date_text=excluded.event_date_text,
      location_text=excluded.location_text,
      watch_live_link=excluded.watch_live_link,
      buy_tickets_link=excluded.buy_tickets_link,
      about_text=excluded.about_text,
      about_html=excluded.about_html,
      tickets_json=excluded.tickets_json,
      lineup_json=excluded.lineup_json,
      location_address=excluded.location_address,
      location_google_map_link=excluded.location_google_map_link,
      location_google_map_iframe=excluded.location_google_map_iframe,
      location_images_json=excluded.location_images_json,
      hero_image=excluded.hero_image
  `.pipe(Effect.asVoid);

export interface EventPageScrapeOptions {
  readonly overwrite?: boolean;
}

export const upsertEventPageScrape = (
  sql: SqlClient.SqlClient,
  scrape: EventPageScrape,
  options: EventPageScrapeOptions = {},
) =>
  Effect.gen(function* () {
    const locationParts = deriveLocationParts(scrape.locationText);
    const locationCity = scrape.locationCity ?? locationParts.city;
    const locationState = scrape.locationState ?? locationParts.state;
    const scrapedAt = scrape.scrapedAt ?? new Date().toISOString();
    const overwrite = options.overwrite ?? false;

    yield* insertEventPageScrapeRow(sql, scrape, scrapedAt);

    if (overwrite) {
      yield* sql`
        UPDATE events
        SET
          event_name = COALESCE(${scrape.eventName ?? null}, event_name),
          buy_tickets = COALESCE(${scrape.buyTicketsLink ?? null}, buy_tickets),
          live_stream_link = COALESCE(${scrape.watchLiveLink ?? null}, live_stream_link),
          notes_general = COALESCE(${scrape.about ?? null}, notes_general),
          event_image = COALESCE(${scrape.heroImage ?? null}, event_image),
          event_image_thumb = COALESCE(${scrape.heroImage ?? null}, event_image_thumb),
          location_city = COALESCE(${locationCity ?? null}, location_city),
          location_state = COALESCE(${locationState ?? null}, location_state)
        WHERE slug = ${scrape.eventSlug}
      `.pipe(Effect.asVoid);
    } else {
      yield* sql`
        UPDATE events
        SET
          event_name = COALESCE(event_name, ${scrape.eventName ?? null}),
          buy_tickets = COALESCE(buy_tickets, ${scrape.buyTicketsLink ?? null}),
          live_stream_link = COALESCE(live_stream_link, ${scrape.watchLiveLink ?? null}),
          notes_general = COALESCE(notes_general, ${scrape.about ?? null}),
          event_image = COALESCE(event_image, ${scrape.heroImage ?? null}),
          event_image_thumb = COALESCE(event_image_thumb, ${scrape.heroImage ?? null}),
          location_city = COALESCE(location_city, ${locationCity ?? null}),
          location_state = COALESCE(location_state, ${locationState ?? null})
        WHERE slug = ${scrape.eventSlug}
      `.pipe(Effect.asVoid);
    }

    const lineup = scrape.lineup;
    if (!lineup || lineup.length === 0) {
      return;
    }

    const lineupCount = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM event_lineup_entries WHERE event_slug = ${scrape.eventSlug}
      `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

    if (!overwrite && lineupCount > 0) {
      return;
    }

    const writeDerivedLineup = Effect.gen(function* () {
      if (overwrite) {
        yield* sql`
            DELETE FROM event_lineup_entries
            WHERE event_slug = ${scrape.eventSlug}
          `.pipe(Effect.asVoid);
        yield* sql`
            DELETE FROM event_participants
            WHERE event_slug = ${scrape.eventSlug}
          `.pipe(Effect.asVoid);
      }

      yield* Effect.forEach(
        lineup,
        (entry, index) =>
          Effect.gen(function* () {
            const corpsName = entry.corpsName?.trim();
            if (!corpsName) {
              return;
            }
            const displayCity = entry.corpsCity?.trim();
            const schedule: Domain.EventSchedule = {
              unitName: corpsName,
              displayCity: displayCity ?? undefined,
              time: entry.time ?? undefined,
              performanceOrder: entry.order ?? undefined,
            };
            const classification = firstExclusionMatch(corpsName);
            const isNonCorps =
              classification?.category === "schedule_item" ||
              classification?.category === "not_a_corps";
            const isExhibition =
              entry.isExhibition === true ||
              classification?.category === "exhibition";
            const isNonPerformance =
              entry.isNonPerformance === true || isNonCorps;
            const source = {
              scrapedAt,
              sourceUrl: scrape.sourceUrl,
              lineupIndex: index,
              isNonPerformance,
              isExhibition,
            };
            // Key the row by POSITION only — never the parsed name. The name
            // can change between scrapes for the same slot (an early parse read
            // "Carolina Crown"; a later one "Encore - Carolina Crown"), and a
            // name-bearing entry_id made the corrected row a NEW id that
            // accumulated alongside the stale one (the encore-duplicate bug).
            // Position is stable per canonical scrape, so re-parses now hit the
            // same entry_id and UPDATE in place. (See fixEncoreDuplicateLineups.ts.)
            const entryId = `${scrape.eventSlug}-${index}`;
            if (!isNonPerformance) {
              const participantId =
                normalizeKey(corpsName) ?? corpsName.toLowerCase();
              const existingCorpsKey = yield* resolveExistingCorpsKey(
                sql,
                corpsName,
                null,
                displayCity,
              );
              const derivedCorpsKey =
                existingCorpsKey ??
                normalizeCorpsNameKey(corpsName) ??
                normalizeKey(corpsName) ??
                participantId;

              if (!existingCorpsKey && derivedCorpsKey) {
                yield* insertLineupCorps(sql, derivedCorpsKey, corpsName);
              }

              if (derivedCorpsKey) {
                yield* insertEventParticipant(
                  sql,
                  scrape.eventSlug,
                  participantId,
                  derivedCorpsKey,
                  null,
                  corpsName,
                  entry.order ?? null,
                );
                yield* insertEventLineupEntry(
                  sql,
                  scrape.eventSlug,
                  entryId,
                  schedule,
                  participantId,
                  source,
                );
              } else {
                yield* insertEventLineupEntry(
                  sql,
                  scrape.eventSlug,
                  entryId,
                  schedule,
                  undefined,
                  source,
                );
              }
            } else {
              yield* insertEventLineupEntry(
                sql,
                scrape.eventSlug,
                entryId,
                schedule,
                undefined,
                source,
              );
            }
          }),
        { discard: true },
      );
    });

    if (overwrite) {
      yield* sql`BEGIN IMMEDIATE`.pipe(Effect.asVoid);
      yield* writeDerivedLineup.pipe(
        Effect.tapError(() => sql`ROLLBACK`.pipe(Effect.asVoid)),
        Effect.andThen(sql`COMMIT`.pipe(Effect.asVoid)),
      );
    } else {
      yield* writeDerivedLineup;
    }
  });

export interface WebsiteScoreListScrape {
  readonly season: string;
  readonly page: number;
  readonly sourceUrl: string;
  readonly rawHtml: string;
  readonly parsed: Domain.WebsiteScoreList;
  readonly scrapedAt?: string;
}

export interface WebsiteRecapScrape {
  readonly slug: string;
  readonly season: string;
  readonly sourceUrl: string;
  readonly rawHtml: string;
  readonly recap: Domain.WebsiteRecap;
  readonly scrapedAt?: string;
}

const insertWebsiteScoreListRow = (
  sql: SqlClient.SqlClient,
  scrape: WebsiteScoreListScrape,
) => {
  const scrapedAt = scrape.scrapedAt ?? new Date().toISOString();
  return sql`
    INSERT INTO website_score_lists (
      season, page, scraped_at, source_url, raw_html, parsed_json, entry_count
    ) VALUES (
      ${scrape.season}, ${scrape.page}, ${scrapedAt}, ${scrape.sourceUrl},
      ${scrape.rawHtml}, ${toJsonText(scrape.parsed)}, ${scrape.parsed.entries.length}
    )
    ON CONFLICT(season, page, scraped_at) DO UPDATE SET
      source_url=excluded.source_url,
      raw_html=excluded.raw_html,
      parsed_json=excluded.parsed_json,
      entry_count=excluded.entry_count
  `.pipe(Effect.asVoid);
};

const insertWebsiteRecapRow = (
  sql: SqlClient.SqlClient,
  scrape: WebsiteRecapScrape,
) => {
  const scrapedAt = scrape.scrapedAt ?? new Date().toISOString();
  // Count total corps across all class tables
  const corpsCount = scrape.recap.classes.reduce(
    (sum, classTable) => sum + classTable.corps.length,
    0,
  );
  return sql`
    INSERT INTO website_recaps (
      recap_slug, season, scraped_at, source_url, event_name, event_date, location, chief_judge,
      raw_html, parsed_json, corps_count
    ) VALUES (
      ${scrape.slug}, ${scrape.season}, ${scrapedAt}, ${scrape.sourceUrl},
      ${scrape.recap.meta.title ?? null}, ${scrape.recap.meta.date ?? null},
      ${scrape.recap.meta.location ?? null}, ${scrape.recap.meta.chiefJudge ?? null},
      ${scrape.rawHtml}, ${toJsonText(scrape.recap)}, ${corpsCount}
    )
    ON CONFLICT(recap_slug, scraped_at) DO UPDATE SET
      source_url=excluded.source_url,
      event_name=excluded.event_name,
      event_date=excluded.event_date,
      location=excluded.location,
      chief_judge=excluded.chief_judge,
      raw_html=excluded.raw_html,
      parsed_json=excluded.parsed_json,
      corps_count=excluded.corps_count
  `.pipe(Effect.asVoid);
};

export const upsertWebsiteScoreList = (
  sql: SqlClient.SqlClient,
  scrape: WebsiteScoreListScrape,
) => insertWebsiteScoreListRow(sql, scrape);

export const upsertWebsiteRecap = (
  sql: SqlClient.SqlClient,
  scrape: WebsiteRecapScrape,
) => insertWebsiteRecapRow(sql, scrape);

const insertGallery = (sql: SqlClient.SqlClient, gallery: Domain.Gallery) =>
  sql`
    INSERT INTO galleries (
      slug, title, description, published_date, created_at, presented_by, gallery_type
    ) VALUES (
      ${gallery.slug}, ${gallery.title}, ${gallery.description ?? null},
      ${gallery.publishedDate ?? null}, ${gallery.createdAt ?? null}, ${gallery.presentedBy ?? null},
      ${gallery.type}
    )
    ON CONFLICT(slug) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      published_date=excluded.published_date, presented_by=excluded.presented_by,
      gallery_type=excluded.gallery_type
  `.pipe(Effect.asVoid);

const insertGalleryImage = (
  sql: SqlClient.SqlClient,
  gallerySlug: string,
  image: Domain.GalleryImage,
  index: number,
) =>
  sql`
    INSERT INTO gallery_images (
      image_id, gallery_slug, url, caption, copyright_name,
      copyright_url, copyright_description, copyright_abbrev,
      copyright_active, copyright_is_default, copyright_media_category
    ) VALUES (
      ${`${gallerySlug}-${index}`}, ${gallerySlug}, ${image.url},
      ${image.caption ?? null}, ${image.copyright.name},
      ${image.copyright.url}, ${image.copyright.description},
      ${image.copyright.abbrev}, ${image.copyright.active ? 1 : 0},
      ${image.copyright.isDefault ? 1 : 0}, ${image.copyright.mediaCategory}
    )
    ON CONFLICT(image_id) DO UPDATE SET
      url=excluded.url, caption=excluded.caption,
      copyright_name=excluded.copyright_name,
      copyright_url=excluded.copyright_url,
      copyright_description=excluded.copyright_description,
      copyright_abbrev=excluded.copyright_abbrev,
      copyright_active=excluded.copyright_active,
      copyright_is_default=excluded.copyright_is_default,
      copyright_media_category=excluded.copyright_media_category
  `.pipe(Effect.asVoid);

const insertSponsor = (sql: SqlClient.SqlClient, sponsor: Domain.Sponsor) =>
  sql`
    INSERT INTO sponsors (
      sponsor_id, name, link, logo, active, display_order, created_at, updated_at
    ) VALUES (
      ${sponsor.id}, ${sponsor.name}, ${sponsor.link}, ${sponsor.logo},
      ${sponsor.active ? 1 : 0}, ${sponsor.order}, ${sponsor.createdAt}, ${sponsor.updatedAt}
    )
    ON CONFLICT(sponsor_id) DO UPDATE SET
      name=excluded.name, link=excluded.link, logo=excluded.logo,
      active=excluded.active, display_order=excluded.display_order, updated_at=excluded.updated_at
  `.pipe(Effect.asVoid);

const insertPastChampion = (
  sql: SqlClient.SqlClient,
  champion: Domain.PastChampion,
) =>
  sql`
    INSERT INTO past_champions (
      champion_id, year, champion_name, city, score, class, champion_type
    ) VALUES (
      ${`${champion.year}:${champion.class}:${champion.champion}`},
      ${champion.year}, ${champion.champion}, ${champion.city},
      ${champion.score}, ${champion.class}, ${champion.type}
    )
    ON CONFLICT(champion_id) DO UPDATE SET
      champion_name=excluded.champion_name, city=excluded.city,
      score=excluded.score, champion_type=excluded.champion_type
  `.pipe(Effect.asVoid);

// ============= END NEW TABLES INSERT FUNCTIONS =============

const deriveAssignmentId = (
  staffId: string,
  assignment: CorpsStaffAssignment,
) =>
  assignment.assignmentId ??
  `${staffId}:${assignment.corpsKey}:${assignment.season ?? "all"}:${assignment.title ?? ""}:${assignment.roleType ?? ""}`;

const deriveAffiliationId = (
  staffId: string,
  affiliation: CorpsStaffAffiliation,
) =>
  affiliation.affiliationId ??
  `${staffId}:${affiliation.relatedCorpsKey}:${affiliation.relationType ?? "linked"}`;

const insertStaffMemberRow = (
  sql: SqlClient.SqlClient,
  member: CorpsStaffMember,
) =>
  sql`
    INSERT INTO corps_staff (
      staff_id,
      given_name,
      family_name,
      display_name,
      default_title,
      biography,
      photo_url,
      metadata_json
    ) VALUES (
      ${member.staffId},
      ${member.givenName ?? null},
      ${member.familyName ?? null},
      ${member.displayName ?? member.givenName ?? null},
      ${member.defaultTitle ?? null},
      ${member.biography ?? null},
      ${member.photoUrl ?? null},
      ${toJsonText(member.metadata)}
    )
    ON CONFLICT(staff_id) DO UPDATE SET
      given_name=excluded.given_name,
      family_name=excluded.family_name,
      display_name=excluded.display_name,
      default_title=excluded.default_title,
      biography=excluded.biography,
      photo_url=excluded.photo_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

const insertStaffLinkRow = (
  sql: SqlClient.SqlClient,
  staffId: string,
  link: ExtraDomain.Link,
) =>
  sql`
    INSERT INTO corps_staff_links (staff_id, url, label, kind)
    VALUES (${staffId}, ${link.url}, ${link.label}, ${link.kind ?? null})
    ON CONFLICT(staff_id, url) DO UPDATE SET
      label=excluded.label,
      kind=excluded.kind
  `.pipe(Effect.asVoid);

const insertStaffAssignmentRow = (
  sql: SqlClient.SqlClient,
  staffId: string,
  assignment: CorpsStaffAssignment,
) => {
  const assignmentId = deriveAssignmentId(staffId, assignment);
  return sql`
    INSERT INTO corps_staff_assignments (
      assignment_id,
      staff_id,
      corps_key,
      season,
      title,
      role_type,
      start_year,
      end_year,
      start_date,
      end_date,
      notes,
      links_json
    ) VALUES (
      ${assignmentId},
      ${staffId},
      ${assignment.corpsKey},
      ${assignment.season ?? null},
      ${assignment.title ?? null},
      ${assignment.roleType ?? null},
      ${assignment.startYear ?? null},
      ${assignment.endYear ?? null},
      ${assignment.startDate ?? null},
      ${assignment.endDate ?? null},
      ${assignment.notes ?? null},
      ${assignment.links && assignment.links.length > 0 ? JSON.stringify(assignment.links) : null}
    )
    ON CONFLICT(assignment_id) DO UPDATE SET
      corps_key=excluded.corps_key,
      season=excluded.season,
      title=excluded.title,
      role_type=excluded.role_type,
      start_year=excluded.start_year,
      end_year=excluded.end_year,
      start_date=excluded.start_date,
      end_date=excluded.end_date,
      notes=excluded.notes,
      links_json=excluded.links_json
  `.pipe(Effect.asVoid);
};

const insertStaffAffiliationRow = (
  sql: SqlClient.SqlClient,
  staffId: string,
  affiliation: CorpsStaffAffiliation,
) => {
  const affiliationId = deriveAffiliationId(staffId, affiliation);
  return sql`
    INSERT INTO corps_staff_affiliations (
      affiliation_id,
      staff_id,
      related_corps_key,
      relation_type,
      notes,
      since_season,
      through_season
    ) VALUES (
      ${affiliationId},
      ${staffId},
      ${affiliation.relatedCorpsKey},
      ${affiliation.relationType ?? null},
      ${affiliation.notes ?? null},
      ${affiliation.sinceSeason ?? null},
      ${affiliation.throughSeason ?? null}
    )
    ON CONFLICT(affiliation_id) DO UPDATE SET
      relation_type=excluded.relation_type,
      notes=excluded.notes,
      since_season=excluded.since_season,
      through_season=excluded.through_season
  `.pipe(Effect.asVoid);
};

const deriveJudgeRelationId = (judgeId: string, relation: JudgeCorpsRelation) =>
  relation.relationId ??
  `${judgeId}:${relation.corpsKey ?? relation.corpsName ?? "unknown"}:${relation.season ?? "all"}:${relation.role ?? "relation"}`;

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const chr = value.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash;
};

const deriveJudgeHighlightId = (
  judgeId: string,
  highlight: JudgeSeasonHighlight,
) =>
  highlight.highlightId ??
  `${judgeId}:${highlight.season ?? "all"}:${Math.abs(hashString(highlight.summary ?? ""))}`;

const insertJudgeRow = (sql: SqlClient.SqlClient, profile: JudgeProfile) => {
  const metadata: Record<string, unknown> | undefined =
    profile.metadata ||
    (profile.alternateNames && profile.alternateNames.length > 0)
      ? {
          ...(typeof profile.metadata === "object" && profile.metadata
            ? profile.metadata
            : {}),
          alternateNames: profile.alternateNames ?? [],
        }
      : undefined;
  return sql`
    INSERT INTO judges (
      judge_id,
      first_name,
      last_name,
      display_name,
      biography,
      photo_url,
      metadata_json
    ) VALUES (
      ${profile.judgeId},
      ${profile.givenName ?? null},
      ${profile.familyName ?? null},
      ${profile.displayName},
      ${profile.biography ?? null},
      ${profile.photoUrl ?? null},
      ${toJsonText(metadata)}
    )
    ON CONFLICT(judge_id) DO UPDATE SET
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      display_name=excluded.display_name,
      biography=excluded.biography,
      photo_url=excluded.photo_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);
};

const insertJudgeLinkRow = (
  sql: SqlClient.SqlClient,
  judgeId: string,
  link: ExtraDomain.Link,
) =>
  sql`
    INSERT INTO judge_links (judge_id, url, label, kind)
    VALUES (${judgeId}, ${link.url}, ${link.label}, ${link.kind ?? null})
    ON CONFLICT(judge_id, url) DO UPDATE SET
      label=excluded.label,
      kind=excluded.kind
  `.pipe(Effect.asVoid);

const insertJudgeRelationRow = (
  sql: SqlClient.SqlClient,
  judgeId: string,
  relation: JudgeCorpsRelation,
) => {
  const relationId = deriveJudgeRelationId(judgeId, relation);
  return sql`
    INSERT INTO judge_corps_relations (
      relation_id,
      judge_id,
      corps_key,
      corps_name,
      season,
      role,
      caption_group,
      notes,
      source_url,
      metadata_json
    ) VALUES (
      ${relationId},
      ${judgeId},
      ${relation.corpsKey ?? null},
      ${relation.corpsName ?? null},
      ${relation.season ?? null},
      ${relation.role ?? null},
      ${relation.captionGroup ?? null},
      ${relation.notes ?? null},
      ${relation.sourceUrl ?? null},
      ${toJsonText(relation.metadata)}
    )
    ON CONFLICT(relation_id) DO UPDATE SET
      corps_key=excluded.corps_key,
      corps_name=excluded.corps_name,
      season=excluded.season,
      role=excluded.role,
      caption_group=excluded.caption_group,
      notes=excluded.notes,
      source_url=excluded.source_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);
};

const insertJudgeHighlightRow = (
  sql: SqlClient.SqlClient,
  judgeId: string,
  highlight: JudgeSeasonHighlight,
) => {
  const highlightId = deriveJudgeHighlightId(judgeId, highlight);
  return sql`
    INSERT INTO judge_highlights (
      highlight_id,
      judge_id,
      season,
      summary,
      notable_corps_json,
      awards_json,
      source_url,
      metadata_json
    ) VALUES (
      ${highlightId},
      ${judgeId},
      ${highlight.season ?? null},
      ${highlight.summary ?? null},
      ${highlight.notableCorps && highlight.notableCorps.length > 0 ? JSON.stringify(highlight.notableCorps) : null},
      ${highlight.awards && highlight.awards.length > 0 ? JSON.stringify(highlight.awards) : null},
      ${highlight.sourceUrl ?? null},
      ${toJsonText(highlight.metadata)}
    )
    ON CONFLICT(highlight_id) DO UPDATE SET
      season=excluded.season,
      summary=excluded.summary,
      notable_corps_json=excluded.notable_corps_json,
      awards_json=excluded.awards_json,
      source_url=excluded.source_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);
};

const normalizeJudgeMediaAssetForInsert = (
  judgeId: string,
  asset: MediaAsset,
  index: number,
): MediaAsset => ({
  ...asset,
  mediaId: asset.mediaId ?? `${judgeId}-media-${index + 1}`,
  ownerType: (asset.ownerType ?? "judge") as MediaAsset["ownerType"],
  ownerId: asset.ownerId ?? judgeId,
});

const insertShowRow = (sql: SqlClient.SqlClient, show: CorpsShow) =>
  sql`
    INSERT INTO corps_shows (
      show_id,
      corps_key,
      corps_name,
      season,
      title,
      subtitle,
      description,
      premiere_date,
      venue,
      tagline,
      designer_notes,
      source_url,
      metadata_json
    ) VALUES (
      ${show.showId},
      ${show.corpsKey},
      ${show.corpsName ?? null},
      ${show.season},
      ${show.title},
      ${show.subtitle ?? null},
      ${show.description ?? null},
      ${show.premiereDate ?? null},
      ${show.venue ?? null},
      ${show.tagline ?? null},
      ${show.designerNotes ?? null},
      ${show.sourceUrl ?? null},
      ${toJsonText(show.metadata)}
    )
    ON CONFLICT(show_id) DO UPDATE SET
      corps_key=excluded.corps_key,
      corps_name=excluded.corps_name,
      season=excluded.season,
      title=excluded.title,
      subtitle=excluded.subtitle,
      description=excluded.description,
      premiere_date=excluded.premiere_date,
      venue=excluded.venue,
      tagline=excluded.tagline,
      designer_notes=excluded.designer_notes,
      source_url=excluded.source_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

const insertShowTagRow = (
  sql: SqlClient.SqlClient,
  showId: string,
  tag: string,
) =>
  sql`
    INSERT INTO corps_show_tags (show_id, tag)
    VALUES (${showId}, ${tag})
    ON CONFLICT(show_id, tag) DO NOTHING
  `.pipe(Effect.asVoid);

const insertShowMediaRow = (sql: SqlClient.SqlClient, asset: ShowMediaAsset) =>
  sql`
    INSERT INTO corps_show_media (
      media_id,
      show_id,
      media_type,
      title,
      description,
      url,
      thumbnail_url,
      attribution,
      published_at,
      duration_seconds,
      metadata_json
    ) VALUES (
      ${asset.mediaId},
      ${asset.showId},
      ${asset.mediaType},
      ${asset.title ?? null},
      ${asset.description ?? null},
      ${asset.url},
      ${asset.thumbnailUrl ?? null},
      ${asset.attribution ?? null},
      ${asset.publishedAt ?? null},
      ${asset.durationSeconds ?? null},
      ${toJsonText(asset.metadata)}
    )
    ON CONFLICT(media_id) DO UPDATE SET
      show_id=excluded.show_id,
      media_type=excluded.media_type,
      title=excluded.title,
      description=excluded.description,
      url=excluded.url,
      thumbnail_url=excluded.thumbnail_url,
      attribution=excluded.attribution,
      published_at=excluded.published_at,
      duration_seconds=excluded.duration_seconds,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

const insertShowRepertoireRow = (
  sql: SqlClient.SqlClient,
  entry: ShowRepertoireEntry,
) =>
  sql`
    INSERT INTO corps_show_repertoire (
      entry_id,
      show_id,
      work_title,
      composer,
      arranger,
      description,
      hyperlink,
      related_corps_key,
      notes,
      metadata_json
    ) VALUES (
      ${entry.entryId},
      ${entry.showId},
      ${entry.workTitle},
      ${entry.composer ?? null},
      ${entry.arranger ?? null},
      ${entry.description ?? null},
      ${entry.hyperlink ?? null},
      ${entry.relatedCorpsKey ?? null},
      ${entry.notes ?? null},
      ${toJsonText(entry.metadata)}
    )
    ON CONFLICT(entry_id) DO UPDATE SET
      work_title=excluded.work_title,
      composer=excluded.composer,
      arranger=excluded.arranger,
      description=excluded.description,
      hyperlink=excluded.hyperlink,
      related_corps_key=excluded.related_corps_key,
      notes=excluded.notes,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

const insertShowReviewRow = (sql: SqlClient.SqlClient, review: ShowReview) =>
  sql`
    INSERT INTO corps_show_reviews (
      review_id,
      show_id,
      author_name,
      author_profile_url,
      publication,
      published_at,
      rating,
      summary,
      content,
      source_url,
      metadata_json
    ) VALUES (
      ${review.reviewId},
      ${review.showId},
      ${review.authorName ?? null},
      ${review.authorProfileUrl ?? null},
      ${review.publication ?? null},
      ${review.publishedAt ?? null},
      ${review.rating ?? null},
      ${review.summary ?? null},
      ${review.content ?? null},
      ${review.sourceUrl ?? null},
      ${toJsonText(review.metadata)}
    )
    ON CONFLICT(review_id) DO UPDATE SET
      author_name=excluded.author_name,
      author_profile_url=excluded.author_profile_url,
      publication=excluded.publication,
      published_at=excluded.published_at,
      rating=excluded.rating,
      summary=excluded.summary,
      content=excluded.content,
      source_url=excluded.source_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

// --- NEW: Show announcement scrape archive helpers ---

const insertShowAnnouncementScrapeRow = (
  sql: SqlClient.SqlClient,
  scrape: ShowAnnouncementScrape,
) =>
  sql`
    INSERT INTO show_announcement_scrapes (
      corps_key, source_url, source_type, scraped_at,
      raw_html, parsed_json, http_status
    ) VALUES (
      ${scrape.corpsKey}, ${scrape.sourceUrl}, ${scrape.sourceType},
      ${scrape.scrapedAt}, ${scrape.rawHtml ?? null}, ${scrape.parsedJson ?? null},
      ${scrape.httpStatus ?? null}
    )
    ON CONFLICT(corps_key, source_url, scraped_at) DO UPDATE SET
      source_type=excluded.source_type,
      raw_html=excluded.raw_html,
      parsed_json=excluded.parsed_json,
      http_status=excluded.http_status
  `.pipe(Effect.asVoid);

// --- NEW: Show designers helpers ---

const insertShowDesignerRow = (
  sql: SqlClient.SqlClient,
  designer: ShowDesigner,
) =>
  sql`
    INSERT INTO corps_show_designers (
      designer_id, show_id, corps_key, role, name,
      source_url, scraped_at
    ) VALUES (
      ${designer.designerId}, ${designer.showId}, ${designer.corpsKey},
      ${designer.role}, ${designer.name}, ${designer.sourceUrl ?? null},
      ${designer.scrapedAt ?? null}
    )
    ON CONFLICT(designer_id) DO UPDATE SET
      show_id=excluded.show_id,
      corps_key=excluded.corps_key,
      role=excluded.role,
      name=excluded.name,
      source_url=excluded.source_url,
      scraped_at=excluded.scraped_at
  `.pipe(Effect.asVoid);

// --- NEW: Show movements helpers ---

const insertShowMovementRow = (
  sql: SqlClient.SqlClient,
  movement: ShowMovement,
) =>
  sql`
    INSERT INTO corps_show_movements (
      movement_id, show_id, corps_key, ordinal, title,
      description, source_url, scraped_at
    ) VALUES (
      ${movement.movementId}, ${movement.showId}, ${movement.corpsKey},
      ${movement.ordinal}, ${movement.title ?? null},
      ${movement.description ?? null}, ${movement.sourceUrl ?? null},
      ${movement.scrapedAt ?? null}
    )
    ON CONFLICT(movement_id) DO UPDATE SET
      show_id=excluded.show_id,
      corps_key=excluded.corps_key,
      ordinal=excluded.ordinal,
      title=excluded.title,
      description=excluded.description,
      source_url=excluded.source_url,
      scraped_at=excluded.scraped_at
  `.pipe(Effect.asVoid);

const insertSeasonParticipationRow = (
  sql: SqlClient.SqlClient,
  record: CorpsSeasonParticipation,
) =>
  sql`
    INSERT INTO season_participation (
      season,
      corps_key,
      participation_id,
      corps_name,
      division,
      status,
      participation_type,
      first_appearance,
      last_appearance,
      notes,
      derived_from,
      metadata_json
    ) VALUES (
      ${record.season},
      ${record.corpsKey},
      ${record.participationId ?? null},
      ${record.corpsName ?? null},
      ${record.division ?? null},
      ${record.status ?? null},
      ${record.participationType ?? null},
      ${record.firstAppearance ?? null},
      ${record.lastAppearance ?? null},
      ${record.notes ?? null},
      ${record.derivedFrom ?? null},
      ${toJsonText(record.metadata)}
    )
    ON CONFLICT(season, corps_key) DO UPDATE SET
      participation_id=excluded.participation_id,
      corps_name=excluded.corps_name,
      division=excluded.division,
      status=excluded.status,
      participation_type=excluded.participation_type,
      first_appearance=excluded.first_appearance,
      last_appearance=excluded.last_appearance,
      notes=excluded.notes,
      derived_from=excluded.derived_from,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

const insertMediaAssetRow = (sql: SqlClient.SqlClient, asset: MediaAsset) =>
  sql`
    INSERT INTO media_assets (
      media_id,
      owner_type,
      owner_id,
      url,
      title,
      description,
      media_type,
      format,
      attribution,
      width,
      height,
      duration_seconds,
      thumbnail_url,
      source_url,
      metadata_json
    ) VALUES (
      ${asset.mediaId},
      ${asset.ownerType},
      ${asset.ownerId},
      ${asset.url},
      ${asset.title ?? null},
      ${asset.description ?? null},
      ${asset.mediaType ?? null},
      ${asset.format ?? null},
      ${asset.attribution ?? null},
      ${asset.width ?? null},
      ${asset.height ?? null},
      ${asset.durationSeconds ?? null},
      ${asset.thumbnailUrl ?? null},
      ${asset.sourceUrl ?? null},
      ${toJsonText(asset.metadata)}
    )
    ON CONFLICT(media_id) DO UPDATE SET
      owner_type=excluded.owner_type,
      owner_id=excluded.owner_id,
      url=excluded.url,
      title=excluded.title,
      description=excluded.description,
      media_type=excluded.media_type,
      format=excluded.format,
      attribution=excluded.attribution,
      width=excluded.width,
      height=excluded.height,
      duration_seconds=excluded.duration_seconds,
      thumbnail_url=excluded.thumbnail_url,
      source_url=excluded.source_url,
      metadata_json=excluded.metadata_json
  `.pipe(Effect.asVoid);

interface SeasonMeta {
  readonly firstDate: Date | undefined;
  readonly lastDate: Date | undefined;
  readonly seasonLength: number;
}

const computeSeasonMeta = (
  competitions: ReadonlyArray<Domain.Competition>,
): SeasonMeta => {
  const sorted = [...competitions].sort((a, b) => competitionOrder(a, b));
  const firstDate = sorted[0]?.date;
  const lastDate = sorted[sorted.length - 1]?.date ?? firstDate;
  const seasonLength =
    firstDate && lastDate
      ? Math.max(1, differenceInDays(lastDate, firstDate))
      : 0;
  return { firstDate, lastDate, seasonLength };
};

const deriveCompetitionMeta = (
  competition: Domain.Competition,
  seasonMeta: SeasonMeta,
): { dayOfSeason: number; daysTillFinals: number; percentThrough: number } => {
  if (!seasonMeta.firstDate || !seasonMeta.lastDate) {
    return { dayOfSeason: 0, daysTillFinals: 0, percentThrough: 0 };
  }
  const dayOfSeason = differenceInDays(competition.date, seasonMeta.firstDate);
  const daysTillFinals = differenceInDays(
    seasonMeta.lastDate,
    competition.date,
  );
  const percentThrough =
    seasonMeta.seasonLength > 0
      ? (dayOfSeason / seasonMeta.seasonLength) * 100
      : 0;
  return { dayOfSeason, daysTillFinals, percentThrough };
};

export const upsertStaffMember = (
  sql: SqlClient.SqlClient,
  member: CorpsStaffMember,
) =>
  insertStaffMemberRow(sql, member).pipe(
    Effect.andThen(
      Effect.forEach(member.externalLinks ?? [], (link) =>
        insertStaffLinkRow(sql, member.staffId, link),
      ),
    ),
    Effect.andThen(
      Effect.forEach(member.assignments ?? [], (assignment) =>
        insertStaffAssignmentRow(sql, member.staffId, assignment),
      ),
    ),
    Effect.andThen(
      Effect.forEach(member.affiliations ?? [], (affiliation) =>
        insertStaffAffiliationRow(sql, member.staffId, affiliation),
      ),
    ),
  );

/**
 * Canonical-person id derived from a display name (e.g. "John Smith" -> "john-smith").
 * Collisions are EXPECTED and allowed — disambiguation happens in the identity-resolution
 * pass (confirmed-distinct same-named people get a `-2`/`-3` suffix there), not here.
 */
/** Normalize common first-name diminutives to their canonical form so "Ben Lorenzo"
 *  and "Benjamin Lorenzo" produce the same person_id without identity-resolution. */
const normalizeFirstName = (name: string): string => {
  const tokens = name.split(/\s+/);
  if (tokens.length < 2) return name;
  const normalized: Record<string, string> = {
    ben: "benjamin", benji: "benjamin", benjy: "benjamin",
    sam: "samuel", sammy: "samuel",
    chris: "christopher", chriss: "christopher",
    will: "william", bill: "william", billy: "william", willy: "william",
    andy: "andrew", drew: "andrew",
    mike: "michael", mickey: "michael",
    matt: "matthew", matty: "matthew",
    joe: "joseph", joey: "joseph",
    dave: "david", davey: "david", davy: "david",
    dan: "daniel", danny: "daniel",
    tom: "thomas", tommy: "thomas",
    jim: "james", jimmy: "james", jamie: "james",
    alex: "alexander", al: "alexander", alec: "alexander",
    zach: "zachary", zack: "zachary",
    steve: "stephen", steven: "stephen",
    ken: "kenneth", kenny: "kenneth",
    bob: "robert", bobby: "robert", rob: "robert", robby: "robert",
    rick: "richard", ricky: "richard", rich: "richard", dick: "richard",
    larry: "lawrence",
    ed: "edward", eddy: "edward", eddie: "edward",
    pete: "peter",
    chuck: "charles",
    nick: "nicholas", nicky: "nicholas",
    brad: "bradley",
    greg: "gregory",
    jeff: "jeffrey",
    jon: "jonathan", johnny: "jonathan",
    doug: "douglas",
    fred: "frederick", freddy: "frederick",
    ted: "theodore",
    ray: "raymond",
  };
  const first = tokens[0]!.toLowerCase();
  const canonical = normalized[first];
  if (canonical) tokens[0] = canonical[0]!.toUpperCase() + canonical.slice(1);
  return tokens.join(" ");
};

export const makeStaffPersonId = (displayName: string | null | undefined) => {
  if (!displayName) return undefined;
  // Strip diacritics first (NFD → drop combining marks) so accented names yield clean,
  // stable slugs instead of `normalizeKey` dropping the letters: "José Díaz" → "jose-diaz"
  // rather than "jos-d-az" (#9).
  const deaccented = displayName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Strip quoted/parenthetical nicknames and pronouns so "Chelsea 'Vex' Suarez"
  // and "Chelsea Suarez" map to the same person_id, and "Alix Stuart (she/her)"
  // doesn't produce a unique slug with pronouns baked in.
  // Only strips PAIRED quotes surrounding a word — NOT apostrophes inside names
  // (O'Neil, O'Toole, D'Ante).
  const base = deaccented
    .replace(/[\u201C\u201D\u2018\u2019'"]\w+[\u201C\u201D\u2018\u2019'"]/g, " ")
    .replace(/\s*\([^)]+\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Normalize first-name variants before slugging
  const canonical = normalizeFirstName(base);
  return normalizeKey(canonical) ?? undefined;
};

/** Controlled section/caption vocabulary. Folds free-text staff titles into a stable
 *  `role_type` while the verbatim title is preserved separately on the assignment. */
export type StaffCaption =
  | "brass"
  | "percussion"
  | "guard"
  | "visual"
  | "music"
  | "drum-major"
  | "director"
  | "design"
  | "other";

export const normalizeCaption = (
  title: string | null | undefined,
): StaffCaption => {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return "other";
  // Order matters: most-specific / least-ambiguous first.
  // NOTE: stems use \w* so inflected forms match — a bare \b after a stem (e.g. "choreograph\b")
  // silently fails on "choreographer"/"administration"/"Designs", dumping them into 'other'.
  if (/\bdrum\s*majors?\b|\bdm\b/.test(t)) return "drum-major";
  if (/\b(brass|horns?|hornline|trumpets?|mellophones?|baritones?|euphoniums?|tubas?|contras?)\b/.test(t)) return "brass";
  if (/\b(percussion|batter\w*|drumline|front\s*ensemble|pit|mallets?|snares?|tenors?|cymbals?|timpani)\b/.test(t)) return "percussion";
  if (/\b(colou?r\s*guard|guard|weapons?|sab[er]+|rifles?|flags?|winter\s*guard)\b/.test(t)) return "guard";
  if (/\b(visual|drill|marching|movement|choreograph\w*|bodywork)\b/.test(t)) return "visual";
  if (/\b(music|arrang\w*|compos\w*|orchestrat\w*)\b/.test(t)) return "music";
  if (/\bdesign\w*\b|concept|(?:program|show)\s*(?:design|coordinat)/.test(t)) return "design";
  if (/\b(directors?|executives?|ceo|president|founders?|managers?|operations?|administrat\w*|board)\b/.test(t)) return "director";
  return "other";
};

interface StaffReviewInput {
  readonly leftStaffId: string;
  readonly rightStaffId: string;
  readonly samePerson?: boolean | null;
  readonly confidence?: string | null;
  readonly action?: string | null;
  readonly rationale?: string | null;
  readonly supportingEvidence?: unknown;
  readonly decidedBy?: string | null;
  readonly resolved?: boolean;
}

/** Upsert a candidate identity-merge pair into the review queue. Coalescing on the
 *  ordered (left,right) pair so re-running the comparison updates rather than duplicates. */
export const upsertStaffReview = (
  sql: SqlClient.SqlClient,
  input: StaffReviewInput,
) => {
  // Order the pair so (A,B) and (B,A) collapse to one review row.
  const [left, right] =
    input.leftStaffId <= input.rightStaffId
      ? [input.leftStaffId, input.rightStaffId]
      : [input.rightStaffId, input.leftStaffId];
  const reviewId = `${left}::${right}`;
  const now = new Date().toISOString();
  return sql`
    INSERT INTO corps_staff_review (
      review_id, left_staff_id, right_staff_id, same_person, confidence, action,
      rationale, supporting_evidence_json, resolved, decided_by, created_at, updated_at
    ) VALUES (
      ${reviewId}, ${left}, ${right},
      ${input.samePerson == null ? null : input.samePerson ? 1 : 0},
      ${input.confidence ?? null}, ${input.action ?? null}, ${input.rationale ?? null},
      ${toJsonText(input.supportingEvidence)}, ${input.resolved ? 1 : 0},
      ${input.decidedBy ?? null}, ${now}, ${now}
    )
    ON CONFLICT(review_id) DO UPDATE SET
      same_person=excluded.same_person,
      confidence=excluded.confidence,
      action=excluded.action,
      rationale=excluded.rationale,
      supporting_evidence_json=excluded.supporting_evidence_json,
      resolved=excluded.resolved,
      decided_by=excluded.decided_by,
      updated_at=excluded.updated_at
  `.pipe(Effect.asVoid);
};

/**
 * Idempotent, additive migration for the staff-scraping feature (M1) — safe to run on
 * an existing DB before scraping/resolving. The full `ensureRelationalSchema` also
 * creates these, but the staff scripts call this focused version so they don't depend
 * on a full schema pass having been run first.
 */
export const ensureStaffSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS corps_staff_review (
        review_id TEXT PRIMARY KEY,
        left_staff_id TEXT NOT NULL,
        right_staff_id TEXT NOT NULL,
        same_person INTEGER,
        confidence TEXT,
        action TEXT,
        rationale TEXT,
        supporting_evidence_json TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        decided_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`.pipe(Effect.asVoid);
  yield* ensureColumns(sql, "corps_staff", ["person_id TEXT"]);
  // Candidate store: EVERY bio/photo we ever find for a staff_id, kept with provenance so
  // nothing is lost. corps_staff.biography/photo_url hold the CURRENT pick (most recent),
  // while older candidates remain for later AI merge / best-photo selection. Keyed by
  // (staff_id, kind, source_url) so re-runs upsert in place rather than duplicate.
  yield* sql`CREATE TABLE IF NOT EXISTS staff_profile_candidates (
        staff_id TEXT NOT NULL,
        kind TEXT NOT NULL,            -- 'bio' | 'photo'
        source_url TEXT NOT NULL,
        person_id TEXT,
        value TEXT NOT NULL,           -- bio text OR photo URL
        source_kind TEXT,              -- detail-page | grid | announcement | web-research | yearbook | legacy
        char_len INTEGER,
        source_date TEXT,              -- the CONTENT's date/season (post date, snapshot, season yr) — drives 'current'
        fetched_at TEXT NOT NULL,      -- when WE scraped it (bookkeeping only)
        is_current INTEGER NOT NULL DEFAULT 0,
        extra_json TEXT,
        PRIMARY KEY (staff_id, kind, source_url)
      )`.pipe(Effect.asVoid);
  // Additive migration for tables created before source_date existed.
  yield* ensureColumns(sql, "staff_profile_candidates", ["source_date TEXT"]);
  // S3 — structured facts mined from bio prose (what assignments DON'T already give:
  // education, awards, current position, hometown). Performing history goes to
  // corps_staff_affiliations (relation_type='performed') instead. Keyed so re-runs upsert.
  yield* sql`CREATE TABLE IF NOT EXISTS staff_bio_facts (
        staff_id TEXT NOT NULL,
        person_id TEXT,
        fact_type TEXT NOT NULL,       -- education | award | position | hometown
        value TEXT NOT NULL,           -- normalized display value (institution, award, place…)
        detail_json TEXT,              -- {degree,field,year,title,org,…}
        source_url TEXT,
        source_kind TEXT,              -- bio-parser | bio-ai
        confidence TEXT,               -- HIGH | MEDIUM | LOW
        evidence TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (staff_id, fact_type, value)
      )`.pipe(Effect.asVoid);
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_bio_facts_person ON staff_bio_facts(person_id, fact_type)");
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_staff_person ON corps_staff(person_id)");
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_staff_review_unresolved ON corps_staff_review(resolved)");
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_staff_assignments_staff ON corps_staff_assignments(staff_id)");
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_staff_cand_person ON staff_profile_candidates(person_id, kind)");
  yield* ensureIndex(sql, "CREATE INDEX IF NOT EXISTS idx_staff_cand_staff ON staff_profile_candidates(staff_id, kind)");
});

export const upsertCorpsShow = (sql: SqlClient.SqlClient, show: CorpsShow) =>
  insertShowRow(sql, show).pipe(
    Effect.andThen(
      Effect.forEach(show.tags ?? [], (tag) =>
        insertShowTagRow(sql, show.showId, tag),
      ),
    ),
    Effect.andThen(
      Effect.forEach(show.media ?? [], (asset) =>
        insertShowMediaRow(sql, asset),
      ),
    ),
    Effect.andThen(
      Effect.forEach(show.repertoire ?? [], (entry) =>
        insertShowRepertoireRow(sql, entry),
      ),
    ),
    Effect.andThen(
      Effect.forEach(show.designers ?? [], (designer) =>
        insertShowDesignerRow(sql, designer),
      ),
    ),
    Effect.andThen(
      Effect.forEach(show.movements ?? [], (movement) =>
        insertShowMovementRow(sql, movement),
      ),
    ),
    Effect.andThen(
      Effect.forEach(show.reviews ?? [], (review) =>
        insertShowReviewRow(sql, review),
      ),
    ),
  );

export const upsertShowAnnouncementScrape = (
  sql: SqlClient.SqlClient,
  scrape: ShowAnnouncementScrape,
) => insertShowAnnouncementScrapeRow(sql, scrape);

export const upsertShowDesigner = (
  sql: SqlClient.SqlClient,
  designer: ShowDesigner,
) => insertShowDesignerRow(sql, designer);

export const upsertShowMovement = (
  sql: SqlClient.SqlClient,
  movement: ShowMovement,
) => insertShowMovementRow(sql, movement);

export const upsertSeasonParticipationRecord = (
  sql: SqlClient.SqlClient,
  record: CorpsSeasonParticipation,
) => insertSeasonParticipationRow(sql, record);

export const upsertMediaAsset = (sql: SqlClient.SqlClient, asset: MediaAsset) =>
  insertMediaAssetRow(sql, asset);

export const upsertJudgeProfile = (
  sql: SqlClient.SqlClient,
  profile: JudgeProfile,
) =>
  insertJudgeRow(sql, profile).pipe(
    Effect.andThen(
      Effect.forEach(profile.externalLinks ?? [], (link) =>
        insertJudgeLinkRow(sql, profile.judgeId, link),
      ),
    ),
    Effect.andThen(
      Effect.forEach(profile.corpsRelations ?? [], (relation) =>
        insertJudgeRelationRow(sql, profile.judgeId, relation),
      ),
    ),
    Effect.andThen(
      Effect.forEach(profile.seasonHighlights ?? [], (highlight) =>
        insertJudgeHighlightRow(sql, profile.judgeId, highlight),
      ),
    ),
    Effect.andThen(
      Effect.forEach(profile.media ?? [], (asset, index) =>
        upsertMediaAsset(
          sql,
          normalizeJudgeMediaAssetForInsert(profile.judgeId, asset, index),
        ),
      ),
    ),
  );

// ============= EXPORTS FOR NEW TABLES =============

export const upsertApiResponse = (
  sql: SqlClient.SqlClient,
  endpointUrl: string,
  endpointType: string,
  responseJson: string,
  options?: { season?: string; recordCount?: number },
) => insertApiResponse(sql, endpointUrl, endpointType, responseJson, options);

export const upsertCompetitionType = (
  sql: SqlClient.SqlClient,
  competitionType: Domain.CompetitionType,
) => insertCompetitionType(sql, competitionType);

export const upsertGroupType = (
  sql: SqlClient.SqlClient,
  groupType: Domain.GroupType,
) =>
  insertCompetitionType(sql, groupType.competitionType).pipe(
    Effect.andThen(insertGroupType(sql, groupType)),
  );

// --- Event-to-Competition Mapping ---
// The events table (from DCI website) and competitions table (from DCI API)
// often have different slugs for the same real-world event. This mapping
// resolves the relationship so scores/recaps can be found from either slug.

export const upsertEventCompetitionMapping = (
  sql: SqlClient.SqlClient,
  eventSlug: string,
  competitionSlug: string,
  method: string = "heuristic",
) =>
  sql`
    INSERT INTO event_to_competition (event_slug, competition_slug, match_method)
    VALUES (${eventSlug}, ${competitionSlug}, ${method})
    ON CONFLICT(event_slug) DO UPDATE SET
      competition_slug = excluded.competition_slug,
      match_method = excluded.match_method
  `.pipe(Effect.asVoid);

export const resolveCompetitionSlug = (
  sql: SqlClient.SqlClient,
  eventSlug: string,
) =>
  sql`
    SELECT competition_slug FROM event_to_competition WHERE event_slug = ${eventSlug}
  `.pipe(
    Effect.map(
      (rows) =>
        (rows[0] as { competition_slug: string } | undefined)
          ?.competition_slug ?? null,
    ),
  );

export const upsertEvent = (sql: SqlClient.SqlClient, event: Domain.Event) =>
  Effect.gen(function* () {
    const startDate = event.startDate;
    if (Number.isNaN(startDate.getTime())) {
      yield* Effect.logWarning(
        `Skipping event with invalid startDate: ${event.slug}`,
      );
      return;
    }

    const sanitizedEvent =
      event.endDate && Number.isNaN(event.endDate.getTime())
        ? { ...event, endDate: undefined }
        : event;

    yield* insertEvent(sql, sanitizedEvent);

    if (sanitizedEvent.venue) {
      yield* insertEventVenue(sql, sanitizedEvent, sanitizedEvent.venue);
    }

    const schedules = sanitizedEvent.schedules ?? [];
    yield* Effect.forEach(
      schedules,
      (schedule, index) =>
        insertEventSchedule(sql, sanitizedEvent.id, schedule, index),
      { discard: true },
    );

    const participants = sanitizedEvent.participants ?? [];
    const participantRows = yield* Effect.forEach(
      participants,
      (participantId) =>
        lookupCorpsById(sql, participantId).pipe(
          Effect.map((corps) => ({ participantId, corps })),
        ),
      { concurrency: 5 },
    );

    const participantIdByCorpsKey = new Map<string, string>();
    yield* Effect.forEach(
      participantRows,
      ({ participantId, corps }) => {
        const corpsKey = corps?.corps_key;
        if (!corpsKey) {
          return Effect.void;
        }
        participantIdByCorpsKey.set(corpsKey, participantId);
        return insertEventParticipant(
          sql,
          sanitizedEvent.slug,
          participantId,
          corpsKey,
          corps?.slug ?? null,
          corps?.name ?? null,
        );
      },
      { discard: true },
    );

    yield* Effect.forEach(
      schedules,
      (schedule, index) =>
        lookupCorpsKeyByName(sql, schedule.unitName).pipe(
          Effect.flatMap((corpsKey) => {
            const participantId = corpsKey
              ? participantIdByCorpsKey.get(corpsKey)
              : undefined;
            return insertEventLineupEntry(
              sql,
              sanitizedEvent.slug,
              `${sanitizedEvent.slug}:${index}`,
              schedule,
              participantId,
            );
          }),
        ),
      { discard: true },
    );
  });

export const ingestWaybackEvents = (
  sql: SqlClient.SqlClient,
  rawEvents: ReadonlyArray<unknown>,
  options?: {
    endpointUrl?: string;
    season?: string;
    responseJson?: string;
    recordCount?: number;
  },
) =>
  Effect.gen(function* () {
    yield* ensureRelationalSchema;

    if (options?.endpointUrl && options?.responseJson) {
      yield* upsertApiResponse(
        sql,
        options.endpointUrl,
        "wayback-events",
        options.responseJson,
        {
          season: options.season,
          recordCount: options.recordCount,
        },
      );
    }

    const events = yield* normalizeWaybackEvents(rawEvents);

    yield* Effect.forEach(events, (event) => upsertEvent(sql, event), {
      concurrency: 5,
      discard: true,
    });
  });

export const upsertGallery = (
  sql: SqlClient.SqlClient,
  gallery: Domain.Gallery,
) =>
  insertGallery(sql, gallery).pipe(
    Effect.tapError((e) =>
      Effect.logError(
        `[Gallery Parent Insert Failed] slug=${gallery.slug} err=${JSON.stringify(e, null, 2)}`,
      ),
    ),
    Effect.andThen(
      Effect.forEach(gallery.gallery, (image, index) =>
        insertGalleryImage(sql, gallery.slug, image, index).pipe(
          Effect.tapError((e) =>
            Effect.logError(
              `[Gallery Image Insert Failed] slug=${gallery.slug} index=${index} url=${image.url} err=${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
      ),
    ),
  );

export const upsertSponsor = (
  sql: SqlClient.SqlClient,
  sponsor: Domain.Sponsor,
) => insertSponsor(sql, sponsor);

export const upsertPastChampion = (
  sql: SqlClient.SqlClient,
  champion: Domain.PastChampion,
) => insertPastChampion(sql, champion);

const clearSeasonRankingData = (sql: SqlClient.SqlClient, season: string) =>
  sql`DELETE FROM season_ranking_entries WHERE season = ${season}`.pipe(
    Effect.andThen(sql`DELETE FROM season_rankings WHERE season = ${season}`),
    Effect.asVoid,
  );

const insertSeasonRankingSnapshotRow = (
  sql: SqlClient.SqlClient,
  season: string,
  snapshotIndex: number,
  snapshot: SeasonRankingTimeline["snapshots"][number],
) =>
  sql`
    INSERT INTO season_rankings (
      season,
      snapshot_index,
      competition_slug,
      competition_date,
      day_of_season,
      days_till_finals,
      percent_through
    )
    VALUES (
      ${season},
      ${snapshotIndex},
      ${snapshot.competition.slug ?? null},
      ${snapshot.competition.date.toISOString()},
      ${snapshot.competition.dayOfSeason ?? null},
      ${snapshot.competition.daysTillFinals ?? null},
      ${snapshot.competition.percentageThroughSeason ?? null}
    )
  `.pipe(Effect.asVoid);

interface RankingEntryRowParams {
  readonly season: string;
  readonly snapshotIndex: number;
  readonly metric: string;
  readonly position: number;
  readonly entry: RankingEntry;
  readonly corpsKey?: string;
  readonly competitionSlug?: string | null;
}

const insertSeasonRankingEntryRow = (
  sql: SqlClient.SqlClient,
  params: RankingEntryRowParams,
) =>
  sql`
    INSERT INTO season_ranking_entries (
      season,
      snapshot_index,
      metric,
      metric_position,
      corps_key,
      corps_name,
      division_name,
      score,
      percent_through,
      competition_rank,
      competition_slug
    ) VALUES (
      ${params.season},
      ${params.snapshotIndex},
      ${params.metric},
      ${params.position},
      ${params.corpsKey ?? null},
      ${params.entry.corps},
      ${params.entry.divisionName ?? null},
      ${params.entry.score},
      ${params.entry.percentThrough ?? null},
      ${params.entry.rank ?? null},
      ${params.competitionSlug ?? null}
    )
  `.pipe(Effect.asVoid);

type CorpsKeyResolver = (entry: RankingEntry) => string | undefined;

const createRankingCorpsResolver = (
  dataset: SeasonDataset,
): CorpsKeyResolver => {
  const divisionBuckets = new Map<string, Map<string, string>>();
  const fallback = new Map<string, string>();

  for (const [divisionName, corpsProfiles] of Object.entries(
    dataset.corps ?? {},
  )) {
    const divisionKey = divisionName.toLowerCase();
    const bucket =
      divisionBuckets.get(divisionKey) ?? new Map<string, string>();
    divisionBuckets.set(divisionKey, bucket);
    for (const profile of Object.values(corpsProfiles)) {
      const key = makeCorpsKeyFromParts(
        profile.orgGroupIdentifier,
        profile.name,
      );
      if (!key) continue;
      const normalized = normalizeCorpsNameForLookup(profile.name);
      bucket.set(normalized, key);
      fallback.set(normalized, key);
      fallback.set(profile.name.toLowerCase(), key);
    }
  }

  return (entry) => {
    const direct = makeCorpsKeyFromParts(entry.corpsIdentifier, entry.corps);
    if (direct) {
      return direct;
    }
    const normalized = normalizeCorpsNameForLookup(entry.corps);
    if (entry.divisionName) {
      const bucket = divisionBuckets.get(entry.divisionName.toLowerCase());
      const resolved = bucket?.get(normalized);
      if (resolved) {
        return resolved;
      }
    }
    return (
      fallback.get(normalized) ??
      normalizeCorpsNameKey(entry.corps) ??
      normalized
    );
  };
};

export const persistSeasonRankings = (
  sql: SqlClient.SqlClient,
  season: string,
  timeline: SeasonRankingTimeline,
  dataset: SeasonDataset,
) =>
  Effect.gen(function* () {
    yield* clearSeasonRankingData(sql, season);
    if (timeline.snapshots.length === 0) {
      return;
    }
    const resolveCorpsKey = createRankingCorpsResolver(dataset);
    yield* Effect.forEach(
      timeline.snapshots,
      (snapshot, snapshotIndex) =>
        insertSeasonRankingSnapshotRow(
          sql,
          season,
          snapshotIndex,
          snapshot,
        ).pipe(
          Effect.andThen(
            Effect.forEach(
              Object.entries(snapshot.rankings) as ReadonlyArray<
                [string, RankingEntry[]]
              >,
              ([metric, entries]) =>
                Effect.forEach(entries, (entry, position) =>
                  insertSeasonRankingEntryRow(sql, {
                    season,
                    snapshotIndex,
                    metric,
                    position: position + 1,
                    entry,
                    corpsKey: resolveCorpsKey(entry),
                    competitionSlug: snapshot.competition.slug ?? null,
                  }),
                ),
            ),
          ),
        ),
      { concurrency: 1 },
    );
  });

export interface RelationalIngestOptions {
  readonly seasons?: ReadonlyArray<string>;
  readonly warm?: boolean;
  readonly seasonConcurrency?: number;
  readonly competitionConcurrency?: number;
  readonly scoreConcurrency?: number;
  readonly persistRankings?: boolean;
  readonly rankingOptions?: RankingOptions;
  readonly waybackCorpsPath?: string;
  readonly waybackEventsPath?: string;
  readonly includeWaybackEvents?: boolean;
}

const normalizeOptions = (options?: RelationalIngestOptions) => ({
  warm: options?.warm !== false,
  seasonConcurrency: options?.seasonConcurrency ?? 1,
  competitionConcurrency: options?.competitionConcurrency ?? 2,
  scoreConcurrency: options?.scoreConcurrency ?? 4,
  persistRankings: options?.persistRankings ?? true,
  rankingOptions: options?.rankingOptions,
});

export interface RelationalIngestResult {
  readonly seasons: number;
  readonly competitions: number;
  readonly recaps: number;
  readonly corpsScores: number;
  readonly judgeScores: number;
  readonly subcaptionScores: number;
}

const ingestCorpsScore = (
  sql: SqlClient.SqlClient,
  competition: Domain.Competition,
  score: Domain.CorpsScore,
  counters: IngestCounters,
  options: { scoreConcurrency: number },
) =>
  Effect.gen(function* () {
    const corpKey = yield* resolveCorpsKey(
      sql,
      score.groupName,
      score.orgGroupIdentifier,
    );
    if (!corpKey) {
      return;
    }

    yield* insertCorps(sql, corpKey, score);
    yield* insertCorpsScore(sql, competition, corpKey, score);
    yield* increment(counters.corpsScores);

    // Junction: Competition <-> Corps
    yield* sql`INSERT INTO competition_corps (competition_slug, corps_key) VALUES (${competition.slug}, ${corpKey}) ON CONFLICT DO NOTHING`.pipe(
      Effect.asVoid,
    );

    yield* Effect.forEach(
      score.categories,
      (category) =>
        Effect.gen(function* () {
          yield* insertCategoryScore(sql, competition.slug, corpKey, category);

          const captionsByName = new Map<string, Domain.JudgeCaption[]>();
          for (const judge of category.Captions ?? []) {
            const list = captionsByName.get(judge.Name) ?? [];
            list.push(judge);
            captionsByName.set(judge.Name, list);
          }

          for (const [captionName, judges] of captionsByName.entries()) {
            const totalScore = judges.reduce(
              (acc, j) => acc + Number(j.Score),
              0,
            );
            const avgScore = totalScore / judges.length;
            const first = judges[0]!;

            yield* insertCaptionScore(
              sql,
              competition.slug,
              corpKey,
              category.Name,
              captionName,
              first.Initials ?? null,
              avgScore,
              first.Rank,
            );

            for (const judge of judges) {
              const judgeId = makeJudgeId(judge);
              yield* insertJudge(sql, judgeId, judge);
              yield* insertJudgeAssignment(
                sql,
                competition.slug,
                captionName,
                judgeId,
                judge,
              );

              // Junction: Competition <-> Judge
              yield* sql`INSERT INTO competition_judges (competition_slug, judge_id) VALUES (${competition.slug}, ${judgeId}) ON CONFLICT DO NOTHING`.pipe(
                Effect.asVoid,
              );

              yield* insertJudgeScore(
                sql,
                competition.slug,
                corpKey,
                captionName,
                judgeId,
                judge,
              );
              yield* increment(counters.judgeScores);

              for (const breakdown of judge.Subcaptions ?? []) {
                yield* insertSubcaptionScore(
                  sql,
                  competition.slug,
                  corpKey,
                  captionName,
                  judgeId,
                  breakdown,
                );
                yield* increment(counters.subcaptionScores);
              }
            }
          }
        }),
      { concurrency: options.scoreConcurrency },
    );
  });

export interface WebsiteRecapIngestOptions {
  readonly scoreConcurrency?: number;
  readonly seasonMeta?: {
    readonly firstDate: Date | undefined;
    readonly lastDate: Date | undefined;
    readonly seasonLength: number;
  };
}

export interface WebsiteRecapIngestResult {
  readonly competitions: number;
  readonly recaps: number;
  readonly corpsScores: number;
}

export interface WebsiteRecapIngestPayload {
  readonly season: string;
  readonly competition: Domain.Competition;
  readonly scores: ReadonlyArray<Domain.CorpsScore>;
}

export const ingestWebsiteRecap = (
  sql: SqlClient.SqlClient,
  payload: WebsiteRecapIngestPayload,
  options: WebsiteRecapIngestOptions = {},
): Effect.Effect<WebsiteRecapIngestResult, unknown> =>
  Effect.gen(function* () {
    const counters = yield* makeCounters();
    const seasonMeta =
      options.seasonMeta ?? computeSeasonMeta([payload.competition]);
    const meta = deriveCompetitionMeta(payload.competition, seasonMeta);

    yield* insertCompetition(sql, payload.season, payload.competition, meta);
    yield* increment(counters.competitions);

    // Create the event-to-competition mapping so scores/recaps can be found
    // from either the event slug or the competition slug.
    const eventSlug = yield* lookupEventSlugForCompetition(
      sql,
      payload.competition,
    );
    if (eventSlug) {
      yield* upsertEventCompetitionMapping(
        sql,
        eventSlug,
        payload.competition.slug,
        "website-recap",
      );
    }

    if (payload.scores.length === 0) {
      return {
        competitions: yield* Ref.get(counters.competitions),
        recaps: yield* Ref.get(counters.recaps),
        corpsScores: yield* Ref.get(counters.corpsScores),
      };
    }

    yield* increment(counters.recaps);

    const scoreConcurrency = options.scoreConcurrency ?? 4;
    yield* Effect.forEach(
      payload.scores,
      (score) =>
        ingestCorpsScore(sql, payload.competition, score, counters, {
          scoreConcurrency,
        }),
      { concurrency: scoreConcurrency },
    );

    return {
      competitions: yield* Ref.get(counters.competitions),
      recaps: yield* Ref.get(counters.recaps),
      corpsScores: yield* Ref.get(counters.corpsScores),
    };
  });

const ingestCompetition = (
  api: DciApi,
  sql: SqlClient.SqlClient,
  competition: Domain.Competition,
  season: string,
  seasonMeta: SeasonMeta,
  counters: IngestCounters,
  options: ReturnType<typeof normalizeOptions>,
) =>
  Effect.gen(function* () {
    const slug = competition.slug;
    if (!slug) {
      return;
    }

    const meta = deriveCompetitionMeta(competition, seasonMeta);
    yield* insertCompetition(sql, season, competition, meta);
    yield* increment(counters.competitions);

    // Populate Group Types for Competition
    const eventSlug = yield* lookupEventSlugForCompetition(sql, competition);

    // Create the event-to-competition mapping so scores/recaps can be found
    // from either the event slug or the competition slug.
    if (eventSlug) {
      yield* upsertEventCompetitionMapping(sql, eventSlug, slug, "ingest");
    }

    for (const gt of competition.groupTypes ?? []) {
      yield* insertCompetitionType(sql, gt.competitionType);
      yield* insertGroupType(sql, gt);
      yield* insertCompetitionGroupType(sql, slug, String(gt.id));
      if (eventSlug) {
        yield* insertEventGroupType(sql, eventSlug, String(gt.id));
      }
    }

    if (!competition.recapReleased) {
      return;
    }

    const recap = yield* api.getCompetitionRecap(slug);
    if (!recap.length) {
      return;
    }

    yield* increment(counters.recaps);

    yield* Effect.forEach(
      recap,
      (score) => ingestCorpsScore(sql, competition, score, counters, options),
      { concurrency: options.scoreConcurrency },
    );
  });

const ingestSeason = (
  api: DciApi,
  sql: SqlClient.SqlClient,
  season: string,
  counters: IngestCounters,
  options: ReturnType<typeof normalizeOptions>,
) =>
  Effect.gen(function* () {
    const competitions = yield* api.getCompetitions(season);
    if (competitions.length === 0) {
      return;
    }
    yield* Effect.logInfo(
      `[Season ${season}] Found ${competitions.length} competitions. Starting ingestion...`,
    );

    const seasonMeta = computeSeasonMeta(competitions);

    yield* Effect.forEach(
      competitions,
      (competition) =>
        ingestCompetition(
          api,
          sql,
          competition,
          season,
          seasonMeta,
          counters,
          options,
        ),
      { concurrency: options.competitionConcurrency },
    );

    if (options.persistRankings) {
      const dataset = yield* buildSeasonDataset(season).pipe(
        Effect.provideService(DciApi, api),
      );
      const timeline = yield* buildSeasonRankings(
        season,
        dataset,
        options.rankingOptions,
      );
      yield* persistSeasonRankings(sql, season, timeline, dataset);
    }
  });

const upsertPageContent = (
  sql: SqlClient.SqlClient,
  content: Domain.PageContentEntry,
) =>
  sql`
    INSERT INTO page_content (url, background_image)
    VALUES (${content.url}, ${content.backgroundImage})
    ON CONFLICT (url) DO UPDATE SET
      background_image = excluded.background_image
  `;

const upsertPerformanceClass = (sql: SqlClient.SqlClient, name: string) =>
  sql`
    INSERT INTO performance_classes (name)
    VALUES (${name})
    ON CONFLICT (name) DO NOTHING
  `;

const determineEndpointType = (url: string): string => {
  if (url.includes("/competitions")) {
    if (url.includes("/seasons")) return "seasons";
    if (url.includes("season=")) return "competitions";
    return "recap";
  }
  if (url.includes("/corps")) return "corps";
  if (url.includes("/events")) return "events";
  if (url.includes("/galleries")) return "galleries";
  if (url.includes("/performances")) return "performances";
  if (url.includes("/page-content")) return "page-content";
  if (url.includes("/sponsors")) return "sponsors";
  if (url.includes("/past-champions")) return "past-champions";
  return "unknown";
};

export const ingestRelationalData = (options?: RelationalIngestOptions) =>
  Effect.gen(function* () {
    const baseApi = yield* DciApi;
    const sql = yield* SqlClient.SqlClient;

    const api = yield* makeDciApi({
      ...baseApi.config,
      onResponse: (url, body) => {
        const type = determineEndpointType(url);
        return insertApiResponse(sql, url, type, body).pipe(
          Effect.catch(() => Effect.void),
        );
      },
    });

    const normalized = normalizeOptions(options);

    const seasons = options?.seasons ?? (yield* api.getSeasons());

    yield* ensureRelationalSchema;

    const waybackCorpsPath =
      options?.waybackCorpsPath ??
      path.join("wayback", "wayback_dci_corps_contacts_complete.json");
    yield* Effect.tryPromise(() => fs.readFile(waybackCorpsPath, "utf-8")).pipe(
      Effect.flatMap((contents) => {
        const parsed = JSON.parse(contents) as
          | { corps?: unknown[] }
          | unknown[];
        const corps = Array.isArray(parsed) ? parsed : (parsed.corps ?? []);
        if (corps.length === 0) {
          return Effect.logInfo(
            `No wayback corps data found in ${waybackCorpsPath}.`,
          );
        }
        return ingestWaybackCorpsContacts(sql, corps).pipe(
          Effect.andThen(
            Effect.logInfo(
              `Ingested ${corps.length} wayback corps records from ${waybackCorpsPath}.`,
            ),
          ),
        );
      }),
      Effect.catch(() =>
        Effect.logInfo(
          `Skipping wayback corps ingest (missing or unreadable): ${waybackCorpsPath}`,
        ),
      ),
    );

    if (options?.includeWaybackEvents !== false) {
      const waybackEventsPath =
        options?.waybackEventsPath ??
        path.join("wayback", "wayback_dci_events_2013_2024.json");
      yield* Effect.tryPromise(() =>
        fs.readFile(waybackEventsPath, "utf-8"),
      ).pipe(
        Effect.flatMap((contents) => {
          const parsed = JSON.parse(contents) as
            | { events?: unknown[] }
            | unknown[];
          const events = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
          if (events.length === 0) {
            return Effect.logInfo(
              `No wayback events data found in ${waybackEventsPath}.`,
            );
          }
          return ingestWaybackEvents(sql, events, {
            endpointUrl: `file:${waybackEventsPath}`,
            responseJson: contents,
            recordCount: events.length,
          }).pipe(
            Effect.andThen(
              Effect.logInfo(
                `Ingested ${events.length} wayback events from ${waybackEventsPath}.`,
              ),
            ),
          );
        }),
        Effect.catch(() =>
          Effect.logInfo(
            `Skipping wayback events ingest (missing or unreadable): ${waybackEventsPath}`,
          ),
        ),
      );
    }

    yield* Effect.logInfo(
      "Ingesting auxiliary data (events, galleries, etc)...",
    );
    yield* Effect.all(
      [
        api.getCorps().pipe(
          Effect.flatMap((corps) =>
            Effect.forEach(corps, (c) => upsertCorpsProfile(sql, c), {
              concurrency: 5,
            }),
          ),
          Effect.catch((e) =>
            Effect.logError(`Failed to ingest corps profiles: ${String(e)}`),
          ),
        ),
        api.getPerformanceClasses().pipe(
          Effect.flatMap((classes) =>
            Effect.forEach(classes, (c) => upsertPerformanceClass(sql, c), {
              concurrency: 5,
            }),
          ),
          Effect.catch((e) =>
            Effect.logError(
              `Failed to ingest performance classes: ${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
        api.streamEvents().pipe(
          Stream.runForEach((evt) => upsertEvent(sql, evt)),
          Effect.catch((e) =>
            Effect.logError(
              `Failed to ingest events: ${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
        api.streamGalleries().pipe(
          Stream.runForEach((g) => upsertGallery(sql, g)),
          Effect.catch((e) =>
            Effect.logError(
              `Failed to ingest galleries: ${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
        api.getSponsors().pipe(
          Effect.flatMap((sponsors) =>
            Effect.forEach(sponsors, (s) => upsertSponsor(sql, s), {
              concurrency: 5,
            }),
          ),
          Effect.catch((e) =>
            Effect.logError(
              `Failed to ingest sponsors: ${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
        api.getPastChampions().pipe(
          Effect.flatMap((champions) =>
            Effect.forEach(champions, (c) => upsertPastChampion(sql, c), {
              concurrency: 5,
            }),
          ),
          Effect.catch((e) =>
            Effect.logError(`Failed to ingest past champions: ${String(e)}`),
          ),
        ),
        api.getPageContent().pipe(
          Effect.flatMap((content) =>
            Effect.forEach(content, (c) => upsertPageContent(sql, c), {
              concurrency: 5,
            }),
          ),
          Effect.catch((e) =>
            Effect.logError(`Failed to ingest page content: ${String(e)}`),
          ),
        ),
      ],
      { concurrency: 2, discard: true },
    );

    if (normalized.warm) {
      yield* scrapeAllData({
        seasons,
        includeEvents: true,
        warmInstructions: [
          { namespace: "performanceClasses" },
          { namespace: "eventCorps" },
          { namespace: "eventRegions" },
          { namespace: "eventStates" },
        ],
      }).pipe(Effect.provideService(DciApi, api));
    }

    const counters = yield* makeCounters();

    yield* Effect.forEach(
      seasons,
      (season) =>
        ingestSeason(api, sql, season, counters, normalized).pipe(
          Effect.catch((e) =>
            Effect.logError(
              `Failed to ingest season ${season}: ${JSON.stringify(e, null, 2)}`,
            ),
          ),
        ),
      { concurrency: normalized.seasonConcurrency },
    );

    const counts = yield* Effect.all({
      competitions: Ref.get(counters.competitions),
      recaps: Ref.get(counters.recaps),
      corpsScores: Ref.get(counters.corpsScores),
      judgeScores: Ref.get(counters.judgeScores),
      subcaptionScores: Ref.get(counters.subcaptionScores),
    });

    return {
      seasons: seasons.length,
      competitions: counts.competitions,
      recaps: counts.recaps,
      corpsScores: counts.corpsScores,
      judgeScores: counts.judgeScores,
      subcaptionScores: counts.subcaptionScores,
    };
  }).pipe(Effect.mapError((cause) => toDciError(cause, "relational.ingest")));
