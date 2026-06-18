// Repeatable judge biography research via the Claude judge scraper.
//
// Builds per-judge research prompts (DB-grounded with seasons/captions/corps),
// runs them through the Claude CLI (`claude -p`), and upserts the resulting
// JudgeBioProfile rows. Judges are ranked by assignment volume, so `--top N`
// researches the most-active judges first.
//
// Usage:
//   npx tsx scripts/researchJudges.ts --top 12              # top 12 by assignments
//   npx tsx scripts/researchJudges.ts --judge c-nelson-1 --judge w-dillon-1
//   npx tsx scripts/researchJudges.ts --top 25 --concurrency 2
//   npx tsx scripts/researchJudges.ts --top 5 --dry-run     # build prompts, no live calls
//
// Notes:
// - The top 12 were already researched + applied via the higher-quality manual
//   path (results/judge-bios-20260610.json + scripts/applyJudgeBios.ts). This
//   script is for scaling to the remaining judges.
// - Live runs require the `claude` CLI to have web tools (WebSearch/WebFetch)
//   enabled; validate on a single judge before a bulk run.

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { runClaudeJudgeScraper } from "../src/scraperClaude.js";
import { DciApiDbBackedLive } from "../src/dbBackedApi.js";

const argValues = (name: string): string[] => {
  const out: string[] = [];
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i]!;
    if (arg.startsWith(prefix)) out.push(arg.slice(prefix.length));
    else if (arg === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
};
const argValue = (name: string) => argValues(name)[0];

const judgeIds = argValues("judge");
const top = argValue("top") ? Number(argValue("top")) : undefined;
const concurrency = argValue("concurrency") ? Number(argValue("concurrency")) : 1;
const dryRun = process.argv.includes("--dry-run");
const seasons = argValues("season");

const main = Effect.gen(function* () {
  const stats = yield* (
    runClaudeJudgeScraper({
      targetJudgeIds: judgeIds.length > 0 ? judgeIds : undefined,
      maxTasks: top,
      concurrency,
      dryRun,
      targetSeasons: seasons.length > 0 ? seasons : undefined,
      logPrompts: dryRun
    })
  );
  yield* (
    Effect.logInfo(
      `Judge research complete: ${stats.judges} judges, ${stats.media} media, ` +
        `${stats.skipped} skipped across ${stats.seasons} seasons.`
    )
  );
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(
  main.pipe(Effect.provide(DciApiDbBackedLive), Effect.provide(SqlLayer))
).catch((error) => {
  console.error("researchJudges failed:", error);
  process.exitCode = 1;
});
