/**
 * Formatting helpers for display values. Dates from the SDK arrive as UTC ISO
 * strings at midnight Z (e.g. `2026-06-26T00:00:00.000Z`); format in UTC so the
 * calendar date never shifts due to the viewer's timezone.
 */

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** `2026-06-26T00:00:00.000Z` → `Fri, Jun 26` (year omitted). Falls back to the raw input. */
export function formatEventDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return DATE_FMT.format(date);
}

/** A DCI total score to its conventional 3 decimals (`91.4` → `91.400`); '' when absent. */
export const formatScore = (value: number | null | undefined): string =>
  typeof value === 'number' ? value.toFixed(3) : '';

/**
 * Fixed-zone (ET) datetime label — deterministic across server and client so an
 * SSR'd "Updated …" line never mismatches at hydration. ET is the sport's home
 * timezone. `2026-07-13T04:37:17Z` → `Jul 13, 12:37 AM ET`.
 */
export function formatUpdatedET(iso: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso)) + ' ET'
    );
  } catch {
    return iso.slice(0, 10);
  }
}
