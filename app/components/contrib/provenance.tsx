/**
 * Shared provenance + divergence badges for seedable rows (plan §17.2 / §12).
 *
 * Every merged seedable row carries `source` + `sourceAuthority` and a per-row
 * `scrapeDiverged` flag (set by the nightly reconciler). These small badges
 * surface that provenance so a reader can tell a yearbook-sourced fact from a
 * generic scrape, and so a divergence banner names the authority it diverged
 * from. On master the scraped rows carry no provenance yet, so `SourceBadge`
 * degrades to "Scraped"/"Fan added".
 */

const YEARBOOK_AUTHORITY = 100;

export interface RowProvenance {
  source: string | null;
  sourceAuthority: number | null;
  added?: boolean;
}

const isYearbook = (p: RowProvenance): boolean =>
  p.sourceAuthority === YEARBOOK_AUTHORITY || p.source === 'dci-yearbook';

/** Where this row's scraped value came from (or "Fan added" / "Scraped"). */
export function SourceBadge({ source, sourceAuthority, added }: RowProvenance) {
  if (isYearbook({ source, sourceAuthority })) {
    return <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">DCI Yearbook</span>;
  }
  if (source) return <span className="rounded bg-foreground/5 px-1.5 py-0.5">{source}</span>;
  if (added) return <span className="rounded bg-foreground/5 px-1.5 py-0.5">Fan added</span>;
  return <span className="rounded bg-foreground/5 px-1.5 py-0.5">Scraped</span>;
}

/**
 * Shown when a human-overridden row's scraped source has since changed. The text
 * is authority-aware: a yearbook divergence names the canon so disagreeing with
 * it is visible, a generic scrape just flags the change.
 */
export function DivergenceBadge({
  source,
  sourceAuthority,
  season,
}: RowProvenance & { season: string }) {
  const yearbook = isYearbook({ source, sourceAuthority });
  const label = yearbook ? `Differs from the ${season} DCI Yearbook` : 'Source changed';
  return (
    <span
      className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700"
      title={
        yearbook
          ? `A human edit overrode this row; the official ${season} DCI Yearbook value has since changed.`
          : 'A human edit overrode this row; the scraped source has since changed.'
      }
    >
      {label}
    </span>
  );
}
