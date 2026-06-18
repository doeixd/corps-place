import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface DuplicateGroup {
  first_name: string | null;
  last_name: string | null;
  judge_ids: string;
  count: number;
}

interface JudgeRecord {
  judge_id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  biography: string | null;
  photo_url: string | null;
  metadata_json: string | null;
}

interface JudgeNumber {
  judge_number: number;
}

interface JudgeMetadata {
  seenJudgeNumbers?: number[];
  duplicateIdsRemoved?: string[];
  deduplicationDate?: string;
  alternateNames?: string[];
  [key: string]: unknown;
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

const collectJudgeMetadata = (sql: SqlClient.SqlClient, judgeIds: string[]) =>
  Effect.gen(function* () {
    // Get all judge records
    const placeholders = judgeIds.map((_, i) => `$${i + 1}`).join(",");
    const judges = yield* (
      sql.unsafe<JudgeRecord>(
        `SELECT * FROM judges WHERE judge_id IN (${placeholders})`,
        judgeIds
      )
    );

    // Get all judge_numbers ever used
    const judgeNumbers = yield* (
      sql.unsafe<JudgeNumber>(
        `SELECT DISTINCT judge_number
         FROM judge_assignments
         WHERE judge_id IN (${placeholders})
           AND judge_number IS NOT NULL
         ORDER BY judge_number`,
        judgeIds
      )
    );

    // Merge strategy: prefer non-null values, first wins on conflict
    const merged: JudgeRecord = {
      judge_id: "", // Will be set by caller
      first_name:
        judges.find((j) => j.first_name)?.first_name ?? judges[0].first_name,
      last_name:
        judges.find((j) => j.last_name)?.last_name ?? judges[0].last_name,
      display_name:
        judges.find((j) => j.display_name)?.display_name ??
        judges[0].display_name,
      biography:
        judges.find((j) => j.biography)?.biography ?? judges[0].biography,
      photo_url:
        judges.find((j) => j.photo_url)?.photo_url ?? judges[0].photo_url,
      metadata_json: null, // Will build below
    };

    return {
      merged,
      judgeNumbers: judgeNumbers.map((jn) => jn.judge_number),
    };
  });

const buildMetadata = (
  existingMetadata: string | null,
  judgeNumbers: number[],
  duplicateIds: string[]
): string => {
  const existing: JudgeMetadata = existingMetadata
    ? JSON.parse(existingMetadata)
    : {};

  const metadata: JudgeMetadata = {
    ...existing,
    seenJudgeNumbers: judgeNumbers,
    duplicateIdsRemoved: duplicateIds,
    deduplicationDate: new Date().toISOString(),
  };

  return JSON.stringify(metadata);
};

const removeConflictingRows = (
  sql: SqlClient.SqlClient,
  duplicateId: string,
  canonicalId: string
) =>
  Effect.gen(function* () {
    // Delete rows from duplicate ID that would conflict with canonical ID's rows
    // This must happen BEFORE updating FKs to prevent PK violations

    yield* (
      sql.unsafe(
        `DELETE FROM judge_assignments
         WHERE judge_id = ?
           AND EXISTS (
             SELECT 1 FROM judge_assignments ja2
             WHERE ja2.judge_id = ?
               AND ja2.competition_slug = judge_assignments.competition_slug
               AND ja2.caption_name = judge_assignments.caption_name
           )`,
        [duplicateId, canonicalId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `DELETE FROM judge_scores
         WHERE judge_id = ?
           AND EXISTS (
             SELECT 1 FROM judge_scores js2
             WHERE js2.judge_id = ?
               AND js2.competition_slug = judge_scores.competition_slug
               AND js2.corps_key = judge_scores.corps_key
               AND js2.caption_name = judge_scores.caption_name
           )`,
        [duplicateId, canonicalId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `DELETE FROM subcaption_scores
         WHERE judge_id = ?
           AND EXISTS (
             SELECT 1 FROM subcaption_scores ss2
             WHERE ss2.judge_id = ?
               AND ss2.competition_slug = subcaption_scores.competition_slug
               AND ss2.corps_key = subcaption_scores.corps_key
               AND ss2.caption_name = subcaption_scores.caption_name
               AND ss2.subcaption_name = subcaption_scores.subcaption_name
           )`,
        [duplicateId, canonicalId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `DELETE FROM competition_judges
         WHERE judge_id = ?
           AND EXISTS (
             SELECT 1 FROM competition_judges cj2
             WHERE cj2.judge_id = ?
               AND cj2.competition_slug = competition_judges.competition_slug
           )`,
        [duplicateId, canonicalId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `DELETE FROM judge_links
         WHERE judge_id = ?
           AND EXISTS (
             SELECT 1 FROM judge_links jl2
             WHERE jl2.judge_id = ?
               AND jl2.url = judge_links.url
           )`,
        [duplicateId, canonicalId]
      ).pipe(Effect.asVoid)
    );
  });

const updateForeignKeys = (
  sql: SqlClient.SqlClient,
  duplicateId: string,
  canonicalId: string
) =>
  Effect.gen(function* () {
    // Update all foreign key references
    yield* (
      sql.unsafe(
        `UPDATE judge_assignments SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`UPDATE judge_scores SET judge_id = ? WHERE judge_id = ?`, [
        canonicalId,
        duplicateId,
      ]).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE subcaption_scores SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE competition_judges SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`UPDATE judge_links SET judge_id = ? WHERE judge_id = ?`, [
        canonicalId,
        duplicateId,
      ]).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE judge_corps_relations SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE judge_highlights SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE judge_elo_ratings SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(
        `UPDATE judge_elo_history SET judge_id = ? WHERE judge_id = ?`,
        [canonicalId, duplicateId]
      ).pipe(Effect.asVoid)
    );
  });

const deduplicateConstraintViolations = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    // Remove duplicate rows that violate composite PK after FK updates

    yield* (
      sql.unsafe(`
        DELETE FROM judge_assignments
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM judge_assignments
          GROUP BY competition_slug, caption_name, judge_id
        )
      `).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`
        DELETE FROM judge_scores
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM judge_scores
          GROUP BY competition_slug, corps_key, caption_name, judge_id
        )
      `).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`
        DELETE FROM subcaption_scores
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM subcaption_scores
          GROUP BY competition_slug, corps_key, caption_name, judge_id, subcaption_name
        )
      `).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`
        DELETE FROM competition_judges
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM competition_judges
          GROUP BY competition_slug, judge_id
        )
      `).pipe(Effect.asVoid)
    );

    yield* (
      sql.unsafe(`
        DELETE FROM judge_links
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM judge_links
          GROUP BY judge_id, url
        )
      `).pipe(Effect.asVoid)
    );
  });

const upsertCanonicalJudge = (
  sql: SqlClient.SqlClient,
  judge: JudgeRecord
) =>
  Effect.gen(function* () {
    yield* (
      sql.unsafe(
        `INSERT INTO judges (
          judge_id, first_name, last_name, display_name,
          biography, photo_url, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(judge_id) DO UPDATE SET
          first_name = COALESCE(excluded.first_name, judges.first_name),
          last_name = COALESCE(excluded.last_name, judges.last_name),
          display_name = COALESCE(excluded.display_name, judges.display_name),
          biography = COALESCE(excluded.biography, judges.biography),
          photo_url = COALESCE(excluded.photo_url, judges.photo_url),
          metadata_json = excluded.metadata_json
        `,
        [
          judge.judge_id,
          judge.first_name,
          judge.last_name,
          judge.display_name,
          judge.biography,
          judge.photo_url,
          judge.metadata_json,
        ]
      ).pipe(Effect.asVoid)
    );
  });

const deduplicateGroup = (
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
      `\nProcessing group: ${group.first_name} ${group.last_name}`
    );
    console.log(`  Duplicates: ${duplicateIds.join(", ")}`);
    console.log(`  Canonical: ${canonicalId}`);

    // Collect metadata
    const { merged, judgeNumbers } = yield* (
      collectJudgeMetadata(sql, duplicateIds)
    );

    console.log(`  Judge numbers seen: [${judgeNumbers.join(", ")}]`);

    // Build metadata JSON
    const duplicatesToRemove = duplicateIds.filter((id) => id !== canonicalId);
    const metadataJson = buildMetadata(
      merged.metadata_json,
      judgeNumbers,
      duplicatesToRemove
    );

    merged.judge_id = canonicalId;
    merged.metadata_json = metadataJson;

    // IMPORTANT: Upsert canonical judge FIRST to avoid FK constraint violations
    yield* (upsertCanonicalJudge(sql, merged));
    console.log(`  Upserted canonical judge: ${canonicalId}`);

    // For each duplicate, remove conflicting rows then update FKs
    for (const dupId of duplicateIds) {
      if (dupId !== canonicalId) {
        // Remove rows that would conflict when updating FKs
        yield* (removeConflictingRows(sql, dupId, canonicalId));
        console.log(`  Removed conflicts for: ${dupId}`);

        // Now safe to update FKs
        yield* (updateForeignKeys(sql, dupId, canonicalId));
        console.log(`  Updated FKs: ${dupId} -> ${canonicalId}`);
      }
    }

    // Final cleanup of any remaining constraint violations
    yield* (deduplicateConstraintViolations(sql));
    console.log(`  Final cleanup completed`);

    // Delete duplicates
    for (const dupId of duplicateIds) {
      if (dupId !== canonicalId) {
        yield* (
          sql.unsafe(`DELETE FROM judges WHERE judge_id = ?`, [
            dupId,
          ]).pipe(Effect.asVoid)
        );
        console.log(`  Deleted duplicate: ${dupId}`);
      }
    }
  });

const deduplicateJudges = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("=".repeat(60));
  console.log("Judge Deduplication Migration");
  console.log("=".repeat(60));

  // Get all duplicate groups
  const duplicateGroups = yield* (findDuplicateGroups(sql));

  console.log(`\nFound ${duplicateGroups.length} duplicate groups to process`);

  if (duplicateGroups.length === 0) {
    console.log("No duplicates found. Nothing to do.");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const group of duplicateGroups) {
    const result = yield* (
      sql
        .withTransaction(deduplicateGroup(sql, group))
        .pipe(Effect.result)
    );

    if (result._tag === 'Success') {
      successCount++;
    } else {
      failCount++;
      console.error(
        `\n✗ Failed to deduplicate group: ${group.first_name} ${group.last_name}`
      );
      console.error(`  Error: ${result.failure}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Migration Complete");
  console.log(`  Success: ${successCount} groups`);
  console.log(`  Failed: ${failCount} groups`);
  console.log("=".repeat(60));

  if (failCount > 0) {
    console.error(
      "\nWarning: Some groups failed. Review errors above and consider re-running."
    );
  }
});

const main = Effect.gen(function* () {
  console.log("\nStarting judge deduplication migration...\n");

  yield* (deduplicateJudges);

  console.log("\nMigration complete. Please run validation script:");
  console.log(
    "  bun run scripts/validateJudgeDeduplication.ts post-migration"
  );
  console.log("\nThen rebuild the judge index map:");
  console.log("  bun run scripts/buildJudgeIndexMap.ts\n");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(Effect.provide(SqlLayer));

Effect.runPromise(program)
  .then(() => {
    console.log("Migration complete!");
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  });
