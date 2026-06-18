import { createClient } from "@libsql/client";

async function checkDatabase() {
  console.log("Checking database...");

  const paths = [
    "file:./dci-relational.db",
    "file:../dci-relational.db",
    "file:../../dci-relational.db"
  ];

  for (const path of paths) {
    console.log(`\nTrying path: ${path}`);
    try {
      const client = createClient({ url: path });
      const result = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' LIMIT 10"
      });
      console.log(`✓ Connected! Found ${result.rows.length} tables:`);
      for (const row of result.rows) {
        console.log(`  - ${row.name}`);
      }
      client.close();
      console.log(`\n✅ Use this path: ${path}`);
      return;
    } catch (error) {
      console.log(`✗ Failed: ${error.message}`);
    }
  }
}

checkDatabase();
