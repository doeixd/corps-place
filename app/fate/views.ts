import { dataView, list, type Entity } from '@nkzw/fate/server';
import type { EventDirectoryRow } from '../lib/event-directory';

/**
 * Fate "data views" — the server-side allowlist of fields a client may select
 * for each entity. These mirror client views but live on the server so the
 * source layer can mask private fields and translate selection sets.
 *
 * Every Fate entity needs a stable global `id`. Our event rows are keyed by
 * `slug`, so the source adapter projects `id = slug` (see sources.ts) and we
 * expose both.
 */
export type EventNode = EventDirectoryRow & { id: string };

export const eventDataView = dataView<EventNode>('Event')({
  id: true,
  slug: true,
  name: true,
  event_name: true,
  start_date: true,
  start_time: true,
  location_city: true,
  location_state: true,
  event_image: true,
  scores_released: true,
  recap_released: true,
  lineup_entries: true,
  participant_entries: true,
  judge_assignments: true,
  prediction_runs: true,
  latest_prediction_at: true,
});

export type EventEntity = Entity<typeof eventDataView, 'Event'>;

/**
 * Root operations exposed to clients. `events` is a connection-style list.
 * The root key (`events`) is the operation name the client requests.
 */
export const Root = {
  events: list(eventDataView, { orderBy: [{ start_date: 'asc' }, { id: 'asc' }] }),
};
