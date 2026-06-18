import Database from 'better-sqlite3';

const db = new Database('./dci-relational.db', { readonly: true });
const slug = '2024-dci-world-championship-finals';

console.log(`--- Judge Scores for ${slug} ---`);
const judges = db.prepare(`
  SELECT DISTINCT caption_name 
  FROM judge_scores 
  WHERE competition_slug = ? 
  ORDER BY caption_name
`).all(slug);
console.log(judges);
