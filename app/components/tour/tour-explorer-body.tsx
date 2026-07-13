// /tour explorer body (lazy chunk). Renders EVERY visible corps' route on one
// map. Performance contract (TOUR_MAP_PLAN §Rendering performance):
//   - no motion springs here — ~100 routes use plain paths + CSS transitions;
//   - scrub is per-step: reveal per corps = dash-offset from a precomputed
//     cumulative-length table (straight-segment math, no getTotalLength);
//   - all-corps mode draws shared-venue dots (~72), never per-stop pins.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useSelector } from '@xstate/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { themeStore } from '@/stores/theme-store';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import {
  ArrowExpandIcon,
  ArrowShrinkIcon,
  Download01Icon,
  PlayIcon,
  PauseIcon,
} from '@/components/icons/generated';
import { ShareButton } from '@/components/share-button';
import { formatEventDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SeasonTourCorps } from '@sdk/src/readModel/builders/tour.js';
import type { TourExplorerMapProps } from './tour-explorer-map';
import { VIEW_W, VIEW_H, loadGeometry, type MapGeometry } from './geometry';
import { StaticTourMapImg } from './static-map-img';

interface SeriesGeom {
  corps: SeasonTourCorps;
  color: string;
  /** Projected points, stop-aligned: [x, y, date, eventId]. */
  pts: [number, number, string, string][];
  d: string | null;
  totalLen: number;
  /** Cumulative polyline length at each point (same order as pts). */
  cumLen: number[];
}

const dateVal = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

