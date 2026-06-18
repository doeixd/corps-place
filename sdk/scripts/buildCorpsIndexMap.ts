import { createClient } from '@libsql/client';
import * as fs from 'node:fs';

const DB_PATH = "./dci-relational.db";
const OUTPUT_PATH = "./src/training/corpsIndexMap.json";

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });
  const res = await client.execute('SELECT DISTINCT corps_key FROM corps ORDER BY corps_key');

  const map: Record<string, number> = { "unknown": 0 };
  res.rows.forEach((row, idx) => {
    map[row.corps_key as string] = idx + 1;
  });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(map, null, 2));
  client.close();
  console.log(`Created ${OUTPUT_PATH} with ${Object.keys(map).length} entries`);
}

main().catch(console.error);
