import { SchemaParser } from "effect";
import { optionalWith, Union } from "./schemaCompat.js";
import { Duration, Effect, Order, Ref, Schema, Schedule } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DciApi } from "./service.js";
import type { DciError } from "./errors.js";
import { DciDecodeError } from "./errors.js";
import * as Domain from "./domain.js";
import * as ExtraDomain from "./extraDomain.js";
import {
  upsertStaffMember,
  upsertCorpsShow,
  upsertSeasonParticipationRecord,
  upsertMediaAsset,
  upsertJudgeProfile
} from "./relational.js";

const execFile = promisify(execFileCallback);

const normalizeKey = (value: string | undefined | null) => {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
};

const compareSeasonsDesc = (a: string, b: string) => {
  const yearA = Number.parseInt(a, 10);
  const yearB = Number.parseInt(b, 10);
  if (Number.isFinite(yearA) && Number.isFinite(yearB)) {
    return yearB - yearA;
  }
  return b.localeCompare(a);
};

const toDciError = (cause: unknown, path: string): DciError =>
  cause instanceof DciDecodeError
    ? cause
    : new DciDecodeError({
        message: `Claude scrape failed at ${path}`,
        path,
        issues: cause
      });

export interface ClaudeRunner {
  readonly run: (prompt: string, meta?: { label?: string }) => Effect.Effect<string, DciError>;
}

export interface ClaudeRunnerOptions {
  readonly command?: string;
  readonly dryRun?: boolean;
  readonly dryRunResponse?: string;
  readonly logPrompts?: boolean;
  readonly retry?: {
    readonly attempts?: number;
    readonly initialDelayMs?: number;
  };
}

const makeRetrySchedule = (options?: ClaudeRunnerOptions["retry"]) => {
  if (!options) {
    return Schedule.exponential(Duration.millis(500)).pipe(
      Schedule.both(Schedule.recurs(2)),
      Schedule.jittered
    );
  }
  const attempts = options.attempts ?? 2;
  if (attempts <= 0) {
    return undefined;
  }
  return Schedule.exponential(Duration.millis(options.initialDelayMs ?? 500)).pipe(
    Schedule.both(Schedule.recurs(attempts)),
    Schedule.jittered
  );
};

export const makeClaudeRunner = (options?: ClaudeRunnerOptions): ClaudeRunner => {
  const command = options?.command ?? defaultClaudeCommand();
  const dryRun = options?.dryRun ?? false;
  const logPrompts = options?.logPrompts ?? false;
  const dryRunResponse = options?.dryRunResponse ?? "{}";
  const retrySchedule = makeRetrySchedule(options?.retry);

  return {
    run: (prompt, meta) => {
      const label = meta?.label ?? "claude";
      const logEffect = logPrompts ? Effect.logDebug(`[${label}] Claude prompt:\n${prompt}`) : Effect.void;
      const baseEffect = dryRun
        ? Effect.sync(() => dryRunResponse)
        : runClaudeCommand(command, prompt);
      const effectWithLog = logEffect.pipe(Effect.andThen(baseEffect));
      return retrySchedule ? effectWithLog.pipe(Effect.retry(retrySchedule)) : effectWithLog;
    }
  };
};

const deriveCorpsKey = (score: Domain.CorpsScore) =>
  score.orgGroupIdentifier?.toLowerCase() ?? normalizeKey(score.groupName) ?? `corps-${score.rank}`;

const formatDate = (date: Date) => date.toISOString().split("T")[0]!;

interface CompetitionSummary {
  readonly slug: string;
  readonly eventName: string;
  readonly location: string | undefined;
  readonly date: Date;
}

interface CorpsSeasonTask {
  readonly season: string;
  readonly corpsKey: string;
  readonly corpsName: string;
  readonly competitions: ReadonlyArray<CompetitionSummary>;
}

const competitionOrder = Order.mapInput(Order.Number, (competition: CompetitionSummary) =>
  competition.date.getTime()
);

const buildCompetitionSummaryLines = (competitions: ReadonlyArray<CompetitionSummary>) =>
  competitions
    .slice()
    .sort((a, b) => competitionOrder(b, a))
    .map(
      (competition) =>
        `- ${competition.eventName} on ${formatDate(competition.date)} @ ${competition.location ?? "TBD"}`
    )
    .join("\n");

interface JudgeAssignmentSummary {
  readonly competitionSlug: string;
  readonly eventName: string;
  readonly season: string;
  readonly caption: string;
  readonly date: Date;
  readonly location?: string;
  readonly corpsHighlights: ReadonlyArray<string>;
}

interface JudgeRelationContext {
  readonly relationKey: string;
  readonly corpsKey?: string;
  readonly corpsName?: string;
  readonly seasons: ReadonlyArray<string>;
  readonly captions: ReadonlyArray<string>;
  readonly competitions: ReadonlyArray<string>;
}

interface JudgeTask {
  readonly judgeId: string;
  readonly displayName: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly seasons: ReadonlyArray<string>;
  readonly captions: ReadonlyArray<string>;
  readonly competitions: ReadonlyArray<JudgeAssignmentSummary>;
  readonly relations: ReadonlyArray<JudgeRelationContext>;
  readonly relationLookup: Map<string, JudgeRelationContext>;
}

const buildPrompt = (task: CorpsSeasonTask) => {
  const competitionLines = buildCompetitionSummaryLines(task.competitions);
  return `
You are a meticulous researcher building a factual dossier for the ${task.season} season of ${task.corpsName} (corps key: ${task.corpsKey}). 

MANDATORY RESEARCH WORKFLOW:
1. Wikipedia: search for "${task.corpsName}" and specifically look for ${task.season} show information or historical summaries.
2. Official corps website: browse current pages, news posts, and season announcements. If unavailable, pull relevant snapshots via the Internet Archive Wayback Machine.
3. DCI.org: scan event pages, competition recaps, articles, and show descriptions.
4. External coverage: use Google searches (quotes + ${task.season}) for press releases, blog reviews, and reputable news sources.
5. Cross-check all facts. When conflicting, favor official sources or majority consensus.

CONTEXT FROM THE DCI API (corps appearances):
${competitionLines || "- No competitions recorded (fill roster info only)." }

OUTPUT REQUIREMENTS:
- Respond with JSON ONLY (no prose, no Markdown fences).
- The JSON must match the following TypeScript interface (all arrays optional but preferred when data exists):
{
  "shows": ExtraDomain.CorpsShowSchema[],
  "staff": ExtraDomain.CorpsStaffMemberSchema[],
  "participation": ExtraDomain.CorpsSeasonParticipationSchema[],
  "media": ExtraDomain.MediaAssetSchema[]
}

GUIDELINES:
- Every show must include showId, corpsKey="${task.corpsKey}", corpsName="${task.corpsName}", and season="${task.season}". 
  If an official show title is unknown, create a stable placeholder like "${task.corpsKey}-${task.season}-show".
- Repertoire entries should include composers/arrangers when mentioned. Provide hyperlinks (hyperlink fields or sourceUrl values) pointing to the best reference.
- Staff records should describe key designers/instructors with bios when available. Each assignment should reference corpsKey="${task.corpsKey}" and season="${task.season}".
- Participation entries should state division/status (e.g., World Class finalist).
- Media items must include ownerType ("corps", "staff", or "show"), ownerId (e.g., a showId or staffId), url, mediaType ("image","video","article", etc.), and thumbnailUrl if available.
- Include sourceUrl fields or link arrays referencing Wikipedia/official/DCI/Wayback/Google sources so we can trace provenance.

Remember: respond with strictly valid JSON.
`.trim();
};

