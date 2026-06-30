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
    // As-of snapshot (relational-only, UI-dead): Total only — drop on a caption.
    if (caption !== 'total') return null;
    // Dynamic in asOf → relational (live) path only; degrades to empty where the
    // relational DB isn't on the host (the series then simply drops).
    const [pts, corps] = await Promise.all([
      buildVsPredictionSnapshot(getDb(), s.corpsSlug, s.asOf).catch(() => []),
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

/** The 2026 prediction snapshot dates for a corps (relational-only; empty where
 *  the relational DB isn't on the host). */
export const getVs2026SnapshotDates = createServerFn({ method: 'GET' })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<{ dates: string[] }> => {
    const dates = await buildVs2026SnapshotDates(getDb(), data.slug).catch(() => [] as string[]);
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
