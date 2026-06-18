import { Effect } from "effect";

import { CompetitionRecapSummary } from "./recapSummary.js";
import type { SeasonDataset } from "./season.js";

export interface RankingEntry {
  score: number;
  corps: string;
  corpsIdentifier?: string;
  divisionName?: string;
  date: Date;
  percentThrough: number;
  rank?: number;
}

export type RankingPool = Record<string, RankingEntry[]>;

export interface SeasonRankingSnapshot {
  competition: CompetitionRecapSummary["competition"];
  rankings: RankingPool;
}

export interface SeasonRankingTimeline {
  season: string;
  snapshots: SeasonRankingSnapshot[];
}

export interface RankingOptions {
  includeDivisions?: string[];
  excludeGroupTypeIds?: number[];
  excludeCompetitionTypeIds?: number[];
  skipCompetition?: (competition: SeasonRankingSnapshot["competition"]) => boolean;
  reservedCaptions?: Set<string>;
  reservedSubcaptions?: Set<string>;
}

const defaultRankingOptions: Required<RankingOptions> = {
  includeDivisions: ["world", "open"],
  excludeGroupTypeIds: [19],
  excludeCompetitionTypeIds: [8501],
  skipCompetition: () => false,
  reservedCaptions: new Set(["rank", "name", "total", "score", "Penalties", "Timing & Penalties"]),
  reservedSubcaptions: new Set(["rank", "name", "total", "score"])
};

const clonePool = (pool: RankingPool): RankingPool => {
  const copy: RankingPool = {};
  for (const [caption, entries] of Object.entries(pool)) {
    copy[caption] = entries.map((entry) => ({ ...entry }));
  }
  return copy;
};

const applyRanking = (pool: RankingPool, label: string, entry: RankingEntry, reserved: Set<string>) => {
  if (!label || reserved.has(label)) return;
  const existing = pool[label] ?? [];
  const betterExisting = existing.find((item) => item.corps === entry.corps);
  if (betterExisting && betterExisting.score >= entry.score) return;
  const next = existing.filter((item) => item.corps !== entry.corps);
  next.push(entry);
  next.sort((a, b) => b.score - a.score);
  pool[label] = next;
};

const createEntry = (
  score: CompetitionRecapSummary["scores"][number],
  competition: CompetitionRecapSummary["competition"],
  value: number
) => ({
  corps: score.corps,
  corpsIdentifier: score.orgGroupIdentifier ?? undefined,
  divisionName: score.divisionName ?? undefined,
  score: value,
  date: competition.date,
  percentThrough: competition.percentageThroughSeason,
  rank: score.rank
});

const matchesDivision = (divisionName: string, allowed: string[]) =>
  allowed.some((value) => divisionName.toLowerCase().includes(value.toLowerCase()));

const computeGroupRankings = (
  current: RankingPool,
  group: CompetitionRecapSummary[],
  options: Required<RankingOptions>
) => {
  for (const recap of group) {
    if (options.skipCompetition(recap.competition)) continue;

    for (const score of recap.scores) {
      if (!matchesDivision(score.divisionName, options.includeDivisions)) continue;
      if (score.groupTypeId && options.excludeGroupTypeIds.includes(score.groupTypeId)) continue;
      if (score.competitionTypeId && options.excludeCompetitionTypeIds.includes(score.competitionTypeId)) continue;

      const totalEntry = createEntry(score, recap.competition, score.totalScore);
      applyRanking(current, "total", totalEntry, options.reservedCaptions);

      for (const caption of score.captions ?? []) {
        applyRanking(current, caption.caption, createEntry(score, recap.competition, caption.score), options.reservedCaptions);
        const subcaptions = caption.subcaptions ?? {};
        for (const [subcaptionName, subcaptionValue] of Object.entries(subcaptions as Record<string, { score: number }>)) {
          applyRanking(
            current,
            subcaptionName,
            createEntry(score, recap.competition, subcaptionValue.score),
            options.reservedSubcaptions
          );
        }
      }
    }
  }
};

const partitionRecapsByDay = (recaps: ReadonlyArray<CompetitionRecapSummary>) => {
  const buckets = new Map<number, CompetitionRecapSummary[]>();
  for (const recap of recaps) {
    const day = recap.competition.dayOfSeason ?? recap.competition.date.getTime();
    const list = buckets.get(day) ?? [];
    list.push(recap);
    buckets.set(day, list);
  }
  return buckets;
};

export const buildSeasonRankings = (
  season: string,
  dataset: SeasonDataset,
  options?: RankingOptions
): Effect.Effect<SeasonRankingTimeline, never, never> =>
  Effect.sync(() => {
    const opts: Required<RankingOptions> = {
      includeDivisions: options?.includeDivisions ?? defaultRankingOptions.includeDivisions,
      excludeGroupTypeIds: options?.excludeGroupTypeIds ?? defaultRankingOptions.excludeGroupTypeIds,
      excludeCompetitionTypeIds:
        options?.excludeCompetitionTypeIds ?? defaultRankingOptions.excludeCompetitionTypeIds,
      skipCompetition: options?.skipCompetition ?? defaultRankingOptions.skipCompetition,
      reservedCaptions: options?.reservedCaptions ?? defaultRankingOptions.reservedCaptions,
      reservedSubcaptions: options?.reservedSubcaptions ?? defaultRankingOptions.reservedSubcaptions
    };

    const dayBuckets = partitionRecapsByDay(dataset.recaps);
    const sortedDays = Array.from(dayBuckets.keys()).sort((a, b) => a - b);
    const snapshots: SeasonRankingSnapshot[] = [];
    const currentRankings: RankingPool = {};

    for (const day of sortedDays) {
      const group = dayBuckets.get(day)!;
      computeGroupRankings(currentRankings, group, opts);
      snapshots.push({
        competition: group[0].competition,
        rankings: clonePool(currentRankings)
      });
    }

    const timeline: SeasonRankingTimeline = { season, snapshots };
    return timeline;
  });

export const collectSeasonRankings = (
  datasets: Record<string, SeasonDataset>,
  options?: RankingOptions
) =>
  Effect.forEach(Object.entries(datasets), ([season, dataset]) =>
    buildSeasonRankings(season, dataset, options)
  ).pipe(
    Effect.map((results) =>
      results.reduce<Record<string, SeasonRankingTimeline>>((acc, timeline) => {
        acc[timeline.season] = timeline;
        return acc;
      }, {})
    )
  );
