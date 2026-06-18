import { Effect } from "effect";
import { spawn } from "node:child_process";

// Spawns the ML training subprocess. v4 consolidated `@effect/platform/Command`
// into `effect/unstable/process`; for a one-shot job runner a plain node spawn
// wrapped in Effect.callback is simpler and keeps the error in the typed channel.
export const trainModelJob = (args: {
  db: string;
  out: string;
  featureSpec: string;
}) =>
  Effect.callback<void, Error>((resume) => {
    const child = spawn(
      "node",
      [
        "dist/ml/train/trainModel.js",
        "--db",
        args.db,
        "--out",
        args.out,
        "--featureSpec",
        args.featureSpec,
        "--useJudges",
        "1",
        "--maxJudges",
        "16",
        "--epochs",
        "200",
      ],
      { stdio: "inherit" }
    );

    child.on("error", (error) => resume(Effect.fail(error)));
    child.on("close", (code) => {
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(new Error(`Training failed with exit code ${code}`))
      );
    });
  });
