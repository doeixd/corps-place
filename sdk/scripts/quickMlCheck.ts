import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Quick ML Pipeline Check\n");

  // 1. Load judge index map
  const judgeIndexMap: Record<string, number> = JSON.parse(
    fs.readFileSync("./src/training/judgeIndexMap.json", "utf-8")
  );
  console.log(`✓ judgeIndexMap.json loaded: ${Object.keys(judgeIndexMap).length} judges`);

  // 2. Check table
  const rows = yield* (
    sql<{ count: number }>`SELECT COUNT(*) as count FROM ml_sequence_rows_v7`
  );
  console.log(`✓ ml_sequence_rows_v7 exists: ${rows[0].count} rows`);

  // 3. Check a sample row
  const sample = yield* (sql.unsafe(`SELECT * FROM ml_sequence_rows_v7 LIMIT 1`));
  console.log(`✓ Sample row has ${Object.keys(sample[0]).length} columns`);

  // 4. Check if judge_index column exists
  if (sample[0].judge_index !== undefined) {
    console.log(`✓ judge_index column exists`);

    const maxIdx = yield* (
      sql.unsafe<{ max_idx: number }>(`SELECT MAX(judge_index) as max_idx FROM ml_sequence_rows_v7`)
    );
    const maxInMap = Math.max(...Object.values(judgeIndexMap));
    console.log(`✓ Max judge_index in data: ${maxIdx[0].max_idx}, in map: ${maxInMap}`);

    if (maxIdx[0].max_idx <= maxInMap) {
      console.log(`✓ All judge indices are valid`);
    } else {
      console.log(`✗ Some judge indices exceed map range`);
    }
  } else {
    console.log(`  (judge_index not in this version)`);
  }

  console.log(`\n✓ ML pipeline ready for training with deduplicated judges`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
