import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";

const checkSubcaptionFeatures = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Checking subcaption feature coverage...");

  const rows = yield* (sql<{
    competition_slug: string;
    corps_key: string;
    x_static_json: string;
  }>`SELECT competition_slug, corps_key, x_static_json FROM ml_sequence_rows_v9_subcaption WHERE season IN ('2023', '2024') LIMIT 20`);

  let totalRows = 0;
  let rowsWithSubcaptionData = 0;

  for (const row of rows) {
    totalRows++;
    const features = JSON.parse(row.x_static_json);

    // Subcaption features are the last 32 features (indices 137-168)
    const lastContentByCaption = features.slice(137, 145);  // 8 features
    const lastAchievementByCaption = features.slice(145, 153);  // 8 features
    const emaContentByCaption = features.slice(153, 161);  // 8 features
    const emaAchievementByCaption = features.slice(161, 169);  // 8 features

    const hasSubcaptionData = lastContentByCaption.some((v: number) => v > 0) ||
                              lastAchievementByCaption.some((v: number) => v > 0);

    if (hasSubcaptionData) {
      rowsWithSubcaptionData++;
    }

    console.log(`${row.competition_slug} | ${row.corps_key}`);
    console.log(`  Last Content: [${lastContentByCaption.map((v: number) => v.toFixed(3)).join(', ')}]`);
    console.log(`  Last Achievement: [${lastAchievementByCaption.map((v: number) => v.toFixed(3)).join(', ')}]`);
    console.log(`  EMA Content: [${emaContentByCaption.map((v: number) => v.toFixed(3)).join(', ')}]`);
    console.log(`  EMA Achievement: [${emaAchievementByCaption.map((v: number) => v.toFixed(3)).join(', ')}]`);
    console.log(`  Has subcaption data: ${hasSubcaptionData}`);
    console.log('');
  }

  console.log(`\nSummary:`);
  console.log(`  Total rows checked: ${totalRows}`);
  console.log(`  Rows with subcaption data: ${rowsWithSubcaptionData} (${(rowsWithSubcaptionData / totalRows * 100).toFixed(1)}%)`);
  console.log(`  Rows without subcaption data: ${totalRows - rowsWithSubcaptionData} (${((totalRows - rowsWithSubcaptionData) / totalRows * 100).toFixed(1)}%)`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(checkSubcaptionFeatures.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("\nDone."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
