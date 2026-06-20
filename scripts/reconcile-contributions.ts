#!/usr/bin/env npx tsx
/**
 * Nightly contributions reconciler (Show Detail Wiki, plan §9 / M7).
 *
 * Runs after each read-model emit. Read-only against contributions except the
 * soft-pointer / divergence columns:
 *   1. Re-resolve show_pages.show_id from the stable (corps_key, season); mark
 *      status='orphaned' when the scrape no longer exists (never delete, §12).
 *   2. Log LOUDLY if any (corps_key, season) maps to >1 scraped show (the M-1
 *      one-show-per-corps-per-season invariant guard).
 *   3. For each page, recompute per-row source hashes and set scrape_diverged on
 *      overridden rows whose scraped value has since changed (precise, per row).
 *
 * Idempotent; safe to re-run. Emits a short report like the other runbooks.
 *
 *   npx tsx scripts/reconcile-contributions.ts [--apply] [--limit N]
 *
 * Default is a dry run (no writes). Pass --apply to persist orphan/divergence
 * changes. Reads the scraped half the same way the app does (hybrid): from the
 * emitted read-model when READ_MODEL_DB_URL is set (production, after emit), else
 * the relational DB via the shared builder (dev fallback).
 */
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { getContributionsDb } from '@/lib/contributions-db';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { listShowPages, type PageRow } from '@/lib/contrib/store';
import { reconcileShowDivergenceForDetail } from '@/lib/contrib/reconcile';
import { buildShowDetail, type ShowDetail } from '@sdk/src/readModel/builders/shows.js';
import { readShowDetail } from '@sdk/src/readModel/readers.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 100_000;

const log = (...args: unknown[]) => console.log('[reconcile]', ...args);

const relationalClient = () => {
  const sdkDir = path.resolve(process.cwd(), 'sdk');
  const url =
    process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir, 'dci-relational.db')}`;
  return createClient({ url });
};

/** (corps_key, season) pairs that map to more than one scraped show (M-1 guard). */
const findScrapedCollisions = async (
  big: Client
): Promise<{ corps_key: string; season: string; n: number }[]> => {
  const res = await big.execute(
    `SELECT corps_key, season, COUNT(*) AS n
       FROM corps_shows
      GROUP BY corps_key, season
     HAVING COUNT(*) > 1
      ORDER BY n DESC`
  );
  return res.rows as unknown as { corps_key: string; season: string; n: number }[];
};

const markOrphaned = async (
  db: Awaited<ReturnType<typeof getContributionsDb>>,
  page: PageRow,
  now: string
) => {
  if (!APPLY) return;
  await db.execute({
    sql: "UPDATE show_pages SET status = 'orphaned', updated_at = ? WHERE page_id = ?",
    args: [now, page.page_id],
  });
};

const resolveShowId = async (
  db: Awaited<ReturnType<typeof getContributionsDb>>,
  page: PageRow,
  showId: string,
  now: string
) => {
  if (!APPLY || page.show_id === showId) return;
  await db.execute({
    sql: 'UPDATE show_pages SET show_id = ?, status = ?, updated_at = ? WHERE page_id = ?',
    args: [showId, 'active', now, page.page_id],
  });
};

const main = async () => {
  const now = new Date().toISOString();
  const db = await getContributionsDb();

  // Match the app's hybrid read: read-model in production, relational in dev.
  const useReadModel = readModelEnabled();
  const big = useReadModel ? null : relationalClient();
  const fetchShow = (corpsKey: string, season: string): Promise<ShowDetail | null> =>
    useReadModel
      ? readShowDetail(getReadModelClient(), corpsKey, season)
      : buildShowDetail(big!, corpsKey, season);
  log(`scraped source: ${useReadModel ? 'read-model' : 'relational DB'}`);

  // The (corps_key, season) collision guard needs the relational table; the
  // read-model is already keyed uniquely, so it can't represent a collision.
  if (big) {
    const collisions = await findScrapedCollisions(big);
    if (collisions.length > 0) {
      log('⚠️  M-1 INVARIANT BREACH — (corps_key, season) maps to >1 scraped show:');
      for (const c of collisions) log(`   ${c.corps_key} ${c.season} → ${c.n} shows`);
      process.exitCode = 2; // loud, non-fatal signal for the runbook
    }
  }

  const pages = await listShowPages(db, LIMIT);
  log(`${pages.length} contribution page(s)${APPLY ? '' : ' (dry run — no writes)'}`);

  const report = {
    pages: pages.length,
    orphaned: 0,
    reconciled: 0,
    rowsDiverged: 0,
    rowsCleared: 0,
  };

  for (const page of pages) {
    const show = await fetchShow(page.corps_key, page.season);
    if (!show) {
      report.orphaned += 1;
      log(`orphaned: ${page.corps_key} ${page.season} (no scraped show)`);
      await markOrphaned(db, page, now);
      continue;
    }
    await resolveShowId(db, page, show.showId, now);

    if (APPLY) {
      const summary = await reconcileShowDivergenceForDetail(db, page.corps_key, page.season, show);
      if (summary.status === 'reconciled') {
        report.reconciled += 1;
        report.rowsDiverged += summary.diverged;
        report.rowsCleared += summary.cleared;
        if (summary.changed > 0)
          log(
            `reconciled ${page.corps_key} ${page.season}: ${summary.diverged} diverged, ${summary.cleared} cleared`
          );
      }
    } else {
      report.reconciled += 1;
    }
  }

  log('done', JSON.stringify(report));
};

main().catch((e) => {
  console.error('[reconcile] failed:', e);
  process.exit(1);
});
