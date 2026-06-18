import { optionalWith, Union } from "./schemaCompat.js";
import { Schema } from "effect";

const numericString = Schema.NumberFromString;
const numericValue = Union(Schema.Number, Schema.NumberFromString);

const optionalArray = <A, I>(item: Schema.Codec<A, I>) =>
  Schema.Array(item).pipe(
    optionalWith({
      default: () => []
    })
  );

const optionalNullableString = Schema.String.pipe(
  optionalWith({ nullable: true })
);

const optionalNullableNumber = numericValue.pipe(
  optionalWith({ nullable: true })
);

const optionalNullableBoolean = Schema.Boolean.pipe(
  optionalWith({ nullable: true })
);

const optionalNullableNumericValue = numericValue.pipe(
  optionalWith({ nullable: true })
);

const stringOrStringArray = Union(
  Schema.Array(Schema.String),
  Schema.String
);

export const DivisionNameSchema = Union(
  Schema.Literals([
    "World Class",
    "Open Class",
    "All Age Class",
    "SoundSport",
    "International Class"
  ]),
  Schema.String
);

export const PerformanceClassSchema = Union(
  Schema.Literals(["World Class", "Open Class", "All Age", "International", "SoundSport"]),
  Schema.String
);

export const GroupTypeNameSchema = Union(
  Schema.Literals(["Marching", "SoundSport"]),
  Schema.String
);

export const CompetitionTypeNameSchema = Union(
  Schema.Literals(["8 Judge", "General"]),
  Schema.String
);

export const CompetitionTypeSchema = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  name: CompetitionTypeNameSchema
});

export const GroupTypeSchema = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  name: GroupTypeNameSchema,
  competitionType: CompetitionTypeSchema
});

export const CompetitionSchema = Schema.Struct({
  slug: Schema.String,
  eventName: Schema.String,
  competitionGUID: Schema.String.pipe(optionalWith({ default: () => "" })),
  competitionLevel: Schema.Number,
  location: Schema.String,
  date: Schema.Date,
  chiefJudge: optionalNullableString,
  scoresReleased: Schema.Boolean,
  recapReleased: Schema.Boolean,
  categoryRecapReleased: Schema.Boolean,
  seasonGUID: Schema.String.pipe(optionalWith({ default: () => "" })),
  seasonName: Schema.String,
  groupTypes: optionalArray(GroupTypeSchema)
});

export const SubCaptionBreakdownSchema = Schema.Struct({
  Name: Schema.String,
  Score: numericValue,
  Rank: Schema.Number,
  Initials: Schema.String.pipe(
    optionalWith({ nullable: true })
  )
});

export const JudgeCaptionSchema = Schema.Struct({
  Name: Schema.String,
  Judge: numericValue,
  JudgeFirstName: optionalNullableString,
  JudgeLastName: optionalNullableString,
  Initials: Schema.String.pipe(optionalWith({ nullable: true })),
  Score: numericValue,
  Rank: Schema.Number,
  Subcaptions: optionalArray(SubCaptionBreakdownSchema)
});

export const CategoryScoreSchema = Schema.Struct({
  Name: Schema.String,
  Initials: Schema.String.pipe(optionalWith({ nullable: true })),
  Score: numericValue,
  Rank: Schema.Number,
  Captions: optionalArray(JudgeCaptionSchema)
});

export const CorpsScoreSchema = Schema.Struct({
  groupName: Schema.String,
  divisionName: DivisionNameSchema,
  orgGroupIdentifier: Schema.String,
  active: Schema.Boolean,
  isOtherType: Schema.Boolean,
  totalScore: numericValue,
  subtotalScore: optionalNullableNumber,
  subtotalRank: Schema.Number.pipe(
    optionalWith({ nullable: true })
  ),
  round: Schema.String.pipe(
    optionalWith({ default: () => "" })
  ),
  rank: Schema.Number,
  categories: Schema.Array(CategoryScoreSchema),
  competition: CompetitionSchema
});

export const WebsiteScoreResultSchema = Schema.Struct({
  value: Schema.Number,
  rank: Schema.Number.pipe(optionalWith({ nullable: true }))
});

export const WebsiteJudgeCaptionSchema = Schema.Struct({
  judgeName: Schema.String,
  captionName: Schema.String,
  subCaptions: Schema.Record(Schema.String, WebsiteScoreResultSchema),
  total: WebsiteScoreResultSchema
});

export const WebsiteCategoryResultSchema = Schema.Struct({
  judges: Schema.Array(WebsiteJudgeCaptionSchema),
  total: WebsiteScoreResultSchema
});

