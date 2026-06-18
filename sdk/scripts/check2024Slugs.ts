import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');
const rows = db.prepare("SELECT slug, date, event_name FROM competitions WHERE season = '2024' AND (slug LIKE '%final%' OR event_name LIKE '%Final%') ORDER BY date DESC").all();

console.log(JSON.stringify(rows, null, 2));
db.close();
