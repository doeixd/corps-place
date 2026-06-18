import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface DuplicateGroup {
  first_name: string | null;
  last_name: string | null;
  judge_ids: string;
  count: number;
}

const normalizeKey = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  return lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const getCanonicalId = (
  judgeIds: string[],
  firstName: string | null,
  lastName: string | null
): string => {
  // Check if -1 suffix exists
  const canonical = judgeIds.find((id) => id.endsWith("-1"));

  if (canonical) {
    return canonical;
  }

  // No -1 exists, create it
  const normalizedFirst = normalizeKey(firstName ?? undefined) ?? "unknown";
  const normalizedLast = normalizeKey(lastName ?? undefined) ?? "unknown";
  return `${normalizedFirst}-${normalizedLast}-1`;
};

const findDuplicateGroups = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const groups = yield* (
      sql<DuplicateGroup>`
        SELECT
          first_name,
          last_name,
          GROUP_CONCAT(judge_id ORDER BY judge_id) as judge_ids,
          COUNT(*) as count
        FROM judges
        WHERE judge_id <> 'unknown'
        GROUP BY LOWER(COALESCE(first_name, '')), LOWER(COALESCE(last_name, ''))
        HAVING COUNT(*) > 1
        ORDER BY count DESC, first_name, last_name
      `
    );
    return groups;
  });

const simpleDeduplicateGroup = (
  sql: SqlClient.SqlClient,
  group: DuplicateGroup
) =>
  Effect.gen(function* () {
    const duplicateIds = group.judge_ids.split(",");
    const canonicalId = getCanonicalId(
      duplicateIds,
      group.first_name,
      group.last_name
    );

    console.log(
      `\nProcessing: ${group.first_name} ${group.last_name}`
    );
    console.log(`  IDs: ${duplicateIds.join(", ")} -> ${canonicalId}`);

    const duplicatesToDelete = duplicateIds.filter((id) => id !== canonicalId);

    if (duplicatesToDelete.length === 0) {
      console.log(`  No duplicates to delete`);
      return;
    }

    // If canonical doesn't exist, create it from first duplicate
    const canonicalExists = duplicateIds.includes(canonicalId);
    if (!canonicalExists) {
      const sourceId = duplicateIds[0];
      yield* (
        sql.unsafe(
          `INSERT INTO judges (judge_id, first_name, last_name, display_name, biography, photo_url, metadata_json)
           SELECT ?, first_name, last_name, display_name, biography, photo_url, metadata_json
           FROM judges
           WHERE judge_id = ?`,
          [canonicalId, sourceId]
        ).pipe(Effect.asVoid)
      );
      console.log(`  Created canonical: ${canonicalId} from ${sourceId}`);
    }

    // Simply delete duplicate judges (CASCADE will remove child records)
    for (const dupId of duplicatesToDelete) {
      yield* (
        sql.unsafe(`DELETE FROM judges WHERE judge_id = ?`, [dupId]).pipe(
          Effect.asVoid
        )
      );
      console.log(`  Deleted: ${dupId}`);
    }
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("=".repeat(60));
  console.log("Simple Judge Deduplication (Delete Duplicates)");
  console.log("=".repeat(60));

  const duplicateGroups = yield* (findDuplicateGroups(sql));

  console.log(`\nFound ${duplicateGroups.length} duplicate groups`);

  if (duplicateGroups.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const group of duplicateGroups) {
    const result = yield* (
      sql
        .withTransaction(simpleDeduplicateGroup(sql, group))
        .pipe(Effect.result)
    );

    if (result._tag === 'Success') {
      successCount++;
    } else {
      failCount++;
      console.error(`✗ Failed: ${group.first_name} ${group.last_name}`);
      console.error(`  Error: ${result.failure}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Complete: ${successCount} success, ${failCount} failed`);
  console.log("=".repeat(60));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("\nRun validation: bun run scripts/validateJudgeDeduplication.ts post-migration"))
  .catch(console.error);
