/**
 * DCX Museum full-site scraper — CLI orchestrator.
 *
 * Writes a standalone, queryable mirror of dcxmuseum.org into `dcx.db`.
 * Driven by a durable, restart-safe work queue (see sdk/src/dcxScrape/dcxQueue.ts):
 * kill the process at any point and just relaunch — it resumes from the queue.
 *
 * Usage:
 *   npx tsx scripts/scrapeDcx.ts --init            # create schema
 *   npx tsx scripts/scrapeDcx.ts --status          # print queue counts
 *   npx tsx scripts/scrapeDcx.ts --reset           # requeue failed tasks
 *   npx tsx scripts/scrapeDcx.ts --rooms corps --concurrency 2   # (M2+) run
 *
 * Flags:
 *   --db <path>           default ./dcx.db
 *   --rooms a,b,c         which room families to scrape (default: all)
 *   --ids 17,34           limit to specific corps ids
 *   --limit N             cap enqueued detail tasks (testing)
 *   --concurrency N       worker fibers (default 2 — be polite)
 */
import { Effect, Layer } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import {
  initSchema,
  upsertCorpsDetail,
  upsertAssetGallery,
  upsertShows,
  upsertBiographies,
  upsertHofPage,
  upsertRepYear,
  upsertPhotoGroups,
} from "../src/dcxScrape/dcxDb.js";
import { DcxQueue, DcxQueueLive } from "../src/dcxScrape/dcxQueue.js";
import { DcxClient, DcxClientLive } from "../src/dcxScrape/dcxClient.js";
import { parseCorpsDetail } from "../src/dcxScrape/parseCorps.js";
import { parseAssetGallery, parseAssetPageChunks } from "../src/dcxScrape/parseAssets.js";
import { parsePhotoRoom } from "../src/dcxScrape/parsePhotos.js";
import { parseShowsByYear } from "../src/dcxScrape/parseShows.js";
import {
  parseBiographies,
  parseHallOfFameIndex,
  parseHofPage,
} from "../src/dcxScrape/parsePeople.js";
import {
  parseRepYearHtml,
  DCX_REPYEAR_URL,
} from "../src/showScraperDcx.js";
import {
  ASSET_ROOMS,
  ASSET_ROOM_CFM_URL,
  ASSET_DISPLAY_URL,
  PHOTO_ROOMS,
  PHOTO_ROOM_URL,
  BIOGRAPHIES_URL,
  CORPS_DETAIL_URL,
  CORPS_LIST_URL,
  HOF_INDEX_URL,
  HOF_PAGE_URL,
  SHOWS_BYYEAR_URL,
  parseCorpsIds,
} from "../src/dcxScrape/enumerate.js";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const val = (flag: string, dflt?: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const dbPath = val("--db", "./dcx.db")!;
const concurrency = Number(val("--concurrency", "2"));

const program = Effect.gen(function* () {
  const queue = yield* DcxQueue;

  if (has("--init")) {
    yield* initSchema();
    yield* Effect.log("Initialized", { db: dbPath });
    return;
  }

  // Always (re)create schema + reclaim crashed leases before any run/status.
  yield* initSchema();
  yield* queue.reclaimExpired();

  if (has("--reset")) {
    yield* queue.resetFailed();
    yield* Effect.log("Requeued failed tasks");
  }

  yield* Effect.log("Queue status (before run)", { ...(yield* queue.counts()) });

  if (has("--status")) return;

  const client = yield* DcxClient;
  const allRooms = ["corps", "assets", "photos", "shows", "people", "hof"];
  const roomsArg = val("--rooms", "all") ?? "all";
  const rooms = roomsArg === "all" ? allRooms : roomsArg.split(",").map((s) => s.trim());
  const limit = val("--limit") ? Number(val("--limit")) : undefined;
  const explicitIds = val("--ids")?.split(",").map((s) => s.trim());
  // Per-year RepYear backfill is huge (corps × decades); opt-in.
  const withRepYear = has("--repyear");

  // ── Enqueue top-level tasks ─────────────────────────────────────────────────
  if (rooms.includes("corps")) {
    let ids: string[];
    if (explicitIds && explicitIds.length > 0) {
      ids = explicitIds;
    } else {
      yield* Effect.log("Enumerating corps ids…");
      const list = yield* client.fetchText(CORPS_LIST_URL("all"));
      ids = parseCorpsIds(list.html);
      yield* Effect.log("Enumerated corps", { count: ids.length });
    }
    if (limit) ids = ids.slice(0, limit);
    yield* queue.enqueueMany(
      ids.map((id) => ({ taskKey: `corps:${id}`, taskType: "corps", params: { id, withRepYear } })),
    );
  }
  if (rooms.includes("assets")) {
    yield* queue.enqueueMany(
      ASSET_ROOMS.map((r) => ({
        taskKey: `asset-room:${r.option}`,
        taskType: "asset-room",
        params: r,
        priority: 50,
      })),
    );
  }
  if (rooms.includes("photos")) {
    yield* queue.enqueueMany(
      PHOTO_ROOMS.map((r) => ({
        taskKey: `photo-room:${r.option}`,
        taskType: "photo-room",
        params: r,
        priority: 50,
      })),
    );
  }
  if (rooms.includes("shows")) {
    yield* queue.enqueue({ taskKey: "shows:byyear", taskType: "shows", params: {}, priority: 50 });
  }
  if (rooms.includes("people")) {
    yield* queue.enqueue({ taskKey: "people:bios", taskType: "bios", params: {}, priority: 50 });
  }
  if (rooms.includes("hof")) {
    yield* queue.enqueue({ taskKey: "hof:index", taskType: "hof-index", params: {}, priority: 10 });
  }

  yield* Effect.log("Queue status (after enqueue)", { ...(yield* queue.counts()) });

  // ── Handler (dispatch by task type) ─────────────────────────────────────────
  const handle = (task: { taskType: string; params: unknown }) =>
    Effect.gen(function* () {
      const p = task.params as Record<string, unknown>;
      switch (task.taskType) {
        case "corps": {
          const id = String(p.id);
          const url = CORPS_DETAIL_URL(id);
          const { html } = yield* client.fetchText(url);
          const detail = parseCorpsDetail(html, id);
          if (!detail.name && detail.repertoire.length === 0 && detail.members.length === 0) {
            return "empty" as const;
          }
          yield* upsertCorpsDetail(detail, url);
          // Item 3: fan out per-year RepYear backfill tasks for this corps.
          if (p.withRepYear) {
            const years = Array.from(new Set(detail.scores.map((s) => s.year).filter((y): y is number => y != null)));
            yield* queue.enqueueMany(
              years.map((y) => ({
                taskKey: `repyear:${id}:${y}`,
                taskType: "repyear",
                params: { id, year: y },
                priority: 200,
              })),
            );
          }
          return "done" as const;
        }
        case "repyear": {
          const id = String(p.id);
          const year = Number(p.year);
          const url = DCX_REPYEAR_URL(id, year);
          const { html } = yield* client.fetchText(url);
          const r = parseRepYearHtml(html);
          if (!r.available) return "empty" as const;
          yield* upsertRepYear(id, year, r.title, r.position, r.score, r.repertoire, url);
          return "done" as const;
        }
        case "asset-room": {
          // Discover all gallery pages, then fan out one durable task per page.
          const { roomid, option } = p as { roomid: number; option: string };
          const url = ASSET_ROOM_CFM_URL(roomid, option);
          const { html } = yield* client.fetchText(url);
          const chunks = parseAssetPageChunks(html);
          if (chunks.length === 0) return "empty" as const;
          yield* queue.enqueueMany(
            chunks.map((assetlist, page) => ({
              taskKey: `asset-page:${option}:${page}`,
              taskType: "asset-page",
              params: { roomid, option, assetlist },
              priority: 60,
            })),
          );
          return "done" as const;
        }
        case "asset-page": {
          const { roomid, option, assetlist } = p as {
            roomid: number;
            option: string;
            assetlist: string;
          };
          const url = ASSET_DISPLAY_URL(roomid, option, assetlist);
          const { html } = yield* client.fetchText(url);
          const items = parseAssetGallery(html);
          if (items.length === 0) return "empty" as const;
          yield* upsertAssetGallery(items, option, url);
          return "done" as const;
        }
        case "photo-room": {
          const { roomid, option } = p as { roomid: number; option: string };
          const url = PHOTO_ROOM_URL(roomid, option);
          const { html } = yield* client.fetchText(url);
          const groups = parsePhotoRoom(html);
          if (groups.length === 0) return "empty" as const;
          yield* upsertPhotoGroups(groups, option, url);
          return "done" as const;
        }
        case "shows": {
          const { html } = yield* client.fetchText(SHOWS_BYYEAR_URL);
          const shows = parseShowsByYear(html);
          if (shows.length === 0) return "empty" as const;
          yield* upsertShows(shows, SHOWS_BYYEAR_URL);
          return "done" as const;
        }
        case "bios": {
          const { html } = yield* client.fetchText(BIOGRAPHIES_URL);
          const bios = parseBiographies(html);
          if (bios.length === 0) return "empty" as const;
          yield* upsertBiographies(bios, BIOGRAPHIES_URL);
          return "done" as const;
        }
        case "hof-index": {
          const { html } = yield* client.fetchText(HOF_INDEX_URL);
          const halls = parseHallOfFameIndex(html);
          yield* queue.enqueueMany(
            halls.map((h) => ({
              taskKey: `hof-page:${h.view}`,
              taskType: "hof-page",
              params: { view: h.view, name: h.name },
              priority: 20,
            })),
          );
          return halls.length > 0 ? ("done" as const) : ("empty" as const);
        }
        case "hof-page": {
          const view = String(p.view);
          const url = HOF_PAGE_URL(view);
          const { html } = yield* client.fetchText(url);
          const page = parseHofPage(html);
          yield* upsertHofPage(view, (p.name as string) ?? null, page.title, page.bodyText, url);
          return "done" as const;
        }
        default:
          return "empty" as const;
      }
    });

  // ── Run workers (drain the durable queue) ──────────────────────────────────
  yield* Effect.log("Draining queue…", { concurrency });
  yield* queue.runWorkers(concurrency, handle);
  yield* Effect.log("Run complete", { ...(yield* queue.counts()) });
});

const SqlLayer = LibsqlClient.layer({ url: `file:${dbPath}` });
const AppLayer = Layer.mergeAll(DcxQueueLive, DcxClientLive).pipe(Layer.provideMerge(SqlLayer));

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).catch((e) => {
  console.error(e);
  process.exit(1);
});
