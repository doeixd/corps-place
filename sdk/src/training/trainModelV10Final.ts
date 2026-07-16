/**
 * Canonical post-final2 V10 entrypoint.
 *
 * The older trainModelV10.ts is a recovered pre-V9 experiment and is deliberately
 * preserved for archaeology. This entrypoint inherits the verified V9.5 engine
 * and applies V10's versioned architecture/optimization profile.
 */
import { getV10Profile, mergeV10Args, V10_PROFILE_NAMES, type V10ProfileName } from "./v10Config.js";

const userArgs = process.argv.slice(2);
const profileIndex = userArgs.indexOf("--profile");
if (profileIndex < 0 || !userArgs[profileIndex + 1]) {
  throw new Error(`V10 requires --profile <${V10_PROFILE_NAMES.join("|")}>; there is no implicit combined default.`);
}
const profileName = userArgs[profileIndex + 1] as V10ProfileName;
const profile = getV10Profile(profileName);
if (!profile.runnable) {
  throw new Error(`V10 profile '${profileName}' is not runnable: ${profile.blockedReason}`);
}
const trainerArgs = userArgs.filter((_, index) => index !== profileIndex && index !== profileIndex + 1);
const seedIndex = userArgs.indexOf("--seed");
const requestedSeed = seedIndex >= 0 ? Number(userArgs[seedIndex + 1]) : 43;
process.argv = [
  process.argv[0]!,
  process.argv[1]!,
  ...mergeV10Args(profileName, trainerArgs, Number.isFinite(requestedSeed) ? requestedSeed : 43),
];

await import("./trainModelV95.js");
