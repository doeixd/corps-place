import { createClient } from "@libsql/client";

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });

  // Check a few samples from the rebuilt table
  const result = await client.execute(`
    SELECT 
      y_subbaselines_json,
      y_subcaption_json,
      y_recap_json,
      corps_key,
      competition_slug
    FROM ml_sequence_rows_v9subcaption_mtl 
    LIMIT 10
  `);

  console.log("=== Checking y_subbaselines_json values ===\n");

  for (const row of result.rows) {
    const subBaselines = row.y_subbaselines_json ? JSON.parse(row.y_subbaselines_json as string) : null;
    const subcaptions = JSON.parse(row.y_subcaption_json as string);
    const recap = JSON.parse(row.y_recap_json as string);

    console.log(`Corps: ${row.corps_key}, Show: ${row.competition_slug}`);
    console.log(`  SubBaselines: ${JSON.stringify(subBaselines)}`);
    console.log(`  Subcaptions: ${JSON.stringify(subcaptions)}`);
    console.log(`  Recap GE1: ${recap.GE1}`);

    if (subBaselines && subcaptions) {
      // Calculate what the residuals would be
      const ge1ContentResidual = (subcaptions.GE1?.content ?? 0) - (subBaselines.GE1?.content ?? 0);
      const ge1AchResidual = (subcaptions.GE1?.achievement ?? 0) - (subBaselines.GE1?.achievement ?? 0);
      console.log(`  GE1 Content Residual: ${ge1ContentResidual.toFixed(2)}`);
      console.log(`  GE1 Achievement Residual: ${ge1AchResidual.toFixed(2)}`);
    }
    console.log("");
  }

  // Also check stats
  const statsResult = await client.execute(`
    SELECT 
      AVG(json_extract(y_subbaselines_json, '$.GE1.content')) as avg_ge1_cont_baseline,
      AVG(json_extract(y_subcaption_json, '$.GE1.content')) as avg_ge1_cont_actual
    FROM ml_sequence_rows_v9subcaption_mtl
  `);

  console.log("=== Aggregate Stats ===");
  console.log(`Avg GE1 Content Baseline: ${statsResult.rows[0]?.avg_ge1_cont_baseline}`);
  console.log(`Avg GE1 Content Actual: ${statsResult.rows[0]?.avg_ge1_cont_actual}`);

  await client.close();
}

main().catch(console.error);
