import { optionalWith, Union } from "./schemaCompat.js";
import { Schema } from "effect";

const optionalString = Schema.String.pipe(optionalWith({ nullable: true }));
const optionalNumber = Schema.Number.pipe(optionalWith({ nullable: true }));
const optionalStringOrNumber = Union(Schema.Number, Schema.String).pipe(
  optionalWith({ nullable: true })
);
const optionalStringArray = Schema.Array(Schema.String).pipe(
  optionalWith({ default: () => [] })
);

export const LinkSchema = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
  kind: optionalString
});

export const CorpsStaffAffiliationSchema = Schema.Struct({
  affiliationId: Schema.String.pipe(optionalWith({ nullable: true })),
  relatedCorpsKey: Schema.String,
  relatedCorpsName: optionalString,
  relationType: optionalString,
  notes: optionalString,
  sinceSeason: optionalString,
  throughSeason: optionalString
});

export const CorpsStaffAssignmentSchema = Schema.Struct({
  assignmentId: Schema.String.pipe(optionalWith({ nullable: true })),
  corpsKey: Schema.String,
  corpsName: optionalString,
  season: optionalString,
  title: optionalString,
  roleType: optionalString,
  startYear: optionalNumber,
  endYear: optionalNumber,
  startDate: optionalString,
  endDate: optionalString,
  notes: optionalString,
  links: Schema.Array(LinkSchema).pipe(optionalWith({ default: () => [] }))
});

