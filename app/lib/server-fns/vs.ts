// VS Comparison Chart — series resolver RPC (plan M1). Turns the declarative
// VsSeries[] (from the URL) into plottable VsResolvedSeries[], reading the VS
// read-model shards in prod and falling back to the relational builders in dev.
// LEAK-SAFE: a createServerFn module — its server/SDK/node value-imports are
// stripped from the client bundle; the client only keeps the callable + types.
import { createServerFn } from '@tanstack/react-start';
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import {
  buildVsCorpsScores,
  buildVsBaselineCurve,
  buildVsCorps2026Predicted,
  buildVsPredictionSnapshot,
  buildVsCorpsSeasons,
  buildVsSeasonAvailability,
  buildVsActiveCorps,
  buildVs2026SnapshotDates,
} from '@sdk/src/readModel/builders/vs.js';
import { buildCorpsBySlug } from '@sdk/src/readModel/builders/corps.js';
import {
  readVsCorpsScores,
  readVsBaselines,
  readVsCorps2026Predicted,
  readVsCorpsSeasons,
  readVsCorpsSeasonAvailability,
  readVsActiveCorps,
  readCorpsBySlug,
  readVs2026SnapshotDates,
  readVsCorps2026PredictedAsOf,
} from '@sdk/src/readModel/readers.js';
import { parseCaption, type VsCaption } from '@/lib/vs/captions';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { VS_SERIES_CAP, type VsSeries, type VsResolvedSeries } from '@/lib/vs/types';
import type { VsCaptionValues } from '@sdk/src/readModel/builders/vs.js';

// Relational fallback client (dev / no read-model), lazily created server-side.
let sharedDb: Client | null = null;
const getDb = () =>
  (sharedDb ??= createClient({
    url:
      process.env.DCI_RELATIONAL_DB_URL ??
      `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`,
  }));

const readOrBuild = <A>(read: (db: Client) => Promise<A>, build: (db: Client) => Promise<A>) =>
  readModelEnabled() ? read(getReadModelClient()) : build(getDb());

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** Pull the active caption's value off a wide VS point; null if absent (older
 *  seasons / missing panels) → the point is dropped, never plotted as 0. */
