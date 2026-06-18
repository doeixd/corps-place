import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const countCorps = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const total = yield* (sql`SELECT count(*) as count FROM corps`);
  const withWebsite = yield* (sql`SELECT count(*) as count FROM corps WHERE website IS NOT NULL`);
  const samples = yield* (sql`SELECT name, website FROM corps LIMIT 10`);

  console.log(`Total Corps: ${total[0].count}`);
  console.log(`Corps with Metadata: ${withWebsite[0].count}`);
  console.table(samples);
});

const SqlLayer = LibsqlClient.layer({ url: "file:dci-relational.db" });
Effect.runPromise(countCorps.pipe(Effect.provide(SqlLayer)));
