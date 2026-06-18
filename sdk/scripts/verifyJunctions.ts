import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const checkData = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("--- Corps Metadata (Check 1) ---");
  const corps = yield* (sql`SELECT name, website, facebook, about FROM corps WHERE website IS NOT NULL LIMIT 2`);
  console.log(JSON.stringify(corps, null, 2));

  console.log("\n--- Competition Corps Junction ---");
  const junctions = yield* (sql`SELECT * FROM competition_corps LIMIT 5`);
  console.table(junctions);

  console.log("\n--- Competition Judges Junction ---");
  const judgeJunctions = yield* (sql`SELECT * FROM competition_judges LIMIT 5`);
  console.table(judgeJunctions);
});

const SqlLayer = LibsqlClient.layer({ url: "file:dci-relational.db" });
const Program = checkData.pipe(Effect.provide(SqlLayer));
Effect.runPromise(Program).catch(console.error);
