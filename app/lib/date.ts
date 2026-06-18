/**
 * Date logic primitives (distinct from the display formatting in `format.ts`).
 *
 * Event dates from the SDK are UTC-midnight ISO strings (e.g.
 * `2026-06-26T00:00:00.000Z`), and the UI displays them in UTC — so we compute
 * "today", year, and upcoming-ness in UTC too, keeping these comparisons
 * consistent with the dates shown. Centralized here so the rule lives in one
 * place (the SDK read-model builders mirror this server-side; see
 * `sdk/src/readModel/builders/home.ts`).
 */

/** A `Date` as a UTC `YYYY-MM-DD` string. */
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Today as a UTC `YYYY-MM-DD` string. */
export const todayYmd = (now: Date = new Date()): string => ymd(now);

/** The year prefix of an ISO date / YMD string (`2026-06-13…` → `2026`). */
export const yearOf = (isoDate: string): string => isoDate.slice(0, 4);

/** Whether an event `start_date` is on or after a `YYYY-MM-DD` reference day. */
export const startsOnOrAfter = (startDate: string, refYmd: string): boolean =>
  startDate.slice(0, 10) >= refYmd;
