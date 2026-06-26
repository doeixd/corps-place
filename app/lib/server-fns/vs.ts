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
} from '@sdk/src/readModel/builders/vs.js';
import { buildCorpsBySlug } from '@sdk/src/readModel/builders/corps.js';
import {
  readVsCorpsScores,
  readVsBaselines,
  readVsCorps2026Predicted,
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
    if (!pts.length) return null;
    const lines: VsLine[] = [
      {
        style: 'solid',
        points: pts.map((p) => ({
          pct: p.pct,
          value: p.total,
          date: p.date || undefined,
          eventLabel: p.eventLabel || undefined,
        })),
      },
    ];
    // Current season: overlay the model's predicted-to-finals line (dashed).
    // Predictions exist only for 2026 (M7).
    if (s.season === '2026') {
      const pred = await readOrBuild(
        (db) => readVsCorps2026Predicted(db, s.corpsSlug),
        (db) => buildVsCorps2026Predicted(db, s.corpsSlug)
      ).catch(() => []);
      if (pred.length) {
        lines.push({ style: 'dashed', points: pred.map((p) => ({ pct: p.pct, value: p.predicted })) });
      }
    }
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

  // kind: 'prediction' — 2026 snapshot resolver is M7 (live prediction path).
  return null;
}

/** Resolve a list of series (capped) to plottable data. */
export const resolveVsSeries = createServerFn({ method: 'GET' })
  .validator((data: { series: VsSeries[] }) => data)
  .handler(async ({ data }): Promise<{ series: VsResolvedSeries[] }> => {
    const wanted = (data.series ?? []).slice(0, VS_SERIES_CAP);
    const resolved = await Promise.all(wanted.map((s) => resolveOne(s).catch(() => null)));
    return { series: resolved.filter((r): r is VsResolvedSeries => r != null) };
  });
