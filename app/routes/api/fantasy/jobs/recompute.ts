import { createFileRoute } from '@tanstack/react-router';
import { Effect } from 'effect';
import { StandingsService } from '@/lib/fantasy/services/standings-service';
import { fantasyRuntime } from '@/rpc';

/**
 * Cron-hit standings recompute (Fantasy DCI plan §5.5). The recap scraper is
 * externally triggered, so a cron (or the scrape job) hits this after ingest to
 * refresh standings + lock finals. Guarded by the same shared secret as dispatch.
 * Season defaults to the current year; override with `?season=YYYY`.
 */
const authorized = (request: Request): boolean => {
  const secret = process.env.FANTASY_CRON_SECRET;
  return Boolean(secret) && request.headers.get('x-fantasy-cron') === secret;
};

const run = async ({ request }: { request: Request }): Promise<Response> => {
  if (!authorized(request)) return new Response('Not found', { status: 404 });
  const season =
    new URL(request.url).searchParams.get('season') ?? String(new Date().getFullYear());
  const summary = await fantasyRuntime.runPromise(
    Effect.flatMap(StandingsService, (s) => s.recompute(season))
  );
  return Response.json({ ok: true, season, ...summary });
};

export const Route = createFileRoute('/api/fantasy/jobs/recompute')({
  server: {
    handlers: {
  GET: run,
  POST: run,
    },
  },
});
