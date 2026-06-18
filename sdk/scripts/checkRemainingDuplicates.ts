import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const dupes = yield* (sql<{
    first_name: string | null;
    last_name: string | null;
    ids: string;
    count: number;
  }>`
    SELECT
      first_name,
      last_name,
      GROUP_CONCAT(judge_id) as ids,
      COUNT(*) as count
    FROM judges
    WHERE judge_id <> 'unknown'
    GROUP BY LOWER(COALESCE(first_name, '')), LOWER(COALESCE(last_name, ''))
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 20
  `);

  console.log("Remaining duplicate groups:");
  console.table(dupes);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done"))
  .catch(console.error);