export default function TourExplorerBody({
  corps,
  events,
  season,
  focused,
  asof,
  hoverSlug,
  onHoverSlug,
  onToggleFocus,
}: TourExplorerMapProps) {
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

  const series = useMemo<SeriesGeom[]>(() => {
    if (!geo) return [];
    return corps.map((c) => {
      const pts: SeriesGeom['pts'] = [];
      for (const [eventId, date, lat, lng] of c.stops) {
        const p = geo.project(lng, lat);
        if (p) pts.push([p[0], p[1], date, eventId]);
      }
      const cumLen: number[] = [];
      let total = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
        cumLen.push(total);
      }
      return {
        corps: c,
        color: c.colorPrimary
          ? corpsPalette(
              { primary: c.colorPrimary, secondary: c.colorSecondary ?? undefined },
              theme
            ).chart
          : 'var(--color-primary)',
        pts,
        d:
          pts.length >= 2
            ? 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')
            : null,
        totalLen: total,
        cumLen,
      };
    });
  }, [geo, corps, theme]);

  // Season date axis across the visible series.
  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.pts) set.add(p[2]);
    return [...set].sort();
  }, [series]);

  // Reveal date: URL asof (clamped) → today (mid-season) → last date.
  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultDate = useMemo(() => {
    if (dates.length === 0) return null;
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const want = asof && asof >= first && asof <= last ? asof : null;
    if (want) return want;
    if (todayIso >= first && todayIso <= last) return todayIso;
    return last;
  }, [dates, asof, todayIso]);
  const [revealIdx, setRevealIdx] = useState<number | null>(null);
  const idx = useMemo(() => {
    if (dates.length === 0) return 0;
    if (revealIdx != null) return Math.min(revealIdx, dates.length - 1);
    let i = dates.length - 1;
    if (defaultDate) {
      i = 0;
      for (let k = 0; k < dates.length; k++) if (dates[k]! <= defaultDate) i = k;
    }
    return i;
  }, [revealIdx, dates, defaultDate]);
  const revealDate = dates[idx] ?? null;

  // Today marker (date-proportional along the axis span).
  const todayMark = useMemo(() => {
    if (dates.length < 2) return null;
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    if (todayIso < first || todayIso > last) return null;
    // Fraction within the INDEX axis: interpolate between surrounding dates.
    let i = 0;
    for (let k = 0; k < dates.length; k++) if (dates[k]! <= todayIso) i = k;
    let fraction = i / (dates.length - 1);
    const next = dates[i + 1];
    if (next) {
      const within =
        (dateVal(todayIso) - dateVal(dates[i]!)) / (dateVal(next) - dateVal(dates[i]!));
      fraction = (i + Math.max(0, Math.min(1, within))) / (dates.length - 1);
    }
    return { index: i, fraction };
  }, [dates, todayIso]);

  /** Dash-revealed length for a series at the reveal date. */
  const revealLen = (s: SeriesGeom): number => {
    if (!revealDate || s.pts.length === 0) return s.totalLen;
    let len = 0;
    for (let i = 0; i < s.pts.length; i++) if (s.pts[i]![2] <= revealDate) len = s.cumLen[i]!;
    return len;
  };

  // Shared-venue dots (all-corps mode): group visible revealed stops by coord.
  const [activeVenue, setActiveVenue] = useState<string | null>(null);
  const venues = useMemo(() => {
    const m = new Map<
      string,
      { x: number; y: number; corpsCount: Set<string>; events: Map<string, string> }
    >();
    for (const s of series) {
      for (const [x, y, date, eventId] of s.pts) {
        if (revealDate && date > revealDate) continue;
        const key = `${x.toFixed(1)},${y.toFixed(1)}`;
        const v = m.get(key) ?? { x, y, corpsCount: new Set(), events: new Map() };
        v.corpsCount.add(s.corps.slug);
        v.events.set(eventId, date);
        m.set(key, v);
      }
    }
    return m;
  }, [series, revealDate]);
  const activeVenueData = activeVenue ? venues.get(activeVenue) : null;

  const isFocusedMode = !!focused?.length;

  // ── Toolbar: fullscreen lightbox, play, downloads ──────────────────────────
  const [fullscreen, setFullscreen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState<string | null>(null);

  // Lightbox: lock page scroll + Esc to close.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  // Play: advance one season day at a time; restart from 0 when at the end.
  useEffect(() => {
    if (!playing || dates.length < 2) return;
    if (idx >= dates.length - 1) {
      setRevealIdx(0);
      return;
    }
    const t = setTimeout(() => setRevealIdx((idx + 1) as number), 550);
    return () => clearTimeout(t);
  }, [playing, idx, dates.length]);
  useEffect(() => {
    if (playing && idx >= dates.length - 1) setPlaying(false);
  }, [playing, idx, dates.length]);

  /** Standalone SVG string of the CURRENT frame (theme-independent dark style —
   *  same look as the OG card) for PNG/video export. */
  const frameSvg = useCallback(
    (atDate: string | null): string => {
      if (!geo) return '';
      const routes = series
        .map((sr) => {
          if (!sr.d) return '';
          let shown = sr.totalLen;
          if (atDate) {
            shown = 0;
            for (let i = 0; i < sr.pts.length; i++)
              if (sr.pts[i]![2] <= atDate) shown = sr.cumLen[i]!;
          }
          const off = Math.max(0, sr.totalLen - shown);
          return `<path d="${sr.d}" fill="none" stroke="${sr.corps.colorPrimary ?? '#fd5007'}" stroke-width="${isFocusedMode ? 2.2 : 1.6}" stroke-opacity="${isFocusedMode ? 0.9 : 0.55}" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${sr.totalLen}" stroke-dashoffset="${off}"/>`;
        })
        .join('');
      const label = atDate
        ? `<text x="40" y="${VIEW_H - 28}" font-family="sans-serif" font-size="26" fill="rgba(255,255,255,0.85)">${season} tour — ${formatEventDate(atDate)} · drumcorps.app/tour</text>`
        : '';
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W * 2}" height="${VIEW_H * 2}">` +
        `<rect width="${VIEW_W}" height="${VIEW_H}" fill="#0b0d12"/>` +
        `<path d="${geo.nationPath}" fill="#151923"/>` +
        `<path d="${geo.statesPath}" fill="none" stroke="#2a3040" stroke-width="0.8"/>` +
        routes +
        label +
        `</svg>`
      );
    },
    [geo, series, isFocusedMode, season]
  );

  const svgToCanvas = useCallback(async (svg: string, canvas: HTMLCanvasElement) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('svg decode failed'));
        img.src = url;
      });
      canvas.width = VIEW_W * 2;
      canvas.height = VIEW_H * 2;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

  const downloadBlob = (blob: Blob, filename: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadPng = useCallback(async () => {
    setRendering('image');
    try {
      const canvas = document.createElement('canvas');
      await svgToCanvas(frameSvg(revealDate), canvas);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (blob) downloadBlob(blob, `dci-tour-${season}${revealDate ? `-${revealDate}` : ''}.png`);
    } finally {
      setRendering(null);
    }
  }, [frameSvg, revealDate, season, svgToCanvas]);

  // Video: replay every season day into a canvas stream via MediaRecorder
  // (WebM — universal-enough; browsers without MediaRecorder hide the button).
  const canRecord = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined';
  const downloadVideo = useCallback(async () => {
    if (!canRecord || dates.length < 2) return;
    setRendering('video');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = VIEW_W * 2;
      canvas.height = VIEW_H * 2;
      const stream = canvas.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      );
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.start();
      // Hold each day ~0.45s; ease in with a title frame and out with a hold.
      for (let i = 0; i < dates.length; i++) {
        await svgToCanvas(frameSvg(dates[i]!), canvas);
        await new Promise((r) => setTimeout(r, 450));
      }
      await new Promise((r) => setTimeout(r, 1200));
      rec.stop();
      await done;
      downloadBlob(new Blob(chunks, { type: 'video/webm' }), `dci-tour-${season}.webm`);
    } finally {
      setRendering(null);
    }
  }, [canRecord, dates, frameSvg, season, svgToCanvas]);

  // Until the geometry chunk resolves, keep showing the static map image the
  // SSR shell painted — the interactive SVG then swaps in (same aspect box).
  if (!geo) {
    return <StaticTourMapImg season={season} corps={focused} />;
  }

  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  return (
    <div
      className={cn(
        'space-y-3',
        fullscreen &&
          'fixed inset-0 z-50 overflow-y-auto bg-background p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:p-6'
      )}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={cn('w-full', fullscreen && 'mx-auto max-h-[78dvh]')}
        role="img"
        aria-label={`${season} tour map — ${corps.length} corps`}
        onMouseLeave={() => onHoverSlug(null)}
      >
        {/* Light mode needs a real landmass tint (muted/30 was white-on-white)
            + firmer state lines; dark mode keeps the subtle originals. */}
        <path d={geo.nationPath} className="fill-muted dark:fill-muted/30" />
        <path
          d={geo.statesPath}
          fill="none"
          className="stroke-muted-foreground/25 dark:stroke-border"
          strokeWidth={0.75}
        />

        {/* Routes: visible path + invisible fat hit-twin. CSS transitions only. */}
        {series.map((s) => {
          if (!s.d) return null;
          const hovered = hoverSlug === s.corps.slug;
          const dimmed = hoverSlug != null && !hovered;
          const shown = revealLen(s);
          return (
            <g key={s.corps.slug}>
              <path
                d={s.d}
                fill="none"
                stroke={s.color}
                strokeWidth={hovered ? 2.5 : isFocusedMode ? 2 : 1.25}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.totalLen}
                strokeDashoffset={Math.max(0, s.totalLen - shown)}
                style={{
                  opacity: hovered ? 1 : dimmed ? 0.12 : isFocusedMode ? 0.9 : 0.35,
                  transition: 'opacity 150ms, stroke-width 150ms, stroke-dashoffset 300ms',
                }}
              />
              <path
                d={s.d}
                fill="none"
                stroke="transparent"
                strokeWidth={8}
                className="cursor-pointer"
                onMouseEnter={() => onHoverSlug(s.corps.slug)}
                onClick={() => onToggleFocus(s.corps.slug)}
              >
                <title>{s.corps.name}</title>
              </path>
            </g>
          );
        })}

        {/* Focused mode: per-stop pins for the focused corps. */}
        {isFocusedMode
          ? series.map((s) =>
              s.pts.map(([x, y, date, eventId]) => {
                if (revealDate && date > revealDate) return null;
                const ev = events[eventId];
                return (
                  <Link
                    key={`${s.corps.slug}-${eventId}`}
                    to="/events/$yearSlug/$slug/prediction"
                    params={{ yearSlug: season, slug: ev?.[0] ?? eventId }}
                    aria-label={ev ? `${ev[1]}, ${formatEventDate(date)}` : date}
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={4}
                      fill={s.color}
                      className="cursor-pointer stroke-background"
                      strokeWidth={1.25}
                    >
                      <title>
                        {ev ? `${s.corps.name} — ${ev[1]} (${formatEventDate(date)})` : date}
                      </title>
                    </circle>
                  </Link>
                );
              })
            )
          : /* All-corps mode: shared-venue dots sized by corps count. */
            [...venues.entries()].map(([key, v]) => (
              <g key={key}>
                <circle
                  cx={v.x}
                  cy={v.y}
                  r={Math.min(2 + Math.sqrt(v.corpsCount.size) * 1.4, 8)}
                  className={cn(
                    'cursor-pointer fill-foreground/45 stroke-background transition-[r]',
                    activeVenue === key && 'fill-primary'
                  )}
                  strokeWidth={1}
                  onClick={() => setActiveVenue(activeVenue === key ? null : key)}
                />
                <circle
                  cx={v.x}
                  cy={v.y}
                  r={9}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={() => setActiveVenue(activeVenue === key ? null : key)}
                />
              </g>
            ))}
      </svg>

      {/* Date scrubber + Today marker (index axis, date-interpolated marker). */}
      {dates.length >= 2 ? (
        <div className="px-1">
          <div className="relative">
            {todayMark ? (
              <button
                type="button"
                onClick={() => setRevealIdx(todayMark.index)}
                aria-label="Jump to today"
                className="group absolute -top-1 bottom-0 z-10 -translate-x-1/2"
                style={{ left: `${(todayMark.fraction * 100).toFixed(2)}%` }}
              >
                <span className="block h-4 w-[2px] rounded-full bg-foreground/50 transition-colors group-hover:bg-foreground" />
              </button>
            ) : null}
            <Slider
              min={0}
              max={dates.length - 1}
              step={1}
              value={[idx]}
              onValueChange={(v: number | readonly number[]) =>
                setRevealIdx(Array.isArray(v) ? (v[0] ?? 0) : (v as number))
              }
              aria-label="Reveal tours through date"
            />
            {todayMark ? (
              <span
                aria-hidden
                className="absolute top-full mt-0.5 -translate-x-1/2 text-[10px] font-medium text-text-muted"
                style={{ left: `${(todayMark.fraction * 100).toFixed(2)}%` }}
              >
                Today
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-text-muted">
            <span>{formatEventDate(dates[0]!)}</span>
            <span>{formatEventDate(dates[dates.length - 1]!)}</span>
          </div>
          {/* Current reveal date on its own line, below the Today label's band
              so the two never overlap. */}
          <div className="mt-3 text-center text-xs font-medium text-text-secondary">
            {revealDate ? formatEventDate(revealDate) : ''}
          </div>
        </div>
      ) : null}

      {/* Toolbar: play, fullscreen, export, share. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPlaying((p) => !p)}
          disabled={dates.length < 2}
          aria-label={playing ? 'Pause season playback' : 'Play the season'}
        >
          <Icon icon={playing ? PauseIcon : PlayIcon} size="sm" />
          {playing ? 'Pause' : 'Play season'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFullscreen((f) => !f)}
          aria-label={fullscreen ? 'Exit full screen' : 'View full screen'}
        >
          <Icon icon={fullscreen ? ArrowShrinkIcon : ArrowExpandIcon} size="sm" />
          {fullscreen ? 'Exit' : 'Full screen'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void downloadPng()}
          disabled={rendering != null || !geo}
        >
          <Icon icon={Download01Icon} size="sm" />
          {rendering === 'image' ? 'Rendering…' : 'Image'}
        </Button>
        {canRecord ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadVideo()}
            disabled={rendering != null || dates.length < 2}
            title="Replay the whole season as a WebM video"
          >
            <Icon icon={Download01Icon} size="sm" />
            {rendering === 'video' ? 'Recording… (takes ~half a minute)' : 'Video'}
          </Button>
        ) : null}
        <div className="ml-auto">
          <ShareButton url={shareUrl} title={`${season} DCI Tour Map`} />
        </div>
      </div>

      {/* Venue card (all-corps mode): every event at the tapped coordinate. */}
      {!isFocusedMode && activeVenueData ? (
        <div className="rounded-lg border border-border px-3 py-2 text-sm">
          <div className="mb-1 text-xs text-text-muted">
            {activeVenueData.corpsCount.size} corps stop here (approximate location)
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...activeVenueData.events.entries()]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .slice(0, 8)
              .map(([eventId, date]) => {
                const ev = events[eventId];
                return ev ? (
                  <Link
                    key={eventId}
                    to="/events/$yearSlug/$slug/prediction"
                    params={{ yearSlug: season, slug: ev[0] }}
                    className="text-primary hover:underline"
                  >
                    {ev[1]}
                    <span className="ml-1 text-xs text-text-muted">{formatEventDate(date)}</span>
                  </Link>
                ) : null;
              })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
