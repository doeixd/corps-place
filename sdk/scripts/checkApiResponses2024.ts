import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db');
const results = db.prepare('SELECT endpoint_url FROM api_responses WHERE endpoint_url LIKE ? LIMIT 5').all('%2024%');
console.log(results);
