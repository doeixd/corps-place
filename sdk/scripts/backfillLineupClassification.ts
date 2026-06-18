// Backfill lineup rows using the canonical classification rules.
//
// Dry-run by default. Pass --apply to:
//   1. mark schedule_item / not_a_corps lineup rows as non-performance,
//   2. unlink those lineup rows from participants,
//   3. remove participant rows that are no longer referenced,
//   4. remove bogus corps rows only when they have no score/prediction evidence.

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  firstExclusionMatch,
  NON_CORPS_CATEGORIES,
  type ExclusionCategory
} from "../src/lineupClassification.js";

const apply = process.argv.includes("--apply");

type LineupAuditRow = {
  readonly entry_id: string;
  readonly event_slug: string;
  readonly unit_name: string;
  readonly participant_id: string | null;
  readonly corps_key: string | null;
  readonly is_non_performance: number;
  readonly is_exhibition: number;
};

type TargetRow = LineupAuditRow & {
  readonly matched_pattern: string;
  readonly matched_category: ExclusionCategory;
  readonly matched_reason: string;
};

type BogusCorpsRow = {
  readonly corps_key: string;
  readonly name: string;
  readonly scores: number;
  readonly pred_rows: number;
  readonly participants: number;
  readonly matched_pattern: string;
  readonly matched_category: ExclusionCategory;
  readonly matched_reason: string;
};

const isNonCorpsCategory = (category: ExclusionCategory) =>
  NON_CORPS_CATEGORIES.includes(category);

const targetRows = (rows: readonly LineupAuditRow[]): readonly TargetRow[] =>
  rows.flatMap((row) => {
    const match = firstExclusionMatch(row.unit_name);
    if (!match || !isNonCorpsCategory(match.category)) return [];
    return [
      {
        ...row,
        matched_pattern: match.pattern,
        matched_category: match.category,
        matched_reason: match.reason
      }
    ];
  });

const logSampleRows = (rows: readonly TargetRow[]) =>
  Effect.gen(function* () {
    for (const row of rows.slice(0, 50)) {
      yield* (
        Effect.log(
          [
            `  - ${row.event_slug}`,
            row.unit_name,
            `participant=${row.participant_id ?? "null"}`,
            `corps=${row.corps_key ?? "null"}`,
            `pattern=${row.matched_pattern}`,
            `category=${row.matched_category}`
          ].join(" | ")
        )
      );
    }
    if (rows.length > 50) {
      yield* (Effect.log(`  ... ${rows.length - 50} more`));
    }
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const lineupRows = yield* (
    sql<LineupAuditRow>`SELECT
        ele.entry_id,
        ele.event_slug,
        ele.unit_name,
        ele.participant_id,
        ep.corps_key,
        ele.is_non_performance,
        ele.is_exhibition
      FROM event_lineup_entries ele
      LEFT JOIN event_participants ep
        ON ep.event_slug = ele.event_slug
       AND ep.participant_id = ele.participant_id`
  );
  const targets = targetRows(lineupRows);
  const needsFlag = targets.filter((row) => row.is_non_performance !== 1);
  const needsUnlink = targets.filter((row) => row.participant_id != null);

  yield* (Effect.log(`${apply ? "Applying" : "Dry run"} lineup classification backfill`));
  yield* (Effect.log(`  non-corps lineup rows: ${targets.length}`));
  yield* (Effect.log(`  need is_non_performance=1: ${needsFlag.length}`));
  yield* (Effect.log(`  need participant unlink: ${needsUnlink.length}`));
  yield* (logSampleRows(targets));

  const corpsRows = yield* (
    sql<{
      corps_key: string;
      name: string;
      scores: number;
      pred_rows: number;
      participants: number;
    }>`SELECT
        c.corps_key,
        c.name,
        (SELECT COUNT(*) FROM corps_scores s WHERE s.corps_key = c.corps_key) AS scores,
        (SELECT COUNT(*) FROM model_event_prediction_rows r WHERE r.corps_key = c.corps_key) AS pred_rows,
        (SELECT COUNT(*) FROM event_participants ep WHERE ep.corps_key = c.corps_key) AS participants
      FROM corps c`
  );
  const bogusCorps: readonly BogusCorpsRow[] = corpsRows.flatMap((row) => {
    const match = firstExclusionMatch(row.name);
    if (!match || !isNonCorpsCategory(match.category)) return [];
    if (row.scores !== 0 || row.pred_rows !== 0) return [];
    return [
      {
        ...row,
        matched_pattern: match.pattern,
        matched_category: match.category,
        matched_reason: match.reason
      }
    ];
  });

  yield* (Effect.log(`  bogus non-corps rows eligible for delete: ${bogusCorps.length}`));
  for (const row of bogusCorps.slice(0, 50)) {
    yield* (
      Effect.log(
        `  - ${row.corps_key} | ${row.name} | participants=${row.participants} | pattern=${row.matched_pattern}`
      )
    );
  }
  if (bogusCorps.length > 50) {
    yield* (Effect.log(`  ... ${bogusCorps.length - 50} more`));
  }

  if (!apply) {
    yield* (Effect.log("Dry-run only. Re-run with --apply to write."));
    return;
  }

  yield* (sql`BEGIN IMMEDIATE`.pipe(Effect.asVoid));
  yield* (
    Effect.gen(function* () {
      for (const row of targets) {
        yield* (
          sql`UPDATE event_lineup_entries
              SET is_non_performance = 1, participant_id = NULL
              WHERE entry_id = ${row.entry_id}`.pipe(Effect.asVoid)
        );
      }

      const participantKeys = Array.from(
        new Set(
          needsUnlink.map((row) => `${row.event_slug}\u0000${row.participant_id}`).filter(Boolean)
        )
      ).map((key) => {
        const [eventSlug, participantId] = key.split("\u0000");
        return { eventSlug, participantId };
      });

      for (const participant of participantKeys) {
        const remaining = yield* (
          sql<{ count: number }>`SELECT COUNT(*) AS count
            FROM event_lineup_entries
            WHERE event_slug = ${participant.eventSlug}
              AND participant_id = ${participant.participantId}`.pipe(
            Effect.map((rows) => rows[0]?.count ?? 0)
          )
        );
        if (remaining === 0) {
          yield* (
            sql`DELETE FROM event_participants
                WHERE event_slug = ${participant.eventSlug}
                  AND participant_id = ${participant.participantId}`.pipe(Effect.asVoid)
          );
        }
      }

      for (const row of bogusCorps) {
        const evidence = yield* (
          sql<{ count: number }>`SELECT
              (SELECT COUNT(*) FROM corps_scores s WHERE s.corps_key = ${row.corps_key}) +
              (SELECT COUNT(*) FROM model_event_prediction_rows r WHERE r.corps_key = ${row.corps_key}) +
              (SELECT COUNT(*) FROM event_participants ep WHERE ep.corps_key = ${row.corps_key})
              AS count`.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
        );
        if (evidence === 0) {
          yield* (sql`DELETE FROM corps WHERE corps_key = ${row.corps_key}`.pipe(Effect.asVoid));
        }
      }
    }).pipe(
      Effect.tapError(() => sql`ROLLBACK`.pipe(Effect.asVoid)),
      Effect.andThen(sql`COMMIT`.pipe(Effect.asVoid))
    )
  );

  yield* (Effect.log("Applied lineup classification backfill."));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Lineup classification backfill failed:", error);
  process.exitCode = 1;
});