export const CorpsStaffMemberSchema = Schema.Struct({
  staffId: Schema.String,
  givenName: optionalString,
  familyName: optionalString,
  displayName: optionalString,
  defaultTitle: optionalString,
  biography: optionalString,
  photoUrl: optionalString,
  externalLinks: Schema.Array(LinkSchema).pipe(optionalWith({ default: () => [] })),
  affiliations: Schema.Array(CorpsStaffAffiliationSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  assignments: Schema.Array(CorpsStaffAssignmentSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const ShowMediaTypeSchema = Union(
  Schema.Literals(["video", "audio", "image", "article", "document", "press"]),
  Schema.String
);

export const ShowMediaAssetSchema = Schema.Struct({
  mediaId: Schema.String,
  showId: Schema.String,
  mediaType: ShowMediaTypeSchema,
  title: optionalString,
  description: optionalString,
  url: Schema.String,
  thumbnailUrl: optionalString,
  attribution: optionalString,
  source: optionalString,
  sourceAuthority: optionalNumber,
  publishedAt: optionalString,
  durationSeconds: optionalNumber,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const MediaAssetSchema = Schema.Struct({
  mediaId: Schema.String,
  ownerType: Union(
    Schema.Literals(["corps", "staff", "show", "competition", "event", "generic", "judge"]),
    Schema.String
  ),
  ownerId: Schema.String,
  url: Schema.String,
  title: optionalString,
  description: optionalString,
  mediaType: Union(ShowMediaTypeSchema, Schema.String),
  format: optionalString,
  attribution: optionalString,
  width: optionalNumber,
  height: optionalNumber,
  durationSeconds: optionalNumber,
  thumbnailUrl: optionalString,
  sourceUrl: optionalString,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const ShowRepertoireEntrySchema = Schema.Struct({
  entryId: Schema.String,
  showId: Schema.String,
  workTitle: Schema.String,
  composer: optionalString,
  arranger: optionalString,
  description: optionalString,
  hyperlink: optionalString,
  relatedCorpsKey: optionalString,
  notes: optionalString,
  source: optionalString,
  sourceAuthority: optionalNumber,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const ShowReviewSchema = Schema.Struct({
  reviewId: Schema.String,
  showId: Schema.String,
  authorName: optionalString,
  authorProfileUrl: optionalString,
  publication: optionalString,
  publishedAt: optionalString,
  rating: optionalNumber,
  summary: optionalString,
  content: optionalString,
  sourceUrl: optionalString,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const ShowDesignerSchema = Schema.Struct({
  designerId: Schema.String,
  showId: Schema.String,
  corpsKey: Schema.String,
  role: Schema.String,
  name: Schema.String,
  sourceUrl: optionalString,
  source: optionalString,
  sourceAuthority: optionalNumber,
  scrapedAt: optionalNumber,
});

export const ShowMovementSchema = Schema.Struct({
  movementId: Schema.String,
  showId: Schema.String,
  corpsKey: Schema.String,
  ordinal: Schema.Number,
  title: optionalString,
  description: optionalString,
  sourceUrl: optionalString,
  source: optionalString,
  sourceAuthority: optionalNumber,
  scrapedAt: optionalNumber,
});

export const ShowAnnouncementScrapeSchema = Schema.Struct({
  corpsKey: Schema.String,
  sourceUrl: Schema.String,
  sourceType: Schema.String,
  scrapedAt: Schema.Number,
  rawHtml: optionalString,
  parsedJson: optionalString,
  httpStatus: optionalNumber,
});

export const CorpsShowSchema = Schema.Struct({
  showId: Schema.String,
  corpsKey: Schema.String,
  corpsName: optionalString,
  season: Schema.String,
  title: Schema.String,
  subtitle: optionalString,
  description: optionalString,
  premiereDate: optionalString,
  venue: optionalString,
  tagline: optionalString,
  designerNotes: optionalString,
  sourceUrl: optionalString,
  source: optionalString,
  sourceAuthority: optionalNumber,
  tags: optionalStringArray,
  repertoire: Schema.Array(ShowRepertoireEntrySchema).pipe(
    optionalWith({ default: () => [] })
  ),
  media: Schema.Array(ShowMediaAssetSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  designers: Schema.Array(ShowDesignerSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  movements: Schema.Array(ShowMovementSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  reviews: Schema.Array(ShowReviewSchema).pipe(optionalWith({ default: () => [] })),
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const CorpsSeasonParticipationSchema = Schema.Struct({
  participationId: Schema.String.pipe(optionalWith({ nullable: true })),
  season: Schema.String,
  corpsKey: Schema.String,
  corpsName: optionalString,
  division: optionalString,
  status: optionalString,
  participationType: optionalString,
  firstAppearance: optionalString,
  lastAppearance: optionalString,
  notes: optionalString,
  derivedFrom: optionalString,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const JudgeCorpsRelationSchema = Schema.Struct({
  relationId: Schema.String.pipe(optionalWith({ nullable: true })),
  judgeId: Schema.String.pipe(optionalWith({ nullable: true })),
  corpsKey: Schema.String.pipe(optionalWith({ nullable: true })),
  corpsName: optionalString,
  season: optionalString,
  role: optionalString,
  captionGroup: optionalString,
  notes: optionalString,
  sourceUrl: optionalString,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const JudgeSeasonHighlightSchema = Schema.Struct({
  highlightId: Schema.String.pipe(optionalWith({ nullable: true })),
  judgeId: Schema.String.pipe(optionalWith({ nullable: true })),
  season: optionalString,
  summary: optionalString,
  notableCorps: optionalStringArray,
  awards: optionalStringArray,
  sourceUrl: optionalString,
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const JudgeProfileSchema = Schema.Struct({
  judgeId: Schema.String,
  displayName: Schema.String,
  givenName: optionalString,
  familyName: optionalString,
  biography: optionalString,
  photoUrl: optionalString,
  alternateNames: Schema.Array(Schema.String).pipe(optionalWith({ default: () => [] })),
  externalLinks: Schema.Array(LinkSchema).pipe(optionalWith({ default: () => [] })),
  corpsRelations: Schema.Array(JudgeCorpsRelationSchema).pipe(optionalWith({ default: () => [] })),
  seasonHighlights: Schema.Array(JudgeSeasonHighlightSchema).pipe(
    optionalWith({ default: () => [] })
  ),
  media: Schema.Array(MediaAssetSchema).pipe(optionalWith({ default: () => [] })),
  metadata: Schema.Unknown.pipe(optionalWith({ default: () => undefined }))
});

export const AppearancesSchema = Schema.Struct({
  eventSlug: Schema.String,
  eventId: optionalString,
  eventName: Schema.String,
  eventStartDate: optionalString,
  eventStartTime: optionalString,
  eventEdtStartTime: optionalString,
  locationCity: optionalString,
  locationState: optionalString,
  venueCity: optionalString,
  venueState: optionalString,
  timezone: optionalString,
  competitionSlug: optionalString,
  competitionEventName: optionalString,
  competitionDate: optionalString,
  season: optionalString,
  competitionLevel: optionalNumber,
  scoresReleased: optionalNumber,
  recapReleased: optionalNumber,
  categoryRecapReleased: optionalNumber,
  recapId: optionalString,
  lineupId: Schema.String,
  performanceTime: optionalString,
  lineupUnitName: Schema.String,
  lineupDisplayCity: optionalString,
  participantId: optionalString,
  participantSlug: optionalString,
  participantName: optionalString,
  corpsKey: optionalString,
  corpsName: optionalString,
  corpsSlug: optionalString,
  groupName: Schema.String,
  divisionName: optionalString,
  round: optionalString,
  rank: optionalNumber,
  totalScore: optionalNumber,
  subtotalScore: optionalNumber,
  subtotalRank: optionalNumber,
  groupTypeId: optionalStringOrNumber,
  groupTypeName: optionalString,
  competitionTypeId: optionalStringOrNumber,
  competitionTypeName: optionalString,
  performanceOrderOverall: optionalNumber,
  performanceOrderInClass: optionalNumber,
  numberOfPerformersInClass: optionalNumber
});

export type Link = typeof LinkSchema.Type;
export type Appearances = typeof AppearancesSchema.Type;
export type CorpsStaffMember = typeof CorpsStaffMemberSchema.Type;
export type CorpsStaffAssignment = typeof CorpsStaffAssignmentSchema.Type;
export type CorpsStaffAffiliation = typeof CorpsStaffAffiliationSchema.Type;
export type CorpsShow = typeof CorpsShowSchema.Type;
export type ShowMediaAsset = typeof ShowMediaAssetSchema.Type;
export type MediaAsset = typeof MediaAssetSchema.Type;
export type ShowRepertoireEntry = typeof ShowRepertoireEntrySchema.Type;
export type ShowReview = typeof ShowReviewSchema.Type;
export type ShowDesigner = typeof ShowDesignerSchema.Type;
export type ShowMovement = typeof ShowMovementSchema.Type;
export type ShowAnnouncementScrape = typeof ShowAnnouncementScrapeSchema.Type;
export type CorpsSeasonParticipation = typeof CorpsSeasonParticipationSchema.Type;
export type JudgeBioProfile = typeof JudgeProfileSchema.Type;
export type JudgeCorpsRelation = typeof JudgeCorpsRelationSchema.Type;
export type JudgeSeasonHighlight = typeof JudgeSeasonHighlightSchema.Type;
