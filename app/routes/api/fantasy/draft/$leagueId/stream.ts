import { createServerFileRoute } from '@tanstack/react-start/server';
import { Effect, Fiber, Stream } from 'effect';
import { getActor } from '@/lib/authz';
import { getContributionsDb } from '@/lib/contributions-db';
import { subscribe } from '@/lib/fantasy/bus';
import { getSnapshot } from '@/lib/fantasy/draft-engine';
import { effectDraftEnabled } from '@/lib/fantasy/flag';
import { DraftService, DraftServiceLive, draftPubSub } from '@/lib/fantasy/services/draft-service';

/**
 * Live draft channel (Fantasy DCI plan H.2): a Server-Sent Events stream. On
 * connect we verify the actor is a league member, push one `snapshot`, then
 * fan out `pick` / `state` deltas from the in-memory bus. A 25s heartbeat keeps
 * proxies from closing the idle connection. The DB is the source of truth, so a
 * reconnect simply re-reads the full snapshot (no replay bookkeeping needed).
 */
export const ServerRoute = createServerFileRoute('/api/fantasy/draft/$leagueId/stream').methods({
  GET: async ({ request, params }) => {
    const actor = await getActor(request);
    if (!actor) return new Response('Unauthorized', { status: 401 });

    const db = await getContributionsDb();
    const member = (
      await db.execute({
        sql: "SELECT 1 FROM fantasy_members WHERE league_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
        args: [params.leagueId, actor.userId],
      })
    ).rows[0];
    if (!member) return new Response('Forbidden', { status: 403 });

    const leagueId = params.leagueId;
    const useEffect = effectDraftEnabled();
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: string, data: unknown, id?: number) => {
          const frame =
            (id == null ? '' : `id: ${id}\n`) +
            `event: ${event}\n` +
            `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        };

        // Engine A/B (P3): the Effect path reads the snapshot from DraftService and
        // fans out from its PubSub; the legacy path uses draft-engine + bus.ts. The
        // SSE wire format is identical, so the client is unchanged either way.
        const snapshot = useEffect
          ? await Effect.runPromise(
              Effect.flatMap(DraftService, (s) => s.getSnapshot(leagueId)).pipe(
                Effect.provide(DraftServiceLive)
              )
            )
          : await getSnapshot(leagueId);
        write('snapshot', snapshot, snapshot.draft?.currentPickNo ?? 0);

        if (useEffect) {
          // Subscribe a Stream from the league PubSub; interrupt the fiber on cancel.
          const fiber = Effect.runFork(
            Stream.fromPubSub(draftPubSub(leagueId)).pipe(
              Stream.runForEach((e: { event: string; data: unknown }) =>
                Effect.sync(() => write(e.event, e.data))
              )
            )
          );
          unsubscribe = () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        } else {
          unsubscribe = subscribe(leagueId, {
            id: crypto.randomUUID(),
            send: ({ event, data }) => write(event, data),
          });
        }
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            // Controller closed (client gone) before cancel() fired — stop pinging.
            if (heartbeat) clearInterval(heartbeat);
          }
        }, 25_000);
      },
      cancel() {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  },
});
