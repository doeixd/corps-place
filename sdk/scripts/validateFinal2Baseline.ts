import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type Check = {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
};

const sdkRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = path.join(sdkRoot, "src", "training", "baselines", "final2-baseline.json");
const argv = process.argv.slice(2);

const argValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const asRecord = (value: unknown, label: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
};

const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};

const at = (value: unknown, keys: readonly (string | number)[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
      continue;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonRecord)[key];
  }
  return current;
};

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, "utf8")) as unknown;

const sha256File = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const checks: Check[] = [];

const checkEqual = (name: string, actual: unknown, expected: unknown): void => {
  checks.push({ name, ok: Object.is(actual, expected), expected, actual });
};

const checkNumber = (name: string, actual: unknown, expected: unknown, tolerance = 1e-12): void => {
  const a = Number(actual);
  const e = Number(expected);
  checks.push({
    name,
    ok: Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= tolerance,
    expected: e,
    actual: a,
  });
};

const main = async (): Promise<void> => {
  const manifestPath = path.resolve(argValue("--manifest") ?? defaultManifestPath);
  const manifest = asRecord(await readJson(manifestPath), "baseline manifest");
  const configuredModelDir = String(manifest.model_dir ?? "");
  const modelDir = path.resolve(argValue("--model-dir") ?? path.join(sdkRoot, configuredModelDir));

  const artifactFiles = asRecord(manifest.artifact_files, "artifact_files");
  for (const [fileName, rawExpectation] of Object.entries(artifactFiles)) {
    const expectation = asRecord(rawExpectation, `artifact_files.${fileName}`);
    const filePath = path.join(modelDir, fileName);
    try {
      const fileStat = await stat(filePath);
      checkNumber(`artifact.${fileName}.bytes`, fileStat.size, expectation.bytes, 0);
      checkEqual(`artifact.${fileName}.sha256`, await sha256File(filePath), expectation.sha256);
    } catch (error) {
      checks.push({ name: `artifact.${fileName}.readable`, ok: false, expected: "readable", actual: String(error) });
    }
  }

  const modelCard = await readJson(path.join(modelDir, "model-card.json"));
  const trainingArgs = await readJson(path.join(modelDir, "training-args.json"));
  const modelJson = await readJson(path.join(modelDir, "model.json"));

  checkEqual("model_card.generated_at", at(modelCard, ["generated_at"]), manifest.generated_at);
  checkEqual("model_card.trainer", at(modelCard, ["trainer"]), manifest.trainer);
  checkNumber("data.rows", at(modelCard, ["data", "row_count"]), at(manifest, ["data", "rows"]), 0);
  checkNumber("data.world_rows", at(modelCard, ["data", "divisions", "World Class"]), at(manifest, ["data", "divisions", "World Class"]), 0);
  checkNumber("data.open_rows", at(modelCard, ["data", "divisions", "Open Class"]), at(manifest, ["data", "divisions", "Open Class"]), 0);

  const splitPaths: Array<[string, string]> = [
    ["val_mode", "mode"],
    ["train_rows", "train_rows"],
    ["validation_rows", "validation_rows"],
    ["test_rows", "test_rows"],
    ["train_shows", "train_shows"],
    ["validation_shows", "validation_shows"],
    ["test_shows", "test_shows"],
    ["validation_date_min", "validation_date_min"],
    ["validation_date_max", "validation_date_max"],
  ];
  for (const [cardKey, manifestKey] of splitPaths) {
    checkEqual(`split.${manifestKey}`, at(modelCard, ["split", cardKey]), at(manifest, ["split", manifestKey]));
  }

  const sourceHashes = asRecord(manifest.source_artifact_hashes, "source_artifact_hashes");
  const sourceHashPaths: Array<[string, string]> = [
    ["reference_curves", "reference_curves_sha256"],
    ["judge_index_map", "judge_index_map_sha256"],
    ["corps_index_map", "corps_index_map_sha256"],
    ["normalization", "normalization_sha256"],
  ];
  for (const [manifestKey, cardKey] of sourceHashPaths) {
    checkEqual(`source_hash.${manifestKey}`, at(modelCard, ["artifacts", cardKey]), sourceHashes[manifestKey]);
  }

  const expectedConfig = asRecord(manifest.training_config, "training_config");
  for (const [key, expected] of Object.entries(expectedConfig)) {
    checkEqual(`training_config.${key}`, at(trainingArgs, [key]), expected);
    checkEqual(`model_card.config.${key}`, at(modelCard, ["config", key]), expected);
  }

  const modelTopology = asRecord(at(modelJson, ["modelTopology"]), "modelTopology");
  const layers = asArray(at(modelTopology, ["config", "layers"]), "modelTopology.config.layers")
    .map((layer, index) => asRecord(layer, `layer[${index}]`));
  const layerByName = new Map(layers.map((layer) => [String(layer.name), layer]));
  const sequenceShape = at(layerByName.get("sequence"), ["config", "batch_input_shape"]);
  const staticShape = at(layerByName.get("static"), ["config", "batch_input_shape"]);
  checkEqual("model.sequence_shape", JSON.stringify(sequenceShape), JSON.stringify([null, at(manifest, ["dimensions", "sequence_length"]), at(manifest, ["dimensions", "sequence_features"])]));
  checkEqual("model.static_shape", JSON.stringify(staticShape), JSON.stringify([null, at(manifest, ["dimensions", "model_static_features"])]));

  const bidirectionalUnits = layers
    .filter((layer) => layer.class_name === "Bidirectional")
    .map((layer) => at(layer, ["config", "layer", "config", "units"]));
  checkEqual("model.bidirectional_lstm_units", JSON.stringify(bidirectionalUnits), JSON.stringify(at(manifest, ["architecture", "bidirectional_lstm_units"])));
  checkNumber("model.dense_trunk_1", at(layerByName.get("dense_Dense2"), ["config", "units"]), at(manifest, ["architecture", "dense_trunk_units", 0]), 0);
  checkNumber("model.dense_trunk_2", at(layerByName.get("dense_Dense3"), ["config", "units"]), at(manifest, ["architecture", "dense_trunk_units", 1]), 0);
  checkNumber("model.accuracy_trunk", at(layerByName.get("accuracy_trunk"), ["config", "units"]), at(manifest, ["architecture", "accuracy_trunk_units"]), 0);

  const metricChecks: Array<[string, readonly (string | number)[], readonly (string | number)[]]> = [
    ["metrics.validation.rows", ["evaluations", "validation", "metrics", "rows"], ["metrics", "validation", "rows"]],
    ["metrics.validation.recap_mae", ["evaluations", "validation", "metrics", "recap_mae_pts"], ["metrics", "validation", "recap_mae_pts"]],
    ["metrics.validation.total_mae", ["evaluations", "validation", "metrics", "total_mae_pts"], ["metrics", "validation", "total_mae_pts"]],
    ["metrics.validation.coverage", ["evaluations", "validation", "metrics", "coverage"], ["metrics", "validation", "coverage"]],
    ["metrics.validation.width", ["evaluations", "validation", "metrics", "width"], ["metrics", "validation", "width"]],
    ["metrics.calibration.scale", ["interval_calibration", "selected", "scale"], ["metrics", "calibrated_validation", "scale"]],
    ["metrics.calibration.coverage", ["interval_calibration", "selected", "coverage"], ["metrics", "calibrated_validation", "coverage"]],
    ["metrics.calibration.width", ["interval_calibration", "selected", "width"], ["metrics", "calibrated_validation", "width"]],
    ["metrics.preseason.rows", ["evaluations", "test_preseason_forecast", "metrics", "rows"], ["metrics", "preseason_forecast", "rows"]],
    ["metrics.preseason.total_mae", ["evaluations", "test_preseason_forecast", "metrics", "total_mae_pts"], ["metrics", "preseason_forecast", "total_mae_pts"]],
    ["metrics.established_history", ["evaluations", "validation", "by_history", "established_history", "total_mae_pts"], ["metrics", "history_total_mae", "established_history"]],
    ["metrics.short_history", ["evaluations", "validation", "by_history", "short_history", "total_mae_pts"], ["metrics", "history_total_mae", "short_history"]],
    ["metrics.sparse_history", ["evaluations", "validation", "by_history", "sparse_history", "total_mae_pts"], ["metrics", "history_total_mae", "sparse_history"]],
    ["metrics.zero_history", ["evaluations", "validation", "by_history", "zero_history", "total_mae_pts"], ["metrics", "history_total_mae", "zero_history"]],
    ["metrics.season_debut", ["evaluations", "validation", "by_forecast_mode", "season_debut", "total_mae_pts"], ["metrics", "history_total_mae", "season_debut"]],
    ["metrics.vs_inertia", ["baselines", "final_validation_vs_inertia_pts"], ["metrics", "baselines", "final_validation_vs_inertia_pts"]],
    ["metrics.vs_quadratic", ["baselines", "final_validation_vs_quadratic_pts"], ["metrics", "baselines", "final_validation_vs_quadratic_pts"]],
  ];
  for (const [name, cardPath, manifestPathKeys] of metricChecks) {
    checkNumber(name, at(modelCard, cardPath), at(manifest, manifestPathKeys));
  }

  const expectedTransitions = asArray(manifest.curriculum_transitions, "curriculum_transitions");
  const actualTransitions = asArray(at(modelCard, ["curriculum_transitions"]), "model-card curriculum_transitions");
  checkNumber("curriculum.transition_count", actualTransitions.length, expectedTransitions.length, 0);
  expectedTransitions.forEach((rawExpected, index) => {
    const expected = asRecord(rawExpected, `curriculum_transitions[${index}]`);
    for (const key of ["epoch", "from", "to", "reason"] as const) {
      checkEqual(`curriculum.${index}.${key}`, at(actualTransitions[index], [key]), expected[key]);
    }
  });

  const failures = checks.filter((check) => !check.ok);
  const report = {
    baseline: manifest.id,
    manifest: path.relative(sdkRoot, manifestPath),
    model_dir: path.relative(sdkRoot, modelDir),
    checks: checks.length,
    failures: failures.length,
    ok: failures.length === 0,
    failed_checks: failures,
  };

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (failures.length === 0) {
    process.stdout.write(`final2 baseline verified: ${checks.length} checks passed\n`);
  } else {
    process.stderr.write(`final2 baseline verification failed: ${failures.length}/${checks.length} checks failed\n`);
    for (const failure of failures) {
      process.stderr.write(`- ${failure.name}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}\n`);
    }
  }

  if (failures.length > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
