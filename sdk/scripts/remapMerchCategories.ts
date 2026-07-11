// One-off (idempotent) category cleanup over already-ingested merch_products:
// re-fold each stored category through the current CATEGORY_SYNONYMS, and bucket
// uncategorized products from their title. Future ingests apply the same rules
// at fetch time (merchCatalog.ts), so this only backfills existing rows.
//
// Usage (from sdk/):
//   npx tsx scripts/remapMerchCategories.ts --dry-run
//   npx tsx scripts/remapMerchCategories.ts

import { createClient } from "@libsql/client";
import { resolveCategory } from "../src/merchCatalog.js";

const dryRun = process.argv.includes("--dry-run");
const db = createClient({ url: "file:./dci-relational.db" });

const rows = await db.execute(
  "SELECT product_id, title, category FROM merch_products",
);

let changed = 0;
const updates: { id: string; cat: string | null }[] = [];
for (const r of rows.rows) {
  const id = String(r.product_id);
  const title = String(r.title ?? "");
  const current = r.category == null ? null : String(r.category);
  const next = resolveCategory(current, title);
  if (next !== current) {
    updates.push({ id, cat: next });
    changed++;
  }
}

console.log(`${rows.rows.length} products, ${changed} category changes`);

if (!dryRun) {
  for (const u of updates) {
    await db.execute({
      sql: "UPDATE merch_products SET category = ? WHERE product_id = ?",
      args: [u.cat, u.id],
    });
  }
}

const after = await db.execute(
  dryRun
    ? "SELECT category, COUNT(*) n FROM merch_products GROUP BY category ORDER BY n DESC"
    : "SELECT category, COUNT(*) n FROM merch_products GROUP BY category ORDER BY n DESC",
);
console.log(dryRun ? "\nCurrent facet (unchanged, dry run):" : "\nFacet after remap:");
for (const r of after.rows) console.log(`  ${r.category ?? "(none)"}: ${r.n}`);
db.close();
