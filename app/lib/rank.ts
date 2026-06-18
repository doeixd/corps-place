/**
 * Ranking display helpers shared by the home panels (latest results, standings)
 * and the corps appearance cards.
 */

/** Tailwind text color for a finishing place: gold / silver / bronze for the
 *  podium, muted otherwise. Null/undefined → muted. */
export const medalClass = (rank: number | null | undefined): string =>
  rank === 1
    ? 'text-amber-500'
    : rank === 2
      ? 'text-zinc-400'
      : rank === 3
        ? 'text-amber-700'
        : 'text-text-secondary';

/** A whole number as an English ordinal: 1 → "1st", 2 → "2nd", 13 → "13th". */
export const ordinal = (n: number): string => {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  const suffix =
    abs >= 11 && abs <= 13
      ? 'th'
      : last === 1
        ? 'st'
        : last === 2
          ? 'nd'
          : last === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
};