const capVal = (p: VsCaptionValues, caption: VsCaption): number | null => {
  const v = p[caption];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

async function resolveOne(s: VsSeries, caption: VsCaption): Promise<VsResolvedSeries | null> {
  if (s.kind === 'corps') {
    const [pts, corps] = await Promise.all([
      readOrBuild(
        (db) => readVsCorpsScores(db, s.corpsSlug, s.season),
        (db) => buildVsCorpsScores(db, s.corpsSlug, s.season)
      ),
      readOrBuild(
        (db) => readCorpsBySlug(db, s.corpsSlug),
        (db) => buildCorpsBySlug(db, s.corpsSlug)
      ),
    ]);
    // A corps season plots ONLY its actual scored shows (a short segment for the
    // current season) — the model's curve is the separate 'predicted' kind.
    const points = pts.flatMap((p) => {
      const value = capVal(p, caption);
      return value == null
        ? []
        : [{ pct: p.pct, value, date: p.date || undefined, eventLabel: p.eventLabel || undefined }];
    });
    if (!points.length) return null; // no scored shows for this caption → nothing
    return {
      id: `corps~${s.corpsSlug}~${s.season}`,
      label: `${corps?.name ?? s.corpsSlug} ${s.season}`,
      kind: 'corps',
      brand: { primary: corps?.color_primary ?? null, secondary: corps?.color_secondary ?? null },
      color: '',
      lines: [{ style: 'solid', points }],
    };
  }

  if (s.kind === 'predicted') {
    // Read-model-backed predicted-to-finals curve for 2026 (works on prod).
    const [pred, corps] = await Promise.all([
      readOrBuild(
        (db) => readVsCorps2026Predicted(db, s.corpsSlug),
        (db) => buildVsCorps2026Predicted(db, s.corpsSlug)
      ).catch(() => []),
      readOrBuild(
        (db) => readCorpsBySlug(db, s.corpsSlug),
        (db) => buildCorpsBySlug(db, s.corpsSlug)
      ).catch(() => null),
    ]);
    // Uncertainty band only on Total (its margin is calibrated to the 0–100
    // scale); for a caption the dashed line shows without a band.
    const isTotal = caption === 'total';
    const points = pred.flatMap((p) => {
      const value = capVal(p, caption);
      if (value == null) return [];
      if (isTotal) {
        const margin = 1.5 + 2.5 * (1 - Math.min(Math.max(p.pct, 0), 100) / 100);
        return [
          {
            pct: p.pct,
            value,
            low: Number((value - margin).toFixed(2)),
            high: Number((value + margin).toFixed(2)),
          },
        ];
      }
      return [{ pct: p.pct, value }];
    });
    if (!points.length) return null;
    return {
      id: `predicted~${s.corpsSlug}`,
      label: `${corps?.name ?? s.corpsSlug} 2026 prediction`,
      kind: 'predicted',
      brand: { primary: corps?.color_primary ?? null, secondary: corps?.color_secondary ?? null },
      color: '',
      lines: [{ style: 'dashed', points }],
    };
  }

  if (s.kind === 'baseline') {
    const all = readModelEnabled()
      ? await readVsBaselines(getReadModelClient())
      : buildVsBaselineCurve();
    const rows = all.filter((b) => b.rank === s.rank).sort((a, b) => a.bucket - b.bucket);
    const points = rows.flatMap((b) => {
      const value = capVal(b, caption);
      return value == null ? [] : [{ pct: b.bucket, value }];
    });
    if (!points.length) return null;
    return {
      id: `baseline~${s.rank}`,
      label: `${ordinal(s.rank)} place`,
      kind: 'baseline',
      brand: null,
      color: '',
      lines: [{ style: 'solid', points }],
    };
  }

  if (s.kind === 'prediction') {
    // As-of snapshot: Total only — drop on a caption.
    if (caption !== 'total') return null;
    // Reads the corps prediction-snapshot matrix from the read-model in prod
    // (rm_corps_prediction_snapshots, x = %-through), falling back to the live
    // relational builder in dev. Previously relational-only → empty in prod.
    const [pts, corps] = await Promise.all([
      readOrBuild(
        (db) => readVsCorps2026PredictedAsOf(db, s.corpsSlug, s.asOf),
        (db) => buildVsPredictionSnapshot(db, s.corpsSlug, s.asOf)
      ).catch(() => []),
      readOrBuild(
        (db) => readCorpsBySlug(db, s.corpsSlug),
        (db) => buildCorpsBySlug(db, s.corpsSlug)
      ).catch(() => null),
    ]);
    if (!pts.length) return null;
    return {
      id: `pred~${s.corpsSlug}~${s.asOf}`,
      label: `${corps?.name ?? s.corpsSlug} · pred ${s.asOf}`,
      kind: 'prediction',
      brand: { primary: corps?.color_primary ?? null, secondary: corps?.color_secondary ?? null },
      color: '',
      lines: [
        {
          style: 'dashed',
          points: pts.map((p) => ({
            pct: p.pct,
            value: p.predicted,
            date: p.date || undefined,
            eventLabel: p.eventLabel || undefined,
          })),
        },
      ],
    };
  }

  return null;
}

/** The seasons a corps actually competed (for the builder's season chips). */
export const getVsCorpsSeasons = createServerFn({ method: 'GET' })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<{ seasons: string[] }> => {
    const seasons = await readOrBuild(
      (db) => readVsCorpsSeasons(db, data.slug),
      (db) => buildVsCorpsSeasons(db, data.slug)
    ).catch(() => [] as string[]);
    return { seasons };
  });

/** Which corps have plottable data per season → `{ [season]: slug[] }`. Lets the
 *  Corps-season picker grey out corps that didn't compete the selected season. */
export const getVsSeasonAvailability = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ bySeason: Record<string, string[]> }> => {
    const pairs = await readOrBuild(
      (db) => readVsCorpsSeasonAvailability(db),
      (db) => buildVsSeasonAvailability(db)
    ).catch(() => [] as Array<{ corps_slug: string; season: string }>);
    const bySeason: Record<string, string[]> = {};
    for (const { corps_slug, season } of pairs) {
      const list = bySeason[season];
      if (list) list.push(corps_slug);
      else bySeason[season] = [corps_slug];
    }
    return { bySeason };
  }
);

/** The 2026 prediction snapshot dates for a corps — from the read-model in prod
 *  (rm_corps_prediction_snapshots), the relational builder in dev. */
export const getVs2026SnapshotDates = createServerFn({ method: 'GET' })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<{ dates: string[] }> => {
    const dates = await readOrBuild(
      (db) => readVs2026SnapshotDates(db, data.slug),
      (db) => buildVs2026SnapshotDates(db, data.slug)
    ).catch(() => [] as string[]);
    return { dates };
  });

