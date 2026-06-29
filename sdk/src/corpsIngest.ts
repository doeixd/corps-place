import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { matchExistingCorpsKey } from './relational.js';
import { parseCorpsDirectory, parseCorpsProfile, type DirectoryCorps } from './corpsParser.js';

/**
 * Ingest scraped corps data (M4).
 *
 * Operates over the *archived* parsed data in `corps_page_scrapes` (directory
 * roster + per-corps profiles) — no network. For each roster corps it resolves a
 * canonical `corps_key` (by slug, else alias/name-aware), then applies a
 * **coalescing** upsert: scraped non-null fields win, but a missing scraped field
 * never nulls out existing data. Class observations are logged to
 * `corps_class_history`. `dryRun` reports the planned changes without writing.
 */

// The corps columns we maintain from scraping, paired with the scraped value.
interface CorpsFields {
  division_name: string | null;
  about: string | null;
  website: string | null;
  facebook: string | null;
  twitter: string | null;
  instagram: string | null;
  youtube: string | null;
  linked_in: string | null;
  phone: string | null;
  primary_email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  display_city: string | null;
  corps_logo: string | null;
  corps_photo: string | null;
  cover_image: string | null;
  corps_mmdl_link_audio: string | null;
  corps_mmdl_link_video: string | null;
  meta_description: string | null;
}

const FIELD_KEYS = [
  'division_name',
  'about',
  'website',
  'facebook',
  'twitter',
  'instagram',
  'youtube',
  'linked_in',
  'phone',
  'primary_email',
  'address',
  'city',
  'state',
  'display_city',
  'corps_logo',
  'corps_photo',
  'cover_image',
  'corps_mmdl_link_audio',
  'corps_mmdl_link_video',
  'meta_description',
] as const;

export interface CorpsFieldChange {
  readonly slug: string;
  readonly corpsKey: string;
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
  /** `fill` = existing was null/empty (safe). `overwrite` = replacing a real value. */
  readonly kind: 'fill' | 'overwrite';
}

export interface CorpsIngestSummary {
  readonly rosterCount: number;
  readonly matched: number;
  readonly unresolved: readonly string[];
  /** Changes that will be written (fills + safe overwrites). */
  readonly changes: readonly CorpsFieldChange[];
  readonly classChanges: readonly CorpsFieldChange[];
  /** Proposed overwrites withheld by guardrails (garbage values / non-enrichment address). */
  readonly held: readonly CorpsFieldChange[];
  readonly dryRun: boolean;
}

// Reject obviously-placeholder scraped values (e.g. an address from a profile
// with a blank contact card: "--- Renton WA, 00000").
const isGarbage = (value: string): boolean =>
  /^[\s\-,]*$/.test(value) || /(^|\s)-{2,}(\s|$)/.test(value) || /\b00000\b/.test(value);

// Decide whether a proposed change is safe to write now.
//  - drop garbage
//  - fill when existing is empty
//  - address: only overwrite when it's an *enrichment* (contains the old value),
//    so a detailed mailing address isn't replaced by a shorter/different one
//  - everything else (incl. hometown/city/state — DCI is authoritative for the
//    displayed location, and stored values can be stale/wrong): write
const decideWrite = (field: string, next: string, cur: string | null): 'write' | 'hold' => {
  if (isGarbage(next)) return 'hold';
  if (cur == null || cur === '') return 'write';
  if (field === 'address' && !next.includes(cur)) return 'hold';
  return 'write';
};

