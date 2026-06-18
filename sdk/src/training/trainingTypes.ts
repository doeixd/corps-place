// trainingTypes.ts
// Interfaces for a DCI score prediction training pipeline.
// Focus: a single canonical "TrainingExample" row per (competition, corps, division/class).
// This supports partial data (early season), judge/panel features, rankings-as-of, weather,
// travel distance from last show, etc.

export type ISODate = string; // "YYYY-MM-DD"
export type ISODateTime = string; // "YYYY-MM-DDTHH:mm:ss" (timezone optional but be consistent)

export type SeasonId = string; // e.g. "2024"
export type CompetitionSlug = string; // e.g. "2017-dci-tour-premiere-presented-by-demoulin-bros-and-co"
export type CorpsKey = string; // normalized key, e.g. "bluecoats", "blue-devils"
export type CorpsName = string; // display name, e.g. "Bluecoats"

export type DivisionName = "World Class" | "Open Class" | "All Age" | "SoundSport" | string;
export type GroupTypeId = number; // as seen in payloads (e.g. 4)
export type CompetitionTypeId = number; // as seen in payloads (e.g. 75)

export type CaptionName =
  | "General Effect"
  | "Visual"
  | "Music"
  | "Timing & Penalties"
  | string;

export type SubcaptionName = string; // e.g. "General Effect 1", "Music - Brass", "Color Guard"
export type BreakdownCategory =
  | "Content"
  | "Achievement"
  | "Repertoire"
  | "Performance"
  | "Composition"
  | "Penalties"
  | string;

export interface ScoreBreakdownItem {
  score?: number | null;
  rank?: number | null;
}

/**
 * Breakdown of a judge's score into specific categories (standard DCI).
 */
export type JudgeScoreBreakdown = Partial<Record<BreakdownCategory, ScoreBreakdownItem>>;

export type JudgeId = string; // recommended: stable hashed id derived from judge name
export type JudgeName = string;

export type Region = string;
export type USState = string; // "IN", "CA", etc.

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LocationRef {
  city?: string | null;
  state?: USState | string | null;
  country?: string | null;
  venueName?: string | null;
  geo?: GeoPoint | null;
}

export interface CompetitionRef {
  season: SeasonId;
  slug: CompetitionSlug;
  date: ISODateTime; // competition date/time (use local or UTC, but be consistent)
  dayOfSeason?: number | null;
  daysTillFinals?: number | null;
  percentageThroughSeason?: number | null; // store as 0..1 (recommended), even if source is "0".."100"
  eventName?: string | null; // human name (avoid using as high-cardinality model feature unless hashed/embedded)
  competitionLevel?: number | null; // e.g. 0..n; treat as ordinal/categorical
  location?: LocationRef | null;

  // API-specific metadata (optional but often useful)
  groupTypeId?: GroupTypeId | null;
  competitionTypeId?: CompetitionTypeId | null;
  scoresReleased?: boolean | null;
  recapReleased?: boolean | null;
  categoryRecapReleased?: boolean | null;
}

/** A single judge assignment for a (competition, caption/subcaption). */
export interface JudgeAssignment {
  judgeId: JudgeId;
  judgeName: JudgeName;
  caption: CaptionName;
  subcaption?: SubcaptionName | null; // when the judge maps to a specific subcaption
}

/** Weather context at/near performance time (can be observed or forecast). */
export interface WeatherFeatures {
  // Use whatever source you like; keep these optional.
  temperatureC?: number | null;
  temperatureF?: number | null;
  humidityPct?: number | null; // 0..100
  dewPointC?: number | null;
  windSpeedMps?: number | null;
  windGustMps?: number | null;
  precipitationMm?: number | null;
  precipitationProbPct?: number | null; // 0..100
  pressureHPa?: number | null;
  isRaining?: boolean | null;
  isSnowing?: boolean | null;

  // For data lineage/debug
  weatherSource?: string | null; // e.g. "NOAA", "Open-Meteo", etc.
  weatherObservedAt?: ISODateTime | null;
}

/** Travel context derived from prior appearance (helps: fatigue/logistics). */
export interface TravelFeatures {
  hasLastShow: boolean;
  daysSinceLastShow?: number | null; // if hasLastShow
  lastShowDate?: ISODateTime | null;
  lastShowLocation?: LocationRef | null;

  // Distance/time from last show to this show (derive via geo if you can).
  distanceKmFromLastShow?: number | null;
  distanceMiFromLastShow?: number | null;
  estimatedTravelHours?: number | null;

  // Optional: multi-show travel burden (rolling)
  distanceKmLast7Days?: number | null;
  showCountLast7Days?: number | null;
}

