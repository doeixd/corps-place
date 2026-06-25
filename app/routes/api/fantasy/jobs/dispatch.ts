import { createServerFileRoute } from '@tanstack/react-start/server';
import { Effect } from 'effect';
import { NotificationService } from '@/lib/fantasy/services/notification-service';
import { DraftService } from '@/lib/fantasy/services/draft-service';
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
      // Auto-start scheduled drafts whose time has arrived, then run reminders/digests.
      const drafts = yield* Effect.flatMap(DraftService, (s) => s.startDueScheduledDrafts());
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
