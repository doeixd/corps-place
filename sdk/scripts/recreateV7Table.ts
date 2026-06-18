import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./dci-relational.db" });

// Drop the old V7 table
await client.execute({ sql: "DROP TABLE IF EXISTS ml_sequence_rows_v7" });
console.log("Dropped old ml_sequence_rows_v7 table");

// Recreate with new schema
await client.execute({ sql: `
  CREATE TABLE ml_sequence_rows_v7 (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    season TEXT NOT NULL,
    competition_slug TEXT NOT NULL,
    competition_date TEXT NOT NULL,
    division_name TEXT NOT NULL,
    corps_key TEXT NOT NULL,
    x_sequence_json TEXT NOT NULL,
    x_static_json TEXT NOT NULL,
    judge_indices_json TEXT NOT NULL,
    y_residuals_json TEXT NOT NULL,
    y_recap_json TEXT NOT NULL,
    y_total REAL NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(season, competition_slug, division_name, corps_key)
  )
` });

console.log("✅ Created ml_sequence_rows_v7 with updated schema");

client.close();
