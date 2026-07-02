import { createServerFileRoute } from '@tanstack/react-start/server';
import { Effect } from 'effect';
import { NotificationService } from '@/lib/fantasy/services/notification-service';
import { DraftService } from '@/lib/fantasy/services/draft-service';
import * as draftEngine from '@/lib/fantasy/draft-engine';
import { effectDraftEnabled } from '@/lib/fantasy/flag';
import { fantasyRuntime } from '@/rpc';

/**
 * Cron-hit reminder + notification dispatcher (Fantasy DCI plan H.4 / §8.1).
 * Guarded by a shared secret header so the public can't trigger it. A system /
 * Coolify cron on the VM hits this every few minutes; the work is idempotent.
 */
const authorized = (request: Request): boolean => {
  const secret = process.env.FANTASY_CRON_SECRET;
  return Boolean(secret) && request.headers.get('x-fantasy-cron') === secret;
};

const run = async ({ request }: { request: Request }): Promise<Response> => {
  if (!authorized(request)) return new Response('Not found', { status: 404 });
  const summary = await fantasyRuntime.runPromise(
    Effect.gen(function* () {
      // Auto-start due scheduled drafts — through whichever engine is active, so a
      // draft is always started by the same engine that will serve its picks.
      // (Previously the legacy branch was a no-op, so prod — which runs the legacy
      // engine — silently never honored "start automatically at the scheduled time".)
      const drafts = effectDraftEnabled()
        ? yield* Effect.flatMap(DraftService, (s) => s.startDueScheduledDrafts())
        : yield* Effect.promise(() => draftEngine.startDueScheduledDrafts());
      const dispatch = yield* Effect.flatMap(NotificationService, (s) => s.dispatch());
      return { ...dispatch, draftsStarted: drafts.started };
    })
  );
  return Response.json({ ok: true, ...summary });
};

export const ServerRoute = createServerFileRoute('/api/fantasy/jobs/dispatch').methods({
  GET: run,
  POST: run,
});
