import Database from 'better-sqlite3';

const db = new Database('./dci-relational.db', { readonly: true });

console.log('--- Caption Scores ---');
const caps = db.prepare(`SELECT DISTINCT caption_name FROM caption_scores ORDER BY caption_name`).all();
console.log(caps);

console.log('--- Subcaption Scores ---');
const subcaps = db.prepare(`SELECT DISTINCT subcaption_name FROM subcaption_scores ORDER BY subcaption_name`).all();
console.log(subcaps);

console.log('--- Judge Scores (Caption Column) ---');
const judges = db.prepare(`SELECT DISTINCT caption_name FROM judge_scores ORDER BY caption_name`).all();
console.log(judges);