const buildMediaPrompt = (task: CorpsSeasonTask) => {
  const competitionLines = buildCompetitionSummaryLines(task.competitions);
  return `
You are a media researcher collecting high-quality assets for ${task.corpsName} during the ${task.season} season.

MANDATORY SOURCES (search each in order and cite best links):
1. Official corps website/CDN (current and archived pages via Wayback Machine).
2. Corps social channels: Instagram, TikTok, YouTube, Facebook, X/Twitter (look for reels/shorts/live streams).
3. DCI.org galleries, event recaps, and press releases.
4. Google Images/Videos (focus on reputable sources and official uploads).

CONTEXT – Key appearances this season:
${competitionLines || "- No competitions recorded for this season."}

OUTPUT: JSON ONLY with shape { "media": ExtraDomain.MediaAssetSchema[] }

MEDIA REQUIREMENTS:
- Each asset must include mediaId, ownerType ("corps","show","staff","competition"), ownerId, url (direct CDN/video/article), mediaType ("image","video","article","short","audio"), and sourceUrl if different from url.
- Provide title/description summarizing the asset, plus attribution (photographer/channel).
- Include thumbnailUrl for video/reel assets, and format labels (e.g., "mp4","instagram-reel","youtube-short").
- Prefer official or high-quality uploads. Skip low-res duplicates.
- Return strict JSON, no markdown.
`.trim();
};

const describeJudgeRelations = (task: JudgeTask) =>
  task.relations
    .slice(0, 10)
    .map(
      (relation) =>
        `- ${relation.corpsName ?? relation.corpsKey ?? "Unknown corps"} (seasons: ${
          relation.seasons.join(", ") || "n/a"
        }, captions: ${relation.captions.join(", ") || "n/a"})`
    )
    .join("\n");

const describeJudgeCompetitions = (task: JudgeTask) =>
  task.competitions
    .slice(0, 12)
    .map(
      (assignment) =>
        `- ${assignment.season} ${assignment.eventName} (${assignment.caption}) on ${formatDate(assignment.date)}${
          assignment.location ? ` @ ${assignment.location}` : ""
        }`
    )
    .join("\n");

const buildJudgePrompt = (task: JudgeTask) => {
  const competitionLines = describeJudgeCompetitions(task);
  const relationLines = describeJudgeRelations(task);
  return `
You are compiling a detailed professional profile for adjudicator ${task.displayName} (judge id ${task.judgeId}).

RESEARCH PROTOCOL:
1. Search DCI.org for judge bios, recaps, and press releases mentioning ${task.displayName}.
2. Review official corps/staff listings, adjudication panels, and educational clinics for context.
3. Use reputable sources (LinkedIn, professional bios, band associations, music publications) for biography/background.
4. Use Google, Wayback Machine, and image/video platforms to find headshots or interview media. Cite sources.
5. If multiple individuals share the same name, determine whether they are the same person—note alternate names or confirmations.

CONTEXT:
- Seasons observed: ${task.seasons.join(", ") || "n/a"}
- Captions assigned: ${task.captions.join(", ") || "n/a"}
- Key competitions:
${competitionLines || "- No known competitions"}
- Frequent corps / circuits:
${relationLines || "- Data limited"}

OUTPUT STRICTLY JSON matching:
{
  "judge": ExtraDomain.JudgeProfileSchema
}

GUIDELINES:
- Always populate judgeId="${task.judgeId}" and displayName="${task.displayName}".
- Include biography text summarizing judging background, performance history, education, and notable achievements.
- Provide photoUrl when a reliable headshot exists (use HTTPS CDN or official uploads).
- Include alternateNames array when other spellings or aliases appear.
- Capture corpsRelations entries referencing corps/season involvement (judge panels, staff crossover, etc.) with sourceUrl.
- SeasonHighlights should summarize notable seasons or milestones.
- media entries should reference interviews, videos, or photos, tagging ownerType="judge" and ownerId="${task.judgeId}".
- Provide externalLinks (article, LinkedIn, organization) whenever cited.
- Be precise and cite trustworthy sources. Respond with JSON only—no commentary.
`.trim();
};

