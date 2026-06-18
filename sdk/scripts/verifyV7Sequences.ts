// scripts/verifyV7Sequences.ts
import Database from "better-sqlite3";

try {
  const db = new Database("./dci-relational.db");
  const row: any = db.prepare("SELECT * FROM ml_sequence_rows_v7 WHERE season = '2024' LIMIT 1").get();

  if (!row) {
    console.error("No rows found in ml_sequence_rows_v7");
    process.exit(1);
  }

  console.log("=== V7 Sequence Verification ===");
  console.log(`Corps: ${row.corps_key}`);
  console.log(`Show: ${row.competition_slug}`);

  const x_seq = JSON.parse(row.x_sequence_json);
  const x_static = JSON.parse(row.x_static_json);
  const judge_indices = JSON.parse(row.judge_indices_json);
  const y_residuals = JSON.parse(row.y_residuals_json);

  console.log(`Sequence Length: ${x_seq.length} (Expected 15)`);
  console.log(`Timestep Features: ${x_seq[0]?.length} (Expected 67)`);
  console.log(`Static Features: ${x_static.length} (Expected 73)`);
  console.log(`Judge Indices: ${judge_indices.length} (Matches panel size)`);
  console.log(`Residuals: ${Object.keys(y_residuals).length} (Expected 8)`);

  // Check some values
  console.log("\nSample Static Features (Last 5 - Elo):", x_static.slice(-5));
  console.log("Sample Judge Indices:", judge_indices);

  // Verify comparative features in last timestep
  const lastTimestep = x_seq[x_seq.length - 1];
  console.log("\nSample Comparative Features (Relative Total Score):", lastTimestep[57]);
  console.log("Sample Comparative Features (Last 10):", lastTimestep.slice(-10));

  db.close();
} catch (e: any) {
  console.error("Verification failed:", e.message);
}
