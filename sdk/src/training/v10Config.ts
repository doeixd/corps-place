export const V10_PROFILE_NAMES = [
  "clean-data-control",
  "field-pace",
  "thin-history",
  "support-aware-identity",
  "scaled-control",
  "phase-aware-lr",
  "smooth-sequence",
  "combined-candidate",
] as const;

export type V10ProfileName = (typeof V10_PROFILE_NAMES)[number];

type V10Profile = {
  modelVersion: string;
  parentModel: string;
  dataContract: string;
  featureProfile: string;
  mlTable: string;
  expectedTrainableParameters: number | null;
  runnable: boolean;
  blockedReason: string;
  args: readonly string[];
};

const exactSizeArgs = [
  "--lstm1-units", "128",
  "--lstm2-units", "64",
  "--dense1-units", "512",
  "--dense2-units", "256",
  "--accuracy-trunk-units", "270",
] as const;

const scaledArgs = [
  "--lstm1-units", "192",
  "--lstm2-units", "96",
  "--dense1-units", "768",
  "--dense2-units", "384",
  "--accuracy-trunk-units", "405",
] as const;

const final2RegimenArgs = [
  "--lr", "0.00075",
  "--lr-schedule", "cosine",
  "--auto-curriculum", "true",
  "--curriculum-phase-a-end", "10",
  "--curriculum-phase-b-end", "40",
  "--sequence-transition-epochs", "0",
] as const;

const fixedRegimenArgs = [
  "--auto-curriculum", "false",
  "--curriculum-phase-a-end", "10",
  "--curriculum-phase-b-end", "40",
] as const;

const treatmentBlockedReason =
  "Treatment is blocked until the clean-data control qualifies and this treatment is evaluated independently";

export const V10_PROFILES: Readonly<Record<V10ProfileName, V10Profile>> = {
  "clean-data-control": {
    modelVersion: "v10-clean-control-dev1",
    parentModel: "v9.5-final2-compatible",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v9.5-220-control",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_034_259,
    runnable: true,
    blockedReason: "",
    args: [...exactSizeArgs, ...final2RegimenArgs],
  },
  "field-pace": {
    modelVersion: "v10-field-pace-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v10-field-pace-p1-pending",
    mlTable: "ml_sequence_rows_v10_field_pace",
    expectedTrainableParameters: 1_037_451,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [...exactSizeArgs, ...final2RegimenArgs],
  },
  "thin-history": {
    modelVersion: "v10-thin-history-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v10-thin-history-p2-p3-dev1",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_034_259,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [
      ...exactSizeArgs,
      ...final2RegimenArgs,
      "--thin-history-sample-fraction", "0.45",
      "--thin-history-truncation-rate", "0.25",
      "--thin-history-baseline-blend", "true",
    ],
  },
  "support-aware-identity": {
    modelVersion: "v10-support-aware-identity-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v10-support-aware-identity-dev1",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_034_259,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [
      ...exactSizeArgs,
      ...final2RegimenArgs,
      "--support-aware-identity", "true",
      "--support-dropout-strength", "0.6",
    ],
  },
  "scaled-control": {
    modelVersion: "v10-scaled-control-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v9.5-220-control",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_962_558,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [...scaledArgs, ...final2RegimenArgs],
  },
  "phase-aware-lr": {
    modelVersion: "v10-phase-aware-lr-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v9.5-220-control",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_034_259,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [
      ...exactSizeArgs,
      ...fixedRegimenArgs,
      "--lr", "0.00075",
      "--lr-schedule", "phase-aware",
      "--sequence-transition-epochs", "0",
    ],
  },
  "smooth-sequence": {
    modelVersion: "v10-smooth-sequence-dev1",
    parentModel: "v10-clean-control-dev1",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v9.5-220-control",
    mlTable: "ml_sequence_rows_v10_clean_control",
    expectedTrainableParameters: 1_034_259,
    runnable: false,
    blockedReason: treatmentBlockedReason,
    args: [
      ...exactSizeArgs,
      ...fixedRegimenArgs,
      "--lr", "0.00075",
      "--lr-schedule", "cosine",
      "--sequence-transition-epochs", "4",
    ],
  },
  "combined-candidate": {
    modelVersion: "v10-combined-candidate-dev1",
    parentModel: "v10-ablation-winners-pending",
    dataContract: "v10-sequence-contract-dev1",
    featureProfile: "v10-combined-pending",
    mlTable: "ml_sequence_rows_v10_final",
    expectedTrainableParameters: null,
    runnable: false,
    blockedReason:
      "Combined V10 is blocked until clean-data, feature, phase-aware LR, smooth-sequence, and scale treatments qualify independently",
    args: [
      ...scaledArgs,
      ...fixedRegimenArgs,
      "--lr", "0.00065",
      "--lr-schedule", "phase-aware",
      "--sequence-transition-epochs", "4",
    ],
  },
};

export const getV10Profile = (name: string): V10Profile => {
  if (!V10_PROFILE_NAMES.includes(name as V10ProfileName)) {
    throw new Error(`Unknown V10 profile '${name}'. Expected one of: ${V10_PROFILE_NAMES.join(", ")}`);
  }
  return V10_PROFILES[name as V10ProfileName];
};

export const v10DefaultArgs = (profileName: V10ProfileName, seed = 43): string[] => {
  const profile = V10_PROFILES[profileName];
  const slug = profileName.replaceAll("-", "_");
  return [
    "--db", "./data/v10-training-dev1.db",
    "--ml-table", profile.mlTable,
    "--model-dir", `./models/v10_${slug}`,
    "--norm-path", `./results/v10-${profileName}-seed-${seed}-target-norm.json`,
    "--log-csv", `./results/v10-${profileName}-seed-${seed}-training-log.csv`,
    "--model-version", profile.modelVersion,
    "--parent-model", profile.parentModel,
    "--data-contract", profile.dataContract,
    "--feature-profile", profile.featureProfile,
    "--judge-count", "214",
    "--corps-count", "56",
    "--show-count", "301",
    "--raw-static-dim", profileName === "field-pace" ? "216" : "212",
    "--judge-map", "./src/training/v10/dev1/judgeIndexMap.json",
    "--corps-map", "./src/training/v10/dev1/corpsIndexMap.json",
    "--show-map", "./src/training/v10/dev1/showIndexMap.json",
    "--identity-support", "./src/training/v10/dev1/identitySupport.json",
    "--pareto-checkpoints", "8",
    "--reference-curves", "./src/training/v10/dev1/referenceCurves.json",
    "--seed", String(seed),
    "--trial-id", `v10_${slug}_seed${seed}`,
    ...profile.args,
  ];
};

export const mergeV10Args = (
  profileName: V10ProfileName,
  userArgs: readonly string[],
  seed = 43,
): string[] => {
  const merged = [...userArgs];
  const defaults = v10DefaultArgs(profileName, seed);
  for (let index = 0; index < defaults.length; index += 2) {
    const flag = defaults[index]!;
    if (!merged.includes(flag)) merged.push(flag, defaults[index + 1]!);
  }
  return merged;
};
