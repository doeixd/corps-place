import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as fs from "node:fs";
import {
  CAPTIONS,
  ensureBayesianStateTable,
  updateBayesianStatesForShow,
} from "../src/bayesianAdjustmentV5.js";

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    input: get("--input")!,
    db: get("--db", "./dci-relational.db")!,
    variance: Number(get("--variance", "1")),
  };
}

type InputEntry = {
  corps_key: string;
  season: string;
  errors: Partial<Record<(typeof CAPTIONS)[number], number>>;
};

type InputFile = {
  entries: InputEntry[];
};

const updateFromFile = (input: InputFile, variance: number) =>
  Effect.gen(function* () {
    yield* (ensureBayesianStateTable);

    yield* (
      Effect.forEach(
        input.entries,
        (entry) =>
          updateBayesianStatesForShow(entry.corps_key, entry.season, entry.errors as Record<string, number>, variance),
        { concurrency: 20, discard: true }
      )
    );
  });

const main = () => {
  const args = parseArgs();
  if (!args.input) throw new Error("--input is required");

  const payload = JSON.parse(fs.readFileSync(args.input, "utf-8")) as InputFile;

  const SqlLayer = LibsqlClient.layer({ url: `file:${args.db}` });
  return Effect.runPromise(updateFromFile(payload, args.variance).pipe(Effect.provide(SqlLayer)));
};

main()
  .then(() => console.log("Bayesian adjustments updated."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
