// scripts/ingestWaybackCorpsContacts.ts
// Usage: npx tsx scripts/ingestWaybackCorpsContacts.ts [path/to/wayback_corps.json]

import fs from "fs/promises";
import path from "path";
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestWaybackCorpsContacts } from "../src/relational.js";

const defaultPath = path.join("wayback", "wayback_dci_corps_contacts_complete.json");
const filePath = process.argv[2] ?? defaultPath;

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const fileContents = yield* (Effect.tryPromise(() => fs.readFile(filePath, "utf-8")));
  const parsed = JSON.parse(fileContents) as { corps?: unknown[] } | unknown[];
  const corps = Array.isArray(parsed) ? parsed : (parsed.corps ?? []);

  console.log(`Parsed ${corps.length} corps records from ${filePath}.`);

  yield* (ingestWaybackCorpsContacts(sql, corps));

  console.log("Wayback corps contacts ingested.");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(Effect.provide(SqlLayer));

Effect.runPromise(program)
  .then(() => {
    console.log("Done!");
  })
  .catch((err) => {
    console.error("Wayback corps ingest failed:", err);
    process.exitCode = 1;
  });
