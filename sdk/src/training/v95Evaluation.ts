export type EvaluationRow = {
  showKey: string;
  date: string;
  division: string;
  competitionSlug: string;
  seqMask: readonly boolean[];
  stat: readonly number[];
};

export type ValidationSplitConfig = {
  valMode: string;
  valSplit: number;
  valDateCutoff?: string;
  seed: number;
};

const seededRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
};

const shuffle = <T>(values: readonly T[], rng: () => number): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
};

const groupByShow = <T extends Pick<EvaluationRow, "showKey">>(rows: readonly T[]) => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.showKey) ?? [];
    group.push(row);
    groups.set(row.showKey, group);
  }
  return [...groups.values()];
};

const preserveTrainPopulation = <T extends Pick<EvaluationRow, "showKey">>(
  trainRows: T[],
  valRows: T[],
) => {
  if (trainRows.length !== 0 || valRows.length <= 1) return;
  const firstValShow = valRows[0]?.showKey;
  const moved = valRows.filter((row) => row.showKey === firstValShow);
  const movedSet = new Set(moved);
  valRows.splice(0, valRows.length, ...valRows.filter((row) => !movedSet.has(row)));
  trainRows.push(...moved);
};

export const splitValidationRows = <T extends Pick<EvaluationRow, "showKey" | "date">>(
  rows: readonly T[],
  config: ValidationSplitConfig,
): { trainRows: T[]; valRows: T[]; resolvedMode: "date-forward" | "show-random" } => {
  const targetValRows = Math.max(1, Math.floor(rows.length * config.valSplit));
  const trainRows: T[] = [];
  const valRows: T[] = [];

  if (config.valMode === "date-forward") {
    const groups = groupByShow(rows).sort((left, right) => {
      const dateOrder = (left[0]?.date ?? "").localeCompare(right[0]?.date ?? "");
      return dateOrder || (left[0]?.showKey ?? "").localeCompare(right[0]?.showKey ?? "");
    });
    if (config.valDateCutoff) {
      for (const group of groups) {
        if ((group[0]?.date ?? "") >= config.valDateCutoff) valRows.push(...group);
        else trainRows.push(...group);
      }
    } else {
      for (let index = groups.length - 1; index >= 0; index--) {
        const group = groups[index]!;
        if (valRows.length < targetValRows) valRows.unshift(...group);
        else trainRows.unshift(...group);
      }
    }
    preserveTrainPopulation(trainRows, valRows);
    return { trainRows, valRows, resolvedMode: "date-forward" };
  }

  const groups = shuffle(groupByShow(rows), seededRandom(config.seed));
  for (const group of groups) {
    if (valRows.length < targetValRows) valRows.push(...group);
    else trainRows.push(...group);
  }
  preserveTrainPopulation(trainRows, valRows);
  return { trainRows, valRows, resolvedMode: "show-random" };
};

export const FINAL2_EVALUATION_LABELS = [
  "validation",
  "validation_as_of_show_date",
  "test_all",
  "test_world_class",
  "test_open_class",
  "test_championship_week",
  "test_early_season",
  "test_sparse_history",
  "test_zero_history",
  "test_season_debut",
  "validation_panel_unknown",
  "test_panel_unknown",
  "validation_lineup_unknown",
  "test_lineup_unknown",
  "validation_preseason_forecast",
  "test_preseason_forecast",
] as const;

export type Final2EvaluationLabel = typeof FINAL2_EVALUATION_LABELS[number];

export const evaluationMaskRates = (label: string) => ({
  history: label.endsWith("_preseason_forecast") ? 1 : 0,
  judges: label.endsWith("_panel_unknown") || label.endsWith("_preseason_forecast") ? 1 : 0,
  forecastContext: label.endsWith("_preseason_forecast") ? 1 : 0,
  lineup: label.endsWith("_lineup_unknown") ? 1 : 0,
});

export const buildFinal2EvaluationRows = <T extends EvaluationRow>(
  validationRows: readonly T[],
  testRows: readonly T[],
  coldStartOffset: number,
): Record<Final2EvaluationLabel, T[]> => ({
  validation: [...validationRows],
  validation_as_of_show_date: [...validationRows],
  test_all: [...testRows],
  test_world_class: testRows.filter((row) => row.division === "World Class"),
  test_open_class: testRows.filter((row) => row.division === "Open Class"),
  test_championship_week: testRows.filter((row) => row.competitionSlug.includes("world-championship")),
  test_early_season: testRows.filter((row) => {
    const month = Number(row.date.slice(5, 7));
    const day = Number(row.date.slice(8, 10));
    return month < 7 || (month === 7 && day <= 7);
  }),
  test_sparse_history: testRows.filter((row) => row.seqMask.filter(Boolean).length <= 2),
  test_zero_history: testRows.filter((row) => row.seqMask.filter(Boolean).length === 0),
  test_season_debut: testRows.filter((row) => (row.stat[coldStartOffset] ?? 0) >= 0.5),
  validation_panel_unknown: [...validationRows],
  test_panel_unknown: [...testRows],
  validation_lineup_unknown: [...validationRows],
  test_lineup_unknown: [...testRows],
  validation_preseason_forecast: validationRows.filter((row) => row.seqMask.filter(Boolean).length > 0),
  test_preseason_forecast: testRows.filter((row) => row.seqMask.filter(Boolean).length > 0),
});