const ClaudePayloadSchema = Schema.Struct({
  shows: Schema.Array(ExtraDomain.CorpsShowSchema).pipe(optionalWith({ default: () => [] })),
  staff: Schema.Array(ExtraDomain.CorpsStaffMemberSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  participation: Schema.Array(ExtraDomain.CorpsSeasonParticipationSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  media: Schema.Array(ExtraDomain.MediaAssetSchema).pipe(optionalWith({ default: () => [] }))
});

type ClaudePayload = typeof ClaudePayloadSchema.Type;

const normalizeJudgeProfileOutput = (
  task: JudgeTask,
  raw: Partial<ExtraDomain.JudgeBioProfile>
): Effect.Effect<ExtraDomain.JudgeBioProfile, DciError> => {
  const judge = {
    ...raw,
    judgeId: raw?.judgeId ?? task.judgeId,
    displayName: raw?.displayName ?? task.displayName,
    givenName: raw?.givenName ?? task.givenName,
    familyName: raw?.familyName ?? task.familyName,
    corpsRelations: Array.isArray(raw?.corpsRelations)
      ? raw!.corpsRelations!.map((relation, index) => {
          const key =
            relation.relationId ??
            relation.corpsKey ??
            (relation.corpsName ? normalizeKey(relation.corpsName) ?? relation.corpsName.toLowerCase() : undefined) ??
            `${task.judgeId}:relation:${index}`;
          const hint = key ? task.relationLookup.get(key) : undefined;
          return {
            ...relation,
            relationId: relation.relationId ?? `${task.judgeId}:${index}`,
            judgeId: relation.judgeId ?? task.judgeId,
            corpsKey: relation.corpsKey ?? hint?.corpsKey ?? undefined,
            corpsName: relation.corpsName ?? hint?.corpsName ?? undefined
          };
        })
      : [],
    media: Array.isArray(raw?.media)
      ? raw!.media!.map((asset, index) => ({
          ...asset,
          mediaId: asset.mediaId ?? `${task.judgeId}-media-${index + 1}`,
          ownerType: asset.ownerType ?? "judge",
          ownerId: asset.ownerId ?? task.judgeId
        }))
      : []
  };
  return SchemaParser.decodeUnknownEffect(ExtraDomain.JudgeProfileSchema)(judge).pipe(
    Effect.mapError((cause) => toDciError(cause, "scraperClaude.judgeProfile"))
  );
};

const buildFallbackId = (base: string, index: number, suffix: string) =>
  `${base}-${suffix}-${index + 1}`;

const normalizeShow = (
  task: CorpsSeasonTask,
  show: Partial<ExtraDomain.CorpsShow>,
  index: number
): ExtraDomain.CorpsShow => {
  const title = show.title ?? `Program ${task.season}`;
  const showId =
    show.showId ??
    `${task.corpsKey}-${task.season}-${normalizeKey(title) || buildFallbackId(task.corpsKey, index, "show")}`;
  return {
    ...show,
    showId,
    corpsKey: show.corpsKey ?? task.corpsKey,
    corpsName: show.corpsName ?? task.corpsName,
    season: show.season ?? task.season,
    title
  } as ExtraDomain.CorpsShow;
};

const normalizeStaffMember = (
  task: CorpsSeasonTask,
  member: Partial<ExtraDomain.CorpsStaffMember>,
  index: number
): ExtraDomain.CorpsStaffMember => {
  const staffId =
    member.staffId ?? buildFallbackId(task.corpsKey, index, "staff");
  const assignments = (member.assignments ?? []).map((assignment, idx) => ({
    ...assignment,
    assignmentId:
      assignment.assignmentId ?? buildFallbackId(staffId, idx, "assignment"),
    corpsKey: assignment.corpsKey ?? task.corpsKey,
    corpsName: assignment.corpsName ?? task.corpsName,
    season: assignment.season ?? task.season
  }));
  const affiliations = (member.affiliations ?? []).map((affiliation, idx) => ({
    ...affiliation,
    affiliationId:
      affiliation.affiliationId ?? buildFallbackId(staffId, idx, "affiliation"),
    relatedCorpsKey: affiliation.relatedCorpsKey ?? task.corpsKey
  }));
  return {
    staffId,
    givenName: member.givenName ?? undefined,
    familyName: member.familyName ?? undefined,
    displayName: member.displayName ?? member.givenName ?? member.familyName ?? `Staff ${index + 1}`,
    defaultTitle: member.defaultTitle ?? undefined,
    biography: member.biography ?? undefined,
    photoUrl: member.photoUrl ?? undefined,
    externalLinks: member.externalLinks ?? [],
    assignments,
    affiliations,
    metadata: member.metadata ?? undefined
  };
};

const normalizeParticipation = (
  task: CorpsSeasonTask,
  record: Partial<ExtraDomain.CorpsSeasonParticipation>
): ExtraDomain.CorpsSeasonParticipation => ({
  participationId: record.participationId,
  season: record.season ?? task.season,
  corpsKey: record.corpsKey ?? task.corpsKey,
  corpsName: record.corpsName ?? task.corpsName,
  division: record.division ?? undefined,
  status: record.status ?? undefined,
  participationType: record.participationType ?? undefined,
  firstAppearance: record.firstAppearance ?? undefined,
  lastAppearance: record.lastAppearance ?? undefined,
  notes: record.notes ?? undefined,
  derivedFrom: record.derivedFrom ?? undefined,
  metadata: record.metadata ?? undefined
});

const normalizeMediaAsset = (
  task: CorpsSeasonTask,
  asset: Partial<ExtraDomain.MediaAsset>,
  index: number
): ExtraDomain.MediaAsset => {
  const mediaId =
    asset.mediaId ?? buildFallbackId(task.corpsKey, index, "media");
  return {
    mediaId,
    ownerType: asset.ownerType ?? "corps",
    ownerId: asset.ownerId ?? task.corpsKey,
    url: asset.url ?? "",
    title: asset.title ?? undefined,
    description: asset.description ?? undefined,
    mediaType: asset.mediaType ?? "image",
    format: asset.format ?? undefined,
    attribution: asset.attribution ?? undefined,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    durationSeconds: asset.durationSeconds ?? undefined,
    thumbnailUrl: asset.thumbnailUrl ?? undefined,
    sourceUrl: asset.sourceUrl ?? undefined,
    metadata: asset.metadata ?? undefined
  };
};

const normalizePayload = (task: CorpsSeasonTask, raw: any) => {
  const shows = Array.isArray(raw?.shows) ? raw.shows : [];
  const staff = Array.isArray(raw?.staff) ? raw.staff : [];
  const participation = Array.isArray(raw?.participation) ? raw.participation : [];
  const media = Array.isArray(raw?.media) ? raw.media : [];

  const normalized = {
    shows: shows.map((show: Partial<ExtraDomain.CorpsShow>, index: number) => normalizeShow(task, show, index)),
    staff: staff.map((member: Partial<ExtraDomain.CorpsStaffMember>, index: number) =>
      normalizeStaffMember(task, member, index)
    ),
    participation: participation.map((record: Partial<ExtraDomain.CorpsSeasonParticipation>) =>
      normalizeParticipation(task, record)
    ),
    media: media.map((asset: Partial<ExtraDomain.MediaAsset>, index: number) =>
      normalizeMediaAsset(task, asset, index)
    )
  };
  return SchemaParser.decodeUnknownEffect(ClaudePayloadSchema)(normalized).pipe(
    Effect.mapError((cause) => toDciError(cause, "scraperClaude.payload"))
  );
};

const ensureScraperProgressTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS scraper_progress (
      task_type TEXT NOT NULL,
      season TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT,
      PRIMARY KEY (task_type, season, corps_key)
    )
  `.pipe(Effect.asVoid);

const getScraperTaskStatus = (
  sql: SqlClient.SqlClient,
  taskType: string,
  season: string,
  corpsKey: string
) =>
  sql<{ status: string }>`
    SELECT status FROM scraper_progress
    WHERE task_type = ${taskType} AND season = ${season} AND corps_key = ${corpsKey}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.status),
    Effect.catch(() => Effect.succeed<string | undefined>(undefined))
  );

