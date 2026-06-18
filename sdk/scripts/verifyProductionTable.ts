import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');
const rows = db.prepare("SELECT split, COUNT(*) as count FROM ml_sequence_rows_v6_production GROUP BY split").all();
console.log(rows);
db.close();
