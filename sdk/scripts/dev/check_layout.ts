import { createClient } from "@libsql/client";

const DB_PATH = "./dci-relational.db";
const RESIDUAL_OFFSET = 14;
const CAPTION_STRIDE = 4;

async function main() {
  const client = createClient({ url: `file:${DB_PATH}` });
  const result = await client.execute(`
    SELECT x_sequence_json FROM ml_sequence_rows_v7 LIMIT 1
  `);

  const row = result.rows[0] as { x_sequence_json: string };
  const seq = JSON.parse(row.x_sequence_json) as number[][];

  // Look at the last step (most recent)
  const lastStep = seq[seq.length - 1];

  console.log("Checking feature values for first caption (GE1)...");
  console.log(`Index ${RESIDUAL_OFFSET} (Residual?):`, lastStep[RESIDUAL_OFFSET]);
  console.log(`Index ${RESIDUAL_OFFSET + 1} (Recap?):`, lastStep[RESIDUAL_OFFSET + 1]);
  console.log(`Index ${RESIDUAL_OFFSET + 2}:`, lastStep[RESIDUAL_OFFSET + 2]);
  console.log(`Index ${RESIDUAL_OFFSET + 3}:`, lastStep[RESIDUAL_OFFSET + 3]);

  // Check GE2 (next set of 4)
  const GE2_OFFSET = RESIDUAL_OFFSET + CAPTION_STRIDE;
  console.log("\nChecking feature values for second caption (GE2)...");
  console.log(`Index ${GE2_OFFSET} (Residual?):`, lastStep[GE2_OFFSET]);
  console.log(`Index ${GE2_OFFSET + 1} (Recap?):`, lastStep[GE2_OFFSET + 1]);

  client.close();
}

main();
