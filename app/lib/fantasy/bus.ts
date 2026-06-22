/**
 * In-memory per-league pub/sub for the live draft (Fantasy DCI plan H.1).
 *
 * The DB is the source of truth; this bus is only fan-out to connected SSE
 * clients. Single-process assumption (A8/V1) — a horizontal scale-out would need
 * a shared transport (libsql polling / Redis / sticky routing).
 */
export type DraftEvent = { event: string; data: unknown };
export type DraftClient = { id: string; send: (event: DraftEvent) => void };

const rooms = new Map<string, Set<DraftClient>>();

/** Register a client for a league; returns an unsubscribe fn. */
export function subscribe(leagueId: string, client: DraftClient): () => void {
  let room = rooms.get(leagueId);
  if (!room) {
    room = new Set();
    rooms.set(leagueId, room);
  }
  room.add(client);
  return () => {
    const r = rooms.get(leagueId);
    if (!r) return;
    r.delete(client);
    if (r.size === 0) rooms.delete(leagueId);
  };
}

/** Fan an event out to every client subscribed to a league. */
export function broadcast(leagueId: string, event: DraftEvent): void {
  const room = rooms.get(leagueId);
  if (!room) return;
  for (const client of room) {
    try {
      client.send(event);
    } catch {
      // A dead controller (client gone) — its cancel handler will unsubscribe.
    }
  }
}

/** Number of connected clients (diagnostics / tests). */
export const roomSize = (leagueId: string): number => rooms.get(leagueId)?.size ?? 0;
