import { createClient } from "@libsql/client";

async function listAllTables() {
  const client = createClient({ url: "file:./dci-relational.db" });
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  });
  console.log(`Found ${result.rows.length} tables:\n`);
  for (const row of result.rows) {
    console.log(`  ${row.name}`);
  }
  client.close();
}

listAllTables();