export const WebsiteCorpsRecapSchema = Schema.Struct({
  corpsName: Schema.String,
  generalEffect: WebsiteCategoryResultSchema,
  visual: WebsiteCategoryResultSchema,
  music: WebsiteCategoryResultSchema,
  subTotal: Schema.Number,
  penalties: Schema.Number,
  finalScore: Schema.Number,
  finalRank: Schema.Number
});

export const WebsiteRecapMetadataSchema = Schema.Struct({
  date: Schema.String,
  location: Schema.String,
  title: Schema.String,
  chiefJudge: Schema.String
});

export const WebsiteClassTableSchema = Schema.Struct({
  className: Schema.String,
  corps: Schema.Array(WebsiteCorpsRecapSchema)
});

export const WebsiteRecapSchema = Schema.Struct({
  kind: Schema.Literal("recap"),
  meta: WebsiteRecapMetadataSchema,
  classes: Schema.Array(WebsiteClassTableSchema)
});

export const WebsiteScoreListEntrySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  date: Schema.String,
  location: Schema.String,
  url: Schema.String
});

export const WebsiteScoreListSchema = Schema.Struct({
  kind: Schema.Literal("list"),
  season: Schema.String.pipe(optionalWith({ nullable: true })),
  entries: Schema.Array(WebsiteScoreListEntrySchema)
});

export const CorpsContactSchema = Schema.Struct({
  firstName: optionalNullableString,
  lastName: optionalNullableString,
  phone: optionalNullableString,
  email: optionalNullableString
});

export const CorpsAddressSchema = Schema.Struct({
  city: optionalNullableString,
  state: optionalNullableString,
  postalCode: optionalNullableString,
  street: optionalNullableString,
  country: optionalNullableString,
  latitude: optionalNullableNumber,
  longitude: optionalNullableNumber,
  geocodeAccuracy: optionalNullableString
});

export const CorpsSchema = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  name: Schema.String,
  slug: Schema.String,
  about: optionalNullableString,
  description: optionalNullableString,
  type: Schema.String,
  status: Schema.String,
  entityType: optionalNullableString,
  website: optionalNullableString,
  corpsLogo: optionalNullableString,
  corpsPhoto: optionalNullableString,
  corpsMMDLLinkAudio: optionalNullableString,
  corpsMMDLLinkVideo: optionalNullableString,
  displayCity: optionalNullableString,
  latitude: optionalNullableNumber,
  longitude: optionalNullableNumber,
  address: optionalNullableString,
  city: optionalNullableString,
  state: optionalNullableString,
  zip: optionalNullableString,
  country: optionalNullableString,
  billingAddress: CorpsAddressSchema.pipe(optionalWith({ nullable: true })),
  shippingCity: optionalNullableString,
  shippingState: optionalNullableString,
  companyCountry: optionalNullableString,
  phone: optionalNullableString,
  contactName: optionalNullableString,
  contactTitle: optionalNullableString,
  contactEmail: optionalNullableString,
  contactPhone: optionalNullableString,
  mainPhone: optionalNullableString,
  mainEmail: optionalNullableString,
  primaryEmail: optionalNullableString,
  primaryContactTitle: optionalNullableString,
  contact: CorpsContactSchema.pipe(optionalWith({ nullable: true })),
  facebook: optionalNullableString,
  twitter: optionalNullableString,
  instagram: optionalNullableString,
  youtube: optionalNullableString,
  linkedIn: optionalNullableString,
  metaDescription: optionalNullableString,
  metaTitle: optionalNullableString,
  groupTicketsStatus: optionalNullableString,
  auditions: Schema.Unknown.pipe(
    optionalWith({ default: () => undefined })
  )
});

export const SeasonSchema = Schema.String;

export const EventScheduleSchema = Schema.Struct({
  unitName: Schema.String,
  displayCity: optionalNullableString,
  time: optionalNullableString,
  performanceOrder: Schema.Number.pipe(optionalWith({ nullable: true }))
});

export const CoordinatesSchema = Schema.Struct({
  latitude: Schema.Number,
  longitude: Schema.Number
});

