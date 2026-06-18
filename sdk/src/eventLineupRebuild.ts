import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ensureRelationalSchema,
  upsertEventPageScrape,
  type EventPageLineupEntry,
  type EventPageTicketInfo,
  type EventPageScrape
} from "./relational.js";
import { firstExclusionMatch } from "./lineupClassification.js";

export interface EventLineupScrapeRow {
  readonly event_slug: string;
  readonly season: string | null;
  readonly scraped_at: string;
  readonly source_url: string | null;
  readonly event_name: string | null;
  readonly event_date_text: string | null;
  readonly location_text: string | null;
  readonly watch_live_link: string | null;
  readonly buy_tickets_link: string | null;
  readonly about_text: string | null;
  readonly about_html: string | null;
  readonly tickets_json: string | null;
  readonly lineup_json: string;
  readonly location_address: string | null;
  readonly location_google_map_link: string | null;
  readonly location_google_map_iframe: string | null;
  readonly location_images_json: string | null;
  readonly hero_image: string | null;
}

export interface EventLineupRebuildFilter {
  readonly season?: string;
  readonly slug?: string;
}

export interface EventLineupRebuildPlan {
  readonly scrape: EventLineupScrapeRow;
  readonly currentRows: number;
  readonly currentSourceScrapedAt: readonly string[];
  readonly targetRows: number;
  readonly contentMatches: boolean;
  readonly wouldChange: boolean;
  /** performance_order values that carry both a non-performance row (an encore /
   *  ceremony) and a performing row — the encore-duplicate signature. A clean
   *  single-scrape rebuild can never produce this, so a non-empty list means the
   *  derived table is polluted (stale sibling row) or the scrape itself is bad. */
  readonly orderCollisions: readonly number[];
}

// Detect the encore-duplicate signature: one performance_order shared by both a
// non-performance row and a performing row. (Two performing corps at the same
// order — a real, if rare, scheduling quirk — is intentionally NOT flagged.)
export const lineupOrderCollisions = (
  rows: ReadonlyArray<{ performance_order: number | null; is_non_performance: number }>
): readonly number[] => {
  const byOrder = new Map<number, { np: boolean; perf: boolean }>();
  for (const r of rows) {
    if (r.performance_order == null) continue;
    const seen = byOrder.get(r.performance_order) ?? { np: false, perf: false };
    if (r.is_non_performance) seen.np = true;
    else seen.perf = true;
    byOrder.set(r.performance_order, seen);
  }
  return [...byOrder.entries()].filter(([, v]) => v.np && v.perf).map(([order]) => order);
};

const parseJsonArray = (value: string | null | undefined): ReadonlyArray<unknown> => {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
};

export const latestEventLineupScrapes = (
  sql: SqlClient.SqlClient,
  filter: EventLineupRebuildFilter
) =>
  sql<EventLineupScrapeRow>`WITH ranked AS (
      SELECT eps.*, e.season,
        row_number() OVER (
          PARTITION BY eps.event_slug
          ORDER BY eps.scraped_at DESC
        ) AS scrape_rank
      FROM event_page_scrapes eps
      LEFT JOIN events e ON e.slug = eps.event_slug
      WHERE eps.lineup_json IS NOT NULL
        AND json_array_length(eps.lineup_json) > 0
        AND (${filter.slug ?? null} IS NULL OR eps.event_slug = ${filter.slug ?? null})
        AND (${filter.season ?? null} IS NULL OR e.season = ${filter.season ?? null})
    )
    SELECT *
    FROM ranked
    WHERE scrape_rank = 1
    ORDER BY scraped_at DESC`;

export const toEventPageScrape = (scrape: EventLineupScrapeRow): EventPageScrape => ({
  eventSlug: scrape.event_slug,
  eventDateText: scrape.event_date_text || undefined,
  eventName: scrape.event_name || undefined,
  locationText: scrape.location_text || undefined,
  watchLiveLink: scrape.watch_live_link || undefined,
  buyTicketsLink: scrape.buy_tickets_link || undefined,
  about: scrape.about_text || undefined,
  aboutHtml: scrape.about_html || undefined,
  tickets: parseJsonArray(scrape.tickets_json) as ReadonlyArray<EventPageTicketInfo>,
  lineup: parseJsonArray(scrape.lineup_json) as ReadonlyArray<EventPageLineupEntry>,
  locationAddress: scrape.location_address || undefined,
  locationGoogleMapLink: scrape.location_google_map_link || undefined,
  locationGoogleMapIframe: scrape.location_google_map_iframe || undefined,
  heroImage: scrape.hero_image || undefined,
  locationImages: parseJsonArray(scrape.location_images_json) as ReadonlyArray<string>,
  scrapedAt: scrape.scraped_at,
  sourceUrl: scrape.source_url || undefined
});