/**
 * Rankings snapshot "as-of" a date (computed from shows strictly BEFORE the target show
 * when used for prediction).
 */
export interface RankingsAsOf {
  asOfDate: ISODateTime;

  // Overall ranks/scores
  hasOverallRank: boolean;
  overallRank?: number | null;
  overallScore?: number | null;

  // By caption
  captionRanks?: Partial<Record<CaptionName, number>>; // rank within class/division
  captionScores?: Partial<Record<CaptionName, number>>;

  // Useful derived gaps (prefer gaps over ordinal ranks when possible)
  gapToLeaderOverall?: number | null;
  gapToNextOverall?: number | null;
  gapToPrevOverall?: number | null;

  // Optional: percentile representations (0..1)
  overallPercentile?: number | null;
  captionPercentiles?: Partial<Record<CaptionName, number>>;
}

/** Rolling form features computed from prior shows within the same season. */
export interface RollingFormFeatures {
  // Use flags so the model can learn missingness.
  hasAnyPriorShow: boolean;
  priorShowCount: number;

  lastScoreTotal?: number | null;
  lastScoreByCaption?: Partial<Record<CaptionName, number>>;

  // Rolling windows (examples; you can add/remove as you like)
  hasLast2: boolean;
  avgLast2Total?: number | null;
  slopeLast2Total?: number | null;

  hasLast3: boolean;
  avgLast3Total?: number | null;
  slopeLast3Total?: number | null;

  // Variability
  stdLast3Total?: number | null;

  // Optional: margins vs field (computed from lineups of prior shows)
  avgMarginVsFieldLast3?: number | null;
}

/** Competition lineup / strength-of-field context. */
export interface FieldStrengthFeatures {
  // Derived from who is present at this competition (known pre-show from entries/lineups, or inferred from recaps).
  corpsCountInClass?: number | null;
  top5PresentCount?: number | null;
  top12PresentCount?: number | null;

  // Summary stats of opponents (as-of date), computed without peeking at target results.
  opponentsAvgOverallScoreAsOf?: number | null;
  opponentsMedianOverallScoreAsOf?: number | null;
  opponentsMaxOverallScoreAsOf?: number | null;

  // Optional: “major show” indicator
  isRegionalOrMajor?: boolean | null;
}

/**
 * Judge/panel features.
 *
 * IMPORTANT: Avoid raw one-hot explosion in your feature store.
 * Best practice: keep judge ids + computed "priors" (bias/spread) learned from history.
 */
export interface JudgePanelFeatures {
  assignments: JudgeAssignment[]; // who is on the panel and where they sit

  // Priors computed from past judging (per judge x caption/subcaption), shrunk toward 0.
  // These are numeric and model-friendly.
  judgeBiasByCaption?: Partial<Record<CaptionName, number>>; // e.g. +0.15 points vs average
  judgeSpreadByCaption?: Partial<Record<CaptionName, number>>; // tendency to separate (higher spread)

  // Coverage flags
  hasAnyJudgeInfo: boolean;
  missingCaptionJudge?: Partial<Record<CaptionName, boolean>>;
}

/** Targets you can train on (total, captions, ranks, etc.). */
export interface ScoreTargets {
  // Primary regression targets
  totalScore: number;
  captionTotals?: Partial<Record<CaptionName, number>>;

  // Optional: ranking targets (classification/ordinal)
  rank?: number | null;

  // Useful for training: which division/class this target belongs to
  divisionName: DivisionName;
}

/** A canonical row used for training/inference. */
export interface TrainingExample {
  // Identity / keys
  season: SeasonId;
  competition: CompetitionRef;

  corpsKey: CorpsKey;
  corpsName?: CorpsName | null;
  divisionName: DivisionName;

  // If you segment by class/group/competition type
  groupTypeId?: GroupTypeId | null;
  competitionTypeId?: CompetitionTypeId | null;

  // Feature blocks
  rankingsAsOf?: RankingsAsOf | null;
  rollingForm: RollingFormFeatures;
  travel: TravelFeatures;
  fieldStrength?: FieldStrengthFeatures | null;
  weather?: WeatherFeatures | null;
  judges?: JudgePanelFeatures | null;

  // Additional optional context
  // Use with caution (high-cardinality). If you include, hash/embedding recommended.
  eventName?: string | null;
  region?: Region | null;

  // “Time” features (explicit, so you don’t rely on parsing date strings later)
  dayOfSeason?: number | null;
  showOfSeason?: number | null; // e.g. 1st show, 2nd show, etc. for this corps
  performanceOrderInClass?: number | null; // 1st, 2nd, etc. in their division/class
  percentageThroughSeason?: number | null; // 0..1 recommended
  daysTillFinals?: number | null;

  // The label (omit for inference-time rows)
  target?: ScoreTargets;
}