/** Resolve a list of series (capped) to plottable data at the given caption. */
export const resolveVsSeries = createServerFn({ method: 'GET' })
  .validator((data: { series: VsSeries[]; caption?: VsCaption }) => data)
  .handler(async ({ data }): Promise<{ series: VsResolvedSeries[] }> => {
    const caption = parseCaption(data.caption) ?? 'total';
    const wanted = (data.series ?? []).slice(0, VS_SERIES_CAP);
    const resolved = await Promise.all(wanted.map((s) => resolveOne(s, caption).catch(() => null)));
    return { series: resolved.filter((r): r is VsResolvedSeries => r != null) };
  });

/** The active 2026 field (roster) — corps with a predicted curve. Lets the corps
 *  pickers restrict to who's actually competing in 2026. */
export const getVsActiveCorps = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ slugs: string[] }> => {
    const slugs = await readOrBuild(
      (db) => readVsActiveCorps(db),
      (db) => buildVsActiveCorps(db)
    ).catch(() => [] as string[]);
    return { slugs };
  }
);

export interface VsCorpsComparison {
  corps: {
    slug: string;
    name: string;
    logo: { corps_logo?: string | null; corps_logo_dark?: number | null; corps_logo_dark_url?: string | null };
    colorPrimary: string | null;
  };
  series: VsResolvedSeries[];
  summary: {
    final2025: number | null;
    latest2026: number | null;
    latest2026Date: string | null;
    latest2026Event: string | null;
    projected2026: number | null;
    /** projected 2026 finals − 2025 finals (positive = improving). */
    delta: number | null;
  };
}

const lastPoint = (series: VsResolvedSeries[], id: string) => {
  const s = series.find((x) => x.id === id);
  const pts = s?.lines.flatMap((l) => l.points) ?? [];
  return pts.length ? pts[pts.length - 1] : null;
};

/** Everything a `/vs/<slug>` page needs: the seeded 2025 vs 2026 (+ predicted-to-
 *  finals) comparison and a numeric summary for the headings/SEO. Returns null
 *  unless the corps is in the 2026 field AND has 2025 scores (the page requires
 *  both seasons). */
export const getVsCorpsComparison = createServerFn({ method: 'GET' })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<VsCorpsComparison | null> => {
    const slug = data.slug.trim().toLowerCase();
    const [roster, corps] = await Promise.all([
      readOrBuild((db) => readVsActiveCorps(db), (db) => buildVsActiveCorps(db)).catch(
        () => [] as string[]
      ),
      readOrBuild((db) => readCorpsBySlug(db, slug), (db) => buildCorpsBySlug(db, slug)).catch(
        () => null
      ),
    ]);
    if (!corps || !roster.includes(slug)) return null;

    const seed: VsSeries[] = [
      { kind: 'corps', corpsSlug: slug, season: '2025' },
      { kind: 'corps', corpsSlug: slug, season: '2026' },
      { kind: 'predicted', corpsSlug: slug },
    ];
    const series = (await Promise.all(seed.map((s) => resolveOne(s, 'total').catch(() => null)))).filter(
      (r): r is VsResolvedSeries => r != null
    );
    // Requires a real 2025 line — otherwise it's not a 2026-vs-2025 page.
    if (!series.some((s) => s.id === `corps~${slug}~2025`)) return null;

    const p2025 = lastPoint(series, `corps~${slug}~2025`);
    const p2026 = lastPoint(series, `corps~${slug}~2026`);
    const pPred = lastPoint(series, `predicted~${slug}`);
    const final2025 = p2025?.value ?? null;
    const projected2026 = pPred?.value ?? null;

    return {
      corps: {
        slug,
        name: corps.name ?? slug,
        logo: {
          corps_logo: corps.corps_logo,
          corps_logo_dark: corps.corps_logo_dark,
          corps_logo_dark_url: corps.corps_logo_dark_url,
        },
        colorPrimary: corps.color_primary ?? null,
      },
      series,
      summary: {
        final2025,
        latest2026: p2026?.value ?? null,
        latest2026Date: p2026?.date ?? null,
        latest2026Event: p2026?.eventLabel ?? null,
        projected2026,
        delta:
          final2025 != null && projected2026 != null
            ? Number((projected2026 - final2025).toFixed(3))
            : null,
      },
    };
  });