export const planEventLineupRebuild = (sql: SqlClient.SqlClient, scrape: EventLineupScrapeRow) =>
  Effect.gen(function* () {
    const currentLineup = yield* (
      sql<{
        lineup_index: number | null;
        performance_order: number | null;
        time: string | null;
        unit_name: string;
        is_non_performance: number;
        is_exhibition: number;
      }>`SELECT lineup_index, performance_order, time, unit_name, is_non_performance, is_exhibition
        FROM event_lineup_entries
        WHERE event_slug = ${scrape.event_slug}
        ORDER BY COALESCE(lineup_index, performance_order, 999), time, unit_name`
    );
    const currentSourceScrapedAt = yield* (
      sql<{ source_scraped_at: string | null }>`SELECT DISTINCT source_scraped_at
        FROM event_lineup_entries
        WHERE event_slug = ${scrape.event_slug}
        ORDER BY source_scraped_at`
    );
    const targetLineup = parseJsonArray(scrape.lineup_json)
      .map((entry, index) =>
        typeof entry === "object" &&
        entry != null &&
        typeof (entry as { corpsName?: unknown }).corpsName === "string" &&
        ((entry as { corpsName: string }).corpsName.trim().length > 0)
          ? (() => {
              const unitName = (entry as { corpsName: string }).corpsName.trim();
              const classification = firstExclusionMatch(unitName);
              const isNonCorps =
                classification?.category === "schedule_item" ||
                classification?.category === "not_a_corps";
              return {
                lineup_index: index,
                performance_order:
                  typeof (entry as { order?: unknown }).order === "number"
                    ? (entry as { order: number }).order
                    : null,
                time:
                  typeof (entry as { time?: unknown }).time === "string"
                    ? (entry as { time: string }).time
                    : null,
                unit_name: unitName,
                is_non_performance:
                  (entry as { isNonPerformance?: unknown }).isNonPerformance || isNonCorps ? 1 : 0,
                is_exhibition:
                  (entry as { isExhibition?: unknown }).isExhibition ||
                  classification?.category === "exhibition"
                    ? 1
                    : 0
              };
            })()
          : null
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
    const currentComparable = currentLineup.map((entry) => ({
      lineup_index: entry.lineup_index,
      performance_order: entry.performance_order,
      time: entry.time,
      unit_name: entry.unit_name,
      is_non_performance: entry.is_non_performance,
      is_exhibition: entry.is_exhibition
    }));
    const contentMatches = JSON.stringify(currentComparable) === JSON.stringify(targetLineup);
    const sources = currentSourceScrapedAt
      .map((row) => row.source_scraped_at)
      .filter((value): value is string => value != null);
    return {
      scrape,
      currentRows: currentLineup.length,
      currentSourceScrapedAt: sources,
      targetRows: targetLineup.length,
      contentMatches,
      wouldChange:
        currentLineup.length !== targetLineup.length ||
        !contentMatches ||
        sources.length !== 1 ||
        sources[0] !== scrape.scraped_at,
      orderCollisions: lineupOrderCollisions(currentLineup)
    } satisfies EventLineupRebuildPlan;
  });

export const rebuildEventLineupFromScrape = (sql: SqlClient.SqlClient, scrape: EventLineupScrapeRow) =>
  upsertEventPageScrape(sql, toEventPageScrape(scrape), { overwrite: true }).pipe(
    Effect.andThen(planEventLineupRebuild(sql, scrape)),
    Effect.flatMap((plan) =>
      plan.wouldChange || plan.orderCollisions.length > 0
        ? Effect.fail(
            new Error(
              `Lineup rebuild verification failed for ${scrape.event_slug}: ` +
                `${plan.currentRows} row(s), source(s) ${plan.currentSourceScrapedAt.join(", ")}` +
                (plan.orderCollisions.length > 0
                  ? `; encore-duplicate collision at performance_order ${plan.orderCollisions.join(", ")}`
                  : "")
            )
          )
        : Effect.succeed(plan)
    )
  );

export const rebuildLatestEventLineups = (
  sql: SqlClient.SqlClient,
  filter: EventLineupRebuildFilter,
  options: { readonly apply: boolean }
) =>
  Effect.gen(function* () {
    yield* (ensureRelationalSchema);
    const scrapes = yield* (latestEventLineupScrapes(sql, filter));
    const plans = yield* (Effect.forEach(scrapes, (scrape) => planEventLineupRebuild(sql, scrape)));

    if (!options.apply) {
      return { plans, applied: [] as readonly EventLineupRebuildPlan[] };
    }

    const applied = yield* (
      Effect.forEach(scrapes, (scrape) => rebuildEventLineupFromScrape(sql, scrape))
    );
    return { plans, applied };
  });