const markScraperTaskStatus = (
  sql: SqlClient.SqlClient,
  taskType: string,
  season: string,
  corpsKey: string,
  status: string,
  payload?: string
) => {
  const now = new Date().toISOString();
  return sql`
    INSERT INTO scraper_progress (task_type, season, corps_key, status, updated_at, payload)
    VALUES (${taskType}, ${season}, ${corpsKey}, ${status}, ${now}, ${payload ?? null})
    ON CONFLICT(task_type, season, corps_key)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
  `.pipe(Effect.asVoid);
};

const shouldSkipScraperTask = (
  sql: SqlClient.SqlClient,
  taskType: string,
  season: string,
  corpsKey: string,
  resume: boolean
) =>
  resume
    ? getScraperTaskStatus(sql, taskType, season, corpsKey).pipe(
        Effect.map((status) => status === "completed")
      )
    : Effect.succeed(false);

const parseClaudeJson = (output: string, label: string) =>
  Effect.try({
    try: () => JSON.parse(output),
    catch: (cause) =>
      new DciDecodeError({
        message: `Invalid JSON from Claude for ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: "scraper.claude.json",
        issues: cause
      })
  });

const describeStaffMember = (member: ExtraDomain.CorpsStaffMember) => {
  const names = [
    member.displayName,
    member.givenName && member.familyName ? `${member.givenName} ${member.familyName}` : undefined
  ]
    .filter(Boolean)
    .join(" / ");
  const titles = member.assignments?.map((assignment) => assignment.title).filter(Boolean) ?? [];
  const corpsSet = new Set(
    member.assignments?.map((assignment) => assignment.corpsName ?? assignment.corpsKey).filter(Boolean)
  );
  const seasons = new Set(member.assignments?.map((assignment) => assignment.season).filter(Boolean));
  const links = member.externalLinks ?? [];
  const photo = member.photoUrl ?? links.find((link) => link.kind === "photo")?.url;

  return [
    `Name(s): ${names || member.staffId}`,
    `Titles: ${titles.length > 0 ? titles.join(", ") : "Unknown"}`,
    `Corps: ${corpsSet.size > 0 ? Array.from(corpsSet).join(", ") : "Unknown"}`,
    `Seasons: ${seasons.size > 0 ? Array.from(seasons).join(", ") : "Unknown"}`,
    member.biography ? `Bio snippet: ${member.biography.slice(0, 280)}` : undefined,
    `Assignments count: ${member.assignments?.length ?? 0}`,
    `Photo: ${photo ?? "n/a"}`,
    links.length > 0 ? `Links: ${links.map((link) => `${link.label ?? link.kind ?? link.url}: ${link.url}`).join("; ")}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
};

const describeJudgeProfile = (judge: ExtraDomain.JudgeBioProfile) => {
  const links = judge.externalLinks ?? [];
  const relations =
    judge.corpsRelations?.map((relation) => {
      const corps = relation.corpsName ?? relation.corpsKey ?? "Unknown corps";
      const season = relation.season ?? "multi-season";
      const role = relation.role ?? relation.captionGroup ?? "judge";
      return `${corps} (${season}, ${role})`;
    }) ?? [];
  const highlights =
    judge.seasonHighlights?.map(
      (highlight) => `${highlight.season ?? "n/a"}: ${highlight.summary ?? ""}`
    ) ?? [];
  return [
    `Name: ${judge.displayName}`,
    judge.givenName || judge.familyName
      ? `Given/Family: ${judge.givenName ?? ""} ${judge.familyName ?? ""}`.trim()
      : undefined,
    judge.biography ? `Bio: ${judge.biography}` : undefined,
    relations.length > 0 ? `Corps Relations: ${relations.join("; ")}` : undefined,
    highlights.length > 0 ? `Highlights: ${highlights.join(" | ")}` : undefined,
    links.length > 0 ? `Links: ${links.map((link) => link.url).join(", ")}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
};

const buildJudgeComparisonPrompt = (
  judgeA: ExtraDomain.JudgeBioProfile,
  judgeB: ExtraDomain.JudgeBioProfile
) => `
You are a fact-checker verifying whether two judge biographies describe the same person.
Use all provided context (bios, corps relations, seasons, links) to decide if they are one individual.
Return JSON only matching StaffComparisonResultSchema (same format used for staff comparisons).

Judge Profile A:
${describeJudgeProfile(judgeA)}

Judge Profile B:
${describeJudgeProfile(judgeB)}

Deliver a JSON object with fields: samePerson, confidence, rationale, supportingEvidence[], recommendedAction (merge|keep-separate|needs-review), normalizedName?, notes?.
`.trim();

const buildStaffComparisonPrompt = (
  memberA: ExtraDomain.CorpsStaffMember,
  memberB: ExtraDomain.CorpsStaffMember
) => `
You are validating whether two marching arts staff profiles refer to the SAME PERSON.

Mandatory workflow:
1. Review the provided summaries carefully.
2. Search official corps websites, staff bios, press releases, and LinkedIn/IMDb-style profiles for confirmation.
3. Use image searches (Google Images, social media, Wayback snapshots) to compare headshots if available.
4. Cross-check third-party sources (DCI.org, Drum Corps Planet, Wikipedia) for matching histories.
5. Only conclude they are the same person when multiple independent signals align (name, role, career timeline, photos).

Output JSON ONLY:
{
  "samePerson": boolean,
  "confidence": number (0-1),
  "rationale": string,
  "supportingEvidence": string[],
  "recommendedAction": "merge" | "keep-separate" | "needs-review",
  "normalizedName"?: string,
  "notes"?: string
}

Profile A:
${describeStaffMember(memberA)}

Profile B:
${describeStaffMember(memberB)}

Return strict JSON, no commentary.
`.trim();

const StaffComparisonResultSchema = Schema.Struct({
  samePerson: Schema.Boolean,
  confidence: Schema.Number.pipe(optionalWith({ default: () => 0 })),
  rationale: Schema.String,
  supportingEvidence: Schema.Array(Schema.String).pipe(optionalWith({ default: () => [] })),
  recommendedAction: Union(
    Schema.Literals(["merge", "keep-separate", "needs-review"]),
    Schema.String
  ),
  normalizedName: Schema.String.pipe(optionalWith({ nullable: true })),
  notes: Schema.String.pipe(optionalWith({ nullable: true }))
});

export type StaffComparisonResult = typeof StaffComparisonResultSchema.Type;

interface CorpInfo {
  corpsKey: string;
  corpsName: string;
  competitions: Map<string, CompetitionSummary>;
}

const collectCorpsForSeason = (
  api: DciApi,
  season: string
): Effect.Effect<readonly CorpsSeasonTask[], DciError> =>
  Effect.gen(function* () {
    const competitions = yield* (api.getCompetitions(season));
    const map = new Map<string, CorpInfo>();

    for (const competition of competitions) {
      if (!competition.slug || !competition.recapReleased) {
        continue;
      }
      const recap = yield* (api.getCompetitionRecap(competition.slug));
      const summary: CompetitionSummary = {
        slug: competition.slug,
        eventName: competition.eventName,
        location: competition.location,
        date: competition.date
      };
      for (const score of recap) {
        const corpsKey = deriveCorpsKey(score);
        const info = map.get(corpsKey) ?? {
          corpsKey,
          corpsName: score.groupName,
          competitions: new Map<string, CompetitionSummary>()
        };
        info.corpsName = score.groupName ?? info.corpsName;
        info.competitions.set(competition.slug, summary);
        map.set(corpsKey, info);
      }
    }

    const tasks: CorpsSeasonTask[] = Array.from(map.values()).map((info) => ({
      season,
      corpsKey: info.corpsKey,
      corpsName: info.corpsName,
      competitions: Array.from(info.competitions.values())
    }));

    tasks.sort((a, b) => a.corpsName.localeCompare(b.corpsName));
    return tasks;
  });

const judgeNamePart = (value?: string | null) => normalizeKey(value) ?? "unknown";

const makeJudgeIdentifier = (judge: Domain.JudgeCaption) => {
  const judgeNumber = judge.Judge !== undefined ? String(judge.Judge) : "0";
  return `${judgeNamePart(judge.JudgeFirstName)}-${judgeNamePart(judge.JudgeLastName)}-${judgeNumber}`;
};

interface JudgeRelationAggregate {
  readonly relationKey: string;
  readonly corpsKey?: string;
  readonly corpsName?: string;
  readonly seasons: Set<string>;
  readonly captions: Set<string>;
  readonly competitions: Set<string>;
}

interface JudgeAggregation {
  judgeId: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  seasons: Set<string>;
  captions: Set<string>;
  competitions: JudgeAssignmentSummary[];
  relations: Map<string, JudgeRelationAggregate>;
}

const collectJudgesForSeason = (
  api: DciApi,
  season: string
): Effect.Effect<Map<string, JudgeAggregation>, DciError> =>
  Effect.gen(function* () {
    const competitions = yield* (api.getCompetitions(season));
    const map = new Map<string, JudgeAggregation>();

    for (const competition of competitions) {
      if (!competition.slug || !competition.recapReleased) {
        continue;
      }
      const recap = yield* (api.getCompetitionRecap(competition.slug));
      const sortedScores = recap.slice().sort((a, b) => a.rank - b.rank);
      const corpsHighlights = sortedScores.slice(0, 5).map((score) => score.groupName);
      const seen = new Set<string>();

      for (const score of recap) {
        for (const category of score.categories) {
          for (const judgeScore of category.Captions ?? []) {
            const judgeId = makeJudgeIdentifier(judgeScore);
            const displayName = `${judgeScore.JudgeFirstName ?? ""} ${judgeScore.JudgeLastName ?? ""}`.trim() ||
              judgeScore.Name;
            let aggregation = map.get(judgeId);
            if (!aggregation) {
              aggregation = {
                judgeId,
                displayName,
                givenName: judgeScore.JudgeFirstName ?? undefined,
                familyName: judgeScore.JudgeLastName ?? undefined,
                seasons: new Set<string>(),
                captions: new Set<string>(),
                competitions: [],
                relations: new Map()
              };
              map.set(judgeId, aggregation);
            } else if (!aggregation.displayName && displayName) {
              aggregation.displayName = displayName;
            }

            aggregation.seasons.add(season);
            aggregation.captions.add(category.Name);

            const assignmentKey = `${competition.slug}:${category.Name}:${judgeId}`;
            if (!seen.has(assignmentKey)) {
              seen.add(assignmentKey);
              aggregation.competitions.push({
                competitionSlug: competition.slug,
                eventName: competition.eventName,
                season,
                caption: category.Name,
                date: competition.date,
                location: competition.location,
                corpsHighlights
              });
            }

            const corpsKey = deriveCorpsKey(score);
            const relationKey = corpsKey ?? normalizeKey(score.groupName) ?? score.groupName;
            const relation = aggregation.relations.get(relationKey) ?? {
              relationKey,
              corpsKey,
              corpsName: score.groupName,
              seasons: new Set<string>(),
              captions: new Set<string>(),
              competitions: new Set<string>()
            };
            relation.seasons.add(season);
            relation.captions.add(category.Name);
            relation.competitions.add(competition.slug);
            aggregation.relations.set(relationKey, relation);
          }
        }
      }
    }

    return map;
  });

const mergeJudgeAggregations = (
  existing: JudgeAggregation,
  incoming: JudgeAggregation
) => {
  incoming.seasons.forEach((season) => existing.seasons.add(season));
  incoming.captions.forEach((caption) => existing.captions.add(caption));
  existing.competitions.push(...incoming.competitions);
  for (const relation of incoming.relations.values()) {
    const existingRelation = existing.relations.get(relation.relationKey) ?? {
      relationKey: relation.relationKey,
      corpsKey: relation.corpsKey,
      corpsName: relation.corpsName,
      seasons: new Set<string>(),
      captions: new Set<string>(),
      competitions: new Set<string>()
    };
    relation.seasons.forEach((season) => existingRelation.seasons.add(season));
    relation.captions.forEach((caption) => existingRelation.captions.add(caption));
    relation.competitions.forEach((slug) => existingRelation.competitions.add(slug));
    existing.relations.set(relation.relationKey, existingRelation);
  }
};

const mergeJudgeMaps = (target: Map<string, JudgeAggregation>, source: Map<string, JudgeAggregation>) => {
  for (const [judgeId, aggregation] of source.entries()) {
    const existing = target.get(judgeId);
    if (existing) {
      mergeJudgeAggregations(existing, aggregation);
    } else {
      target.set(judgeId, aggregation);
    }
  }
};

const finalizeJudgeTasks = (aggregations: Map<string, JudgeAggregation>): JudgeTask[] => {
  const tasks: JudgeTask[] = [];
  for (const aggregation of aggregations.values()) {
    const relationsArray: JudgeRelationContext[] = Array.from(aggregation.relations.values()).map((relation) => ({
      relationKey: relation.relationKey,
      corpsKey: relation.corpsKey,
      corpsName: relation.corpsName,
      seasons: Array.from(relation.seasons).sort(),
      captions: Array.from(relation.captions).sort(),
      competitions: Array.from(relation.competitions).sort()
    }));
    const relationLookup = new Map<string, JudgeRelationContext>();
    for (const relation of relationsArray) {
      relationLookup.set(relation.relationKey, relation);
      if (relation.corpsKey) {
        relationLookup.set(relation.corpsKey, relation);
      }
      if (relation.corpsName) {
        relationLookup.set(normalizeKey(relation.corpsName) ?? relation.corpsName.toLowerCase(), relation);
      }
    }
    tasks.push({
      judgeId: aggregation.judgeId,
      displayName: aggregation.displayName,
      givenName: aggregation.givenName,
      familyName: aggregation.familyName,
      seasons: Array.from(aggregation.seasons).sort(),
      captions: Array.from(aggregation.captions).sort(),
      competitions: aggregation.competitions
        .slice()
        .sort((a, b) => b.date.getTime() - a.date.getTime()),
      relations: relationsArray,
      relationLookup
    });
  }
  // Rank by assignment volume (deduped competition*caption count) so `maxTasks`
  // selects the most-active judges first; break ties alphabetically for stability.
  tasks.sort((a, b) => b.competitions.length - a.competitions.length || a.displayName.localeCompare(b.displayName));
  return tasks;
};

interface ClaudeScraperOptions {
  readonly claudeCommand?: string;
  readonly targetSeasons?: ReadonlyArray<string>;
  /** When set, only research these judge ids (overrides maxTasks ranking). */
  readonly targetJudgeIds?: ReadonlyArray<string>;
  readonly seasonsLimit?: number;
  readonly concurrency?: number;
  readonly maxTasks?: number;
  readonly dryRun?: boolean;
  readonly logPrompts?: boolean;
  readonly retry?: {
    readonly attempts?: number;
    readonly initialDelayMs?: number;
  };
  readonly resume?: boolean;
  readonly runner?: ClaudeRunner;
  readonly taskType?: string;
}

export interface ClaudeScraperStats {
  readonly seasons: number;
  readonly corps: number;
  readonly shows: number;
  readonly staff: number;
  readonly participation: number;
  readonly media: number;
  readonly skipped: number;
}

const defaultClaudeCommand = () =>
  process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? "claude";

const runClaudeCommand = (command: string, prompt: string) =>
  Effect.tryPromise({
    try: () =>
      execFile(command, ["-p", prompt], {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      }),
    catch: (cause) => cause as Error
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.mapError(
      (cause) =>
        new DciDecodeError({
          message: `Claude CLI failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: "scraper.claude",
          issues: cause
        })
    )
  );

const processDataTask = (
  sql: SqlClient.SqlClient,
  runner: ClaudeRunner,
  task: CorpsSeasonTask,
  counters: {
    corps: Ref.Ref<number>;
    shows: Ref.Ref<number>;
    staff: Ref.Ref<number>;
    participation: Ref.Ref<number>;
    media: Ref.Ref<number>;
    skipped: Ref.Ref<number>;
  },
  options: { resume: boolean; taskType: string }
) =>
  Effect.gen(function* () {
    const skip = yield* (shouldSkipScraperTask(sql, options.taskType, task.season, task.corpsKey, options.resume));
    if (skip) {
      yield* (Effect.logDebug(`Skipping ${task.corpsName} ${task.season} (already completed)`));
      return;
    }

    yield* (markScraperTaskStatus(sql, options.taskType, task.season, task.corpsKey, "in-progress"));

    const prompt = buildPrompt(task);
    const output = yield* (runner.run(prompt, { label: `${task.corpsKey}-${task.season}` }));
    const parsed = yield* (parseClaudeJson(output, `${task.corpsName} ${task.season}`));
    const payload = yield* (normalizePayload(task, parsed));

    for (const show of payload.shows) {
      yield* (upsertCorpsShow(sql, show));
      yield* (Ref.update(counters.shows, (value) => value + 1));
    }

    for (const staff of payload.staff) {
      yield* (upsertStaffMember(sql, staff));
      yield* (Ref.update(counters.staff, (value) => value + 1));
    }

    for (const participation of payload.participation) {
      yield* (upsertSeasonParticipationRecord(sql, participation));
      yield* (Ref.update(counters.participation, (value) => value + 1));
    }

    for (const media of payload.media) {
      if (!media.url) continue;
      yield* (upsertMediaAsset(sql, media));
      yield* (Ref.update(counters.media, (value) => value + 1));
    }

    const summary = {
      shows: payload.shows.length,
      staff: payload.staff.length,
      participation: payload.participation.length,
      media: payload.media.length
    };
    yield* (
      markScraperTaskStatus(
        sql,
        options.taskType,
        task.season,
        task.corpsKey,
        "completed",
        JSON.stringify(summary)
      )
    );
    yield* (Ref.update(counters.corps, (value) => value + 1));
    yield* (Effect.logInfo(`Ingested ${task.corpsName} ${task.season} via Claude.`));
  }).pipe(
    Effect.catch((error) =>
      markScraperTaskStatus(
        sql,
        options.taskType,
        task.season,
        task.corpsKey,
        "failed",
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      ).pipe(
        Effect.andThen(Ref.update(counters.skipped, (value) => value + 1)),
        Effect.andThen(
          Effect.logError(
            `Claude data task failed for ${task.corpsName} ${task.season}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      )
    )
  );

const processJudgeTask = (
  sql: SqlClient.SqlClient,
  runner: ClaudeRunner,
  task: JudgeTask,
  counters: {
    judges: Ref.Ref<number>;
    media: Ref.Ref<number>;
    skipped: Ref.Ref<number>;
  },
  options: { resume: boolean; taskType: string }
) =>
  Effect.gen(function* () {
    const primarySeason = task.seasons[0] ?? "multi";
    const skip = yield* (
      shouldSkipScraperTask(sql, options.taskType, primarySeason, task.judgeId, options.resume)
    );
    if (skip) {
      yield* (Effect.logDebug(`Skipping judge ${task.displayName} (${task.judgeId})`));
      return;
    }

    yield* (
      markScraperTaskStatus(sql, options.taskType, primarySeason, task.judgeId, "in-progress")
    );

    const prompt = buildJudgePrompt(task);
    const output = yield* (
      runner.run(prompt, { label: `judge-${task.judgeId}` })
    );
    const parsed = yield* (parseClaudeJson(output, `judge ${task.displayName}`));
    const normalized = yield* (
      normalizeJudgeProfileOutput(task, (parsed?.judge ?? parsed) as Partial<ExtraDomain.JudgeBioProfile>)
    );
    yield* (upsertJudgeProfile(sql, normalized));
    yield* (Ref.update(counters.judges, (value) => value + 1));
    yield* (
      Ref.update(counters.media, (value) => value + (normalized.media?.length ?? 0))
    );

    yield* (
      markScraperTaskStatus(
        sql,
        options.taskType,
        primarySeason,
        task.judgeId,
        "completed",
        JSON.stringify({
          media: normalized.media?.length ?? 0,
          relations: normalized.corpsRelations?.length ?? 0
        })
      )
    );
    yield* (Effect.logInfo(`Enriched judge profile for ${task.displayName}`));
  }).pipe(
    Effect.catch((error) =>
      markScraperTaskStatus(
        sql,
        options.taskType,
        task.seasons[0] ?? "multi",
        task.judgeId,
        "failed",
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      ).pipe(
        Effect.andThen(Ref.update(counters.skipped, (value) => value + 1)),
        Effect.andThen(
          Effect.logError(
            `Claude judge task failed for ${task.displayName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      )
    )
  );

export const runClaudeScraper = (
  options?: ClaudeScraperOptions
): Effect.Effect<ClaudeScraperStats, DciError, DciApi | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const sql = yield* (SqlClient.SqlClient);
    const runner =
      options?.runner ??
      makeClaudeRunner({
        command: options?.claudeCommand,
        dryRun: options?.dryRun,
        logPrompts: options?.logPrompts,
        retry: options?.retry
      });
    const resume = options?.resume !== false;
    const taskType = options?.taskType ?? "claude-data";

    const availableSeasons = yield* (api.getSeasons());
    const sortedSeasons = availableSeasons.slice().sort(compareSeasonsDesc);

    const filteredSeasons =
      options?.targetSeasons && options.targetSeasons.length > 0
        ? sortedSeasons.filter((season) => options.targetSeasons?.includes(season))
        : sortedSeasons;
    const limitedSeasons =
      options?.seasonsLimit && options.seasonsLimit > 0
        ? filteredSeasons.slice(0, options.seasonsLimit)
        : filteredSeasons;

    const counters = yield* (
      Effect.all({
        corps: Ref.make(0),
        shows: Ref.make(0),
        staff: Ref.make(0),
        participation: Ref.make(0),
        media: Ref.make(0),
        skipped: Ref.make(0)
      })
    );

    yield* (ensureScraperProgressTable(sql));

    for (const season of limitedSeasons) {
      const tasks = yield* (collectCorpsForSeason(api, season));
      const maxTasks =
        options?.maxTasks && options.maxTasks > 0 ? options.maxTasks : Infinity;

      yield* (
        Effect.forEach(
          tasks.slice(0, maxTasks),
          (task) => processDataTask(sql, runner, task, counters, { resume, taskType }),
          { concurrency: options?.concurrency ?? 1 }
        )
      );
    }

    const stats = yield* (
      Effect.all({
        seasons: Effect.succeed(limitedSeasons.length),
        corps: Ref.get(counters.corps),
        shows: Ref.get(counters.shows),
        staff: Ref.get(counters.staff),
        participation: Ref.get(counters.participation),
        media: Ref.get(counters.media),
        skipped: Ref.get(counters.skipped)
      })
    );

    return stats;
  }).pipe(Effect.mapError((cause) => toDciError(cause, "scraperClaude.run")));

export interface ClaudeMediaScraperStats {
  readonly seasons: number;
  readonly corps: number;
  readonly media: number;
  readonly skipped: number;
}

export const runClaudeMediaScraper = (
  options?: ClaudeScraperOptions
): Effect.Effect<ClaudeMediaScraperStats, DciError, DciApi | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const sql = yield* (SqlClient.SqlClient);
    const claudeCommand = options?.claudeCommand ?? defaultClaudeCommand();

    const availableSeasons = yield* (api.getSeasons());
    const sortedSeasons = availableSeasons.slice().sort(compareSeasonsDesc);
    const filteredSeasons =
      options?.targetSeasons && options.targetSeasons.length > 0
        ? sortedSeasons.filter((season) => options.targetSeasons?.includes(season))
        : sortedSeasons;
    const limitedSeasons =
      options?.seasonsLimit && options.seasonsLimit > 0
        ? filteredSeasons.slice(0, options.seasonsLimit)
        : filteredSeasons;

    const counters = yield* (
      Effect.all({
        corps: Ref.make(0),
        media: Ref.make(0),
        skipped: Ref.make(0)
      })
    );

    for (const season of limitedSeasons) {
      const tasks = yield* (collectCorpsForSeason(api, season));
      const maxTasks =
        options?.maxTasks && options.maxTasks > 0 ? options.maxTasks : Infinity;

      yield* (
        Effect.forEach(
          tasks.slice(0, maxTasks),
          (task) =>
            Effect.gen(function* () {
              const prompt = buildMediaPrompt(task);
              const output = yield* (runClaudeCommand(claudeCommand, prompt));
              let assets: ReadonlyArray<ExtraDomain.MediaAsset>;
              try {
                const parsed = JSON.parse(output);
                const mediaArray = Array.isArray(parsed?.media) ? parsed.media : [];
                assets = yield* (SchemaParser.decodeUnknownEffect(Schema.Array(ExtraDomain.MediaAssetSchema))(mediaArray));
              } catch (error) {
                console.warn("Failed to parse claude response", error);
                return;
              }

              for (const asset of assets) {
                if (!asset.url) continue;
                yield* (upsertMediaAsset(sql, asset));
                yield* (Ref.update(counters.media, (value) => value + 1));
              }
              yield* (Ref.update(counters.corps, (value) => value + 1));
            }),
          { concurrency: options?.concurrency ?? 1 }
        )
      );
    }

    const stats = yield* (
      Effect.all({
        seasons: Effect.succeed(limitedSeasons.length),
        corps: Ref.get(counters.corps),
        media: Ref.get(counters.media),
        skipped: Ref.get(counters.skipped)
      })
    );

    return stats;
  }).pipe(Effect.mapError((cause) => toDciError(cause, "scraperClaude.media")));


