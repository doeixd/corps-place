import { SchemaParser } from "effect";
import { Chunk, Effect, Layer, Option, Schema, Stream } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

import {
  defaultConfig,
  mergeConfig,
  type DciSdkConfig,
  type DciSdkConfigOverrides,
} from './config.js';
import * as Domain from './domain.js';
import { DciDecodeError, DciNetworkError, DciHttpError, type DciError } from './errors.js';
import { DciApi } from './service.js';
import type {
  CompetitionsQuery,
  EventsQuery,
  GalleriesQuery,
  PaginatedListOptions,
  PerformanceCorpsQuery,
  PerformancesQuery,
  WarmCacheInstruction,
} from './service.js';

/* ------------------------------------------------------------------ */
/*  DB row → Domain mappers                                             */
/* ------------------------------------------------------------------ */

// The DB-backed methods run SqlClient queries (SqlError) and Schema decodes
// (SchemaError). The DciApi contract exposes domain errors only, so we map any
// infrastructure failure into a DciError at the service boundary (idiomatic
// Effect: a service surfaces its domain errors, not the driver's). Existing
// DciErrors pass through unchanged.
const toDciError = (error: unknown): DciError => {
  if (
    error instanceof DciNetworkError ||
    error instanceof DciHttpError ||
    error instanceof DciDecodeError
  ) {
    return error;
  }
  return new DciNetworkError({
    message: error instanceof Error ? error.message : String(error),
    statusCode: 0,
    cause: error,
  });
};

// Wrap an Effect-returning method so its error channel becomes DciError.
const domainE =
  <Args extends ReadonlyArray<unknown>, A, E, R>(f: (...args: Args) => Effect.Effect<A, E, R>) =>
  (...args: Args): Effect.Effect<A, DciError, R> =>
    f(...args).pipe(Effect.mapError(toDciError));

// Wrap a Stream-returning method so its error channel becomes DciError.
const domainS =
  <Args extends ReadonlyArray<unknown>, A, E, R>(f: (...args: Args) => Stream.Stream<A, E, R>) =>
  (...args: Args): Stream.Stream<A, DciError, R> =>
    f(...args).pipe(Stream.mapError(toDciError));

const intToBool = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;

const safeDate = (v: string | null | undefined): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
};

const safeNumber = (v: number | string | null | undefined): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
};

interface CompetitionRow {
  slug: string;
  season: string;
  event_name: string;
  location: string | null;
  date: string;
  competition_level: number | null;
  competition_guid: string | null;
  season_guid: string | null;
  scores_released: number;
  recap_released: number;
  category_recap_released: number;
  chief_judge: string | null;
}

interface GroupTypeRow {
  id: string;
  name: string;
  competition_type_id: string | null;
  competition_type_name: string | null;
}

const mapCompetition = (
  row: CompetitionRow,
  groupTypes: readonly Domain.GroupType[]
): Domain.Competition => ({
  slug: row.slug,
  eventName: row.event_name,
  competitionGUID: row.competition_guid ?? '',
  competitionLevel: row.competition_level ?? 0,
  location: row.location ?? '',
  date: safeDate(row.date) ?? new Date(row.date),
  chiefJudge: row.chief_judge,
  scoresReleased: intToBool(row.scores_released),
  recapReleased: intToBool(row.recap_released),
  categoryRecapReleased: intToBool(row.category_recap_released),
  seasonGUID: row.season_guid ?? '',
  seasonName: row.season,
  groupTypes,
});

interface CorpsRow {
  corps_key: string;
  corps_id: string | null;
  org_group_identifier: string | null;
  name: string;
  slug: string | null;
  division_name: string | null;
  about: string | null;
  type: string | null;
  status: string | null;
  active: number;
  is_other_type: number;
  website: string | null;
  corps_logo: string | null;
  corps_photo: string | null;
  display_city: string | null;
  latitude: number | null;
  longitude: number | null;
  facebook: string | null;
  twitter: string | null;
  instagram: string | null;
  youtube: string | null;
  auditions_json: string | null;
  description: string | null;
  entity_type: string | null;
  corps_mmdl_link_audio: string | null;
  corps_mmdl_link_video: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  main_phone: string | null;
  main_email: string | null;
  primary_email: string | null;
  primary_contact_title: string | null;
  phone: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  company_country: string | null;
  linked_in: string | null;
  meta_description: string | null;
  meta_title: string | null;
  group_tickets_status: string | null;
}