const latestParsed = (sql: SqlClient.SqlClient, slug: string) =>
  sql<{ parsed_json: string | null }>`
    SELECT parsed_json FROM corps_page_scrapes
    WHERE corps_slug = ${slug} AND parsed_json IS NOT NULL
    ORDER BY scraped_at DESC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.parsed_json ?? null));

// Build the scraped field set for one corps from its roster entry + profile.
const fieldsFor = (
  roster: DirectoryCorps,
  profile: ReturnType<typeof parseCorpsProfile> | null
): CorpsFields => ({
  division_name: roster.division || null,
  about: profile?.about ?? null,
  website: profile?.website ?? null,
  facebook: profile?.facebook ?? null,
  twitter: profile?.twitter ?? null,
  instagram: profile?.instagram ?? null,
  youtube: profile?.youtube ?? null,
  linked_in: profile?.linkedIn ?? null,
  phone: profile?.phone ?? null,
  primary_email: profile?.email ?? null,
  address: profile?.address ?? null,
  city: profile?.city ?? null,
  state: profile?.state ?? null,
  display_city: profile?.hometown ?? null,
  corps_logo: roster.logo ?? profile?.logo ?? null,
  corps_photo: profile?.coverImage ?? null,
  cover_image: profile?.coverImage ?? null,
  corps_mmdl_link_audio: profile?.mmdlAudio ?? null,
  corps_mmdl_link_video: profile?.mmdlVideo ?? null,
  meta_description: profile?.metaDescription ?? null,
});

export const ingestCorps = (options: {
  readonly dryRun: boolean;
  /**
   * Fill-only by default: when false (the default), the ingest never overwrites a
   * field that already has a value — every such overwrite is recorded as `held`
   * for review instead of written. Set true (CLI `--allow-overwrite`) to apply
   * overwrites. Guards curated data from being clobbered (2026-06-28 incident).
   */
  readonly allowOverwrite?: boolean;
}): Effect.Effect<CorpsIngestSummary, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const observedAt = new Date().toISOString();

    const dirJson = yield* (latestParsed(sql, '__directory__'));
    const roster = dirJson
      ? (JSON.parse(dirJson) as ReturnType<typeof parseCorpsDirectory>)
      : { classes: [], corps: [] };

    const changes: CorpsFieldChange[] = [];
    const classChanges: CorpsFieldChange[] = [];
    const held: CorpsFieldChange[] = [];
    const unresolved: string[] = [];
    let matched = 0;

    for (const corps of roster.corps) {
      // Resolve a canonical corps_key: exact slug first, then alias/name-aware.
      const bySlug = yield* (
        sql<{
          corps_key: string;
        }>`SELECT corps_key FROM corps WHERE slug = ${corps.slug} LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.corps_key)
        )
      );
      const corpsKey = bySlug ?? (yield* (matchExistingCorpsKey(sql, { name: corps.name })));
      if (!corpsKey) {
        unresolved.push(corps.slug);
        continue;
      }
      matched++;

      const profJson = yield* (latestParsed(sql, corps.slug));
      const profile = profJson
        ? (JSON.parse(profJson) as ReturnType<typeof parseCorpsProfile>)
        : null;
      const fields = fieldsFor(corps, profile);

      const existing = yield* (
        sql<
          Record<string, string | null>
        >`SELECT * FROM corps WHERE corps_key = ${corpsKey} LIMIT 1`.pipe(
          Effect.map((rows) => rows[0] ?? {})
        )
      );

      // Compute the value to write per field (held fields keep the existing
      // value), recording applied changes vs guardrail-held ones.
      const write: CorpsFields = { ...fields };
      for (const key of FIELD_KEYS) {
        const next = fields[key];
        const cur = existing[key] ?? null;
        if (next == null || next === cur) {
          write[key] = cur;
          continue;
        }
        const kind: 'fill' | 'overwrite' = cur == null || cur === '' ? 'fill' : 'overwrite';
        const change = { slug: corps.slug, corpsKey, field: key, from: cur, to: next, kind };
        // Fill-only by default: an overwrite of an existing value is held unless
        // explicitly allowed. Fills (empty → value) always go through the
        // garbage/enrichment guardrails in decideWrite.
        const allowed = kind === 'fill' || options.allowOverwrite === true;
        if (allowed && decideWrite(key, next, cur) === 'write') {
          write[key] = next;
          changes.push(change);
          if (key === 'division_name') classChanges.push(change);
        } else {
          write[key] = cur; // keep existing — held for review (fill-only / guardrail)
          held.push(change);
        }
      }

      if (!options.dryRun) {
        yield* (
          sql`
            UPDATE corps SET
              division_name = ${write.division_name},
              about = ${write.about},
              website = ${write.website},
              facebook = ${write.facebook},
              twitter = ${write.twitter},
              instagram = ${write.instagram},
              youtube = ${write.youtube},
              linked_in = ${write.linked_in},
              phone = ${write.phone},
              primary_email = ${write.primary_email},
              address = ${write.address},
              city = ${write.city},
              state = ${write.state},
              display_city = ${write.display_city},
              corps_logo = ${write.corps_logo},
              corps_photo = ${write.corps_photo},
              cover_image = ${write.cover_image},
              corps_mmdl_link_audio = ${write.corps_mmdl_link_audio},
              corps_mmdl_link_video = ${write.corps_mmdl_link_video},
              meta_description = ${write.meta_description}
            WHERE corps_key = ${corpsKey}
          `.pipe(Effect.asVoid)
        );
        yield* (
          sql`
            INSERT INTO corps_class_history (corps_key, observed_at, division_name, source_slug)
            VALUES (${corpsKey}, ${observedAt}, ${fields.division_name}, ${corps.slug})
            ON CONFLICT(corps_key, observed_at) DO UPDATE SET
              division_name = excluded.division_name, source_slug = excluded.source_slug
          `.pipe(Effect.asVoid)
        );
      }
    }

    return {
      rosterCount: roster.corps.length,
      matched,
      unresolved,
      changes,
      classChanges,
      held,
      dryRun: options.dryRun,
    };
  });

