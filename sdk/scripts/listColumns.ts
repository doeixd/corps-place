
import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db', { readonly: true });
const stmt = db.prepare("PRAGMA table_info(caption_scores)");
const info = stmt.all();
console.log(JSON.stringify(info, null, 2));
