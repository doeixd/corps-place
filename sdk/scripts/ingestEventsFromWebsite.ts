// Bootstrap 2026 events from DCI website schedule page AJAX API.
// Usage: npx tsx scripts/ingestEventsFromWebsite.ts [--season=2026]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as cheerio from 'cheerio';
import { upsertApiResponse } from '../src/relational.js';

const baseUrl = 'https://www.dci.org/wp-admin/admin-ajax.php';
const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: 'https://www.dci.org',
  Referer: 'https://www.dci.org/events/',
};

const monthMap: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

const parseDate = (dateText: string, season: string): string | undefined => {
  const match = dateText
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]{3})$/);
  if (!match) return undefined;
  const day = match[1]!.padStart(2, '0');
  const month = monthMap[match[2]!];
  if (!month) return undefined;
  return `${season}-${month}-${day}`;
};

const parseLocation = (locationText: string): { city?: string; state?: string } => {
  const parts = locationText.split(',').map((s) => s.trim());
  if (parts.length >= 2) {
    return { city: parts[0], state: parts[parts.length - 1] };
  }
  return { city: locationText, state: undefined };
};

interface EventCard {
  slug: string;
  name: string;
  dateText: string;
  locationText: string;
  timeText: string;
  startDate: string;
  locationCity?: string;
  locationState?: string;
  webStartTime?: string;
  buyTicketsLink?: string;
  watchLiveLink?: string;
  eventImage?: string;
}

const parseTotalPages = (pagination: string): number => {
  const $ = cheerio.load(pagination);
  const totals = $('.info .total, #pagination .total')
    .map((_, element) => Number($(element).text().trim()))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  const links = $('a.pagination-link[data-page]')
    .map((_, element) => Number($(element).attr('data-page')))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, ...totals, ...links);
};

const parseCards = (html: string, season: string): EventCard[] => {
  const $ = cheerio.load(html);
  const cards: EventCard[] = [];

  $('.upcoming-events .upcoming-events-box').each((_, element) => {
    const box = $(element);
    const nameLink = box.find('h4 a, .h4 a, p.h4 a').first();
    const name = nameLink.text().trim();
    const href = nameLink.attr('href') ?? '';
    const slugMatch = href.match(/\/events\/([^/]+)\/?$/);
    const slug = slugMatch ? slugMatch[1] : '';

    const dateText = box.find('ul.upcoming-events-contact li:nth-child(1) span').text().trim();
    const locationText = box.find('ul.upcoming-events-contact li:nth-child(2) span').text().trim();
    const timeText = box.find('ul.upcoming-events-contact li:nth-child(3) span').text().trim();

    const startDate = parseDate(dateText, season);
    const location = parseLocation(locationText);

    const buyTicketsLink = box.find('.upcoming-events-buy-tickets a.btn').attr('href') ?? undefined;
    const watchLiveLink =
      box.find('.upcoming-events-buy-tickets a[aria-label*="live stream"]').attr('href') ??
      undefined;
    const eventImage = box.find('.upcoming-events-img > img').attr('src') ?? undefined;

    if (slug && name && startDate) {
      cards.push({
        slug,
        name,
        dateText,
        locationText,
        timeText,
        startDate,
        locationCity: location.city,
        locationState: location.state,
        webStartTime: timeText,
        buyTicketsLink,
        watchLiveLink,
        eventImage,
      });
    }
  });

  return cards;
};

const fetchEventsPage = async (
  page: number,
  season: string
): Promise<{ status: number; raw: string; cards: EventCard[]; totalPages: number }> => {
  const body = new URLSearchParams();
  body.append('action', 'load_events');
  body.append('page', String(page));
  body.append('filters[corps]', '');
  body.append('filters[location_state]', '');
  body.append('filters[start_date]', '');
  body.append('filters[end_date]', '');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  const text = await res.text();
  let json: { html?: string; pagination?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    console.error('Failed to parse JSON:', text.slice(0, 500));
    return { status: res.status, raw: text, cards: [], totalPages: 0 };
  }

  const html = json.html ?? '';
  const pagination = json.pagination ?? '';
  return {
    status: res.status,
    raw: text,
    cards: parseCards(html, season),
    totalPages: parseTotalPages(pagination || html),
  };
};