/* ------------------------------------------------------------------ */
/*  Discovered-corps ingest (lineup-discovery plan, M3 ladder + M4)    */
/* ------------------------------------------------------------------ */

export type DivisionSource = 'directory' | 'profile-text' | 'db' | null;

/**
 * Class-authority precedence ladder (plan §4.4): DCI directory (current) →
 * profile-text (incl. SoundSport-from-description) → [cached API — TODO, dead
 * endpoint] → existing db value. First non-null wins; never nulls out. Returns
 * the chosen division and its source for `corps_class_history`.
 */
export const resolveDivision = (opts: {
  readonly rosterDivision?: string | null;
  readonly profileText?: string | null;
  readonly existing?: string | null;
}): { division: string | null; source: DivisionSource } => {
  if (opts.rosterDivision) return { division: opts.rosterDivision, source: 'directory' };
  if (opts.profileText) return { division: opts.profileText, source: 'profile-text' };
  if (opts.existing) return { division: opts.existing, source: 'db' };
  return { division: null, source: null };
};

// One discovered corps to ingest: its resolved key + the slug whose profile was
// archived, plus the text-derived class and favicon from the discovery phase.
export interface DiscoveredCorpsInput {
  readonly unitName: string;
  readonly corpsKey: string;
  readonly slug: string;
  readonly textDivision?: string | null;
  readonly favicon?: string | null;
}

export interface DiscoveredIngestSummary {
  readonly considered: number;
  readonly changes: readonly CorpsFieldChange[];
  readonly classObservations: readonly { corpsKey: string; division: string | null; source: DivisionSource }[];
  readonly held: readonly CorpsFieldChange[];
  readonly dryRun: boolean;
}

// Profile-field keys reused for discovered corps (division + logo handled
// specially, so excluded from the generic coalescing loop).
const DISCOVERED_PROFILE_KEYS = FIELD_KEYS.filter(
  (k) => k !== 'division_name' && k !== 'corps_logo'
) as ReadonlyArray<Exclude<(typeof FIELD_KEYS)[number], 'division_name' | 'corps_logo'>>;

/**
 * Ingest corps found via lineup discovery (not on the directory roster). Reads
 * each corps' archived profile, coalescing-upserts its fields (same guardrails as
 * the roster ingest), with two discovery-specific rules:
 *  - **division**: via `resolveDivision`; written only as a *fill* (existing
 *    empty). A differing existing division is *held* for review, not downgraded.
 *  - **logo**: a real DCI logo writes normally; a **favicon** is fill-only.
 * Every class observation is logged to `corps_class_history` with its source.
 * Also adopts the discovered DCI `slug` (fill-only) so future runs see the
 * profile scrape and skip re-probing.
 */
