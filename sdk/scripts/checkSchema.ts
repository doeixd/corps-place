
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";

const main = Effect.gen(function* () {
  const sql = yield* (LibsqlClient.LibsqlClient);

  const rows = yield* (sql`PRAGMA table_info(galleries)`);
  console.log("Columns in 'galleries' table:");
  console.table(rows);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch(console.error);
