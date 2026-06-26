// VS Comparison Chart — the core series abstraction (plan §"Series model").
//
// A `VsSeries` is the *declarative* spec for one line on the chart (what the URL
// encodes). A resolver turns it into a `VsResolvedSeries` — the concrete points
// to plot, plus a stable id, label, and color. LEAK-SAFE: pure types only, no
// server/db imports, so this is shared freely by client + server.

/** One comparison series, as declared in the URL. v1 = OVERALL TOTAL only. */
export type VsSeries =
  // A corps's line for a season. Historical = actual only; current (2026) =
  // actual-so-far (solid) + predicted-to-finals (dashed).
  | { kind: 'corps'; corpsSlug: string; season: string }
  // A prediction snapshot as-of a date. Current season only (no historical
  // snapshots exist); season is implicit = the current season.
  | { kind: 'prediction'; corpsSlug: string; asOf: string }
  // The generic reference curve for an Nth-place corps (rank 1..25), averaged
  // across seasons. Division-agnostic.
  | { kind: 'baseline'; rank: number };

/** One plotted polyline within a resolved series. A 2026 corps series yields two
 *  (actual solid + predicted dashed); historical corps + baselines yield one. */
export interface VsLine {
  style: 'solid' | 'dashed';
  points: VsPoint[];
}

/** A single point. `pct` ∈ [0,100] is the x-axis (% through season). Gaps in the
 *  source render as gaps — a missing value is simply an absent point, never 0. */
export interface VsPoint {
  pct: number;
  value: number;
  /** Real calendar date of the underlying event, when the series is date-bearing
   *  (corps actuals, predictions). Absent for baselines. */
  date?: string;
  /** Human label for the underlying event (e.g. the show name), when present. */
  eventLabel?: string;
}

/** A series resolved to concrete, plottable data. */
export interface VsResolvedSeries {
  /** Stable id — derived from the series spec (its encoded token). Drives color,
   *  legend identity, and React keys. */
  id: string;
  label: string;
  /** The series type, so the colorizer knows whether to use a brand hue or the
   *  categorical (baseline) ramp. */
  kind: VsSeries['kind'];
  /** Brand colors for `kind:'corps'|'prediction'` series — the chart derives the
   *  theme-aware line color from these via `corpsPalette`. Null/absent → ramp. */
  brand?: { primary: string | null; secondary: string | null } | null;
  /** CSS color string (`oklch(...)` / `var(--…)`). Assigned at render by
   *  `assignVsColors` (theme-aware), so the resolver may leave it `''`. */
  color: string;
  lines: VsLine[];
}

/** Hard cap on concurrent series (plan edge-case: visible message, no silent
 *  truncation). */
export const VS_SERIES_CAP = 6;
