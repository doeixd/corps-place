// Tour map body (lazy chunk — see tour-map.tsx). Loads d3-geo + topojson-client
// + the pre-projected us-atlas states topology and renders the tour: state
// outlines, a corps-colored route line that draws itself, dropped pins linking
// to event pages, and a date scrubber that progressively reveals the tour.
//
// Projection: us-atlas `states-albers-10m.json` is PRE-projected to a 975×610
// frame; the documented companion projection for raw lon/lat points is
// geoAlbersUsa().scale(1300).translate([487.5, 305]). Both live only in this
// lazy chunk.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useSelector } from '@xstate/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { themeStore } from '@/stores/theme-store';
import { Slider } from '@/components/ui/slider';
import { formatEventDate, formatScore } from '@/lib/format';
import { medalClass, ordinal } from '@/lib/rank';
import { cn } from '@/lib/utils';
import type { TourStop } from '@/lib/tour';
import type { TourMapProps } from './tour-map';

const VIEW_W = 975;
const VIEW_H = 610;

interface MapGeometry {
  statesPath: string;
  nationPath: string;
  project: (lng: number, lat: number) => [number, number] | null;
}

// Module-level cache: the topology + projection are identical for every corps,
// so navigating between corps pages reuses them without re-fetch/re-parse.
let geometryPromise: Promise<MapGeometry> | null = null;
const loadGeometry = (): Promise<MapGeometry> => {
  geometryPromise ??= (async () => {
    const [{ geoPath, geoAlbersUsa }, { feature, mesh }, topoRes] = await Promise.all([
      import('d3-geo'),
      import('topojson-client'),
      fetch('/geo/us-states-albers-10m.json'),
    ]);
    const topo = await topoRes.json();
    // Pre-projected topology → identity path (no projection argument).
    const path = geoPath();
    const statesPath =
      path(mesh(topo, topo.objects.states, (a: unknown, b: unknown) => a !== b)) ?? '';
    const nationPath = path(feature(topo, topo.objects.nation)) ?? '';
    const projection = geoAlbersUsa().scale(1300).translate([VIEW_W / 2, VIEW_H / 2]);
    return {
      statesPath,
      nationPath,
      project: (lng: number, lat: number) => projection([lng, lat]) ?? null,
    };
  })();
  return geometryPromise;
};

interface ProjectedStop extends TourStop {
  x: number;
  y: number;
}