const cacheEventsPage = (
  sql: SqlClient.SqlClient,
  season: string,
  pageNumber: number,
  result: { status: number; raw: string; cards: EventCard[]; totalPages: number }
) =>
  result.status >= 200 && result.status < 300 && result.cards.length > 0
    ? upsertApiResponse(
        sql,
        `${baseUrl}?action=load_events&page=${pageNumber}`,
        'load_events_raw',
        result.raw,
        { season, recordCount: result.cards.length }
      ).pipe(
        Effect.andThen(
          upsertApiResponse(
            sql,
            `${baseUrl}?action=load_events&page=${pageNumber}#parsed`,
            'load_events_parsed',
            JSON.stringify({
              parsed_at: new Date().toISOString(),
              current_page: pageNumber,
              total_pages: result.totalPages,
              source: 'ajax',
              cards: result.cards,
            }),
            { season, recordCount: result.cards.length }
          )
        )
      )
    : Effect.void;

const upsertEvent = (sql: SqlClient.SqlClient, event: EventCard, season: string) =>
  sql`
    INSERT INTO events (
      event_id, name, event_name, slug, season, year, start_date,
      location_city, location_state, web_start_time, buy_tickets,
      live_stream_link, event_image, event_image_thumb
    ) VALUES (
      ${`web-${season}-${event.slug}`},
      ${event.name},
      ${event.name},
      ${event.slug},
      ${season},
      ${season},
      ${event.startDate},
      ${event.locationCity ?? null},
      ${event.locationState ?? null},
      ${event.webStartTime ?? null},
      ${event.buyTicketsLink ?? null},
      ${event.watchLiveLink ?? null},
      ${event.eventImage ?? null},
      ${event.eventImage ?? null}
    )
    ON CONFLICT(event_id) DO UPDATE SET
      name=excluded.name,
      event_name=excluded.event_name,
      slug=excluded.slug,
      season=excluded.season,
      year=excluded.year,
      start_date=excluded.start_date,
      location_city=excluded.location_city,
      location_state=excluded.location_state,
      web_start_time=excluded.web_start_time,
      buy_tickets=excluded.buy_tickets,
      live_stream_link=excluded.live_stream_link,
      event_image=excluded.event_image,
      event_image_thumb=excluded.event_image_thumb
  `.pipe(Effect.asVoid);

const parseSeason = (): string => {
  const idx = process.argv.indexOf('--season');
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]!;
  }
  const flag = process.argv.find((a) => a.startsWith('--season='));
  if (flag) return flag.slice('--season='.length);
  return String(new Date().getFullYear());
};

const program = Effect.gen(function* () {
  const season = parseSeason();
  const sql = yield* (SqlClient.SqlClient);

  console.log(`Ingesting events for season ${season} from website schedule...`);

  const firstPage = yield* (Effect.tryPromise(() => fetchEventsPage(1, season)));
  yield* (cacheEventsPage(sql, season, 1, firstPage));
  let allCards = [...firstPage.cards];
  let totalPages = firstPage.totalPages;

  console.log(`Page 1: ${firstPage.cards.length} events (total pages: ${totalPages})`);

  for (let page = 2; page <= totalPages; page++) {
    const result = yield* (Effect.tryPromise(() => fetchEventsPage(page, season)));
    yield* (cacheEventsPage(sql, season, page, result));
    console.log(`Page ${page}: ${result.cards.length} events`);
    allCards.push(...result.cards);
    // Sleep briefly to be polite
    yield* (Effect.tryPromise(() => new Promise((r) => setTimeout(r, 500))));
  }

  const uniqueCards = Array.from(new Map(allCards.map((card) => [card.slug, card])).values());
  console.log(`Total events found: ${allCards.length} (${uniqueCards.length} unique slugs)`);

  let inserted = 0;
  for (const card of uniqueCards) {
    yield* (upsertEvent(sql, card, season));
    inserted++;
  }

  console.log(`Upserted ${inserted} events into the database.`);
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(program.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Ingest failed:', error);
  process.exitCode = 1;
});