export const ingestDiscoveredCorps = (options: {
  readonly discovered: readonly DiscoveredCorpsInput[];
  readonly dryRun: boolean;
  /** Fill-only by default (mirrors ingestCorps): existing values are held, not
   * overwritten, unless explicitly allowed. Guards curated data (2026-06-28). */
  readonly allowOverwrite?: boolean;
}): Effect.Effect<DiscoveredIngestSummary, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const observedAt = new Date().toISOString();
    const changes: CorpsFieldChange[] = [];
    const held: CorpsFieldChange[] = [];
    const classObservations: { corpsKey: string; division: string | null; source: DivisionSource }[] =
      [];

    for (const d of options.discovered) {
      const profJson = yield* (latestParsed(sql, d.slug));
      const profile = profJson
        ? (JSON.parse(profJson) as ReturnType<typeof parseCorpsProfile>)
        : null;
      const existing = yield* (
        sql<Record<string, string | null>>`
          SELECT * FROM corps WHERE corps_key = ${d.corpsKey} LIMIT 1
        `.pipe(Effect.map((rows) => rows[0] ?? {}))
      );

      // --- division (ladder, fill-or-hold) ---
      const { division, source } = resolveDivision({
        profileText: d.textDivision,
        existing: existing.division_name ?? null,
      });
      classObservations.push({ corpsKey: d.corpsKey, division, source });
      let writeDivision = existing.division_name ?? null;
      if (division && division !== (existing.division_name ?? null)) {
        const change: CorpsFieldChange = {
          slug: d.slug,
          corpsKey: d.corpsKey,
          field: 'division_name',
          from: existing.division_name ?? null,
          to: division,
          kind: existing.division_name ? 'overwrite' : 'fill',
        };
        if (!existing.division_name) {
          writeDivision = division;
          changes.push(change);
        } else {
          held.push(change); // don't silently downgrade a curated class
        }
      }

      // --- logo (real DCI logo writes; favicon fill-only) ---
      const curLogo = existing.corps_logo ?? null;
      let writeLogo = curLogo;
      const realLogo = profile?.logo ?? null;
      if (realLogo && realLogo !== curLogo && !isGarbage(realLogo)) {
        const logoChange: CorpsFieldChange = {
          slug: d.slug,
          corpsKey: d.corpsKey,
          field: 'corps_logo',
          from: curLogo,
          to: realLogo,
          kind: curLogo ? 'overwrite' : 'fill',
        };
        // Fill-only: never replace a curated logo unless explicitly allowed.
        if (!curLogo || options.allowOverwrite === true) {
          changes.push(logoChange);
          writeLogo = realLogo;
        } else {
          held.push(logoChange);
        }
      } else if (!realLogo && d.favicon && !curLogo) {
        changes.push({
          slug: d.slug,
          corpsKey: d.corpsKey,
          field: 'corps_logo',
          from: null,
          to: d.favicon,
          kind: 'fill',
        });
        writeLogo = d.favicon;
      }

      // --- other profile fields (generic coalescing + guardrails) ---
      const scraped: Record<string, string | null> = {
        about: profile?.about ?? null,
        website: profile?.website ?? null,
        facebook: profile?.facebook ?? null,
        twitter: profile?.twitter ?? null,
        instagram: profile?.instagram ?? null,
        youtube: profile?.youtube ?? null,
        linked_in: profile?.linkedIn ?? null,
        phone: profile?.phone ?? null,
        primary_email: profile?.email ?? null,
        address: profile?.address ?? null,
        city: profile?.city ?? null,
        state: profile?.state ?? null,
        display_city: profile?.hometown ?? null,
        corps_photo: profile?.coverImage ?? null,
        cover_image: profile?.coverImage ?? null,
        corps_mmdl_link_audio: profile?.mmdlAudio ?? null,
        corps_mmdl_link_video: profile?.mmdlVideo ?? null,
        meta_description: profile?.metaDescription ?? null,
      };
      const write: Record<string, string | null> = {};
      for (const key of DISCOVERED_PROFILE_KEYS) {
        const next = scraped[key] ?? null;
        const cur = existing[key] ?? null;
        if (next == null || next === cur) {
          write[key] = cur;
          continue;
        }
        const change: CorpsFieldChange = {
          slug: d.slug,
          corpsKey: d.corpsKey,
          field: key,
          from: cur,
          to: next,
          kind: cur == null || cur === '' ? 'fill' : 'overwrite',
        };
        const allowed = change.kind === 'fill' || options.allowOverwrite === true;
        if (allowed && decideWrite(key, next, cur) === 'write') {
          write[key] = next;
          changes.push(change);
        } else {
          write[key] = cur;
          held.push(change);
        }
      }

      // adopt the discovered DCI slug (fill-only) so future runs find the scrape
      const curSlug = existing.slug ?? null;
      const writeSlug = curSlug && curSlug !== d.slug ? curSlug : d.slug;
      if (writeSlug !== curSlug) {
        changes.push({
          slug: d.slug,
          corpsKey: d.corpsKey,
          field: 'slug',
          from: curSlug,
          to: writeSlug,
          kind: curSlug ? 'overwrite' : 'fill',
        });
      }

      if (!options.dryRun) {
        yield* (
          sql`
            UPDATE corps SET
              slug = ${writeSlug},
              division_name = ${writeDivision},
              corps_logo = ${writeLogo},
              about = ${write.about},
              website = ${write.website},
              facebook = ${write.facebook},
              twitter = ${write.twitter},
              instagram = ${write.instagram},
              youtube = ${write.youtube},
              linked_in = ${write.linked_in},
              phone = ${write.phone},
              primary_email = ${write.primary_email},
              address = ${write.address},
              city = ${write.city},
              state = ${write.state},
              display_city = ${write.display_city},
              corps_photo = ${write.corps_photo},
              cover_image = ${write.cover_image},
              corps_mmdl_link_audio = ${write.corps_mmdl_link_audio},
              corps_mmdl_link_video = ${write.corps_mmdl_link_video},
              meta_description = ${write.meta_description}
            WHERE corps_key = ${d.corpsKey}
          `.pipe(Effect.asVoid)
        );
        if (division) {
          yield* (
            sql`
              INSERT INTO corps_class_history (corps_key, observed_at, division_name, source_slug)
              VALUES (${d.corpsKey}, ${observedAt}, ${division}, ${`discovery:${source}`})
              ON CONFLICT(corps_key, observed_at) DO UPDATE SET
                division_name = excluded.division_name, source_slug = excluded.source_slug
            `.pipe(Effect.asVoid)
          );
        }
      }
    }

    return {
      considered: options.discovered.length,
      changes,
      classObservations,
      held,
      dryRun: options.dryRun,
    };
  });
