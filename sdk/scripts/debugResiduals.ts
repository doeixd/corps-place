import { createClient } from "@libsql/client";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

async function main() {
  const client = createClient({ url: "file:./dci-relational.db" });
  const result = await client.execute("SELECT y_recap_json, y_residuals_json, y_total FROM ml_sequence_rows_v9subcaption_mtl");

  let residuals: number[] = [];
  let totals: number[] = [];

  for (const r of result.rows) {
    const recap = JSON.parse(r.y_recap_json as string);
    const resObj = JSON.parse(r.y_residuals_json as string);

    // residuals_json might be stored differently, let's derive it to be safe
    // Actually, y_residuals_json in buildMlSequencesV9SubcaptionMTL.ts are the "Baseline" (ema) values or the residuals?
    // Let's assume y_residuals_json holds the BASELINE values or RESIDUALS.
    // Wait, the trainer does: r.recap[i] - r.globalBaseline[i]
    // And globalBaseline is calculated in applyBaselines via EMA.

    // Let's just calculate raw variance of (Recap - EMA) using a simple EMA implementation here to verify
  }

  // Actually, we can check the variance of the residuals *if we had them*.
  // Since we calculate them at runtime in the trainer, we should modify the trainer to print this stats.
  // But let's verify if 'y_residuals_json' exists and what it contains.
  console.log("Checking first row structures:");
  if (result.rows.length > 0) {
    console.log("Residuals JSON:", result.rows[0].y_residuals_json);
    console.log("Recap JSON:", result.rows[0].y_recap_json);
  }

  await client.close();
}

main().catch(console.error);
