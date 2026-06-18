// scripts/testInsert.ts
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const rows = [
    { judge_id: "test", season: "2024", competition_slug: "test-slug", caption_name: "GE1", elo_before: 1500, elo_after: 1501, updated_at: "2024-01-01" }
  ];

  console.log("Testing sql.insert...");
  try {
    // Attempt 1: Just sql.insert
    yield* (sql`INSERT INTO judge_elo_history ${sql.insert(rows)}`);
    console.log("sql.insert(rows) worked");
  } catch (e: any) {
    console.log("sql.insert(rows) failed:", e.message);
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
Effect.runPromise(main.pipe(Effect.provide(SqlLayer)));