const mapCorps = (row: CorpsRow): Domain.Corps => ({
  id: row.corps_id ?? row.corps_key,
  name: row.name,
  slug: row.slug ?? row.corps_key,
  about: row.about,
  description: row.description,
  type: row.type ?? '',
  status: row.status ?? '',
  entityType: row.entity_type,
  website: row.website,
  corpsLogo: row.corps_logo,
  corpsPhoto: row.corps_photo,
  corpsMMDLLinkAudio: row.corps_mmdl_link_audio,
  corpsMMDLLinkVideo: row.corps_mmdl_link_video,
  displayCity: row.display_city,
  latitude: row.latitude ?? undefined,
  longitude: row.longitude ?? undefined,
  address: row.address,
  city: row.city,
  state: row.state,
  zip: row.zip,
  country: row.country,
  facebook: row.facebook,
  twitter: row.twitter,
  instagram: row.instagram,
  youtube: row.youtube,
  linkedIn: row.linked_in,
  metaDescription: row.meta_description,
  metaTitle: row.meta_title,
  groupTicketsStatus: row.group_tickets_status,
  contact: {
    firstName: row.contact_name,
    lastName: undefined,
    phone: row.contact_phone ?? row.phone ?? row.main_phone,
    email: row.contact_email ?? row.primary_email ?? row.main_email,
  },
  auditions: undefined,
});

interface EventRow {
  event_id: string;
  name: string;
  slug: string;
  event_name: string | null;
  description: string | null;
  season: string | null;
  year: string | null;
  start_time: string | null;
  edt_start_time: string | null;
  fed: string | null;
  location_city: string | null;
  location_state: string | null;
  venue_city: string | null;
  venue_state: string | null;
  timezone: string | null;
  region_for_web: string | null;
  buy_tickets: string | null;
  buy_tickets_text: string | null;
  presenting_sponsor: string | null;
  small_logo: string | null;
  live_stream_link: string | null;
  tickets_on_sale: string | null;
  event_image_thumb: string | null;
  ticket_watermark: string | null;
  start_date: string;
  end_date: string | null;
  web_start_time: string | null;
  notes_general: string | null;
  notes_lineup_times: string | null;
  notes_individual_tickets: string | null;
  notes_group_tickets: string | null;
  min_ticket_price: number | null;
  max_ticket_price: number | null;
  individual_tickets_disclaimer: string | null;
  group_tickets_disclaimer: string | null;
  group_ticket_threshold: number | null;
  group_price_1: number | null;
  group_price_4: number | null;
  group_price_5: number | null;
  group_price_6: number | null;
  min_group_ticket_price: number | null;
  max_group_ticket: number | null;
  buy_group_tickets: string | null;
  event_image: string | null;
  ticketing_map_image: string | null;
  street_map_image: string | null;
  meta_description: string | null;
  meta_title: string | null;
  category_for_web_calendar: string | null;
  toc_event: number | null;
  entity_type: string | null;
}

