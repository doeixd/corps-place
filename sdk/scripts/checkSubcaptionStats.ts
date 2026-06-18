import { createClient } from "@libsql/client";

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });
  const res = await client.execute("SELECT y_subcaption_json FROM ml_sequence_rows_v9subcaption_mtl");

  let rowsWithSub = 0;
  let totalRows = res.rows.length;

  const captionCounts: Record<string, number> = {};

  for (const row of res.rows) {
    const subRecap = JSON.parse(row.y_subcaption_json as string);
    let hasSub = false;
    for (const cap in subRecap) {
      if (subRecap[cap].content > 0 || subRecap[cap].achievement > 0) {
        hasSub = true;
        captionCounts[cap] = (captionCounts[cap] || 0) + 1;
      }
    }
    if (hasSub) rowsWithSub++;
  }

  console.log(`Total rows: ${totalRows}`);
  console.log(`Rows with at least ONE non-zero subcaption: ${rowsWithSub} (${((rowsWithSub / totalRows) * 100).toFixed(1)}%)`);
  console.log("Counts per caption:");
  console.log(JSON.stringify(captionCounts, null, 2));

  await client.close();
}

main().catch(console.error);