export const EventVenueSchema = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  zioPostcode: optionalNullableString,
  venueCoordinates: CoordinatesSchema.pipe(optionalWith({ nullable: true })),
  venueCapacityAlternate: optionalNullableString,
  venueTotalCapacity: optionalNullableString,
  fieldHashmarksType: optionalNullableString,
  goalPosts: optionalNullableBoolean,
  fieldElectricity: optionalNullableBoolean,
  americanFlagLocation: optionalNullableString,
  tunnelHeight: optionalNullableString,
  videoboard: optionalNullableBoolean,
  accessToStadiumBoxOffice: optionalNullableBoolean,
  airConditioning: optionalNullableBoolean,
  sellingWindowsAvailable: optionalNullableString,
  furnitureNeeds: optionalNullableString,
  mainBoxOfficeLocation: optionalNullableString,
  fieldElectricityLocations: optionalNullableString,
  fieldHashmarks: optionalNullableBoolean,
  gPGeolocation: CoordinatesSchema.pipe(optionalWith({ nullable: true })),
  gPGeocodeQuality: optionalNullableString,
  gPGeocodeRetrievalTime: optionalNullableString,
  clearBagVenue: optionalNullableBoolean,
  merchandiseBuyoutVenue: optionalNullableBoolean,
  marketplaceLocation: optionalNullableString,
  bagPolicy: optionalNullableString,
  spectatorEntrance: optionalNullableString,
  spectatorReEntry: optionalNullableString,
  boxOfficeWillCallLocation: optionalNullableString,
  concessions: optionalNullableString,
  eMTAmbulanceLocation: optionalNullableString,
  tableChairsOnField: optionalNullableBoolean,
  micsOnField: optionalNullableBoolean,
  soundOrdinance: optionalNullableString,
  ticketTakers: optionalNullableString,
  boxOfficeVolunteers: optionalNullableBoolean,
  ushers: optionalNullableString,
  security: optionalNullableString,
  seatNumbering: optionalNullableBoolean,
  seatSize: optionalNullableString,
  marketplaceType: optionalNullableString,
  marketplaceElectricity: optionalNullableString,
  bagPolicyDescription: optionalNullableString,
  cashlessStadium: optionalNullableBoolean,
  reEntryCredentialType: optionalNullableString,
  stadiumWeatherShelterPolicy: optionalNullableString,
  venueOperatedLightningDetection: optionalNullableBoolean,
  lightningDetectionSystemNameType: optionalNullableString,
  programmedLightningRadius: optionalNullableString
});

export const EventVenueSummarySchema = Schema.Struct({
  name: optionalNullableString,
  address: optionalNullableString,
  zioPostcode: optionalNullableString,
  longitude: optionalNullableNumber,
  latitude: optionalNullableNumber,
  googleMapsStaticMap: optionalNullableString
});

export const EventParticipantSchema = Schema.Struct({
  participantId: Schema.String,
  eventSlug: Schema.String,
  corpsKey: Schema.String,
  participantSlug: optionalNullableString,
  participantName: optionalNullableString
});

export const EventLineupEntrySchema = Schema.Struct({
  entryId: Schema.String,
  eventSlug: Schema.String,
  participantId: optionalNullableString,
  unitName: Schema.String,
  displayCity: optionalNullableString,
  time: optionalNullableString
});

export const EventGroupTypeSchema = Schema.Struct({
  eventSlug: Schema.String,
  groupTypeId: Schema.String
});

