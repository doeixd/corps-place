
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";

const main = Effect.gen(function* () {
  const sql = yield* (LibsqlClient.LibsqlClient);

  const rows = yield* (sql`SELECT response_json FROM api_responses WHERE response_json LIKE '%remembering-founding-crossmen-director-harold-robby-robinson%'`);

  if (rows.length === 0) {
    console.log("No API response found containing the slug.");
    return;
  }

  console.log(`Found ${rows.length} potential pages.`);

  for (const row of rows) {
    const galleries = JSON.parse(row.response_json);
    if (Array.isArray(galleries)) {
      const target = galleries.find((g: any) => g.slug === 'remembering-founding-crossmen-director-harold-robby-robinson');
      if (target) {
        console.log("Target Gallery Data FOUND:");
        console.log(JSON.stringify(target, null, 2));
        console.log("Types:");
        console.log("slug:", typeof target.slug);
        console.log("title:", typeof target.title);
        console.log("description:", typeof target.description);
        console.log("publishedDate:", typeof target.publishedDate, target.publishedDate);
        console.log("createdAt:", typeof target.createdAt, target.createdAt);
        console.log("presentedBy:", typeof target.presentedBy);
        console.log("type:", typeof target.type, target.type);
        return;
      }
    }
  }
  console.log("Slug not found in any parsed JSON pages.");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch(console.error);
