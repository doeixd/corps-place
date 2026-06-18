import { optionalWith } from "./schemaCompat.js";
import { Schema, Effect } from "effect";

import { DciApi } from "./service.js";
import * as Domain from "./domain.js";
import {
  CaptionScoreSummary,
  CaptionScoreSummarySchema,
  CompetitionRecapSummary,
  CompetitionRecapSummarySchema,
  CorpsProfile,
  CorpsProfileSchema,
  CorpsRecapScore,
  CorpsRecapScoreSchema,
  JudgePanel,
  JudgePanelSchema,
  JudgeSheet,
  JudgeSheetSchema,
  BreakdownScore,
  BreakdownScoreSchema,
  SubcaptionSummary,
  SubcaptionSummarySchema,
  buildCompetitionRecapSummary
} from "./recapSummary.js";

const differenceInDays = (later: Date, earlier: Date) =>
  Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

const SeasonSummarySchema = Schema.Struct({
  year: Schema.String,
  seasonLength: Schema.Number,
  firstShowDate: Schema.Number,
  lastShowDate: Schema.Number
});

const JudgeProfileSchema = Schema.Struct({
  fullName: Schema.String,
  firstName: Schema.String.pipe(optionalWith({ nullable: true })),
  lastName: Schema.String.pipe(optionalWith({ nullable: true }))
});

export const SeasonDatasetSchema = Schema.Struct({
  season: SeasonSummarySchema,
  competitionInfo: Schema.Record(Schema.String, Domain.CompetitionSchema),
  groupTypes: Schema.Record(Schema.String, Domain.GroupTypeSchema),
  competitionTypes: Schema.Record(Schema.String, Domain.CompetitionTypeSchema),
  corps: Schema.Record(Schema.String, Schema.Record(Schema.String, CorpsProfileSchema)),
  judges: Schema.Record(Schema.String, JudgeProfileSchema),
  nameToInitials: Schema.Record(Schema.String, Schema.String),
  recaps: Schema.Array(CompetitionRecapSummarySchema)
});

export type SeasonSummary = typeof SeasonSummarySchema.Type;
export type JudgeProfile = typeof JudgeProfileSchema.Type;
export type SeasonDataset = typeof SeasonDatasetSchema.Type;

export const buildSeasonDataset = (season: string) =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const competitions = yield* (api.getCompetitions(season));

    if (competitions.length === 0) {
      const empty: SeasonDataset = {
        season: {
          year: season,
          seasonLength: 0,
          firstShowDate: 0,
          lastShowDate: 0
        },
        competitionInfo: {},
        groupTypes: {},
        competitionTypes: {},
        corps: {},
        judges: {},
        nameToInitials: {},
        recaps: []
      };
      return empty;
    }

    const sorted = [...competitions].sort((a, b) => a.date.getTime() - b.date.getTime());
    const startIndex = season.includes("13") && sorted.length > 1 ? 1 : 0;
    const firstShowDate = sorted[startIndex]?.date ?? sorted[0].date;
    const lastShowDate = sorted[sorted.length - 1].date;
    const seasonLength = Math.max(0, differenceInDays(lastShowDate, firstShowDate));

    const competitionInfo: Record<string, Domain.Competition> = {};
    const groupTypes: Record<string, Domain.GroupType> = {};
    const competitionTypes: Record<string, Domain.CompetitionType> = {};
    const corps: Record<string, Record<string, CorpsProfile>> = {};
    const judges: Record<string, JudgeProfile> = {};
    const nameToInitials: Record<string, string> = {};
    const recaps: CompetitionRecapSummary[] = [];

    for (const competition of sorted) {
      competitionInfo[competition.slug] = competition;
      for (const groupType of competition.groupTypes ?? []) {
        groupTypes[String(groupType.id)] ??= groupType;
        competitionTypes[String(groupType.competitionType.id)] ??= groupType.competitionType;
      }

      if (!competition.slug) continue;
      const scores = yield* (api.getCompetitionRecap(competition.slug));
      if (!scores.length) continue;

      recaps.push(
        buildCompetitionRecapSummary(
          competition,
          scores,
          { corps, judges, nameToInitials },
          { firstShowDate, lastShowDate }
        )
      );
    }

    const dataset: SeasonDataset = {
      season: {
        year: season,
        seasonLength,
        firstShowDate: firstShowDate.getTime(),
        lastShowDate: lastShowDate.getTime()
      },
      competitionInfo,
      groupTypes,
      competitionTypes,
      corps,
      judges,
      nameToInitials,
      recaps
    };

    return dataset;
  });

export const collectSeasonDatasets = (
  seasons: ReadonlyArray<string>,
  options?: { concurrency?: number }
) =>
  Effect.gen(function* () {
    const datasets = yield* (
      Effect.forEach(seasons, (season) => buildSeasonDataset(season), {
        concurrency: options?.concurrency ?? 1
      })
    );

    const record: Record<string, SeasonDataset> = {};
    seasons.forEach((season, idx) => {
      record[season] = datasets[idx];
    });

    return record;
  });
