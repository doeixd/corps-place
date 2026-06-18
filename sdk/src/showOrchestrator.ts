import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DcxScraper, DcxScraperLive, DCX_REPYEAR_URL } from "./showScraperDcx.js";
import type { DcxRepYearResult } from "./showScraperDcx.js";
import { ShowIngestion, ShowIngestionLive } from "./showIngestion.js";
import { ShowScraperAgent, buildShowFromAgent } from "./showScraperAgent.js";
import { FloMarchingScraper, buildShowFromFloMarching } from "./showScraperFlomarching.js";
import { DciOrgScraper } from "./showScraperDciOrg.js";
import { buildShowReport, formatReport } from "./showReport.js";
import type { DcxRepertoireEntry } from "./showScraperDcx.js";
import type { CorpsShow, ShowRepertoireEntry } from "./extraDomain.js";

// Pure function: normalize a corps name for fuzzy matching
export const normalizeCorpsName = (name: string): string => {
  let normalized = name
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "") // remove parentheticals like "(*Open Class Affiliate)"
    .replace(/"/g, "") // remove quotes
    .replace(/,/g, "") // remove commas
    .replace(/^the\s+/i, "") // remove leading "The"
    .replace(/\s+the\s*$/i, "") // remove trailing "The"
    .replace(/\s+(corps|drum|bugle|&|and)\s+/gi, " ")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  return normalized;
};

// Pure function: map DCX display name to our corps_key via lookup map
export const dcxNameToCorpsKey = (
  dcxName: string,
  corpsLookup: Map<string, string> // normalizedName -> corpsKey
): string | null => {
  const normalized = normalizeCorpsName(dcxName);
  return corpsLookup.get(normalized) ?? null;
};

// Pure function: generate show ID
export const makeShowId = (corpsKey: string, season: number) => `${corpsKey}_${season}`;

// Pure function: build a CorpsShow from DCX entry + matched corpsKey
export const buildShowFromDcx = (
  entry: DcxRepertoireEntry,
  corpsKey: string,
  season: number
): CorpsShow => {
  const showId = makeShowId(corpsKey, season);
  const repertoire: ShowRepertoireEntry[] = entry.songs.map(
    (song, index): ShowRepertoireEntry => ({
      entryId: `${showId}_song_${index}`,
      showId,
      workTitle: song,
      composer: null,
      arranger: null,
      description: null,
      hyperlink: null,
      relatedCorpsKey: null,
      notes: null,
      metadata: undefined,
    })
  );

  return {
    showId,
    corpsKey,
    corpsName: entry.dcxCorpsName,
    season: String(season),
    title: entry.showTitle ?? "(No title yet)",
    subtitle: null,
    description: null,
    premiereDate: null,
    venue: null,
    tagline: null,
    designerNotes: null,
    sourceUrl: "https://www.dcxmuseum.org/index.cfm?roomid=302&view=repertoires&option=current",
    tags: [],
    repertoire,
    media: [],
    designers: [],
    movements: [],
    reviews: [],
    metadata: {
      dcxCorpsId: entry.dcxCorpsId,
      divisionSection: entry.divisionSection,
      parsedAt: new Date().toISOString(),
    },
  };
};

// Pure: build a CorpsShow from a historical DCX RepYear result.
export const buildShowFromDcxHistory = (
  result: DcxRepYearResult,
  corpsKey: string,
  corpsName: string | null,
  corpsId: string,
  season: number
): CorpsShow => {
  const showId = makeShowId(corpsKey, season);
  const repertoire: ShowRepertoireEntry[] = result.repertoire.map(
    (song, index): ShowRepertoireEntry => ({
      entryId: `${showId}_song_${index}`,
      showId,
      workTitle: song.workTitle,
      composer: song.composer,
      arranger: null,
      description: null,
      hyperlink: null,
      relatedCorpsKey: null,
      notes: null,
      metadata: undefined,
    })
  );

  return {
    showId,
    corpsKey,
    corpsName,
    season: String(season),
    title: result.title ?? "(No title yet)",
    subtitle: null,
    description: null,
    premiereDate: null,
    venue: null,
    tagline: null,
    designerNotes: null,
    sourceUrl: DCX_REPYEAR_URL(corpsId, season),
    tags: [],
    repertoire,
    media: [],
    designers: [],
    movements: [],
    reviews: [],
    metadata: {
      dcxCorpsId: corpsId,
      finalPosition: result.position,
      finalScore: result.score,
      parsedAt: new Date().toISOString(),
    },
  };
};

