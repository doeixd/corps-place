// Venue-local → viewer-local time conversion for event schedules
// (USER_PROFILE_PLAN D6). DCI publishes wall-clock times with a US zone
// abbreviation (ET/CT/MT/PT); we resolve that to an IANA zone, anchor the wall
// time to the event date to get a real instant, and re-format in the viewer's
// zone. Pure client-side; anything unparseable falls back to the venue string.

const ABBREV_TO_IANA: Record<string, string> = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles',
};

export const venueZoneFromAbbrev = (abbrev: string | null | undefined): string | null =>
  abbrev ? (ABBREV_TO_IANA[abbrev.toUpperCase()] ?? null) : null;

/** Wall-clock reading of a UTC instant in `zone`, as a UTC-ms number. */
const wallTimeInZone = (utcMs: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
};

/** The UTC instant whose wall time in `zone` is the given date+h:mm. */
const zonedInstant = (
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  zone: string
): Date => {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two iterations converge for all real offsets (incl. DST edges).
  for (let i = 0; i < 2; i++) {
    const offset = wallTimeInZone(guess, zone) - guess;
    guess = Date.UTC(year, month - 1, day, hour, minute) - offset;
  }
  return new Date(guess);
};

const TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

/**
 * Convert a venue-local schedule time (e.g. "7:00 PM" on the event's date in
 * the venue zone) into the viewer's local "h:mm AM/PM ZZZ" string. Returns null
 * when the time/zone can't be resolved (caller shows the venue string).
 */
export function toViewerLocalTime(
  eventDateISO: string | null | undefined,
  venueTime: string | null | undefined,
  venueZone: string | null
): string | null {
  if (!eventDateISO || !venueTime || !venueZone) return null;
  const m = venueTime.trim().match(TIME_RE);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (/pm/i.test(m[3]!)) hour += 12;
  const minute = Number(m[2]);
  const dateM = eventDateISO.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateM) return null;
  try {
    const instant = zonedInstant(
      Number(dateM[1]),
      Number(dateM[2]),
      Number(dateM[3]),
      hour,
      minute,
      venueZone
    );
    const time = instant.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const zone =
      new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(instant)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    // Crossing midnight for this viewer (e.g. a 7 PM ET show seen from Europe):
    // mark the day shift or the bare time is misleading. Compare full local
    // date vs the venue date (month-wrap safe).
    const localYmd = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}-${String(instant.getDate()).padStart(2, '0')}`;
    const venueYmd = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;
    const shift = localYmd === venueYmd ? '' : localYmd > venueYmd ? ' (+1 day)' : ' (−1 day)';
    return `${zone ? `${time} ${zone}` : time}${shift}`;
  } catch {
    return null;
  }
}

/** The viewer's zone abbreviation (e.g. "CDT"), for labels. */
export function viewerZoneLabel(): string | null {
  try {
    return (
      new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? null
    );
  } catch {
    return null;
  }
}
