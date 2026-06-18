import type { Competition, CorpsScore } from "./domain.js";
import {
  type CaptionLeaderboards,
  type CompetitionRecapSummary,
  type CompetitionTiming,
  type FormatRecapLineOptions,
  type RecapComparison,
  type RecapInsightOptions,
  type RecapInsights,
  type RecapTableRow,
  type RecapContext,
  buildCaptionLeaderboards,
  buildCompetitionRecapSummary,
  buildRecapInsights,
  buildRecapTable,
  compareRecapScores,
  formatCorpsRecapLine
} from "./recapSummary.js";

export interface RecapReportOptions {
  readonly leaderboardTop?: number;
  readonly includeSubcaptions?: boolean;
  readonly captionLimit?: number;
  readonly tightCaptionLimit?: number;
  readonly tableCaptions?: ReadonlyArray<string>;
  readonly headlineOptions?: FormatRecapLineOptions;
  readonly comparePairs?: ReadonlyArray<readonly [string, string]>;
  readonly autoCompareTop?: number;
  readonly context?: RecapContext;
  readonly timing?: CompetitionTiming;
  readonly insightOptions?: RecapInsightOptions;
}

export interface RecapReport {
  readonly summary: CompetitionRecapSummary;
  readonly leaderboards: CaptionLeaderboards;
  readonly insights: RecapInsights;
  readonly table: ReadonlyArray<RecapTableRow>;
  readonly headline?: string;
  readonly comparisons: ReadonlyArray<RecapComparison>;
}

const buildDefaultPairs = (
  summary: CompetitionRecapSummary,
  limit: number
): ReadonlyArray<readonly [string, string]> => {
  if (limit <= 1) return [];
  const names = summary.scores.slice(0, limit).map((entry) => entry.corps);
  if (names.length < 2) return [];
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < names.length - 1; index += 1) {
    pairs.push([names[index]!, names[index + 1]!] as const);
  }
  return pairs;
};

export const buildRecapReport = (
  competition: Competition,
  scores: ReadonlyArray<CorpsScore>,
  options?: RecapReportOptions
): RecapReport => {
  const summary = buildCompetitionRecapSummary(competition, scores, options?.context, options?.timing);
  const leaderboards = buildCaptionLeaderboards(summary.scores, {
    top: options?.leaderboardTop ?? 3,
    includeSubcaptions: options?.includeSubcaptions
  });
  const insights = buildRecapInsights(summary, {
    captionLimit: options?.captionLimit,
    tightCaptionLimit: options?.tightCaptionLimit,
    headlineOptions: options?.headlineOptions,
    ...options?.insightOptions
  });
  const table = buildRecapTable(summary, options?.tableCaptions);
  const headline =
    insights.headline ??
    (summary.scores.length > 0 ? formatCorpsRecapLine(summary.scores[0], options?.headlineOptions) : undefined);

  const explicitPairs = options?.comparePairs ?? [];
  const autoPairs =
    explicitPairs.length === 0 && (options?.autoCompareTop ?? 2) > 1
      ? buildDefaultPairs(summary, options?.autoCompareTop ?? 2)
      : [];
  const allPairs = explicitPairs.length > 0 ? explicitPairs : autoPairs;
  const comparisons = allPairs
    .map(([left, right]) => compareRecapScores(summary, left, right))
    .filter((comparison): comparison is RecapComparison => Boolean(comparison));

  return {
    summary,
    leaderboards,
    insights,
    table,
    headline,
    comparisons
  };
};

export interface FormatRecapReportOptions {
  readonly includeTable?: boolean;
  readonly includeLeaderboards?: boolean;
  readonly includeComparisons?: boolean;
  readonly captionLimit?: number;
}

const formatTable = (rows: ReadonlyArray<RecapTableRow>, captionLimit?: number) => {
  if (rows.length === 0) {
    return [];
  }
  const limit = captionLimit ?? 3;
  const lines: string[] = [];
  for (const row of rows) {
    const captionEntries = Object.entries(row.captions)
      .slice(0, limit)
      .map(([caption, value]) => `${caption} ${value.toFixed(3)}`);
    lines.push(`#${row.rank} ${row.corps} — ${row.total.toFixed(3)}${captionEntries.length ? ` | ${captionEntries.join(", ")}` : ""}`);
  }
  return lines;
};

const formatLeaderboards = (leaderboards: CaptionLeaderboards, captionLimit?: number) => {
  const entries = Object.entries(leaderboards.captions)
    .slice(0, captionLimit ?? 5)
    .map(([caption, corps]) => {
      const formatted = corps.map((entry) => `${entry.corps} (${entry.score.toFixed(3)})`).join(", ");
      return `${caption}: ${formatted}`;
    });
  return entries;
};

const formatComparisons = (comparisons: ReadonlyArray<RecapComparison>) =>
  comparisons.map((comparison) => {
    const spreads = comparison.captionBreakdown
      .slice(0, 3)
      .map((entry) => `${entry.label} ${entry.spread.toFixed(3)}`)
      .join(", ");
    return `${comparison.corpsA.corps} vs ${comparison.corpsB.corps} — total ${comparison.totalSpread.toFixed(3)} (${spreads})`;
  });

export const formatRecapReport = (report: RecapReport, options?: FormatRecapReportOptions): string => {
  const lines: string[] = [];
  const date = report.summary.competition.date.toISOString().split("T")[0];
  lines.push(`${report.summary.competition.eventName} — ${date}`);
  if (report.headline) {
    lines.push(report.headline);
  } else if (report.insights.headline) {
    lines.push(report.insights.headline);
  }

  if (report.insights.marginOfVictory !== undefined) {
    lines.push(`Margin of victory: ${report.insights.marginOfVictory.toFixed(3)}`);
  }
  if (report.insights.captionLeaders.length > 0) {
    const leaders = report.insights.captionLeaders
      .slice(0, options?.captionLimit ?? 5)
      .map((entry) => `${entry.caption}: ${entry.leader} (+${entry.spread.toFixed(3)})`)
      .join(" | ");
    lines.push(`Caption leaders: ${leaders}`);
  }

  if (options?.includeTable ?? true) {
    lines.push("");
    lines.push("Standings:");
    lines.push(...formatTable(report.table, options?.captionLimit));
  }

  if (options?.includeLeaderboards ?? false) {
    lines.push("");
    lines.push("Caption leaderboards:");
    lines.push(...formatLeaderboards(report.leaderboards, options?.captionLimit));
  }

  if ((options?.includeComparisons ?? false) && report.comparisons.length > 0) {
    lines.push("");
    lines.push("Comparisons:");
    lines.push(...formatComparisons(report.comparisons));
  }

  return lines.join("\n");
};
