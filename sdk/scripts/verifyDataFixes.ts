import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const checkData = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("--- Corps Metadata ---");
  const corps = yield* (sql`SELECT name, website, facebook, about FROM corps WHERE website IS NOT NULL LIMIT 3`);
  console.table(corps);

  console.log("\n--- Category Scores ---");
  const categories = yield* (sql`SELECT category_name, score, rank FROM category_scores LIMIT 10`);
  console.table(categories);

  console.log("\n--- Caption Scores (Averaged) ---");
  const captions = yield* (sql`SELECT category_name, caption_name, caption_initials, score FROM caption_scores LIMIT 10`);
  console.table(captions);

  console.log("\n--- Competition Types ---");
  const compTypes = yield* (sql`SELECT type_id, name FROM competition_types LIMIT 5`);
  console.table(compTypes);
});

const SqlLayer = LibsqlClient.layer({
  url: "file:dci-relational.db"
});

const Program = checkData.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(Program).catch(console.error);