export interface ClaudeJudgeScraperStats {
  readonly seasons: number;
  readonly judges: number;
  readonly media: number;
  readonly skipped: number;
}

export const runClaudeJudgeScraper = (
  options?: ClaudeScraperOptions
): Effect.Effect<ClaudeJudgeScraperStats, DciError, DciApi | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    const sql = yield* (SqlClient.SqlClient);
    const runner =
      options?.runner ??
      makeClaudeRunner({
        command: options?.claudeCommand,
        dryRun: options?.dryRun,
        logPrompts: options?.logPrompts,
        retry: options?.retry
      });
    const resume = options?.resume !== false;
    const taskType = options?.taskType ?? "claude-judges";

    const availableSeasons = yield* (api.getSeasons());
    const sortedSeasons = availableSeasons.slice().sort(compareSeasonsDesc);
    const filteredSeasons =
      options?.targetSeasons && options.targetSeasons.length > 0
        ? sortedSeasons.filter((season) => options.targetSeasons?.includes(season))
        : sortedSeasons;
    const limitedSeasons =
      options?.seasonsLimit && options.seasonsLimit > 0
        ? filteredSeasons.slice(0, options.seasonsLimit)
        : filteredSeasons;

    const aggregations = new Map<string, JudgeAggregation>();
    for (const season of limitedSeasons) {
      const seasonJudges = yield* (collectJudgesForSeason(api, season));
      mergeJudgeMaps(aggregations, seasonJudges);
    }

    const tasks = finalizeJudgeTasks(aggregations);
    const targetIds = options?.targetJudgeIds;
    const rankedTasks =
      targetIds && targetIds.length > 0
        ? targetIds
            .map((id) => tasks.find((task) => task.judgeId === id))
            .filter((task): task is JudgeTask => task !== undefined)
        : tasks;
    const maxTasks =
      options?.maxTasks && options.maxTasks > 0 ? options.maxTasks : rankedTasks.length;
    const selectedTasks = rankedTasks.slice(0, maxTasks);

    const counters = yield* (
      Effect.all({
        judges: Ref.make(0),
        media: Ref.make(0),
        skipped: Ref.make(0)
      })
    );

    yield* (ensureScraperProgressTable(sql));

    yield* (
      Effect.forEach(
        selectedTasks,
        (task) => processJudgeTask(sql, runner, task, counters, { resume, taskType }),
        { concurrency: options?.concurrency ?? 1 }
      )
    );

    const stats = yield* (
      Effect.all({
        seasons: Effect.succeed(limitedSeasons.length),
        judges: Ref.get(counters.judges),
        media: Ref.get(counters.media),
        skipped: Ref.get(counters.skipped)
      })
    );

    return stats;
  }).pipe(Effect.mapError((cause) => toDciError(cause, "scraperClaude.judges")));

