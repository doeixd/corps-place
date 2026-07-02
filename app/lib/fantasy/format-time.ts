// Shared formatting for draft times so every surface (schedule setup, draft room,
// join page) renders the same way — including the time-zone code (e.g. "EDT"), so
// members in other zones aren't misled about when the draft actually opens.

/** e.g. "7/2/2026, 3:00 PM EDT" in the viewer's local zone. */
export function formatDraftDateTime(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    // dateStyle/timeStyle can't be combined with timeZoneName in some engines, so
    // append the short zone code (EDT/PST/…) separately for broad support.
  }) + ` ${shortZoneCode(d)}`;
}

/** The short time-zone code for a date in the viewer's local zone (e.g. "EDT"). */
export function shortZoneCode(d: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
