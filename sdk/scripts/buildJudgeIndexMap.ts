// scripts/buildJudgeIndexMap.ts
// Create mapping: judgeId -> integer index for embedding layer.
// Usage: npx tsx scripts/buildJudgeIndexMap.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Querying unique judges...");
  const judges = yield* (sql<{ judge_id: string }>`SELECT DISTINCT judge_id FROM judges ORDER BY judge_id`);

  const mapping: Record<string, number> = { "unknown": 0 };
  judges.forEach((j, idx) => {
    mapping[j.judge_id] = idx + 1;
  });

  console.log(`Mapped ${judges.length} judges to indices.`);

  const outputPath = "./src/training/judgeIndexMap.json";
  fs.writeFileSync(outputPath, JSON.stringify(mapping, null, 2));
  console.log(`Mapping saved to ${outputPath}`);
});

// Set up layer
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("Done!");
  })
  .catch((err) => {
    console.error("Failed to build judge index map:", err);
    process.exitCode = 1;
  });
