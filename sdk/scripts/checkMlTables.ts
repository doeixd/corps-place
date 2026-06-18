import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const tables = yield* (
    sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'ml_%'
      ORDER BY name
    `
  );

  console.log("ML Tables in database:");
  if (tables.length === 0) {
    console.log("  (none found)");
  } else {
    for (const t of tables) {
      const count = yield* (
        sql.unsafe<{ count: number }>(`SELECT COUNT(*) as count FROM ${t.name}`)
      );
      console.log(`  - ${t.name.padEnd(30)} (${count[0].count} rows)`);
    }
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
