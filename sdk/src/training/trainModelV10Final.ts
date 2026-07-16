/**
 * Canonical post-final2 V10 entrypoint.
 *
 * The older trainModelV10.ts is a recovered pre-V9 experiment and is deliberately
 * preserved for archaeology. This entrypoint inherits the verified V9.5 engine
 * and applies V10's versioned architecture/optimization profile.
 */
import { mergeV10Args } from "./v10Config.js";

const userArgs = process.argv.slice(2);
const seedIndex = userArgs.indexOf("--seed");
const requestedSeed = seedIndex >= 0 ? Number(userArgs[seedIndex + 1]) : 43;
process.argv = [
  process.argv[0]!,
  process.argv[1]!,
  ...mergeV10Args(userArgs, Number.isFinite(requestedSeed) ? requestedSeed : 43),
];

await import("./trainModelV95.js");
