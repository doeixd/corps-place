import { optionalWith } from "./schemaCompat.js";
import { Schema } from "effect";

import * as Domain from "./domain.js";

const differenceInDays = (later: Date, earlier: Date) =>
  Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

export const BreakdownScoreSchema = Schema.Struct({
  name: Schema.String,
  score: Schema.Number,
  rank: Schema.Number
});
export type BreakdownScore = typeof BreakdownScoreSchema.Type;

export const JudgeSheetSchema = Schema.Struct({
  sheet: Schema.String,
  judgeId: Schema.Number,
  judge: Schema.String,
  score: Schema.Number,
  rank: Schema.Number,
  breakdown: Schema.Array(BreakdownScoreSchema)
});
export type JudgeSheet = typeof JudgeSheetSchema.Type;

export const SubcaptionSummarySchema = Schema.Struct({
  score: Schema.Number,
  rank: Schema.Number.pipe(optionalWith({ nullable: true }))
});
export type SubcaptionSummary = typeof SubcaptionSummarySchema.Type;

export const CaptionScoreSummarySchema = Schema.Struct({
  caption: Schema.String,
  score: Schema.Number,
  rank: Schema.Number,
  judges: Schema.Array(JudgeSheetSchema),
  subcaptions: Schema.Record(Schema.String, SubcaptionSummarySchema).pipe(optionalWith({ default: () => ({}) }))
});
export type CaptionScoreSummary = typeof CaptionScoreSummarySchema.Type;

export const CorpsProfileSchema = Schema.Struct({
  name: Schema.String,
  orgGroupIdentifier: Schema.String,
  active: Schema.Boolean,
  isOtherType: Schema.Boolean
});
export type CorpsProfile = typeof CorpsProfileSchema.Type;

export const CorpsRecapScoreSchema = Schema.Struct({
  corps: Schema.String,
  orgGroupIdentifier: Schema.String.pipe(optionalWith({ nullable: true })),
  divisionName: Domain.DivisionNameSchema,
  totalScore: Schema.Number,
  subtotalScore: Schema.Number.pipe(optionalWith({ nullable: true })),
  rank: Schema.Number,
  subtotalRank: Schema.Number.pipe(optionalWith({ nullable: true })),
  groupTypeId: Schema.Number.pipe(optionalWith({ nullable: true })),
  competitionTypeId: Schema.Number.pipe(optionalWith({ nullable: true })),
  captions: Schema.Array(CaptionScoreSummarySchema)
});
export type CorpsRecapScore = typeof CorpsRecapScoreSchema.Type;

export interface JudgePanelEntry {
  readonly judgeId: number;
  readonly name: string;
}

export const JudgePanelSchema = Schema.Struct({
  chiefJudge: Schema.String.pipe(optionalWith({ nullable: true })),
  captions: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        judgeId: Schema.Number,
        name: Schema.String
      })
    )
  )
});
export type JudgePanel = typeof JudgePanelSchema.Type;

const CompetitionMetaSchema = Schema.Struct({
  eventName: Schema.String,
  slug: Schema.String,
  scoresReleased: Schema.Boolean,
  recapReleased: Schema.Boolean,
  categoryRecapReleased: Schema.Boolean,
  date: Schema.Date,
  dayOfSeason: Schema.Number,
  daysTillFinals: Schema.Number,
  percentageThroughSeason: Schema.Number,
  location: Schema.String,
  competitionLevel: Schema.Number
});

export const CompetitionRecapSummarySchema = Schema.Struct({
  competition: CompetitionMetaSchema,
  scores: Schema.Array(CorpsRecapScoreSchema),
  judges: JudgePanelSchema
});
export type CompetitionRecapSummary = typeof CompetitionRecapSummarySchema.Type;

export interface RecapContext {
  readonly corps: Record<string, Record<string, CorpsProfile>>;
  readonly judges: Record<string, RecapJudgeProfile>;
  readonly nameToInitials: Record<string, string>;
}

export interface RecapJudgeProfile {
  readonly fullName: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
}

export interface CompetitionTiming {
  readonly firstShowDate?: Date;
  readonly lastShowDate?: Date;
}