const mapEvent = (row: EventRow): Domain.Event => ({
  id: row.event_id,
  name: row.name,
  slug: row.slug,
  eventName: row.event_name,
  description: row.description,
  season: row.season,
  year: row.year,
  startTime: row.start_time,
  eDTStartTimeForAPI: row.edt_start_time ?? '',
  fED: row.fed,
  locationCity: row.location_city,
  locationState: row.location_state,
  venueCity: row.venue_city,
  venueState: row.venue_state,
  timeZone: row.timezone,
  regionForWeb: row.region_for_web,
  buyTickets: row.buy_tickets,
  buyTicketsText: row.buy_tickets_text,
  presentingSponsor: row.presenting_sponsor,
  smallLogo: row.small_logo,
  liveStreamLink: row.live_stream_link,
  ticketsOnSale: row.tickets_on_sale,
  eventImageThumb: row.event_image_thumb,
  ticketWatermark: row.ticket_watermark,
  startDate: safeDate(row.start_date) ?? new Date(row.start_date),
  endDate: safeDate(row.end_date),
  webStartTime: row.web_start_time,
  notesGeneral: row.notes_general,
  notesLineupTimes: row.notes_lineup_times,
  notesIndividualTickets: row.notes_individual_tickets,
  notesGroupTickets: row.notes_group_tickets,
  minTicketPrice: row.min_ticket_price ?? undefined,
  maxTicketPrice: row.max_ticket_price ?? undefined,
  individualTicketsDisclaimer: row.individual_tickets_disclaimer,
  groupTicketsDisclaimer: row.group_tickets_disclaimer,
  groupTicketThreshold: row.group_ticket_threshold ?? undefined,
  groupPrice1: row.group_price_1 ?? undefined,
  groupPrice4: row.group_price_4 ?? undefined,
  groupPrice5: row.group_price_5 ?? undefined,
  groupPrice6: row.group_price_6 ?? undefined,
  minGroupTicketPrice: row.min_group_ticket_price ?? undefined,
  maxGroupTicket: row.max_group_ticket ?? undefined,
  buyGroupTickets: row.buy_group_tickets,
  eventImage: row.event_image,
  ticketingMapImage: row.ticketing_map_image,
  streetMapImage: row.street_map_image,
  metaDescription: row.meta_description,
  metaTitle: row.meta_title,
  categoryForWebCalendar: row.category_for_web_calendar,
  tOCEvent: row.toc_event === 1,
  entityType: row.entity_type,
  schedules: [],
  participants: [],
  venue: undefined,
  venues: undefined,
  soundCheckTime: undefined,
  staffOffice: undefined,
  mealRoom: undefined,
  judgesLocation: undefined,
  suitesInUse: undefined,
  pressBox: undefined,
  marketingLocation: undefined,
  floMarchingLocation: undefined,
  tabulationLocation: undefined,
  eventCompTypePL: undefined,
  eventSpecial: undefined,
  contractDae: undefined,
  tEPContractDate: undefined,
  contractPriceText: undefined,
  x1stPayText: undefined,
  x2ndPtText: undefined,
  balanceDueText: undefined,
  sponsorLoadTime: undefined,
  mealInformation: undefined,
  waterStationLocation: undefined,
  sponsorReception: undefined,
  evacuationLocation: undefined,
  corpsParking: undefined,
  standstillCancellation: undefined,
  corpsFieldEntry: undefined,
  frontEnsembleFieldEntry: undefined,
  corpsFieldExit: undefined,
  frontEnsembleFieldExit: undefined,
  corpsWarmUpLocation: undefined,
  announcerLocation: undefined,
  propFieldEntry: undefined,
  propFieldExit: undefined,
  propStagingArea: undefined,
  tourEventPartnerContractStatus: undefined,
  ticketServiceAgreementStatus: undefined,
  staffParking: undefined,
  depositText: undefined,
  groupBusParking: undefined,
  yearbookSales: undefined,
  mainGateSouvenirSales: undefined,
  contestCoordinatorCell: undefined,
  tEPPrimaryContactEmail: undefined,
  travelContactEmail: undefined,
  marketplaceLocation: undefined,
  marketplaceElectricity: undefined,
  spectatorEntrance: undefined,
  spectatorReEntry: undefined,
  boxOfficeWillCallLocation: undefined,
  concessions: undefined,
  eMTAmbulanceLocation: undefined,
  tableChairsOnField: undefined,
  micsOnField: undefined,
  security: undefined,
  boxOfficeVolunteers: undefined,
  ticketTakers: undefined,
  ushers: undefined,
  keyLocationsVerification: undefined,
  corpsInfoVerification: undefined,
  parkingVerification: undefined,
  keyTimesVerification: undefined,
  eventSafetyInformation: undefined,
  seasonValues: undefined,
  bSA: undefined,
  bCA: undefined,
  bSTA: undefined,
  bPA: undefined,
  tEPName: undefined,
  printMarketplaceFootprintCommunity: undefined,
  printParkingLotFootprintCommunity: undefined,
  printPropsAndElectricalFootprintCom: undefined,
  printShowSheetCommunity: undefined,
});

/* ------------------------------------------------------------------ */
/*  CorpsScore reconstruction from relational tables                    */
/* ------------------------------------------------------------------ */

interface CorpsScoreRow {
  corps_key: string;
  corps_name: string | null;
  total_score: number | null;
  rank: number | null;
  subtotal_score: number | null;
  subtotal_rank: number | null;
  round: string | null;
  division_name: string | null;
}

interface CaptionScoreRow {
  corps_key: string;
  caption_name: string;
  score: number | null;
  rank: number | null;
}

interface JudgeScoreRow {
  corps_key: string;
  caption_name: string;
  judge_id: string;
  score: number | null;
  rank: number | null;
  judge_name: string | null;
  judge_first_name: string | null;
  judge_last_name: string | null;
}

interface SubcaptionScoreRow {
  corps_key: string;
  caption_name: string;
  judge_id: string;
  subcaption_name: string;
  score: number | null;
  rank: number | null;
}

