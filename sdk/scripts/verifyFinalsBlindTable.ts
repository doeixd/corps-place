import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');
const rows = db.prepare("SELECT split, COUNT(*) as count FROM ml_sequence_rows_v6_finals_blind GROUP BY split").all();
console.log(rows);
const testRows = db.prepare("SELECT competition_slug, corps_key FROM ml_sequence_rows_v6_finals_blind WHERE split = 'test'").all();
console.log('Test Examples:', testRows);
db.close();
