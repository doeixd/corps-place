import { readFileSync } from "node:fs";

type SupportRow = {
  identity: string;
  performances?: number;
  covered_performances?: number;
  shows: number;
  seasons: number;
};

type SupportArtifact = {
  version: string;
  corps: SupportRow[];
  judges: SupportRow[];
  shows: SupportRow[];
};

export type TemporalIdentityEvidenceRow = {
  date: string;
  season: string;
  corpsKey: string;
  judgeIndices: readonly number[];
  showIndex: number;
};

export type TemporalIdentityTrust = {
  corpsTrust: number;
  judgeTrust: number[];
  showTrust: number;
};

export const evidenceTrust = (observations: number, seasons: number) =>
  Math.sqrt(Math.min(1, Math.max(0, observations) / 80) * Math.min(1, Math.max(0, seasons) / 3));

export const supportAdjustedDropout = (baseRate: number, trust: number, strength = 0.6) => {
  const base = Math.max(0, Math.min(1, baseRate));
  const boundedTrust = Math.max(0, Math.min(1, trust));
  const boundedStrength = Math.max(0, Math.min(1, strength));
  return 1 - (1 - base) * (1 - boundedStrength * (1 - boundedTrust));
};

export const supportResidualGate = (trust: number, known: boolean) =>
  known ? 0.2 + 0.8 * Math.max(0, Math.min(1, trust)) : 0;

export const supportAugmentationEnabled = (enabled: boolean, identityDropoutRate: number) =>
  enabled && identityDropoutRate > 0;

const dateKey = (value: string) => value.slice(0, 10);

/**
 * Build identity evidence strictly as-of each target date. Every row on the same
 * date sees the state that existed before that date, so one recap cannot leak
 * support into another recap from the same competitive day.
 */
export const temporalIdentityTrust = (
  rows: readonly TemporalIdentityEvidenceRow[],
): TemporalIdentityTrust[] => {
  const result = rows.map(() => ({ corpsTrust: 0, judgeTrust: [] as number[], showTrust: 0 }));
  const corps = new Map<string, { observations: number; seasons: Set<string> }>();
  const judges = new Map<number, { observations: number; seasons: Set<string> }>();
  const shows = new Map<number, { observations: number; seasons: Set<string> }>();
  const ordered = rows
    .map((row, index) => ({ row, index, date: dateKey(row.date) }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);

  for (let cursor = 0; cursor < ordered.length;) {
    const currentDate = ordered[cursor]!.date;
    let end = cursor + 1;
    while (end < ordered.length && ordered[end]!.date === currentDate) end += 1;
    const sameDate = ordered.slice(cursor, end);

    for (const { row, index } of sameDate) {
      const corpsState = corps.get(row.corpsKey);
      result[index] = {
        corpsTrust: corpsState
          ? evidenceTrust(corpsState.observations, corpsState.seasons.size)
          : 0,
        judgeTrust: row.judgeIndices.map((judgeIndex) => {
          if (judgeIndex === 0) return 0;
          const judgeState = judges.get(judgeIndex);
          return judgeState
            ? evidenceTrust(judgeState.observations, judgeState.seasons.size)
            : 0;
        }),
        showTrust: row.showIndex === 0
          ? 0
          : (() => {
              const showState = shows.get(row.showIndex);
              return showState
                ? evidenceTrust(showState.observations, showState.seasons.size)
                : 0;
            })(),
      };
    }

    for (const { row } of sameDate) {
      const corpsState = corps.get(row.corpsKey) ?? { observations: 0, seasons: new Set<string>() };
      corpsState.observations += 1;
      corpsState.seasons.add(row.season);
      corps.set(row.corpsKey, corpsState);

      for (const judgeIndex of new Set(row.judgeIndices.filter((index) => index > 0))) {
        const judgeState = judges.get(judgeIndex) ?? { observations: 0, seasons: new Set<string>() };
        judgeState.observations += 1;
        judgeState.seasons.add(row.season);
        judges.set(judgeIndex, judgeState);
      }
      if (row.showIndex > 0) {
        const showState = shows.get(row.showIndex) ?? { observations: 0, seasons: new Set<string>() };
        showState.observations += 1;
        showState.seasons.add(row.season);
        shows.set(row.showIndex, showState);
      }
    }
    cursor = end;
  }

  return result;
};

export const loadV10IdentitySupport = (
  supportPath: string,
  judgeMapPath: string,
  showMapPath?: string,
) => {
  const artifact = JSON.parse(readFileSync(supportPath, "utf8")) as SupportArtifact;
  const judgeMap = JSON.parse(readFileSync(judgeMapPath, "utf8")) as Record<string, number>;
  const corpsTrustByKey = new Map(artifact.corps.map((row) => [
    row.identity,
    evidenceTrust(row.performances ?? row.shows, row.seasons),
  ]));
  const judgeTrustByIndex = new Map<number, number>([[0, 0]]);
  for (const row of artifact.judges) {
    const index = judgeMap[row.identity];
    if (index !== undefined) {
      judgeTrustByIndex.set(index, evidenceTrust(row.covered_performances ?? row.shows, row.seasons));
    }
  }
  const showTrustByIndex = new Map<number, number>([[0, 0]]);
  if (showMapPath) {
    const showMap = JSON.parse(readFileSync(showMapPath, "utf8")) as Record<string, number>;
    for (const row of artifact.shows) {
      const index = showMap[row.identity];
      if (index !== undefined) {
        showTrustByIndex.set(index, evidenceTrust(row.performances ?? row.shows, row.seasons));
      }
    }
  }
  return { version: artifact.version, corpsTrustByKey, judgeTrustByIndex, showTrustByIndex };
};