export interface IngestionResult {
  readonly corpsKey: string;
  readonly corpsName: string;
  readonly showId: string | null;
  readonly title: string | null;
  readonly songCount: number;
  readonly error: string | null;
}

const makeShowOrchestrator = Effect.gen(function* () {
    const dcx = yield* DcxScraper;
    const ingest = yield* ShowIngestion;

    const runDcxIngestion = Effect.fn("ShowOrchestrator.runDcxIngestion")(
      function* (season: number) {
        yield* Effect.log("Starting DCX ingestion", { season });

        // Step 1: Build corps lookup map from DB
        const sql = yield* SqlClient.SqlClient;
        const allCorps = yield* sql<{ corps_key: string; name: string }>`
          SELECT corps_key, name FROM corps WHERE name IS NOT NULL
        `;
        const corpsLookup = new Map<string, string>();
        for (const c of allCorps) {
          corpsLookup.set(normalizeCorpsName(c.name), c.corps_key);
        }
        yield* Effect.log("Built corps lookup map", { size: corpsLookup.size });

        // Step 2: Scrape DCX (parallel, free)
        const dcxEntries = yield* dcx.scrapeAll();

        // Step 3: Map DCX names to corps_key (pure)
        const mappedEntries = dcxEntries
          .map((entry) => {
            const corpsKey = dcxNameToCorpsKey(entry.dcxCorpsName, corpsLookup);
            return { entry, corpsKey };
          })
          .filter((m): m is { entry: DcxRepertoireEntry; corpsKey: string } => m.corpsKey !== null);

        const unmatched = dcxEntries.filter(
          (e) => !dcxNameToCorpsKey(e.dcxCorpsName, corpsLookup)
        );
        if (unmatched.length > 0) {
          yield* Effect.logWarning("Unmatched DCX corps names", {
            count: unmatched.length,
            names: unmatched.map((e) => e.dcxCorpsName),
          });
        }

        yield* Effect.log("DCX name mapping complete", {
          total: dcxEntries.length,
          matched: mappedEntries.length,
          unmatched: unmatched.length,
        });

        // Step 3: Build shows and upsert (sequential DB writes)
        const results: IngestionResult[] = [];

        for (const { entry, corpsKey } of mappedEntries) {
          const show = buildShowFromDcx(entry, corpsKey, season);

        // Create show even if title is missing — agent can fill it later
        // But skip if there is absolutely no data (no title AND no songs)
        if (!entry.showTitle && entry.songs.length === 0) {
          yield* Effect.log("Skipping show with no data", {
            corpsKey,
            corpsName: entry.dcxCorpsName,
          });
          results.push({
            corpsKey,
            corpsName: entry.dcxCorpsName,
            showId: null,
            title: null,
            songCount: 0,
            error: "no_data",
          });
          continue;
        }

          yield* Effect.log("Upserting show", {
            corpsKey,
            title: show.title,
            songCount: show.repertoire.length,
          });

          yield* ingest.upsertShow(show);

          results.push({
            corpsKey,
            corpsName: entry.dcxCorpsName,
            showId: show.showId,
            title: show.title,
            songCount: show.repertoire.length,
            error: null,
          });
        }

        yield* Effect.log("DCX ingestion complete", {
          season,
          totalShows: results.filter((r) => r.showId !== null).length,
          totalSongs: results.reduce((sum, r) => sum + r.songCount, 0),
        });

        return results;
      }
    );

    /* ---------------------------------------------------------------- */
    /*  Historical backfill from DCX per-corps/per-year RepYear pages    */
    /* ---------------------------------------------------------------- */
    const runDcxHistoryIngestion = Effect.fn("ShowOrchestrator.runDcxHistoryIngestion")(
      function* (opts: {
        seasons: readonly number[];
        dryRun: boolean;
        refresh?: boolean;
      }) {
        const { seasons, dryRun } = opts;
        const refresh = opts.refresh ?? false;
        yield* Effect.log("Starting DCX history backfill", {
          seasons: `${seasons[0]}–${seasons[seasons.length - 1]}`,
          dryRun,
          refresh,
        });

        const sql = yield* SqlClient.SqlClient;

        // 1. corpsId → { corpsKey, corpsName } map.
        //    Seed from existing corps_shows metadata (dcxCorpsId, any season),
        //    then fuzzy-match the live DCX roster against the corps table.
        //    EXCLUDE the 'Individual' division: those 393 rows are soloists named
        //    "Person (Corps)", and normalizeCorpsName strips the parenthetical, so
        //    every one collides with its parent corps. DCX corpsids are corps, never
        //    individuals, so any corpsId→Individual mapping is always wrong.
        const corpsRows = yield* sql<{ corps_key: string; name: string | null }>`
          SELECT corps_key, name FROM corps
          WHERE name IS NOT NULL AND COALESCE(division_name, '') != 'Individual'
        `;
        const nameToKey = new Map<string, string>();
        const keyToName = new Map<string, string>();
        for (const c of corpsRows) {
          if (!c.name) continue;
          keyToName.set(c.corps_key, c.name);
          const norm = normalizeCorpsName(c.name);
          // Last-write-wins on exact-duplicate corps rows (a handful exist, e.g.
          // two "Southern Knights"); warn so the dup is visible.
          if (nameToKey.has(norm) && nameToKey.get(norm) !== c.corps_key) {
            yield* Effect.logWarning("Duplicate normalized corps name; last wins", {
              normalized: norm,
              keptPrev: nameToKey.get(norm),
              now: c.corps_key,
            });
          }
          nameToKey.set(norm, c.corps_key);
        }

        const idToCorps = new Map<string, { corpsKey: string; corpsName: string | null }>();
        const setMapping = function* (corpsId: string, corpsKey: string) {
          const existing = idToCorps.get(corpsId);
          if (existing && existing.corpsKey !== corpsKey) {
            yield* Effect.logWarning("corpsId maps to multiple corps_keys; keeping first", {
              corpsId,
              kept: existing.corpsKey,
              ignored: corpsKey,
            });
            return;
          }
          if (!existing) {
            idToCorps.set(corpsId, { corpsKey, corpsName: keyToName.get(corpsKey) ?? null });
          }
        };

        // Seed from stored metadata — only for keys that resolve to a real
        // (non-Individual) corps row, which drops the soloist collisions.
        const metaRows = yield* sql<{ corps_key: string; metadata_json: string | null }>`
          SELECT corps_key, metadata_json FROM corps_shows WHERE metadata_json LIKE '%dcxCorpsId%'
        `;
        for (const r of metaRows) {
          if (!r.metadata_json || !keyToName.has(r.corps_key)) continue;
          try {
            const id = (JSON.parse(r.metadata_json) as { dcxCorpsId?: string | null }).dcxCorpsId;
            if (id) yield* setMapping(String(id), r.corps_key);
          } catch {
            // ignore malformed metadata
          }
        }

        // Augment via the live DCX roster (fuzzy name match).
        const rosterEntries = yield* dcx.scrapeAll().pipe(
          Effect.catch((err) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("DCX roster fetch failed; using metadata map only", {
                error: String(err),
              });
              return [] as DcxRepertoireEntry[];
            })
          )
        );
        for (const entry of rosterEntries) {
          if (!entry.dcxCorpsId || idToCorps.has(entry.dcxCorpsId)) continue;
          const key = dcxNameToCorpsKey(entry.dcxCorpsName, nameToKey);
          if (key) yield* setMapping(entry.dcxCorpsId, key);
        }

        // Reverse-collision guard: two corpsIds resolving to the same corps_key
        // would fight over one show_id per season. Keep the first corpsId per key.
        const keyToId = new Map<string, string>();
        for (const [corpsId, { corpsKey }] of [...idToCorps]) {
          const firstId = keyToId.get(corpsKey);
          if (firstId === undefined) {
            keyToId.set(corpsKey, corpsId);
          } else {
            yield* Effect.logWarning("Multiple corpsIds map to one corps_key; dropping extra", {
              corpsKey,
              keptCorpsId: firstId,
              droppedCorpsId: corpsId,
            });
            idToCorps.delete(corpsId);
          }
        }

        yield* Effect.log("Built corpsId → corps_key map", { size: idToCorps.size });

        const summary = {
          mappedCorps: idToCorps.size,
          fetched: 0,
          available: 0,
          unavailable: 0,
          written: 0,
          heldExistingTitle: 0,
          errors: 0,
          skippedFresh: 0,
        };
        const found: {
          corpsKey: string;
          season: number;
          title: string | null;
          songs: number;
        }[] = [];

        for (const [corpsId, { corpsKey, corpsName }] of idToCorps) {
          for (const season of seasons) {
            const sourceUrl = DCX_REPYEAR_URL(corpsId, season);

            // skip-fresh: an archived scrape already exists (apply runs only)
            if (!refresh) {
              const existing = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM show_announcement_scrapes
                WHERE source_url = ${sourceUrl} AND source_type = 'dcx_repyear'
              `;
              if ((existing[0]?.n ?? 0) > 0) {
                summary.skippedFresh++;
                continue;
              }
            }

            const scraped = yield* dcx.scrapeRepYear(corpsId, season).pipe(
              Effect.match({
                onSuccess: (s) => s,
                onFailure: () => null,
              })
            );
            if (!scraped) {
              summary.errors++;
              continue;
            }
            summary.fetched++;
            // Polite pacing — this loop makes ~corps×years sequential requests.
            yield* Effect.sleep("300 millis");

            // Treat "no title AND no songs" as unavailable — don't write empty
            // placeholder rows (mirrors runDcxIngestion's no-data skip).
            const hasData =
              scraped.result.title !== null || scraped.result.repertoire.length > 0;
            if (!scraped.result.available || !hasData) {
              summary.unavailable++;
              continue;
            }
            summary.available++;
            found.push({
              corpsKey,
              season,
              title: scraped.result.title,
              songs: scraped.result.repertoire.length,
            });

            if (dryRun) continue;

            // Archive raw HTML first.
            yield* ingest.archiveScrape({
              corpsKey,
              sourceUrl,
              sourceType: "dcx_repyear",
              scrapedAt: Date.now(),
              rawHtml: scraped.html,
              parsedJson: JSON.stringify(scraped.result),
              httpStatus: scraped.httpStatus,
            });

            // Guard: never clobber a real (non-placeholder) title that came from
            // some OTHER source. We DO overwrite (a) placeholders and (b) our own
            // prior dcx_repyear writes — so --refresh can correct earlier backfills.
            const showId = makeShowId(corpsKey, season);
            const existingShow = yield* sql<{ title: string; source_url: string | null }>`
              SELECT title, source_url FROM corps_shows WHERE show_id = ${showId}
            `;
            const existingTitle = (existingShow[0]?.title ?? "").trim().toLowerCase();
            const isPlaceholder =
              existingTitle === "" ||
              existingTitle === "." ||
              existingTitle.startsWith(".") ||
              existingTitle.includes("no title yet") ||
              existingTitle.includes("repertoire not available");
            const isOwnPriorWrite = (existingShow[0]?.source_url ?? "").includes(
              "Corpslist_RepYear.cfm"
            );
            if (existingShow.length > 0 && !isPlaceholder && !isOwnPriorWrite) {
              summary.heldExistingTitle++;
              continue;
            }

            // Clear stale repertoire so a re-run with fewer songs leaves no orphans
            // (index-keyed entryIds otherwise persist beyond the new song count).
            yield* sql`DELETE FROM corps_show_repertoire WHERE show_id = ${showId}`;

            const show = buildShowFromDcxHistory(
              scraped.result,
              corpsKey,
              corpsName,
              corpsId,
              season
            );
            yield* ingest.upsertShow(show);
            summary.written++;
          }
        }

        yield* Effect.log("DCX history backfill complete", summary);
        return { summary, found };
      }
    );

    /* ---------------------------------------------------------------- */
    /*  Run Agent scraper on corps with placeholder titles               */
    /* ---------------------------------------------------------------- */
    const runAgentIngestion = Effect.fn("ShowOrchestrator.runAgentIngestion")(
      function* (season: number) {
        yield* Effect.log("Starting Agent gap-fill ingestion", { season });

        const sql = yield* SqlClient.SqlClient;
        const agent = yield* ShowScraperAgent;

        // Find corps with placeholder titles in DB
        const allShows = yield* sql<{
          corps_key: string;
          title: string;
          corps_name: string | null;
        }>`
          SELECT cs.corps_key, cs.title, c.name as corps_name
          FROM corps_shows cs
          LEFT JOIN corps c ON c.corps_key = cs.corps_key
          WHERE cs.season = ${String(season)}
        `;

        const placeholderShows = allShows.filter((s) => {
          const t = (s.title || "").trim().toLowerCase();
          return (
            t.includes("no title yet") ||
            t.includes("repertoire not available") ||
            t === "." ||
            t === "" ||
            t.startsWith(".")
          );
        });

        if (placeholderShows.length === 0) {
          yield* Effect.log("No placeholder shows found — agent gap-fill not needed");
          return { enriched: 0, failed: 0 };
        }

        yield* Effect.log("Found placeholder shows to enrich", {
          count: placeholderShows.length,
        });

        // Fetch all corps with URLs (filter in JS since SQLite IN array binding is limited)
        const allCorpsData = yield* sql<{
          corps_key: string;
          name: string;
          website: string | null;
          facebook: string | null;
          instagram: string | null;
          twitter: string | null;
        }>`
          SELECT corps_key, name, website, facebook, instagram, twitter
          FROM corps
          WHERE website IS NOT NULL OR facebook IS NOT NULL
        `;

        const corpsKeys = new Set(placeholderShows.map((s) => s.corps_key));
        const urlMap = new Map(
          allCorpsData
            .filter((c) => corpsKeys.has(c.corps_key))
            .map((c) => [
              c.corps_key,
              {
                website: c.website,
                facebook: c.facebook,
                instagram: c.instagram,
                twitter: c.twitter,
              },
            ])
        );

        const targets = placeholderShows
          .map((s) => ({
            corpsKey: s.corps_key,
            corpsName: s.corps_name || s.corps_key,
            season,
            urls: urlMap.get(s.corps_key) || {
              website: null,
              facebook: null,
              instagram: null,
              twitter: null,
            },
          }))
          .filter((t) => t.urls.website || t.urls.facebook); // Need at least one URL to start

        yield* Effect.log("Agent targets prepared", { count: targets.length });

        const batchResult = yield* agent.scrapeCorpsBatch(targets);

        // Ingest enriched shows
        let enrichedCount = 0;
        for (const scraped of batchResult.results) {
          const show = buildShowFromAgent(scraped);

          // Only overwrite if confidence is MEDIUM or HIGH
          if (scraped.confidence === "HIGH" || scraped.confidence === "MEDIUM") {
            yield* Effect.log("Agent enriching show", {
              corpsKey: show.corpsKey,
              title: show.title,
              confidence: scraped.confidence,
            });

            yield* ingest.upsertShow(show);

            if (scraped.designers.length > 0) {
              yield* ingest.upsertDesigners(show.showId, scraped.designers);
            }
            if (scraped.movements.length > 0) {
              yield* ingest.upsertMovements(show.showId, scraped.movements);
            }

            enrichedCount++;
          } else {
            yield* Effect.log("Agent found LOW confidence data — skipping ingestion", {
              corpsKey: show.corpsKey,
              title: show.title,
            });
          }

          // Always archive the scrape
          yield* ingest.archiveScrape({
            corpsKey: show.corpsKey,
            sourceUrl: scraped.sourceUrl,
            sourceType: `agent_${scraped.confidence.toLowerCase()}`,
            scrapedAt: Date.now(),
            rawHtml: null,
            parsedJson: JSON.stringify({
              title: scraped.title,
              description: scraped.description,
              designers: scraped.designers,
              movements: scraped.movements,
              confidence: scraped.confidence,
            }),
            httpStatus: 200,
          });
        }

        yield* Effect.log("Agent gap-fill complete", {
          season,
          enriched: enrichedCount,
          failed: batchResult.errors.length,
          totalAttempted: targets.length,
        });

        return { enriched: enrichedCount, failed: batchResult.errors.length };
      }
    );

    /* ---------------------------------------------------------------- */
    /*  Run FloMarching scraper on all corps                             */
    /* ---------------------------------------------------------------- */
    const runFloMarchingIngestion = Effect.fn("ShowOrchestrator.runFloMarchingIngestion")(
      function* (season: number) {
        yield* Effect.log("Starting FloMarching enrichment", { season });

        const sql = yield* SqlClient.SqlClient;
        const flo = yield* FloMarchingScraper;

        // Get all 2026 corps
        const corpsList = yield* sql<{
          corps_key: string;
          name: string;
        }>`
          SELECT DISTINCT c.corps_key, c.name
          FROM corps c
          JOIN event_participants ep ON c.corps_key = ep.corps_key
          JOIN events e ON e.event_id = ep.event_slug
          WHERE e.season = ${String(season)}
            AND ep.corps_key IS NOT NULL
          ORDER BY c.name
        `;

        let enrichedCount = 0;
        let paywallCount = 0;
        let errorCount = 0;

        // Sequential to control rate and cost
        for (const corps of corpsList) {
          const searchResult = yield* flo.searchForCorps(corps.name, season).pipe(
            Effect.match({
              onSuccess: (url) => url,
              onFailure: () => null,
            })
          );

          if (!searchResult) {
            yield* Effect.log("No FloMarching article found", {
              corpsKey: corps.corps_key,
            });
            continue;
          }

          const scraped = yield* flo
            .scrapeArticle(searchResult, corps.corps_key, corps.name, season)
            .pipe(
              Effect.match({
                onSuccess: (data) => data,
                onFailure: (err) => {
                  if (err && typeof err === "object" && "_tag" in err && err._tag === "FloMarchingPaywallError") {
                    paywallCount++;
                  } else {
                    errorCount++;
                  }
                  return null;
                },
              })
            );

          if (!scraped) {
            continue;
          }

          const show = buildShowFromFloMarching(scraped);

          yield* Effect.log("FloMarching enriching show", {
            corpsKey: corps.corps_key,
            title: show.title,
          });

          // Merge into existing show (upsert partial data)
          if (show.title) {
            yield* sql`UPDATE corps_shows SET title = ${show.title}, source_url = ${show.sourceUrl} WHERE show_id = ${show.showId}`;
          }
          if (show.description) {
            yield* sql`UPDATE corps_shows SET description = COALESCE(description, ${show.description}) WHERE show_id = ${show.showId}`;
          }

          if (scraped.designers.length > 0) {
            yield* ingest.upsertDesigners(show.showId!, scraped.designers);
          }
          if (scraped.media.length > 0) {
            yield* ingest.downloadMedia(scraped.media);
          }

          enrichedCount++;

          // Small delay between requests
          yield* Effect.sleep("1 second");
        }

        yield* Effect.log("FloMarching enrichment complete", {
          season,
          enriched: enrichedCount,
          paywalled: paywallCount,
          errors: errorCount,
        });

        return { enriched: enrichedCount, paywalled: paywallCount, errors: errorCount };
      }
    );

    // DCI.org scraper - currently Cloudflare-blocked, stub implementation
    const runDciOrgIngestion = Effect.fn("ShowOrchestrator.runDciOrgIngestion")(
      function* ({
        season,
      }: {
        season: number;
      }) {
        const dciOrg = yield* DciOrgScraper;

        yield* Effect.log("Starting DCI.org ingestion", { season });

        // scrapeNews already handles the Cloudflare block internally (returns []),
        // so its error channel is `never` — no catchTag needed here.
        const articles = yield* dciOrg.scrapeNews();

        yield* Effect.log("DCI.org news results", {
          articleCount: articles.length,
          note: "DCI.org is currently blocked by Cloudflare; this method will produce zero articles until Browserbase or similar integration is enabled",
        });

        return { articles: articles.length, ingested: 0 };
      }
    );

    // Generate coverage report
    const generateReport = Effect.fn("ShowOrchestrator.generateReport")(
      function* ({ season }: { season: number }) {
        const report = yield* buildShowReport(season);
        const text = formatReport(report);

        yield* Effect.log("Coverage report generated", {
          season: report.season,
          totalShows: report.totalShows,
          realTitles: report.realTitles,
          placeholderTitles: report.placeholderTitles,
          totalRepertoire: report.totalRepertoire,
        });

        return { report, text };
      }
    );

    return { runDcxIngestion, runDcxHistoryIngestion, runAgentIngestion, runFloMarchingIngestion, runDciOrgIngestion, generateReport };
});

export class ShowOrchestrator extends Context.Service<
  ShowOrchestrator,
  Effect.Success<typeof makeShowOrchestrator>
>()("ShowOrchestrator") {}

export const ShowOrchestratorLive = Layer.effect(
  ShowOrchestrator,
  makeShowOrchestrator
).pipe(Layer.provide([DcxScraperLive, ShowIngestionLive]));
