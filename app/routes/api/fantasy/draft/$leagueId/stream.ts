import { createServerFileRoute } from '@tanstack/react-start/server';
import { getActor } from '@/lib/authz';
import { getContributionsDb } from '@/lib/contributions-db';
import { subscribe } from '@/lib/fantasy/bus';
import { getSnapshot } from '@/lib/fantasy/draft-engine';

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

        const snapshot = await getSnapshot(leagueId);
        write('snapshot', snapshot, snapshot.draft?.currentPickNo ?? 0);

        unsubscribe = subscribe(leagueId, {
          id: crypto.randomUUID(),
          send: ({ event, data }) => write(event, data),
        });
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
