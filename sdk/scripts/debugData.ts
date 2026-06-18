
import Database from 'better-sqlite3';
const db = new Database('./dci-relational.db', { readonly: true });

function main() {
  const table = 'caption_scores';
  const count = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  console.log(`Row count for ${table}: ${count.c}`);

  // Sample rows
  console.log(`Sample rows from ${table}:`);
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT 5`).all();
  console.log(rows);

  // Check joinability
  console.log(`Checking join between corps_scores and caption_scores...`);
  const joinCount = db.prepare(`
        SELECT COUNT(*) as c 
        FROM corps_scores cs
        JOIN caption_scores caps ON caps.competition_slug = cs.competition_slug AND caps.corps_key = cs.corps_key
    `).get() as { c: number };
  console.log(`Join count: ${joinCount.c}`);
}

main();
