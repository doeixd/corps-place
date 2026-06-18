import { createClient } from "@libsql/client";

const DB_PATH = "./dci-relational.db";

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });

  // Check "General Effect" scores
  const geTotal = await client.execute(`
    SELECT AVG(score) as avg_score, MIN(score) as min_score, MAX(score) as max_score, COUNT(*) as count 
    FROM caption_scores 
    WHERE caption_name = 'General Effect'
  `);

  // Check "General Effect 1" scores
  const ge1 = await client.execute(`
    SELECT AVG(score) as avg_score, MIN(score) as min_score, MAX(score) as max_score, COUNT(*) as count 
    FROM caption_scores 
    WHERE caption_name = 'General Effect 1'
  `);

  console.log("Caption: General Effect (Total GE?)");
  console.log(geTotal.rows[0]);

  console.log("\nCaption: General Effect 1 (Subcaption)");
  console.log(ge1.rows[0]);

  client.close();
}

main();
