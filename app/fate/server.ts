import { createFateServer, createFateFetchHandler, createLiveEventBus } from '@nkzw/fate/server';
import { Root } from './views';
import { sources } from './sources';

/**
 * Fate native server, backed by our Effect-service source adapter (sources.ts).
 *
 * - `roots`   — the operations clients can request (currently `events`).
 * - `sources` — the custom adapter delegating to EventDirectoryService.
 * - `live`    — in-memory event bus for live views (optional; enables useLiveView).
 *
 * Exposed over a Fetch-compatible handler so it can be mounted on a TanStack
 * Start server route (app/routes/api/fate.ts) at `/api/fate` + `/api/fate/live`.
 */
export const live = createLiveEventBus();

// NOTE: do NOT pass an explicit generic to createFateServer — supplying one type
// arg defeats inference of Roots/Lists, collapsing the API type. Context is
// inferred from the `context` return type (AppContext = { request }).
export const fate = createFateServer({
  live,
  context: async ({ request }) => ({ request }),
  roots: Root,
  sources,
});

export const fateHandler = createFateFetchHandler(fate);

// The generated client (react-fate/vite) imports an entity type named `Event`.
export type { EventEntity as Event } from './views';
export { Root } from './views';
