import { SchemaParser } from "effect";
// Apply researched judge biographies + headshots from a dry-run report.
//
// Reads sdk/results/judge-bios-*.json, caches each headshot's bytes into
// media-cache.db (+ a media_assets row), and upserts each JudgeBioProfile into
// dci-relational.db via the coalescing upsertJudgeProfile writer.
//
// Usage:
//   npx tsx scripts/applyJudgeBios.ts --file results/judge-bios-20260610.json [--dry-run]
//
// --dry-run reports what would be written without touching either DB.

import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ExtraDomain from "../src/extraDomain.js";
import { upsertJudgeProfile } from "../src/relational.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";

const argValue = (name: string) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

const file = argValue("file") ?? "results/judge-bios-20260610.json";
const dryRun = process.argv.includes("--dry-run");

interface RawHighlight {
  title?: string;
  summary?: string;
  season?: string;
  sourceUrl?: string;
}

interface RawProfile {
  judgeId: string;
  displayName: string;
  photoUrl?: string;
  seasonHighlights?: RawHighlight[];
  _research?: unknown;
  [k: string]: unknown;
}

// Strip the report-only `_research` block and map highlight `title` -> schema `summary`.
const toProfileInput = (raw: RawProfile) => {
  const { _research, seasonHighlights, ...rest } = raw;
  return {
    ...rest,
    seasonHighlights: (seasonHighlights ?? []).map((h) => ({
      summary: h.summary ?? h.title,
      season: h.season,
      sourceUrl: h.sourceUrl
    }))
  };
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const media = yield* (MediaService);

  const report = JSON.parse(readFileSync(file, "utf8")) as { profiles: RawProfile[] };
  const profiles = report.profiles ?? [];
  yield* (Effect.logInfo(`Applying ${profiles.length} judge profiles from ${file}${dryRun ? " (dry-run)" : ""}`));

  let cached = 0;
  let written = 0;

  for (const raw of profiles) {
    const decoded = yield* (SchemaParser.decodeUnknownEffect(ExtraDomain.JudgeProfileSchema)(toProfileInput(raw)));

    // 1) Cache headshot bytes + media_assets row.
    if (decoded.photoUrl) {
      if (dryRun) {
        yield* (Effect.logInfo(`  [dry-run] would cache headshot for ${decoded.displayName}: ${decoded.photoUrl}`));
      } else {
        const asset = yield* (
          media.cache({
            ownerType: "judge",
            ownerId: decoded.judgeId,
            role: "headshot",
            sourceUrl: decoded.photoUrl,
            title: `${decoded.displayName} headshot`,
            attribution: "Music for All / source page",
            metadata: { researchedAt: "2026-06-10" }
          }).pipe(
            Effect.catch((e) =>
              Effect.logWarning(`  headshot cache failed for ${decoded.displayName}: ${String(e)}`).pipe(
                Effect.as(null)
              )
            )
          )
        );
        if (asset) {
          cached += 1;
          yield* (Effect.logInfo(`  cached headshot for ${decoded.displayName} (${asset.byteLength ?? "?"} bytes)`));
        }
      }
    }

    // 2) Upsert the profile (bio + links + relations + highlights). Coalescing.
    if (dryRun) {
      yield* (
        Effect.logInfo(
          `  [dry-run] would upsert ${decoded.displayName}: bio ${decoded.biography?.length ?? 0} chars, ` +
            `${decoded.externalLinks?.length ?? 0} links, ${decoded.corpsRelations?.length ?? 0} relations, ` +
            `${decoded.seasonHighlights?.length ?? 0} highlights`
        )
      );
    } else {
      yield* (upsertJudgeProfile(sql, decoded));
      written += 1;
      yield* (Effect.logInfo(`  upserted ${decoded.displayName}`));
    }
  }

  yield* (
    Effect.logInfo(
      dryRun
        ? `Dry-run complete: ${profiles.length} profiles validated.`
        : `Applied: ${written} profiles upserted, ${cached} headshots cached.`
    )
  );
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(
  main.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: "file:./media-cache.db" })),
    Effect.provide(SqlLayer)
  )
).catch((error) => {
  console.error("applyJudgeBios failed:", error);
  process.exitCode = 1;
});