export const EventSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  eventName: optionalNullableString,
  description: optionalNullableString,
  season: optionalNullableString,
  year: optionalNullableString,
  startTime: optionalNullableString,
  eDTStartTimeForAPI: Schema.String,
  fED: optionalNullableString,
  locationCity: optionalNullableString,
  locationState: optionalNullableString,
  venueCity: optionalNullableString,
  venueState: optionalNullableString,
  timeZone: optionalNullableString,
  regionForWeb: optionalNullableString,
  buyTickets: optionalNullableString,
  buyTicketsText: optionalNullableString,
  presentingSponsor: optionalNullableString,
  smallLogo: optionalNullableString,
  liveStreamLink: optionalNullableString,
  ticketsOnSale: optionalNullableString,
  eventImageThumb: optionalNullableString,
  ticketWatermark: optionalNullableString,
  startDate: Schema.DateFromString,
  endDate: Schema.DateFromString.pipe(optionalWith({ nullable: true })),
  schedules: optionalArray(EventScheduleSchema),
  participants: optionalArray(Schema.String),
  webStartTime: optionalNullableString,
  notesGeneral: optionalNullableString,
  notesLineupTimes: optionalNullableString,
  notesIndividualTickets: optionalNullableString,
  notesGroupTickets: optionalNullableString,
  venue: Union(EventVenueSchema, EventVenueSummarySchema).pipe(
    optionalWith({ nullable: true })
  ),
  venues: EventVenueSummarySchema.pipe(optionalWith({ nullable: true })),
  minTicketPrice: optionalNullableNumericValue,
  maxTicketPrice: optionalNullableNumericValue,
  groupTicketThreshold: optionalNullableNumber,
  groupPrice1: optionalNullableNumericValue,
  groupPrice4: optionalNullableNumericValue,
  groupPrice5: optionalNullableNumericValue,
  groupPrice6: optionalNullableNumericValue,
  minGroupTicketPrice: optionalNullableNumericValue,
  maxGroupTicket: optionalNullableNumericValue,
  individualTicketsDisclaimer: optionalNullableString,
  groupTicketsDisclaimer: optionalNullableString,
  buyGroupTickets: optionalNullableString,
  eventImage: optionalNullableString,
  ticketingMapImage: optionalNullableString,
  streetMapImage: optionalNullableString,
  metaDescription: optionalNullableString,
  metaTitle: optionalNullableString,
  categoryForWebCalendar: optionalNullableString,
  tOCEvent: optionalNullableBoolean,
  entityType: optionalNullableString,
  contractDae: optionalNullableString,
  tEPContractDate: optionalNullableString,
  contractPriceText: optionalNullableString,
  x1stPayText: optionalNullableString,
  x2ndPtText: optionalNullableString,
  balanceDueText: optionalNullableString,
  soundCheckTime: optionalNullableString,
  staffOffice: optionalNullableString,
  mealRoom: optionalNullableString,
  judgesLocation: optionalNullableString,
  suitesInUse: optionalNullableString,
  pressBox: optionalNullableString,
  marketingLocation: optionalNullableString,
  floMarchingLocation: optionalNullableString,
  tabulationLocation: optionalNullableString,
  eventCompTypePL: optionalNullableString,
  eventSpecial: optionalNullableBoolean,
  sponsorLoadTime: optionalNullableString,
  mealInformation: optionalNullableString,
  waterStationLocation: optionalNullableString,
  sponsorReception: optionalNullableString,
  evacuationLocation: optionalNullableString,
  corpsParking: optionalNullableString,
  standstillCancellation: optionalNullableString,
  corpsFieldEntry: optionalNullableString,
  frontEnsembleFieldEntry: optionalNullableString,
  corpsFieldExit: optionalNullableString,
  frontEnsembleFieldExit: optionalNullableString,
  corpsWarmUpLocation: optionalNullableString,
  announcerLocation: optionalNullableString,
  propFieldEntry: optionalNullableString,
  propFieldExit: optionalNullableString,
  propStagingArea: optionalNullableString,
  tourEventPartnerContractStatus: optionalNullableString,
  ticketServiceAgreementStatus: optionalNullableString,
  staffParking: optionalNullableString,
  depositText: optionalNullableString,
  groupBusParking: optionalNullableString,
  yearbookSales: optionalNullableBoolean,
  mainGateSouvenirSales: optionalNullableBoolean,
  contestCoordinatorCell: optionalNullableString,
  tEPPrimaryContactEmail: optionalNullableString,
  travelContactEmail: optionalNullableString,
  marketplaceLocation: optionalNullableString,
  marketplaceElectricity: optionalNullableBoolean,
  spectatorEntrance: optionalNullableString,
  spectatorReEntry: optionalNullableString,
  boxOfficeWillCallLocation: optionalNullableString,
  concessions: optionalNullableString,
  eMTAmbulanceLocation: optionalNullableString,
  tableChairsOnField: optionalNullableBoolean,
  micsOnField: optionalNullableBoolean,
  security: optionalNullableString,
  boxOfficeVolunteers: optionalNullableBoolean,
  ticketTakers: optionalNullableString,
  ushers: optionalNullableString,
  keyLocationsVerification: optionalNullableString,
  corpsInfoVerification: optionalNullableString,
  parkingVerification: optionalNullableString,
  keyTimesVerification: optionalNullableString,
  eventSafetyInformation: optionalNullableString,
  seasonValues: optionalNullableString,
  bSA: optionalNullableString,
  bCA: optionalNullableString,
  bSTA: optionalNullableString,
  bPA: optionalNullableString,
  tEPName: optionalNullableString,
  printMarketplaceFootprintCommunity: optionalNullableString,
  printParkingLotFootprintCommunity: optionalNullableString,
  printPropsAndElectricalFootprintCom: optionalNullableString,
  printShowSheetCommunity: optionalNullableString
});

const GalleryCopyrightSchema = Schema.Struct({
  name: optionalNullableString,
  url: optionalNullableString,
  description: optionalNullableString,
  abbrev: optionalNullableString,
  active: optionalNullableBoolean,
  isDefault: optionalNullableBoolean,
  mediaCategory: optionalNullableNumber
});

export const GalleryImageSchema = Schema.Struct({
  url: Schema.String,
  caption: optionalNullableString,
  copyright: GalleryCopyrightSchema
});