export const compareStaffMembersWithClaude = (
  memberA: ExtraDomain.CorpsStaffMember,
  memberB: ExtraDomain.CorpsStaffMember,
  options?: { claudeCommand?: string }
): Effect.Effect<StaffComparisonResult, DciError> =>
  Effect.gen(function* () {
    const command = options?.claudeCommand ?? defaultClaudeCommand();
    const prompt = buildStaffComparisonPrompt(memberA, memberB);
    const output = yield* (runClaudeCommand(command, prompt));
    try {
      const parsed = JSON.parse(output);
      return yield* (
        SchemaParser.decodeUnknownEffect(StaffComparisonResultSchema)(parsed).pipe(
          Effect.mapError((cause) => toDciError(cause, "scraperClaude.staffComparison"))
        )
      );
    } catch (error) {
      return yield* Effect.fail(
        new DciDecodeError({
          message: `Unable to decode staff comparison result: ${error instanceof Error ? error.message : String(error)}`,
          path: "scraper.staffComparison",
          issues: error
        })
      );
    }
  });

export const compareJudgesWithClaude = (
  judgeA: ExtraDomain.JudgeBioProfile,
  judgeB: ExtraDomain.JudgeBioProfile,
  options?: { claudeCommand?: string }
): Effect.Effect<StaffComparisonResult, DciError> =>
  Effect.gen(function* () {
    const command = options?.claudeCommand ?? defaultClaudeCommand();
    const prompt = buildJudgeComparisonPrompt(judgeA, judgeB);
    const output = yield* (runClaudeCommand(command, prompt));
    try {
      const parsed = JSON.parse(output);
      return yield* (
        SchemaParser.decodeUnknownEffect(StaffComparisonResultSchema)(parsed).pipe(
          Effect.mapError((cause) => toDciError(cause, "scraperClaude.judgeComparison"))
        )
      );
    } catch (error) {
      return yield* Effect.fail(
        new DciDecodeError({
          message: `Unable to decode judge comparison result: ${error instanceof Error ? error.message : String(error)}`,
          path: "scraper.judgeComparison",
          issues: error
        })
      );
    }
  });