const buildCategoryScores = (
  corpsKey: string,
  captionRows: readonly CaptionScoreRow[],
  judgeRows: readonly JudgeScoreRow[],
  subcaptionRows: readonly SubcaptionScoreRow[]
): Domain.CategoryScore[] => {
  const captionsForCorps = captionRows.filter((r) => r.corps_key === corpsKey);
  return captionsForCorps.map((cap) => {
    const judgesForCaption = judgeRows.filter(
      (j) => j.corps_key === corpsKey && j.caption_name === cap.caption_name
    );
    const judgeCaptions: Domain.JudgeCaption[] = judgesForCaption.map((j) => {
      const subsForJudge = subcaptionRows.filter(
        (s) =>
          s.corps_key === corpsKey &&
          s.caption_name === cap.caption_name &&
          s.judge_id === j.judge_id
      );
      return {
        Name: j.caption_name,
        Judge: j.score ?? 0,
        JudgeFirstName: j.judge_first_name,
        JudgeLastName: j.judge_last_name,
        Initials: null,
        Score: j.score ?? 0,
        Rank: j.rank ?? 0,
        Subcaptions: subsForJudge.map((s) => ({
          Name: s.subcaption_name,
          Score: s.score ?? 0,
          Rank: s.rank ?? 0,
          Initials: null,
        })),
      };
    });
    return {
      Name: cap.caption_name,
      Initials: null,
      Score: cap.score ?? 0,
      Rank: cap.rank ?? 0,
      Captions: judgeCaptions,
    };
  });
};

/* ------------------------------------------------------------------ */
/*  DB-backed API implementation                                        */
/* ------------------------------------------------------------------ */

