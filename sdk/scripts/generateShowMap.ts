import { createClient } from "@libsql/client";
import * as fs from "node:fs";

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });
  const result = await client.execute("SELECT DISTINCT slug FROM competitions");
  client.close();

  const agnosticSlugs = new Set<string>();
  for (const row of result.rows as any[]) {
    const fullSlug = row.slug as string;
    const agnosticSlug = fullSlug.replace(/^\d{4}-/, "");
    agnosticSlugs.add(agnosticSlug);
  }

  const sortedSlugs = Array.from(agnosticSlugs).sort();
  const map: Record<string, number> = {};
  sortedSlugs.forEach((slug, index) => {
    map[slug] = index + 1; // 1-indexed, 0 for unknown
  });

  const outputPath = "./src/training/showIndexMap.json";
  fs.writeFileSync(outputPath, JSON.stringify(map, null, 2));
  console.log(`Saved ${sortedSlugs.length} agnostic shows to ${outputPath}`);
}

main().catch(console.error);
