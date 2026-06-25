/**
 * In-memory draft presence: which members currently hold a live SSE connection to a
 * league's draft channel. A member can have several tabs open, so we count connections
 * and only consider them offline when the last one drops. Single-process (matches the
 * draft engine's A8/V1 assumption); cleared naturally as connections close.
 *
 * SERVER-ONLY. The SSE route updates this on connect/disconnect and broadcasts the
 * resulting online set to every connected client via the league bus.
 */
const counts = new Map<string, Map<string, number>>();

export function addPresence(leagueId: string, userId: string): void {
  let m = counts.get(leagueId);
  if (!m) {
    m = new Map();
    counts.set(leagueId, m);
  }
  m.set(userId, (m.get(userId) ?? 0) + 1);
}

export function removePresence(leagueId: string, userId: string): void {
  const m = counts.get(leagueId);
  if (!m) return;
  const next = (m.get(userId) ?? 0) - 1;
  if (next <= 0) m.delete(userId);
  else m.set(userId, next);
  if (m.size === 0) counts.delete(leagueId);
}

export function onlineUserIds(leagueId: string): string[] {
  return [...(counts.get(leagueId)?.keys() ?? [])];
}