const ensureRecapContext = (ctx?: RecapContext): RecapContext => ({
  corps: ctx?.corps ?? {},
  judges: ctx?.judges ?? {},
  nameToInitials: ctx?.nameToInitials ?? {}
});

const upsertInitial = (initials: Record<string, string>, key: string, value?: string | null) => {
  if (!value) return;
  initials[key] ??= value;
};

const ensureDivisionCorps = (
  corps: Record<string, Record<string, CorpsProfile>>,
  division: string,
  profile: CorpsProfile
) => {
  const bucket = (corps[division] ||= {});
  if (!bucket[profile.name]) {
    bucket[profile.name] = profile;
  }
};

export const buildCompetitionRecapSummary = (
  competition: Domain.Competition,
  scores: ReadonlyArray<Domain.CorpsScore>,
  context?: RecapContext,
  timing?: CompetitionTiming
): CompetitionRecapSummary => {
  const ctx = ensureRecapContext(context);
  const firstShowDate = timing?.firstShowDate ?? competition.date;
  const lastShowDate = timing?.lastShowDate ?? competition.date;
  const rawSeasonLength = Math.max(0, differenceInDays(lastShowDate, firstShowDate));
  const seasonLength = rawSeasonLength > 0 ? rawSeasonLength : 1;
  const dayOfSeason = differenceInDays(competition.date, firstShowDate);
  const daysTillFinals = differenceInDays(lastShowDate, competition.date);
  const percentageThroughSeason =
    rawSeasonLength > 0 ? Math.round((dayOfSeason / seasonLength) * 10000) / 100 : 100;

  const judgePanelCaptions: Record<string, JudgePanelEntry[]> = {};
  const corpsScores: CorpsRecapScore[] = [];

  for (const score of scores) {
    ensureDivisionCorps(ctx.corps, score.divisionName, {
      name: score.groupName,
      orgGroupIdentifier: score.orgGroupIdentifier,
      active: score.active,
      isOtherType: score.isOtherType
    });

    const captions: CaptionScoreSummary[] = [];
    for (const category of score.categories) {
      upsertInitial(ctx.nameToInitials, category.Name, category.Initials);

      const judgeSheets: JudgeSheet[] = [];
      const subcaptionBuckets: Record<string, { scoreSum: number; rankSum: number; count: number }> = {};
      for (const judgeScore of category.Captions ?? []) {
        const judgeFullName = `${judgeScore.JudgeFirstName ?? "unknown"} ${judgeScore.JudgeLastName ?? "unknown"}`.trim();
        ctx.judges[judgeFullName] ||= {
          fullName: judgeFullName,
          firstName: judgeScore.JudgeFirstName ?? undefined,
          lastName: judgeScore.JudgeLastName ?? undefined
        };
        upsertInitial(ctx.nameToInitials, judgeScore.Name, judgeScore.Initials);

        const breakdown: BreakdownScore[] = [];
        for (const subcaption of judgeScore.Subcaptions ?? []) {
          upsertInitial(ctx.nameToInitials, subcaption.Name, subcaption.Initials);
          breakdown.push({
            name: subcaption.Name,
            score: subcaption.Score,
            rank: subcaption.Rank
          });
          const bucket = (subcaptionBuckets[subcaption.Name] ||= { scoreSum: 0, rankSum: 0, count: 0 });
          bucket.scoreSum += subcaption.Score;
          bucket.rankSum += subcaption.Rank;
          bucket.count += 1;
        }

        judgeSheets.push({
          sheet: judgeScore.Name,
          judgeId: judgeScore.Judge,
          judge: judgeFullName,
          score: judgeScore.Score,
          rank: judgeScore.Rank,
          breakdown
        });

        const captionKey = category.Name;
        const existingPanel = judgePanelCaptions[captionKey] ?? [];
        if (!existingPanel.some((entry) => entry.judgeId === judgeScore.Judge)) {
          judgePanelCaptions[captionKey] = [...existingPanel, { judgeId: judgeScore.Judge, name: judgeFullName }];
        }
      }

      const subcaptions = Object.fromEntries(
        Object.entries(subcaptionBuckets).map(([name, values]) => [
          name,
          {
            score: Math.round((values.scoreSum / Math.max(values.count, 1)) * 1000) / 1000,
            rank: values.count > 0 ? values.rankSum / values.count : undefined
          }
        ])
      );

      captions.push({
        caption: category.Name,
        score: category.Score,
        rank: category.Rank,
        judges: judgeSheets,
        subcaptions
      });
    }

    const groupType = competition.groupTypes?.[0];

    corpsScores.push({
      corps: score.groupName,
      orgGroupIdentifier: score.orgGroupIdentifier,
      divisionName: score.divisionName,
      totalScore: score.totalScore,
      subtotalScore: score.subtotalScore,
      rank: score.rank,
      subtotalRank: score.subtotalRank,
      groupTypeId: toOptionalNumber(groupType?.id),
      competitionTypeId: toOptionalNumber(groupType?.competitionType.id),

      captions
    });
  }

  corpsScores.sort((a, b) => a.rank - b.rank);

  return {
    competition: {
      slug: competition.slug,
      scoresReleased: competition.scoresReleased,
      recapReleased: competition.recapReleased,
      categoryRecapReleased: competition.categoryRecapReleased,
      date: competition.date,
      dayOfSeason,
      daysTillFinals,
      percentageThroughSeason,
      eventName: competition.eventName,
      location: competition.location,
      competitionLevel: competition.competitionLevel
    },
    scores: corpsScores,
    judges: {
      chiefJudge: competition.chiefJudge ?? undefined,
      captions: judgePanelCaptions
    }
  };
};

