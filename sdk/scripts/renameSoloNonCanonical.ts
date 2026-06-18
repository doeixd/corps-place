import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Finding solo non-canonical judges...");

  // Find judges that don't end in -1 and aren't 'unknown'
  const nonCanonical = yield* (
    sql<{ judge_id: string }>`
      SELECT judge_id
      FROM judges
      WHERE judge_id NOT LIKE '%-1'
        AND judge_id <> 'unknown'
      ORDER BY judge_id
    `
  );

  console.log(`\nFound ${nonCanonical.length} non-canonical judges:`);
  nonCanonical.forEach((j) => console.log(`  - ${j.judge_id}`));

  for (const judge of nonCanonical) {
    const oldId = judge.judge_id;
    const newId = oldId.replace(/-[0-9]+$/, "-1");

    console.log(`\nRenaming: ${oldId} -> ${newId}`);

    // Check if canonical already exists
    const existing = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count FROM judges WHERE judge_id = ${newId}
      `
    );

    if (existing[0].count > 0) {
      console.log(`  Skip: ${newId} already exists, deleting ${oldId}`);
      yield* (
        sql.unsafe(`DELETE FROM judges WHERE judge_id = ?`, [oldId]).pipe(
          Effect.asVoid
        )
      );
    } else {
      // Create canonical ID, update FKs, delete old ID
      yield* (
        sql.unsafe(
          `INSERT INTO judges (judge_id, first_name, last_name, display_name, biography, photo_url, metadata_json)
           SELECT ?, first_name, last_name, display_name, biography, photo_url, metadata_json
           FROM judges WHERE judge_id = ?`,
          [newId, oldId]
        ).pipe(Effect.asVoid)
      );

      // Update child table FKs
      yield* (
        sql.unsafe(`UPDATE judge_assignments SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_scores SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE subcaption_scores SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE competition_judges SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_links SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_corps_relations SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_highlights SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_elo_ratings SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );
      yield* (
        sql.unsafe(`UPDATE judge_elo_history SET judge_id = ? WHERE judge_id = ?`, [newId, oldId]).pipe(Effect.asVoid)
      );

      // Delete old ID
      yield* (
        sql.unsafe(`DELETE FROM judges WHERE judge_id = ?`, [oldId]).pipe(Effect.asVoid)
      );
      console.log(`  Renamed successfully`);
    }
  }

  console.log("\nDone!");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("\nRun validation: bun run scripts/validateJudgeDeduplication.ts post-migration"))
  .catch(console.error);
