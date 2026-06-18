import { SchemaParser } from "effect";
import { optionalWith, Union } from "./schemaCompat.js";
import { Schema } from "effect";

const coerceNumber = Union(Schema.Number, Schema.NumberFromString);
const optionalArray = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.Array(schema).pipe(
    optionalWith({
      default: () => []
    })
  );

export namespace RecapSchemas {
  export const DivisionNameSchema = Schema.Literals(["World Class", "Open Class"]);
  export const GroupTypeNameSchema = Schema.Literals(["Marching", "SoundSport"]);
  export const CompetitionTypeNameSchema = Schema.Literals(["8 Judge", "General"]);
  export const CaptionInitialsSchema = Schema.Literals([
    "GE 1",
    "GE 2",
    "VP",
    "VA",
    "CG",
    "BRS",
    "MA",
    "Perc",
    "PEN"
  ]);
  export const CaptionNameSchema = Schema.Literals([
    "General Effect 1",
    "General Effect 2",
    "Visual Proficiency",
    "Visual - Analysis",
    "Color Guard",
    "Music - Brass",
    "Music - Analysis",
    "Music - Percussion",
    "Penalties"
  ]);
  export const CategoryInitialsSchema = Schema.Literals([
    "Rep",
    "Perf",
    "Cont",
    "Achv",
    "Comp",
    "CONT",
    "Pen"
  ]);
  export const CategoryNameSchema = Schema.Literals([
    "General Effect",
    "Visual",
    "Music",
    "Timing & Penalties",
    "Repertoire",
    "Performance",
    "Content",
    "Achievement",
    "Composition",
    "Penalties"
  ]);

  export const CompetitionTypeSchema = Schema.Struct({
    id: Schema.Number,
    name: CompetitionTypeNameSchema
  });

  export const GroupTypeSchema = Schema.Struct({
    id: Schema.Number,
    name: GroupTypeNameSchema,
    competitionType: CompetitionTypeSchema
  });

  export const CompetitionSchema = Schema.Struct({
    groupTypes: Schema.Array(GroupTypeSchema),
    eventName: Schema.String,
    location: Schema.String,
    date: Schema.Date,
    competitionGUID: Schema.String,
    competitionLevel: Schema.Number,
    chiefJudge: Schema.String,
    scoresReleased: Schema.Boolean,
    recapReleased: Schema.Boolean,
    categoryRecapReleased: Schema.Boolean,
    seasonGUID: Schema.String,
    seasonName: Schema.String,
    slug: Schema.String
  });

  export const SubcaptionOverallScoreSchema = Schema.Struct({
    Name: Schema.String,
    Score: Schema.String,
    Rank: Schema.Number,
    Initials: Schema.String.pipe(optionalWith({ nullable: true }))
  });

  export const CaptionSchema = Schema.Struct({
    subcaptions: Schema.Array(SubcaptionOverallScoreSchema),
    judgeFirstName: Schema.NullOr(Schema.String),
    judgeLastName: Schema.NullOr(Schema.String),
    judge: Schema.Number,
    name: CaptionNameSchema,
    initials: CaptionInitialsSchema,
    score: Schema.String,
    rank: Schema.Number
  });

  export const AppearanceSchema = Schema.Struct({
    categories: Schema.Array(SubcaptionOverallScoreSchema),
    divisionName: DivisionNameSchema,
    round: Schema.String,
    groupName: Schema.String,
    orgGroupIdentifier: Schema.String,
    totalScore: coerceNumber,
    rank: Schema.Number,
    subtotalScore: coerceNumber,
    subtotalRank: Schema.Number,
    competitionGUID: Schema.String,
    active: Schema.Boolean,
    isOtherType: Schema.Boolean,
    competition: CompetitionSchema
  });

  export const DciSeasonSchema = Schema.Record(Schema.String, Schema.Array(AppearanceSchema));

  export type CaptionInitials = typeof CaptionInitialsSchema.Type;
  export type CaptionName = typeof CaptionNameSchema.Type;
  export type CategoryInitials = typeof CategoryInitialsSchema.Type;
  export type CategoryName = typeof CategoryNameSchema.Type;
  export type DivisionName = typeof DivisionNameSchema.Type;
  export type GroupTypeName = typeof GroupTypeNameSchema.Type;
  export type CompetitionTypeName = typeof CompetitionTypeNameSchema.Type;
  export type CompetitionType = typeof CompetitionTypeSchema.Type;
  export type GroupType = typeof GroupTypeSchema.Type;
  export type Competition = typeof CompetitionSchema.Type;
  export type Caption = typeof CaptionSchema.Type;
  export type SubcaptionOverallScore = typeof SubcaptionOverallScoreSchema.Type;
  export type Appearance = typeof AppearanceSchema.Type;
  export type DciSeason = typeof DciSeasonSchema.Type;

  export const Convert = {
    toDciSeason: SchemaParser.decodeUnknownEffect(DciSeasonSchema),
    dciSeasonToJson: SchemaParser.encodeEffect(DciSeasonSchema),
    toCaption: SchemaParser.decodeUnknownEffect(CaptionSchema),
    captionToJson: SchemaParser.encodeEffect(CaptionSchema),
    toCategory: SchemaParser.decodeUnknownEffect(SubcaptionOverallScoreSchema),
    categoryToJson: SchemaParser.encodeEffect(SubcaptionOverallScoreSchema),
    toCompetition: SchemaParser.decodeUnknownEffect(CompetitionSchema),
    competitionToJson: SchemaParser.encodeEffect(CompetitionSchema),
    toGroupType: SchemaParser.decodeUnknownEffect(GroupTypeSchema),
    groupTypeToJson: SchemaParser.encodeEffect(GroupTypeSchema),
    toCompetitionType: SchemaParser.decodeUnknownEffect(CompetitionTypeSchema),
    competitionTypeToJson: SchemaParser.encodeEffect(CompetitionTypeSchema)
  };
}