export const GallerySchema = Schema.Struct({
  publishedDate: optionalNullableString,
  slug: Schema.String,
  createdAt: optionalNullableString,
  title: Schema.String,
  gallery: Schema.Array(GalleryImageSchema),
  presentedBy: optionalNullableString,
  description: optionalNullableString,
  corpIds: stringOrStringArray.pipe(
    optionalWith({
      default: () => []
    })
  ),
  tags: stringOrStringArray.pipe(
    optionalWith({
      default: () => []
    })
  ),
  type: Schema.Number
});

export const PageContentEntrySchema = Schema.Struct({
  url: Schema.String,
  backgroundImage: Schema.String
});

export const SponsorSchema = Schema.Struct({
  name: Schema.String,
  link: Schema.String,
  active: Schema.Boolean,
  logo: Schema.String,
  order: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  id: Schema.String
});

export const PastChampionSchema = Schema.Struct({
  champion: Schema.String,
  year: Schema.String,
  city: Schema.String,
  score: numericValue,
  class: Schema.String,
  type: Schema.Number
});

export const EventCorpsDictionarySchema = Schema.Record(Schema.String, Schema.String);

export const PerformanceCorpsListSchema = Schema.Array(Schema.String);

export type RawGallery = typeof GallerySchema.Type;

const normalizeIdList = (value: ReadonlyArray<string> | string | undefined | null) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((entry) => entry.trim().length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
};

export interface Gallery extends Omit<RawGallery, "corpIds" | "tags"> {
  readonly corpIds: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
}

export const normalizeGallery = (gallery: RawGallery): Gallery => ({
  ...gallery,
  corpIds: normalizeIdList(gallery.corpIds),
  tags: normalizeIdList(gallery.tags)
});

export const normalizeGalleries = (galleries: ReadonlyArray<RawGallery>): ReadonlyArray<Gallery> =>
  galleries.map(normalizeGallery);

export type DivisionName = typeof DivisionNameSchema.Type;
export type PerformanceClass = typeof PerformanceClassSchema.Type;
export type GroupTypeName = typeof GroupTypeNameSchema.Type;
export type CompetitionTypeName = typeof CompetitionTypeNameSchema.Type;
export type CompetitionType = typeof CompetitionTypeSchema.Type;
export type GroupType = typeof GroupTypeSchema.Type;
export type Competition = typeof CompetitionSchema.Type;
export type SubCaptionBreakdown = typeof SubCaptionBreakdownSchema.Type;
export type JudgeCaption = typeof JudgeCaptionSchema.Type;
export type CategoryScore = typeof CategoryScoreSchema.Type;
export type CorpsScore = typeof CorpsScoreSchema.Type;
export type WebsiteScoreResult = typeof WebsiteScoreResultSchema.Type;
export type WebsiteJudgeCaption = typeof WebsiteJudgeCaptionSchema.Type;
export type WebsiteCategoryResult = typeof WebsiteCategoryResultSchema.Type;
export type WebsiteCorpsRecap = typeof WebsiteCorpsRecapSchema.Type;
export type WebsiteRecapMetadata = typeof WebsiteRecapMetadataSchema.Type;
export type WebsiteClassTable = typeof WebsiteClassTableSchema.Type;
export type WebsiteRecap = typeof WebsiteRecapSchema.Type;
export type WebsiteScoreListEntry = typeof WebsiteScoreListEntrySchema.Type;
export type WebsiteScoreList = typeof WebsiteScoreListSchema.Type;
export type Corps = typeof CorpsSchema.Type;
export type CorpsContact = typeof CorpsContactSchema.Type;
export type CorpsAddress = typeof CorpsAddressSchema.Type;
export type Season = typeof SeasonSchema.Type;
export type Event = typeof EventSchema.Type;

export type EventSchedule = typeof EventScheduleSchema.Type;
export type EventVenue = typeof EventVenueSchema.Type;
export type EventVenueSummary = typeof EventVenueSummarySchema.Type;
export type EventParticipant = typeof EventParticipantSchema.Type;
export type EventLineupEntry = typeof EventLineupEntrySchema.Type;
export type EventGroupType = typeof EventGroupTypeSchema.Type;
export type Coordinates = typeof CoordinatesSchema.Type;
export type GalleryImage = typeof GalleryImageSchema.Type;
export type PageContentEntry = typeof PageContentEntrySchema.Type;
export type Sponsor = typeof SponsorSchema.Type;
export type PastChampion = typeof PastChampionSchema.Type;
export type EventCorpsDictionary = typeof EventCorpsDictionarySchema.Type;
export type PerformanceCorpsList = typeof PerformanceCorpsListSchema.Type;
