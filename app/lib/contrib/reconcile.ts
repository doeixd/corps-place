import type { Client } from '@libsql/client';
import {
  readShowPageContributions,
  reconcileOverrideDivergence,
  type DivergenceSummary,
} from '@/lib/contrib/store';
import { scrapedSeedableHashes } from '@/lib/contrib/seedable';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';

/**
 * Re-checks a show page's per-row overrides against the latest scraped data and flips
 * their `scrape_diverged` flags. Server-only (libsql Client) — invoked by the reconcile
 * server-fn when a moderator asks "did the source change?". `scrapedSeedableHashes`
 * is the same pure hashing used at write time, so detection is symmetric.
 */
export interface ShowReconcileSummary extends DivergenceSummary {
  pageId: string | null;
  corpsKey: string;
  season: string;
  status: 'missing-page' | 'missing-scrape' | 'reconciled';
}

export const emptyReconcileSummary = (
  corpsKey: string,
  season: string,
  status: 'missing-page' | 'missing-scrape'
): ShowReconcileSummary => ({
  pageId: null,
  corpsKey,
  season,
  status,
  checked: 0,
  changed: 0,
  diverged: 0,
  cleared: 0,
});

export const reconcileShowDivergenceForDetail = async (
  db: Client,
  corpsKey: string,
  season: string,
  show: ShowDetail | null
): Promise<ShowReconcileSummary> => {
  if (!show) return emptyReconcileSummary(corpsKey, season, 'missing-scrape');
  const contributions = await readShowPageContributions(db, corpsKey, season);
  if (!contributions.page) return emptyReconcileSummary(corpsKey, season, 'missing-page');

  const summary = await reconcileOverrideDivergence(
    db,
    contributions.page.page_id,
    scrapedSeedableHashes(show)
  );
  return {
    ...summary,
    pageId: contributions.page.page_id,
    corpsKey,
    season,
    status: 'reconciled',
  };
};
