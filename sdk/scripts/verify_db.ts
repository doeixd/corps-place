
import Database from 'better-sqlite3';

const db = new Database('./dci-relational.db');

const rows = db.prepare('SELECT season, x_numeric_json, feature_version FROM ml_training_rows LIMIT 5').all();

console.log(`Found ${rows.length} rows.`);

for (const row of rows) {
  const vec = JSON.parse(row.x_numeric_json);
  console.log(`Season: ${row.season}, Version: ${row.feature_version}, Vector Length: ${vec.length}`);
}

const count = db.prepare('SELECT COUNT(*) as c FROM ml_training_rows').get();
console.log('Total rows:', count.c);
