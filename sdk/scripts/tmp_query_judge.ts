import Database from 'better-sqlite3';

const db = new Database('./dci-relational.db', { readonly: true });

console.log('--- Judge Scores Sample ---');
const jz = db.prepare(`SELECT * FROM judge_scores LIMIT 2`).all();
console.log(JSON.stringify(jz, null, 2));

console.log('--- Subcaption Scores Sample ---');
const subs = db.prepare(`SELECT * FROM subcaption_scores LIMIT 2`).all();
console.log(JSON.stringify(subs, null, 2));

console.log('--- Caption Scores Sample ---');
const caps = db.prepare(`SELECT * FROM caption_scores LIMIT 2`).all();
console.log(JSON.stringify(caps, null, 2));
