// scripts/runWithLogging.ts
import { execSync } from "child_process";
import * as fs from "fs";

try {
  const output = execSync("npx tsx scripts/computeEloRatingsV7.ts", { stdio: "pipe" });
  fs.writeFileSync("elo_output.log", output.toString());
} catch (e: any) {
  fs.writeFileSync("elo_error.log", e.stdout?.toString() + "\n" + e.stderr?.toString() + "\n" + e.message);
  console.error("Failed, see elo_error.log");
}