export interface RecapLookup {
  readonly nameToInitials: Record<string, string>;
  readonly corps: Record<string, Record<string, CorpsProfile>>;
  readonly judges: Record<string, RecapJudgeProfile>;
}

export const extractRecapLookup = (scores: ReadonlyArray<Domain.CorpsScore>): RecapLookup => {
  const context = ensureRecapContext();
  for (const score of scores) {
    ensureDivisionCorps(context.corps, score.divisionName, {
      name: score.groupName,
      orgGroupIdentifier: score.orgGroupIdentifier,
      active: score.active,
      isOtherType: score.isOtherType
    });

    for (const category of score.categories) {
      upsertInitial(context.nameToInitials, category.Name, category.Initials);
      for (const judgeScore of category.Captions ?? []) {
        const judgeFullName = `${judgeScore.JudgeFirstName ?? "unknown"} ${judgeScore.JudgeLastName ?? "unknown"}`.trim();
        context.judges[judgeFullName] ||= {
          fullName: judgeFullName,
          firstName: judgeScore.JudgeFirstName ?? undefined,
          lastName: judgeScore.JudgeLastName ?? undefined
        };
        upsertInitial(context.nameToInitials, judgeScore.Name, judgeScore.Initials);
        for (const subcaption of judgeScore.Subcaptions ?? []) {
          upsertInitial(context.nameToInitials, subcaption.Name, subcaption.Initials);
        }
      }
    }
  }
  return context;
};

export interface LeaderboardEntry {
  readonly corps: string;
  readonly divisionName: Domain.DivisionName;
  readonly caption: string;
  readonly score: number;
  readonly rank: number;
}

export interface LeaderboardOptions {
  readonly top?: number;
  readonly includeSubcaptions?: boolean;
  readonly filterDivisions?: ReadonlyArray<string>;
}

export interface CaptionLeaderboards {
  readonly totals: ReadonlyArray<LeaderboardEntry>;
  readonly captions: Record<string, ReadonlyArray<LeaderboardEntry>>;
  readonly subcaptions: Record<string, ReadonlyArray<LeaderboardEntry>>;
}

const matchesDivision = (division: string, allowed?: ReadonlyArray<string>) => {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((value) => division.toLowerCase().includes(value.toLowerCase()));
};

const takeTop = (entries: LeaderboardEntry[], top: number) =>
  entries.sort((a, b) => b.score - a.score || a.rank - b.rank).slice(0, top);

type CaptionSource = Domain.CorpsScore | CorpsRecapScore;

const isDomainScore = (score: CaptionSource): score is Domain.CorpsScore =>
  Array.isArray((score as Domain.CorpsScore).categories);

const getCorpsName = (score: CaptionSource) => (isDomainScore(score) ? score.groupName : score.corps);

