import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("=".repeat(60));
  console.log("ML Sequences Verification (Post-Deduplication)");
  console.log("=".repeat(60));

  // Load judgeIndexMap
  const judgeIndexMap = JSON.parse(
    fs.readFileSync("./src/training/judgeIndexMap.json", "utf-8")
  );
  const judgeCount = Object.keys(judgeIndexMap).length;
  console.log(`\n1. Judge Index Map:`);
  console.log(`   Total judges in map: ${judgeCount}`);
  console.log(`   Max index: ${Math.max(...Object.values(judgeIndexMap))}`);

  // Check a few sample mappings
  const samples = ["unknown", "tony-dicarlo-1", "robert-solomon-1", "al-dunn-1"];
  console.log(`\n   Sample mappings:`);
  samples.forEach((id) => {
    if (judgeIndexMap[id] !== undefined) {
      console.log(`     ${id.padEnd(20)} -> ${judgeIndexMap[id]}`);
    }
  });

  // Check ML sequences table
  const seqCount = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM ml_sequence_rows_v7
    `
  );
  console.log(`\n2. ML Sequences V7:`);
  console.log(`   Total sequences: ${seqCount[0].count}`);

  // Check judge indices in sequences
  const sampleSeqs = yield* (
    sql<{
      competition_slug: string;
      corps_key: string;
      judge_indices: string;
    }>`
      SELECT competition_slug, corps_key, judge_indices
      FROM ml_sequence_rows_v7
      LIMIT 5
    `
  );

  console.log(`\n   Sample judge indices (first 5 sequences):`);
  sampleSeqs.forEach((seq) => {
    const indices = JSON.parse(seq.judge_indices);
    const validIndices = indices.filter((i: number) => i > 0 && i < judgeCount);
    console.log(`     ${seq.competition_slug.padEnd(40)} ${seq.corps_key.padEnd(15)} [${indices.join(", ")}] (${validIndices.length}/8 valid)`);
  });

  // Check for invalid judge indices
  const allSeqs = yield* (
    sql<{ judge_indices: string }>`
      SELECT judge_indices FROM ml_sequence_rows_v7
    `
  );

  let invalidCount = 0;
  let totalJudgeSlots = 0;
  let filledSlots = 0;
  const maxValidIndex = Math.max(...Object.values(judgeIndexMap));

  for (const seq of allSeqs) {
    const indices = JSON.parse(seq.judge_indices);
    totalJudgeSlots += indices.length;

    for (const idx of indices) {
      if (idx > 0) {
        filledSlots++;
        if (idx > maxValidIndex) {
          invalidCount++;
        }
      }
    }
  }

  console.log(`\n3. Judge Index Validation:`);
  console.log(`   Total judge slots: ${totalJudgeSlots}`);
  console.log(`   Filled slots (non-zero): ${filledSlots}`);
  console.log(`   Invalid indices (> ${maxValidIndex}): ${invalidCount} ${invalidCount === 0 ? '✓' : '✗'}`);
  console.log(`   Fill rate: ${((filledSlots / totalJudgeSlots) * 100).toFixed(1)}%`);

  // Check for judges in sequences that aren't in the map
  const uniqueIndices = new Set<number>();
  for (const seq of allSeqs) {
    const indices = JSON.parse(seq.judge_indices);
    indices.forEach((idx: number) => {
      if (idx > 0) uniqueIndices.add(idx);
    });
  }

  const mappedIndices = new Set(Object.values(judgeIndexMap));
  const unmappedIndices = Array.from(uniqueIndices).filter(
    (idx) => !mappedIndices.has(idx)
  );

  console.log(`\n4. Index Coverage:`);
  console.log(`   Unique judge indices in sequences: ${uniqueIndices.size}`);
  console.log(`   Judges in index map: ${judgeCount}`);
  console.log(`   Unmapped indices in sequences: ${unmappedIndices.length} ${unmappedIndices.length === 0 ? '✓' : '✗'}`);

  if (unmappedIndices.length > 0 && unmappedIndices.length < 10) {
    console.log(`   Unmapped: ${unmappedIndices.join(", ")}`);
  }

  // Final verdict
  console.log("\n" + "=".repeat(60));
  if (invalidCount === 0 && unmappedIndices.length === 0) {
    console.log("✓ ML sequences are valid and ready for training");
  } else {
    console.log("✗ Issues detected - may need to rebuild sequences or index map");
  }
  console.log("=".repeat(60));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log())
  .catch(console.error);
