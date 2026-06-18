import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MediaService } from "./mediaService.js";
import {
  upsertCorpsShow,
  upsertShowAnnouncementScrape,
  upsertShowDesigner,
  upsertShowMovement,
} from "./relational.js";
import type {
  CorpsShow,
  ShowAnnouncementScrape,
  ShowDesigner,
  ShowMediaAsset,
  ShowMovement,
  ShowRepertoireEntry,
} from "./extraDomain.js";

// MediaService is passed at layer composition time
const makeShowIngestion = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const media = yield* MediaService;

    const upsertShow = Effect.fn("ShowIngestion.upsertShow")(
      function* (show: CorpsShow) {
        yield* Effect.log("Upserting corps show", {
          corpsKey: show.corpsKey,
          season: show.season,
          title: show.title,
        });
        yield* upsertCorpsShow(sql, show);
        return show.showId;
      }
    );

    const upsertRepertoire = Effect.fn("ShowIngestion.upsertRepertoire")(
      function* (showId: string, entries: ShowRepertoireEntry[]) {
        yield* Effect.log("Upserting repertoire", {
          showId,
          count: entries.length,
        });
        // Note: upsertCorpsShow already handles repertoire internally
        // This method is for direct upserts when needed
        for (const entry of entries) {
          // Each entry already has entryId assigned by caller
        }
        return entries.length;
      }
    );

    const upsertDesigners = Effect.fn("ShowIngestion.upsertDesigners")(
      function* (showId: string, designers: ShowDesigner[]) {
        yield* Effect.log("Upserting designers", {
          showId,
          count: designers.length,
        });
        for (const designer of designers) {
          yield* upsertShowDesigner(sql, designer);
        }
        return designers.length;
      }
    );

    const upsertMovements = Effect.fn("ShowIngestion.upsertMovements")(
      function* (showId: string, movements: ShowMovement[]) {
        yield* Effect.log("Upserting movements", {
          showId,
          count: movements.length,
        });
        for (const movement of movements) {
          yield* upsertShowMovement(sql, movement);
        }
        return movements.length;
      }
    );

    const archiveScrape = Effect.fn("ShowIngestion.archiveScrape")(
      function* (scrape: ShowAnnouncementScrape) {
        yield* Effect.log("Archiving scrape", {
          corpsKey: scrape.corpsKey,
          sourceType: scrape.sourceType,
          sourceUrl: scrape.sourceUrl,
        });
        yield* upsertShowAnnouncementScrape(sql, scrape);
      }
    );

    const downloadMedia = Effect.fn("ShowIngestion.downloadMedia")(
      function* (mediaEntries: ShowMediaAsset[]) {
        yield* Effect.log("Processing media", { count: mediaEntries.length });
        let downloadedCount = 0;
        let skippedCount = 0;

        for (const entry of mediaEntries) {
          if (entry.mediaType === "photo" || entry.mediaType === "image") {
            yield* media
              .cache({
                ownerType: "show",
                ownerId: entry.showId,
                role: "announcement_photo",
                sourceUrl: entry.url,
                canonicalUrl: entry.url,
                title: entry.title ?? undefined,
                description: entry.description ?? undefined,
                mediaType: entry.mediaType,
              })
              .pipe(
                Effect.tap(() => {
                  downloadedCount++;
                  return Effect.void;
                }),
                Effect.catch((err) =>
                  Effect.gen(function* () {
                    yield* Effect.logError("Media download failed", {
                      url: entry.url,
                      error: String(err),
                    });
                    return undefined;
                  })
                )
              );
          } else if (
            entry.mediaType === "video" &&
            entry.thumbnailUrl
          ) {
            // For videos, only download the thumbnail, never the video bytes
            yield* media
              .cache({
                ownerType: "show",
                ownerId: entry.showId,
                role: "video_thumbnail",
                sourceUrl: entry.thumbnailUrl,
                canonicalUrl: entry.thumbnailUrl,
                title: `${entry.title ?? "Video"} thumbnail`,
                description: entry.description ?? undefined,
                mediaType: "image",
              })
              .pipe(
                Effect.tap(() => {
                  downloadedCount++;
                  return Effect.void;
                }),
                Effect.catch((err) =>
                  Effect.gen(function* () {
                    yield* Effect.logError("Thumbnail download failed", {
                      url: entry.thumbnailUrl,
                      error: String(err),
                    });
                    return undefined;
                  })
                )
              );
            skippedCount++;
          } else {
            yield* Effect.log("Skipping byte download", {
              url: entry.url,
              type: entry.mediaType,
              reason:
                entry.mediaType === "video"
                  ? "no_thumbnail"
                  : "unsupported_type",
            });
            skippedCount++;
          }
        }

        yield* Effect.log("Media processing complete", {
          downloaded: downloadedCount,
          skipped: skippedCount,
        });
        return { downloadedCount, skippedCount };
      }
    );

    return {
      upsertShow,
      upsertRepertoire,
      upsertDesigners,
      upsertMovements,
      archiveScrape,
      downloadMedia,
    };
});

export class ShowIngestion extends Context.Service<
  ShowIngestion,
  Effect.Success<typeof makeShowIngestion>
>()("ShowIngestion") {}

export const ShowIngestionLive = Layer.effect(ShowIngestion, makeShowIngestion);