const getCaptionEntries = (
  score: CaptionSource
): ReadonlyArray<{
  name: string;
  score: number;
  rank: number;
  subcaptions: ReadonlyArray<{ label: string; score: number; rank?: number }>;
}> => {
  if (isDomainScore(score)) {
    return score.categories.map((category) => ({
      name: category.Name,
      score: category.Score,
      rank: category.Rank,
      subcaptions: (category.Captions ?? []).flatMap((judge) =>
        (judge.Subcaptions ?? []).map((subcaption) => ({
          label: `${category.Name} ú ${subcaption.Name}`,
          score: subcaption.Score,
          rank: subcaption.Rank
        }))
      )
    }));
  }

  return score.captions.map((caption) => ({
    name: caption.caption,
    score: caption.score,
    rank: caption.rank,
    subcaptions: Object.entries(caption.subcaptions ?? {}).map(([subName, summary]) => ({
      label: `${caption.caption} ú ${subName}`,
      score: summary.score,
      rank: summary.rank ?? undefined
    }))
  }));
};

export const buildCaptionLeaderboards = (
  scores: ReadonlyArray<CaptionSource>,
  options?: LeaderboardOptions
): CaptionLeaderboards => {
  const top = options?.top ?? 3;
  const captionBuckets: Record<string, LeaderboardEntry[]> = {};
  const subcaptionBuckets: Record<string, LeaderboardEntry[]> = {};
  const totals: LeaderboardEntry[] = [];

  for (const score of scores) {
    if (!matchesDivision(score.divisionName, options?.filterDivisions)) {
      continue;
    }

    totals.push({
      corps: getCorpsName(score),
      divisionName: score.divisionName,
      caption: "total",
      score: score.totalScore,
      rank: score.rank
    });

    for (const caption of getCaptionEntries(score)) {
      const bucket = (captionBuckets[caption.name] ||= []);
      bucket.push({
        corps: getCorpsName(score),
        divisionName: score.divisionName,
        caption: caption.name,
        score: caption.score,
        rank: caption.rank
      });

      if (!options?.includeSubcaptions) continue;

      for (const subcaption of caption.subcaptions) {
        const subBucket = (subcaptionBuckets[subcaption.label] ||= []);
        subBucket.push({
          corps: getCorpsName(score),
          divisionName: score.divisionName,
          caption: subcaption.label,
          score: subcaption.score,
          rank: subcaption.rank ?? caption.rank
        });
      }
    }
  }

  return {
    totals: takeTop(totals, top),
    captions: Object.fromEntries(
      Object.entries(captionBuckets).map(([caption, entries]) => [caption, takeTop(entries, top)])
    ),
    subcaptions: Object.fromEntries(
      Object.entries(subcaptionBuckets).map(([caption, entries]) => [caption, takeTop(entries, top)])
    )
  };
};

const ensureRecapScoresArray = (
  scores: ReadonlyArray<CorpsRecapScore> | CompetitionRecapSummary
): ReadonlyArray<CorpsRecapScore> =>
  Array.isArray((scores as CompetitionRecapSummary).scores)
    ? ((scores as CompetitionRecapSummary).scores as ReadonlyArray<CorpsRecapScore>)
    : (scores as ReadonlyArray<CorpsRecapScore>);

export const findCorpsRecap = (
  scores: ReadonlyArray<CorpsRecapScore> | CompetitionRecapSummary,
  corpsName: string
): CorpsRecapScore | undefined => {
  const list = ensureRecapScoresArray(scores);
  return list.find((entry) => entry.corps.toLowerCase() === corpsName.toLowerCase());
};

export interface RecapComparisonValue {
  readonly score?: number;
  readonly rank?: number;
}

export interface RecapComparisonEntry {
  readonly label: string;
  readonly corpsA: RecapComparisonValue;
  readonly corpsB: RecapComparisonValue;
  readonly spread: number;
}

export interface RecapComparison {
  readonly corpsA: CorpsRecapScore;
  readonly corpsB: CorpsRecapScore;
  readonly totalSpread: number;
  readonly subtotalSpread?: number;
  readonly captionBreakdown: ReadonlyArray<RecapComparisonEntry>;
  readonly subcaptionBreakdown: ReadonlyArray<RecapComparisonEntry>;
}

