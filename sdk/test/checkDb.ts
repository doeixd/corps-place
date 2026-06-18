// test/checkDb.ts
// Quick script to check database state
import Database from "better-sqlite3";

const db = new Database("./dci-relational.db");

console.log("=== Database Check ===\n");

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log("Tables:", tables.map(t => t.name).join(", "));
console.log("");

// Check for ML tables
const hasMlRows = tables.some(t => t.name === "ml_training_rows");
if (hasMlRows) {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ml_training_rows").get() as { cnt: number };
  console.log("ML training rows:", count.cnt);

  const sample = db.prepare("SELECT season, division_name, COUNT(*) as cnt FROM ml_training_rows GROUP BY season, division_name").all();
  console.log("By season/division:", sample);
} else {
  console.log("ml_training_rows table does NOT exist - need to run data generation first");
}

// Check corps_scores
const scoresCount = db.prepare("SELECT COUNT(*) as cnt FROM corps_scores").get() as { cnt: number };
console.log("\nCorps scores:", scoresCount.cnt);

// Check competitions
const compCount = db.prepare("SELECT COUNT(*) as cnt FROM competitions").get() as { cnt: number };
console.log("Competitions:", compCount.cnt);

// Check 2024 data specifically
const comp2024 = db.prepare("SELECT COUNT(*) as cnt FROM competitions WHERE season = '2024'").get() as { cnt: number };
console.log("2024 competitions:", comp2024.cnt);

db.close();
console.log("\n=== Done ===");
