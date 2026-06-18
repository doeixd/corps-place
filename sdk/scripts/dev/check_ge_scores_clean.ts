import { createClient } from "@libsql/client";

const DB_PATH = "./dci-relational.db";

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });

  const geTotal = await client.execute({
    sql: "SELECT AVG(score) as avg, MIN(score) as min, MAX(score) as max, COUNT(*) as count FROM caption_scores WHERE caption_name = 'General Effect'",
    args: []
  });

  const ge1 = await client.execute({
    sql: "SELECT AVG(score) as avg, MIN(score) as min, MAX(score) as max, COUNT(*) as count FROM caption_scores WHERE caption_name = 'General Effect 1'",
    args: []
  });

  console.log("General Effect (Total):", geTotal.rows[0]);
  console.log("General Effect 1:", ge1.rows[0]);

  client.close();
}

main();