const processMediaTask = (
  sql: SqlClient.SqlClient,
  runner: ClaudeRunner,
  task: CorpsSeasonTask,
  counters: {
    corps: Ref.Ref<number>;
    media: Ref.Ref<number>;
    skipped: Ref.Ref<number>;
  },
  options: { resume: boolean; taskType: string }
) =>
  Effect.gen(function* () {
    const skip = yield* (shouldSkipScraperTask(sql, options.taskType, task.season, task.corpsKey, options.resume));
    if (skip) {
      yield* (Effect.logDebug(`Skipping media for ${task.corpsName} ${task.season} (already completed)`));
      return;
    }

    yield* (markScraperTaskStatus(sql, options.taskType, task.season, task.corpsKey, "in-progress"));

    const prompt = buildMediaPrompt(task);
    const output = yield* (runner.run(prompt, { label: `${task.corpsKey}-${task.season}-media` }));
    const parsed = yield* (parseClaudeJson(output, `${task.corpsName} ${task.season} media`));
    const mediaArray = Array.isArray(parsed?.media) ? parsed.media : [];
    const normalized = yield* (
      SchemaParser.decodeUnknownEffect(Schema.Array(ExtraDomain.MediaAssetSchema))(
        mediaArray.map((asset: Partial<ExtraDomain.MediaAsset>, index: number) =>
          normalizeMediaAsset(task, asset, index)
        )
      )
    );

    for (const asset of normalized) {
      if (!asset.url) continue;
      yield* (upsertMediaAsset(sql, asset));
      yield* (Ref.update(counters.media, (value) => value + 1));
    }

    const summary = { media: normalized.length };
    yield* (
      markScraperTaskStatus(
        sql,
        options.taskType,
        task.season,
        task.corpsKey,
        "completed",
        JSON.stringify(summary)
      )
    );
    yield* (Ref.update(counters.corps, (value) => value + 1));
    yield* (Effect.logInfo(`Cataloged media for ${task.corpsName} ${task.season}`));
  }).pipe(
    Effect.catch((error) =>
      markScraperTaskStatus(
        sql,
        options.taskType,
        task.season,
        task.corpsKey,
        "failed",
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      ).pipe(
        Effect.andThen(Ref.update(counters.skipped, (value) => value + 1)),
        Effect.andThen(
          Effect.logError(
            `Claude media task failed for ${task.corpsName} ${task.season}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      )
    )
  );