/* ---------------------------
   Raw-ish input shapes
   --------------------------- */

/** Minimal raw recap score entry for one corps at one competition. */
export interface RawRecapCorpsScore {
  corps: CorpsName;
  corpsKey?: CorpsKey; // normalize during ingest if not provided
  divisionName: DivisionName;

  totalScore: number; // coerce from string upstream if needed
  subtotalScore?: number | null;
  rank?: number | null;
  subtotalRank?: number | null;

  captionScores?: Record<
    CaptionName,
    {
      score: number; // coerce
      rank?: number | null;

      // Subcaption totals (optional)
      subcaptionScores?: Record<
        SubcaptionName,
        {
          score?: number | null; // if available
          rank?: number | null;

          // Per-judge subcaption details, if present
          judge?: JudgeName | null;
          breakdown?: JudgeScoreBreakdown | null;
        }
      >;

      // Some payloads put judge-scored subcaptions at the caption level too
      // (e.g., "General Effect 1": { judge: "...", score: ... })
      // Keep it flexible:
      judgeEntries?: Record<
        SubcaptionName,
        { judge?: JudgeName | null; score?: number | null; rank?: number | null }
      >;
    }
  >;

  // Helps distinguish DCI categories
  groupType?: GroupTypeId | null;
  competitionType?: CompetitionTypeId | null;
}

/** Raw recap payload normalized enough to store + rebuild features. */
export interface RawCompetitionRecap {
  competition: CompetitionRef;
  scores: RawRecapCorpsScore[];

  // Optional lineage/debug
  fetchedAt?: ISODateTime | null;
  sourceUrl?: string | null;
}

/**
 * Rankings snapshot payload (like the one you posted).
 * Often derived from aggregating recaps; store it for fast access & feature building.
 */
export interface RawRankingsSnapshot {
  season: SeasonId;
  date: ISODateTime;
  percentageThroughSeason?: number | null; // normalize to 0..1
  rankings: Record<
    string, // "total", "General Effect", "Music - Brass", etc.
    Array<{
      corps: CorpsName;
      corpsKey?: CorpsKey;
      score: number | string;
      date: ISODateTime;
      percentThrough?: number | string;
    }>
  >;
}

/* ---------------------------
   Feature-store friendly forms
   --------------------------- */

/** Flattened numeric vector form (if you want to export directly to TF.js tensors). */
export interface NumericFeatureVector {
  // A stable ordering is essential for ML.
  // You can derive this from TrainingExample via a feature builder.

  // Example core
  percentageThroughSeason: number; // default 0 if missing
  dayOfSeason: number; // default -1 if missing
  showOfSeason: number; // default 0 if missing
  performanceOrderInClass: number; // default 0 if missing
  corpsCountInClass: number; // default 0 if missing
  daysSinceLastShow: number; // default -1 if missing
  lastScoreTotal: number; // default 0 if missing
  avgLast3Total: number; // default 0 if missing
  slopeLast3Total: number; // default 0 if missing
  overallRankAsOf: number; // default 0 if missing
  gapToLeaderOverall: number; // default 0 if missing
  distanceKmFromLastShow: number; // default 0 if missing

  // Optional weather
  temperatureF: number; // default 0 if missing
  humidityPct: number; // default 0 if missing
  windSpeedMps: number; // default 0 if missing
  precipitationMm: number; // default 0 if missing

  // Flags
  hasLastShow: 0 | 1;
  hasLast3: 0 | 1;
  hasOverallRank: 0 | 1;
  hasWeather: 0 | 1;
  hasJudgeInfo: 0 | 1;

  // Add more as needed (keep versioned!)
}

/** Categorical ids for embeddings / hashing (TF.js friendly). */
export interface CategoricalFeatureIds {
  corpsId: number; // integer id (lookup table)
  seasonId: number;
  divisionId: number;
  agnosticShowId?: number;
  // Optional
  competitionTypeId?: number;
  groupTypeId?: number;

  // Judge/panel: you can pass a fixed-length array (pad with 0) for embeddings + pooling
  judgeIds?: number[]; // e.g., length N, padded
  judgeCaptionIds?: number[]; // optional parallel array if you encode (judge, caption) pairs
}

/** A training sample already in "model-ready" tensor-ish form. */
export interface ModelReadyExample {
  xNumeric: NumericFeatureVector;
  xCat: CategoricalFeatureIds;
  y: {
    totalScore: number;
    // optionally multi-output
    ge?: number;
    visual?: number;
    music?: number;
  };
  meta: {
    season: SeasonId;
    competitionSlug: CompetitionSlug;
    corpsKey: CorpsKey;
    competitionDate: ISODateTime;
  };
}
