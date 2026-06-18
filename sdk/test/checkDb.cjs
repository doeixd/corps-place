// test/checkDb.cjs
// CommonJS check script
const Database = require("better-sqlite3");

try {
  const db = new Database("./dci-relational.db");

  console.log("Database opened successfully");

  // List tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("\nTables found:", tables.length);
  for (const t of tables) {
    console.log(" -", t.name);
  }

  // Try to check competitions
  try {
    const comp = db.prepare("SELECT COUNT(*) as cnt FROM competitions").get();
    console.log("\nCompetitions:", comp.cnt);

    const comp2024 = db.prepare("SELECT COUNT(*) as cnt FROM competitions WHERE season = '2024'").get();
    console.log("2024 competitions:", comp2024.cnt);
  } catch (e) {
    console.log("\ncompetitions table error:", e.message);
  }

  // Try corps_scores
  try {
    const cs = db.prepare("SELECT COUNT(*) as cnt FROM corps_scores").get();
    console.log("Corps scores:", cs.cnt);
  } catch (e) {
    console.log("corps_scores table error:", e.message);
  }

  // Try ml_training_rows
  try {
    const ml = db.prepare("SELECT COUNT(*) as cnt FROM ml_training_rows").get();
    console.log("ML training rows:", ml.cnt);
  } catch (e) {
    console.log("ml_training_rows table does not exist (need to generate)");
  }

  db.close();
} catch (e) {
  console.error("Error opening database:", e.message);
}