export const makeDbBackedDciApi = (overrides?: DciSdkConfigOverrides) =>
  Effect.gen(function* () {
    const config = mergeConfig(overrides);
    const sql = yield* (SqlClient.SqlClient);

    const getSeasons = () =>
      sql<{ season: string }>`
        SELECT DISTINCT season FROM competitions WHERE season IS NOT NULL ORDER BY season DESC
      `.pipe(Effect.map((rows) => rows.map((r) => r.season)));

    const getCompetitions = (season: string) =>
      Effect.gen(function* () {
        const compRows = yield* (sql<CompetitionRow>`
          SELECT
            slug, season, event_name, location, date,
            competition_level, competition_guid, season_guid,
            scores_released, recap_released, category_recap_released,
            chief_judge
          FROM competitions
          WHERE season = ${season}
          ORDER BY date ASC, slug ASC
        `);

        if (compRows.length === 0) return [] as readonly Domain.Competition[];

        const slugs = compRows.map((r) => r.slug);
        const gtRows = yield* (sql<GroupTypeRow>`
          SELECT
            gt.group_type_id as id, gt.name,
            ct.type_id as competition_type_id, ct.name as competition_type_name
          FROM competition_group_types cgt
          JOIN group_types gt ON gt.group_type_id = cgt.group_type_id
          LEFT JOIN competition_types ct ON ct.type_id = gt.competition_type_id
        `);

        const groupTypesByComp = new Map<string, Domain.GroupType[]>();
        for (const row of gtRows) {
          const list = groupTypesByComp.get(row.id) ?? [];
          list.push({
            id: row.id,
            name: row.name as Domain.GroupTypeName,
            competitionType: {
              id: row.competition_type_id ?? 'general',
              name: (row.competition_type_name ?? 'General') as Domain.CompetitionTypeName,
            },
          });
          groupTypesByComp.set(row.id, list);
        }

        return compRows.map((row) => mapCompetition(row, groupTypesByComp.get(row.slug) ?? []));
      });

    const listCompetitions = (query?: CompetitionsQuery) =>
      query?.season
        ? getCompetitions(String(query.season))
        : Effect.succeed([] as readonly Domain.Competition[]);

    const streamCompetitions = (query?: CompetitionsQuery) =>
      Stream.unwrap(listCompetitions(query).pipe(Effect.map(Stream.fromArray)));

    const getCompetitionRecap = (slug: string) =>
      Effect.gen(function* () {
        // Try raw API cache first — most faithful to original format
        const cached = yield* (
          sql<{ response_json: string }>`
          SELECT response_json FROM api_responses
          WHERE endpoint_type = 'recap'
            AND endpoint_url LIKE ${`%${slug}%`}
          ORDER BY fetched_at DESC
          LIMIT 1
        `.pipe(Effect.map((rows) => rows[0]?.response_json))
        );

        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed)) {
              const decoded = yield* (
                SchemaParser.decodeUnknownEffect(Schema.Array(Domain.CorpsScoreSchema))(parsed)
              );
              return decoded;
            }
          } catch {
            // fall through to relational reconstruction
          }
        }

        // Reconstruct from relational tables
        const compRows = yield* (sql<CompetitionRow>`
          SELECT * FROM competitions WHERE slug = ${slug} LIMIT 1
        `);
        if (compRows.length === 0) return [] as readonly Domain.CorpsScore[];

        const competition = mapCompetition(compRows[0], []);

        const scoreRows = yield* (sql<CorpsScoreRow>`
          SELECT corps_key, corps_name, total_score, rank, subtotal_score, subtotal_rank, round, division_name
          FROM corps_scores WHERE competition_slug = ${slug}
        `);
        if (scoreRows.length === 0) return [] as readonly Domain.CorpsScore[];

        const captionRows = yield* (sql<CaptionScoreRow>`
          SELECT corps_key, caption_name, score, rank
          FROM caption_scores WHERE competition_slug = ${slug}
        `);
        const judgeRows = yield* (sql<JudgeScoreRow>`
          SELECT
            js.corps_key, js.caption_name, js.judge_id, js.score, js.rank,
            j.display_name as judge_name, j.first_name as judge_first_name, j.last_name as judge_last_name
          FROM judge_scores js
          LEFT JOIN judges j ON j.judge_id = js.judge_id
          WHERE js.competition_slug = ${slug}
        `);
        const subcaptionRows = yield* (sql<SubcaptionScoreRow>`
          SELECT corps_key, caption_name, judge_id, subcaption_name, score, rank
          FROM subcaption_scores
          WHERE competition_slug = ${slug}
        `);

        return scoreRows.map((sr) => {
          const categories = buildCategoryScores(
            sr.corps_key,
            captionRows,
            judgeRows,
            subcaptionRows
          );
          return {
            groupName: sr.corps_key,
            divisionName: (sr.division_name ?? 'World Class') as Domain.DivisionName,
            orgGroupIdentifier: sr.corps_key,
            active: true,
            isOtherType: false,
            totalScore: sr.total_score ?? 0,
            subtotalScore: sr.subtotal_score,
            subtotalRank: sr.subtotal_rank,
            round: sr.round ?? '',
            rank: sr.rank ?? 0,
            penalties: 0,
            categories,
            competition,
          };
        });
      });

    const getCorps = () =>
      sql<CorpsRow>`
        SELECT * FROM corps ORDER BY name ASC
      `.pipe(Effect.map((rows) => rows.map(mapCorps)));

    const getPerformanceClasses = () =>
      sql<{ name: string }>`
        SELECT name FROM performance_classes ORDER BY name ASC
      `.pipe(Effect.map((rows) => rows.map((r) => r.name as Domain.PerformanceClass)));

    const getPerformanceCorps = (_query?: PerformanceCorpsQuery) =>
      Effect.succeed([] as readonly string[]);

    const getEventCorps = () =>
      sql<{ corps_key: string; name: string }>`
        SELECT DISTINCT corps_key, name FROM corps ORDER BY name ASC
      `.pipe(
        Effect.map((rows) => {
          const dict: Record<string, string> = {};
          for (const r of rows) {
            dict[r.corps_key] = r.name;
          }
          return dict;
        })
      );

    const getEventRegions = () =>
      sql<{ region_for_web: string }>`
        SELECT DISTINCT region_for_web FROM events WHERE region_for_web IS NOT NULL ORDER BY region_for_web ASC
      `.pipe(Effect.map((rows) => rows.map((r) => r.region_for_web)));

    const getEventStates = () =>
      sql<{ location_state: string }>`
        SELECT DISTINCT location_state FROM events WHERE location_state IS NOT NULL ORDER BY location_state ASC
      `.pipe(Effect.map((rows) => rows.map((r) => r.location_state)));

    const listEvents = (query?: EventsQuery) =>
      query?.season
        ? sql<EventRow>`
            SELECT * FROM events
            WHERE season = ${String(query.season)} OR year = ${String(query.season)}
            ORDER BY start_date ASC, name ASC
          `.pipe(Effect.map((rows) => rows.map(mapEvent)))
        : sql<EventRow>`
            SELECT * FROM events ORDER BY start_date ASC, name ASC
          `.pipe(Effect.map((rows) => rows.map(mapEvent)));

    const streamEvents = (query?: EventsQuery) =>
      Stream.unwrap(listEvents(query).pipe(Effect.map(Stream.fromArray)));

    const getCompetitionLocations = () =>
      sql<{ location: string }>`
        SELECT DISTINCT location FROM competitions WHERE location IS NOT NULL ORDER BY location ASC
      `.pipe(Effect.map((rows) => rows.map((r) => r.location)));

    const listGalleries = (_query?: GalleriesQuery) =>
      Effect.succeed([] as readonly Domain.Gallery[]);

    const streamGalleries = (_query?: GalleriesQuery) =>
      Stream.empty as Stream.Stream<Domain.Gallery, never, never>;

    const listPerformances = (_query: PerformancesQuery) =>
      Effect.succeed([] as readonly Domain.CorpsScore[]);

    const streamPerformances = (_query: PerformancesQuery) =>
      Stream.empty as Stream.Stream<Domain.CorpsScore, never, never>;

    const getPageContent = () =>
      sql<{ url: string; background_image: string | null }>`
        SELECT url, background_image FROM page_content ORDER BY url ASC
      `.pipe(
        Effect.map((rows) =>
          rows.map(
            (r): Domain.PageContentEntry => ({
              url: r.url ?? '',
              backgroundImage: r.background_image ?? '',
            })
          )
        )
      );

    const getSponsors = () =>
      sql<{
        link: string;
        name: string;
        sponsor_id: string;
        active: number;
        display_order: number;
        created_at: number;
        logo: string;
        updated_at: number;
      }>`
        SELECT link, name, sponsor_id, active, display_order, created_at, logo, updated_at FROM sponsors ORDER BY display_order ASC
      `.pipe(
        Effect.map((rows) =>
          rows.map(
            (r): Domain.Sponsor => ({
              link: r.link,
              name: r.name,
              id: r.sponsor_id,
              active: r.active === 1,
              order: r.display_order,
              createdAt: r.created_at,
              logo: r.logo,
              updatedAt: r.updated_at,
            })
          )
        )
      );

    const getPastChampions = () =>
      sql<{
        champion_type: number;
        year: string;
        class: string;
        city: string;
        champion_name: string;
        score: number | null;
      }>`
        SELECT champion_type, year, class, city, champion_name, score FROM past_champions ORDER BY year DESC, class ASC
      `.pipe(
        Effect.map((rows) =>
          rows.map(
            (r): Domain.PastChampion => ({
              type: r.champion_type,
              year: r.year,
              class: r.class,
              city: r.city,
              champion: r.champion_name,
              score: r.score ?? 0,
            })
          )
        )
      );

    const rawPaginated = <A, I>(_path: string, _schema: Schema.Codec<A, I>) =>
      Effect.fail(
        new DciNetworkError({
          message: 'rawPaginated is not supported by the DB-backed API client',
          statusCode: 0,
        })
      ) as Effect.Effect<readonly A[], DciError>;

    const warmCache = (_instructions: WarmCacheInstruction[]) => Effect.void;

    return DciApi.of({
      config,
      getSeasons: domainE(getSeasons),
      getCompetitions: domainE(getCompetitions),
      listCompetitions: domainE(listCompetitions),
      streamCompetitions: domainS(streamCompetitions),
      getCompetitionRecap: domainE(getCompetitionRecap),
      getCorps: domainE(getCorps),
      getPerformanceClasses: domainE(getPerformanceClasses),
      getPerformanceCorps: domainE(getPerformanceCorps),
      getEventCorps: domainE(getEventCorps),
      getEventRegions: domainE(getEventRegions),
      getEventStates: domainE(getEventStates),
      listEvents: domainE(listEvents),
      streamEvents: domainS(streamEvents),
      getCompetitionLocations: domainE(getCompetitionLocations),
      listGalleries: domainE(listGalleries),
      streamGalleries: domainS(streamGalleries),
      listPerformances: domainE(listPerformances),
      streamPerformances: domainS(streamPerformances),
      getPageContent: domainE(getPageContent),
      getSponsors: domainE(getSponsors),
      getPastChampions: domainE(getPastChampions),
      rawPaginated,
      warmCache,
    });
  });

export const makeDbBackedDciApiLayer = (overrides?: DciSdkConfigOverrides) =>
  Layer.effect(DciApi, makeDbBackedDciApi(overrides));

export const DciApiDbBackedLive = makeDbBackedDciApiLayer();