const toRank = (value: number | null | undefined) => (typeof value === "number" ? value : undefined);

const toOptionalNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};


const buildCaptionLookup = (score: CorpsRecapScore) => {
  const map = new Map<string, CaptionScoreSummary>();
  for (const caption of score.captions) {
    map.set(caption.caption, caption);
  }
  return map;
};

const buildSubcaptionLookup = (score: CorpsRecapScore) => {
  const map = new Map<string, SubcaptionSummary>();
  for (const caption of score.captions) {
    for (const [name, value] of Object.entries(caption.subcaptions ?? {})) {
      map.set(`${caption.caption} > ${name}`, value);
    }
  }
  return map;
};

const buildComparisonEntries = (
  labels: Iterable<string>,
  getLeft: (label: string) => { score?: number; rank?: number | null } | undefined,
  getRight: (label: string) => { score?: number; rank?: number | null } | undefined
) => {
  const entries: RecapComparisonEntry[] = [];
  for (const label of labels) {
    const left = getLeft(label);
    const right = getRight(label);
    entries.push({
      label,
      corpsA: { score: left?.score, rank: toRank(left?.rank) },
      corpsB: { score: right?.score, rank: toRank(right?.rank) },
      spread: (left?.score ?? 0) - (right?.score ?? 0)
    });
  }
  return entries.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
};

export const compareRecapScores = (
  scores: CompetitionRecapSummary | ReadonlyArray<CorpsRecapScore>,
  corpsA: string,
  corpsB: string
): RecapComparison | undefined => {
  const left = findCorpsRecap(scores, corpsA);
  const right = findCorpsRecap(scores, corpsB);
  if (!left || !right) {
    return undefined;
  }

  const captionLookupA = buildCaptionLookup(left);
  const captionLookupB = buildCaptionLookup(right);
  const captionLabels = new Set([...captionLookupA.keys(), ...captionLookupB.keys()]);
  const captionBreakdown = buildComparisonEntries(
    captionLabels,
    (label) => captionLookupA.get(label),
    (label) => captionLookupB.get(label)
  );

  const subcaptionLookupA = buildSubcaptionLookup(left);
  const subcaptionLookupB = buildSubcaptionLookup(right);
  const subcaptionLabels = new Set([...subcaptionLookupA.keys(), ...subcaptionLookupB.keys()]);
  const subcaptionBreakdown = buildComparisonEntries(
    subcaptionLabels,
    (label) => subcaptionLookupA.get(label),
    (label) => subcaptionLookupB.get(label)
  );

  return {
    corpsA: left,
    corpsB: right,
    totalSpread: left.totalScore - right.totalScore,
    subtotalSpread:
      left.subtotalScore != null && right.subtotalScore != null
        ? left.subtotalScore - right.subtotalScore
        : undefined,
    captionBreakdown,
    subcaptionBreakdown
  };
};

export interface CaptionSpread {
  readonly caption: string;
  readonly leader: string;
  readonly leaderScore: number;
  readonly runnerUp?: string;
  readonly runnerUpScore?: number;
  readonly spread: number;
}

export interface RecapInsights {
  readonly corpsCount: number;
  readonly winner?: CorpsRecapScore;
  readonly runnerUp?: CorpsRecapScore;
  readonly headline?: string;
  readonly marginOfVictory?: number;
  readonly captionLeaders: ReadonlyArray<CaptionSpread>;
  readonly tightCaptions: ReadonlyArray<CaptionSpread>;
}

export interface RecapInsightOptions {
  readonly captionLimit?: number;
  readonly tightCaptionLimit?: number;
  readonly headlineOptions?: FormatRecapLineOptions;
}

