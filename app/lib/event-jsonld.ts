import { SITE_URL } from '@/lib/seo';

/**
 * Shared builder for Event / SportsEvent structured data, so every event surface
 * (the prediction page, the /scores/$slug recap) emits a consistent, rich schema.
 *
 * Includes the full recommended property set when the data exists: name,
 * description, startDate, endDate, eventStatus, location (with a venue name),
 * image, performer (the corps), organizer, and offers (the ticket link). Anything
 * without real data is omitted rather than fabricated — notably endDate, which DCI
 * doesn't publish (raw end_date is empty), and price, which isn't provided.
 */

type EventLike = {
  event_name?: string | null;
  name?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  venue_name?: string | null;
  venue_address?: string | null;
  event_image?: string | null;
  buy_tickets?: string | null;
};

const DCI_ORGANIZER = {
  '@type': 'Organization',
  name: 'Drum Corps International',
  url: 'https://www.dci.org',
} as const;

export function buildEventJsonLd(
  event: EventLike,
  opts: {
    /** Page display name incl. year, e.g. "DCI West 2026". */
    name: string;
    description: string;
    /** Canonical URL of the page. */
    url: string;
    /** Competing/performing corps names (→ performer + SportsEvent competitor). */
    corps?: readonly string[];
    /** Absolute image URL; falls back to the event's own image. */
    image?: string | null;
    /** SportsEvent once results exist, else Event. */
    scored?: boolean;
  }
): Record<string, unknown> {
  const loc = [event.location_city, event.location_state].filter(Boolean).join(', ');
  const image = opts.image ?? event.event_image ?? undefined;
  const performers = (opts.corps ?? []).filter(Boolean);

  const location =
    event.venue_name || event.venue_address || loc
      ? {
          '@type': 'Place',
          // `name` in location (venue) is explicitly requested.
          ...(event.venue_name ? { name: event.venue_name } : loc ? { name: loc } : {}),
          address: [event.venue_address, loc].filter(Boolean).join(', ') || undefined,
        }
      : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': opts.scored ? 'SportsEvent' : 'Event',
    name: opts.name,
    description: opts.description,
    ...(opts.scored ? { sport: 'Drum and Bugle Corps' } : {}),
    ...(event.start_date ? { startDate: event.start_date } : {}),
    ...(event.end_date ? { endDate: event.end_date } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    ...(location ? { location } : {}),
    ...(image ? { image: [image] } : {}),
    ...(performers.length
      ? {
          performer: performers.map((name) => ({ '@type': 'PerformingGroup', name })),
          ...(opts.scored
            ? { competitor: performers.map((name) => ({ '@type': 'SportsTeam', name })) }
            : {}),
        }
      : {}),
    organizer: DCI_ORGANIZER,
    ...(event.buy_tickets
      ? {
          offers: {
            '@type': 'Offer',
            url: event.buy_tickets,
            availability: 'https://schema.org/InStock',
            priceCurrency: 'USD',
            category: 'primary',
          },
        }
      : {}),
    url: opts.url || `${SITE_URL}`,
  };
}
