import { SchemaParser } from "effect";

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Schema from "@effect/schema/Schema";
// @ts-ignore
import { GallerySchema } from "../src/domain";

const main = Effect.gen(function* () {
  const sql = yield* (LibsqlClient.LibsqlClient);

  const rows = yield* (sql`SELECT endpoint_url, response_json FROM api_responses WHERE endpoint_url LIKE '%galleries?page=%' LIMIT 5`);

  console.log(`Found ${rows.length} gallery responses.`);

  for (const row of rows) {
    if (row.endpoint_url.includes("page=4") || row.endpoint_url.includes("page=6")) {
      console.log(`\nURL: ${row.endpoint_url}`);
      const parsed = JSON.parse(row.response_json);
      // Try decoding
      const decode = SchemaParser.decodeUnknownEffect(Schema.Array(GallerySchema));
      const result = yield* (decode(parsed).pipe(Effect.exit));

      if (result._tag === "Failure") {
        console.log("Schema Decode FAILED!");
        console.log(JSON.stringify(result.cause, null, 2));
        // Try to print formatted error
        // const error = result.cause.failureOrCause;
        // console.log("Error:", error);
      } else {
        console.log("Schema Decode OK!");
      }
    }
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch(console.error);