const computeCaptionSpreads = (scores: ReadonlyArray<CorpsRecapScore>): CaptionSpread[] => {
  const buckets = new Map<string, Array<{ corps: string; score: number }>>();
  for (const score of scores) {
    for (const caption of score.captions) {
      const bucket = buckets.get(caption.caption) ?? [];
      bucket.push({ corps: score.corps, score: caption.score });
      buckets.set(caption.caption, bucket);
    }
  }

  const spreads: CaptionSpread[] = [];
  for (const [caption, entries] of buckets) {
    if (entries.length === 0) continue;
    entries.sort((a, b) => b.score - a.score);
    const leader = entries[0]!;
    const runnerUp = entries[1];
    spreads.push({
      caption,
      leader: leader.corps,
      leaderScore: leader.score,
      runnerUp: runnerUp?.corps,
      runnerUpScore: runnerUp?.score,
      spread: runnerUp ? leader.score - runnerUp.score : leader.score
    });
  }

  return spreads.sort((a, b) => b.spread - a.spread);
};

export const buildRecapInsights = (
  recap: CompetitionRecapSummary,
  options?: RecapInsightOptions
): RecapInsights => {
  const sorted = [...recap.scores].sort((a, b) => a.rank - b.rank);
  const winner = sorted[0];
  const runnerUp = sorted[1];
  const marginOfVictory =
    winner && runnerUp ? winner.totalScore - runnerUp.totalScore : undefined;
  const captionLimit = options?.captionLimit ?? 5;
  const tightCaptionLimit = options?.tightCaptionLimit ?? 3;
  const spreads = computeCaptionSpreads(recap.scores);
  const tightCaptions = [...spreads].sort((a, b) => a.spread - b.spread);

  return {
    corpsCount: recap.scores.length,
    winner,
    runnerUp,
    headline: winner ? formatCorpsRecapLine(winner, options?.headlineOptions) : undefined,
    marginOfVictory,
    captionLeaders: spreads.slice(0, captionLimit),
    tightCaptions: tightCaptions.slice(0, tightCaptionLimit)
  };
};

export interface RecapTableRow {
  readonly corps: string;
  readonly rank: number;
  readonly total: number;
  readonly captions: Record<string, number>;
}

export const buildRecapTable = (
  recap: CompetitionRecapSummary,
  captions?: ReadonlyArray<string>
): ReadonlyArray<RecapTableRow> => {
  const columns = captions && captions.length > 0 ? captions : Array.from(new Set(recap.scores.flatMap((score) => score.captions.map((caption) => caption.caption))));

  return recap.scores.map((score) => {
    const captionScores: Record<string, number> = {};
    for (const caption of score.captions) {
      if (!columns.includes(caption.caption)) continue;
      captionScores[caption.caption] = caption.score;
    }
    return {
      corps: score.corps,
      rank: score.rank,
      total: score.totalScore,
      captions: captionScores
    };
  });
};

export interface FormatRecapLineOptions {
  readonly precision?: number;
  readonly includeCaptions?: boolean;
  readonly captionLimit?: number;
}

export const formatRecapLine = (
  score: Domain.CorpsScore,
  options?: FormatRecapLineOptions
): string => {
  const precision = options?.precision ?? 3;
  const total = score.totalScore.toFixed(precision);
  const subtotal = score.subtotalScore ? ` / ${score.subtotalScore.toFixed(precision)}` : "";
  const headline = `#${score.rank} ${score.groupName} (${score.divisionName}) â€“ ${total}${subtotal}`;
  if (!options?.includeCaptions) {
    return headline;
  }

  const captionLimit = options.captionLimit ?? score.categories.length;
  const captions = score.categories
    .slice(0, captionLimit)
    .map((caption) => `${caption.Name} ${caption.Score.toFixed(precision)} (r${caption.Rank})`)
    .join(", ");

  return captions ? `${headline} | ${captions}` : headline;
};

export const formatCorpsRecapLine = (score: CorpsRecapScore, options?: FormatRecapLineOptions): string => {
  const precision = options?.precision ?? 3;
  const total = score.totalScore.toFixed(precision);
  const subtotal = score.subtotalScore ? ` / ${score.subtotalScore.toFixed(precision)}` : "";
  const headline = `#${score.rank} ${score.corps} (${score.divisionName}) - ${total}${subtotal}`;
  if (!options?.includeCaptions) {
    return headline;
  }

  const captionLimit = options.captionLimit ?? score.captions.length;
  const captions = score.captions
    .slice(0, captionLimit)
    .map((caption) => `${caption.caption} ${caption.score.toFixed(precision)} (r${caption.rank})`)
    .join(", ");

  return captions ? `${headline} | ${captions}` : headline;
};
