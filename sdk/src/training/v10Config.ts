export const V10_PROFILE = {
  modelVersion: "v10-dev1",
  parentModel: "v9.5-reconstructed-final2",
  dataContract: "canonical-clean-v10-dev1",
  featureProfile: "v9.5-220-control",
  mlTable: "ml_sequence_rows_v10_final",
  expectedTrainableParameters: 1_976_938,
  peakLearningRate: 0.00065,
  phaseAEnd: 10,
  phaseBEnd: 40,
  sequenceTransitionEpochs: 4,
} as const;

export const v10DefaultArgs = (seed = 43): string[] => [
  "--db", "./dci-relational.db",
  "--ml-table", V10_PROFILE.mlTable,
  "--model-dir", "./models/v10_candidate",
  "--norm-path", `./results/v10-dev1-seed-${seed}-target-norm.json`,
  "--log-csv", `./results/v10-dev1-seed-${seed}-training-log.csv`,
  "--model-version", V10_PROFILE.modelVersion,
  "--parent-model", V10_PROFILE.parentModel,
  "--data-contract", V10_PROFILE.dataContract,
  "--feature-profile", V10_PROFILE.featureProfile,
  "--seed", String(seed),
  "--trial-id", `v10_dev1_seed${seed}`,
  "--lstm1-units", "192",
  "--lstm2-units", "96",
  "--dense1-units", "768",
  "--dense2-units", "384",
  "--accuracy-trunk-units", "405",
  "--lr", String(V10_PROFILE.peakLearningRate),
  "--lr-schedule", "phase-aware",
  "--auto-curriculum", "false",
  "--curriculum-phase-a-end", String(V10_PROFILE.phaseAEnd),
  "--curriculum-phase-b-end", String(V10_PROFILE.phaseBEnd),
  "--sequence-transition-epochs", String(V10_PROFILE.sequenceTransitionEpochs),
];

export const mergeV10Args = (userArgs: readonly string[], seed = 43): string[] => {
  const merged = [...userArgs];
  const defaults = v10DefaultArgs(seed);
  for (let index = 0; index < defaults.length; index += 2) {
    const flag = defaults[index]!;
    if (!merged.includes(flag)) merged.push(flag, defaults[index + 1]!);
  }
  return merged;
};
