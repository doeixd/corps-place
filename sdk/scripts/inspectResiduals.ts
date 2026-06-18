
import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db', { readonly: true });

const rows = db.prepare(`SELECT season, corps_key, y_residuals_json FROM ml_sequence_rows_v4 LIMIT 5`).all();
rows.forEach((r: any) => {
  console.log(`Season: ${r.season}, Corps: ${r.corps_key}`);
  console.log(`Residuals: ${r.y_residuals_json}`);
});