export default function TourMapBody({ stops, colors }: TourMapProps) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  const [geo, setGeo] = useState<MapGeometry | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadGeometry().then((g) => {
      if (!cancelled) setGeo(g);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const accent = colors.primary
    ? corpsPalette({ primary: colors.primary, secondary: colors.secondary ?? undefined }, theme)
        .chart
    : 'var(--color-primary)';

  // Project once per stops/geometry; drop anything geoAlbersUsa rejects
  // (non-CONUS / bad coordinate) rather than crashing the path.
  const projected = useMemo<ProjectedStop[]>(() => {
    if (!geo) return [];
    const out: ProjectedStop[] = [];
    for (const s of stops) {
      const p = geo.project(s.lng, s.lat);
      if (p) out.push({ ...s, x: p[0], y: p[1] });
    }
    return out;
  }, [geo, stops]);

  // Scrub state: index of the last revealed stop. Historical seasons start
  // fully revealed; mid-season the initial scrub snaps to TODAY (below) so the
  // map reads "the tour so far". Scrubbing replays / previews the rest.
  const [reveal, setReveal] = useState(stops.length - 1);
  const clampedReveal = Math.min(reveal, Math.max(projected.length - 1, 0));
  const active = projected[clampedReveal] ?? null;
  // First reveal animates the line drawing in; keep initial=false afterwards.
  const firstRender = useRef(true);
  useEffect(() => {
    firstRender.current = false;
  }, []);

  // "Today" position on the scrubber: index of the last stop on/before today,
  // and a track fraction date-interpolated between the surrounding stops (the
  // slider is index-spaced, so we interpolate within the segment). Null when
  // today is outside the tour window (past seasons / preseason).
  const today = useMemo(() => {
    if (projected.length < 2) return null;
    const iso = new Date().toISOString().slice(0, 10);
    const first = projected[0]!.date;
    const last = projected[projected.length - 1]!.date;
    if (iso < first || iso > last) return null;
    let index = 0;
    for (let i = 0; i < projected.length; i++) if (projected[i]!.date <= iso) index = i;
    let fraction = index / (projected.length - 1);
    const next = projected[index + 1];
    if (next && next.date > projected[index]!.date) {
      const segStart = Date.parse(projected[index]!.date);
      const segEnd = Date.parse(next.date);
      const within = (Date.parse(iso) - segStart) / (segEnd - segStart);
      fraction = (index + Math.max(0, Math.min(1, within))) / (projected.length - 1);
    }
    return { iso, index, fraction };
  }, [projected]);

  // Mid-season initial position = today (once, when geometry/stops resolve);
  // any user interaction afterwards wins.
  const snappedToToday = useRef(false);
  useEffect(() => {
    if (today && !snappedToToday.current) {
      snappedToToday.current = true;
      setReveal(today.index);
    }
  }, [today]);

  const routeD = useMemo(
    () =>
      projected.length >= 2
        ? 'M' + projected.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join('L')
        : null,
    [projected]
  );
  const revealFraction =
    projected.length >= 2 ? clampedReveal / (projected.length - 1) : 0;

  if (!geo) {
    return (
      <div
        className="w-full animate-pulse rounded-lg bg-muted/40"
        style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
        aria-hidden
      />
    );
  }

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        role="img"
        aria-label="Season tour map"
      >
        <path d={geo.nationPath} className="fill-muted/30" />
        <path
          d={geo.statesPath}
          fill="none"
          className="stroke-border"
          strokeWidth={0.75}
        />
        {routeD ? (
          <motion.path
            d={routeD}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeOpacity={0.75}
            initial={firstRender.current ? { pathLength: 0 } : false}
            animate={{ pathLength: revealFraction }}
            transition={{ type: 'spring', stiffness: 60, damping: 20 }}
          />
        ) : null}
        {projected.map((s, i) => {
          const revealed = i <= clampedReveal;
          const isCurrent = i === clampedReveal;
          return (
            <Link
              key={`${s.slug}-${s.date}`}
              to="/events/$yearSlug/$slug/prediction"
              params={{ yearSlug: s.season, slug: s.linkSlug }}
              aria-label={`${s.name}, ${formatEventDate(s.date)}`}
            >
              <motion.g
                initial={firstRender.current ? { scale: 0 } : false}
                animate={{
                  scale: revealed ? (isCurrent ? 1.35 : 1) : 0,
                  opacity: revealed ? (isCurrent ? 1 : 0.75) : 0,
                }}
                transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
                style={{ transformOrigin: `${s.x}px ${s.y}px` }}
                onMouseEnter={() => setReveal(i)}
                className="cursor-pointer"
              >
                <circle cx={s.x} cy={s.y} r={9} fill="transparent" />
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={4.5}
                  fill={accent}
                  className="stroke-background"
                  strokeWidth={1.5}
                />
                <title>{`${s.name} — ${formatEventDate(s.date)}${s.city ? ` · ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}`}</title>
              </motion.g>
            </Link>
          );
        })}
      </svg>

      {/* Scrubber: discrete stop index — "watch the tour unfold". A "Today"
          marker sits on the track at the current date's position (interpolated
          between the surrounding stops); clicking it scrubs to today. Only
          rendered mid-tour — pre/post-season it would pin to an edge. */}
      <div className="px-1">
        <div className="relative">
          {today ? (
            <button
              type="button"
              onClick={() => setReveal(today.index)}
              aria-label={`Jump to today (${formatEventDate(today.iso)})`}
              className="group absolute -top-1 bottom-0 z-10 -translate-x-1/2"
              style={{ left: `${(today.fraction * 100).toFixed(2)}%` }}
            >
              <span className="block h-4 w-[2px] rounded-full bg-foreground/50 transition-colors group-hover:bg-foreground" />
            </button>
          ) : null}
          <Slider
            min={0}
            max={Math.max(projected.length - 1, 0)}
            step={1}
            value={[clampedReveal]}
            onValueChange={(v: number | readonly number[]) =>
              setReveal(Array.isArray(v) ? (v[0] ?? 0) : (v as number))
            }
            aria-label="Reveal tour through date"
          />
          {today ? (
            <span
              aria-hidden
              className="absolute top-full mt-0.5 -translate-x-1/2 text-[10px] font-medium text-text-muted"
              style={{ left: `${(today.fraction * 100).toFixed(2)}%` }}
            >
              Today
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-text-muted">
          <span>{projected[0] ? formatEventDate(projected[0].date) : ''}</span>
          <span>
            {projected.at(-1) ? formatEventDate(projected.at(-1)!.date) : ''}
          </span>
        </div>
      </div>

      {/* Active stop card — follows the scrub/hover. */}
      {active ? (
        <Link
          to="/events/$yearSlug/$slug/prediction"
          params={{ yearSlug: active.season, slug: active.linkSlug }}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-primary/50"
        >
          <span className="font-medium">{active.name}</span>
          <span className="text-text-secondary">
            {formatEventDate(active.date)}
            {active.city ? ` · ${active.city}${active.state ? `, ${active.state}` : ''}` : ''}
            {active.venue ? ` · ${active.venue}` : ''}
          </span>
          {active.place != null ? (
            <span className={cn('ml-auto font-semibold tabular-nums', medalClass(active.place))}>
              {ordinal(active.place)}
              {active.total != null ? (
                <span className="ml-1 font-normal text-text-secondary">
                  {formatScore(active.total)}
                </span>
              ) : null}
            </span>
          ) : null}
        </Link>
      ) : null}
    </div>
  );
}
