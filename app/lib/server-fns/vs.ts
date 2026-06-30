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
  buildVsPredictionSnapshot,
  buildVsCorpsSeasons,
  buildVsSeasonAvailability,
  buildVs2026SnapshotDates,
} from '@sdk/src/readModel/builders/vs.js';
import { buildCorpsBySlug } from '@sdk/src/readModel/builders/corps.js';
import {
  readVsCorpsScores,
  readVsBaselines,
  readVsCorpsSeasons,
  readVsCorpsSeasonAvailability,
  readCorpsBySlug,
} from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { VS_SERIES_CAP, type VsSeries, type VsResolvedSeries, type VsLine } from '@/lib/vs/types';

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

async function resolveOne(s: VsSeries): Promise<VsResolvedSeries | null> {
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
    const lines: VsLine[] = [];
    if (pts.length) {
      lines.push({
        style: 'solid',
        points: pts.map((p) => ({
          pct: p.pct,
          value: p.total,
          date: p.date || undefined,
          eventLabel: p.eventLabel || undefined,
        })),
      });
    }
    // A corps season plots ONLY its actual scored shows — for the current (2026)
    // season that's just the handful released so far (a short line segment), not
    // a predicted-to-finals overlay. The model's predicted curve is its own
    // series kind ('prediction'), added from the VS builder's Prediction column.
    if (!lines.length) return null; // no scored shows → nothing to plot
    return {
      id: `corps~${s.corpsSlug}~${s.season}`,
      label: `${corps?.name ?? s.corpsSlug} ${s.season}`,
      kind: 'corps',
      brand: { primary: corps?.color_primary ?? null, secondary: corps?.color_secondary ?? null },
      color: '',
      lines,
    };
  }

  if (s.kind === 'baseline') {
    const all = readModelEnabled()
      ? await readVsBaselines(getReadModelClient())
      : buildVsBaselineCurve();
    const rows = all.filter((b) => b.rank === s.rank).sort((a, b) => a.bucket - b.bucket);
    if (!rows.length) return null;
    return {
      id: `baseline~${s.rank}`,
      label: `${ordinal(s.rank)} place`,
      kind: 'baseline',
      brand: null,
      color: '',
      lines: [{ style: 'solid', points: rows.map((b) => ({ pct: b.bucket, value: b.total })) }],
    };
  }

  if (s.kind === 'prediction') {
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

/** Resolve a list of series (capped) to plottable data. */
export const resolveVsSeries = createServerFn({ method: 'GET' })
  .validator((data: { series: VsSeries[] }) => data)
  .handler(async ({ data }): Promise<{ series: VsResolvedSeries[] }> => {
    const wanted = (data.series ?? []).slice(0, VS_SERIES_CAP);
    const resolved = await Promise.all(wanted.map((s) => resolveOne(s).catch(() => null)));
    return { series: resolved.filter((r): r is VsResolvedSeries => r != null) };
  });
