import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { getHybridEventFullRecap, getCorpsByKeys } from '@/lib/server-fns/hybrid';
import { formatEventDate } from '@/lib/format';
import { fadeIn } from '@/lib/motion-variants';
import { EventFullRecap, type RecapCorpsRef } from '@/components/scores/event-full-recap';
import type { FullEventRecap } from '@/components/prediction/full-recap-table';

const yearOf = (slug: string) => slug.match(/^(\d{4})/)?.[1] ?? '';

type RecapData = { recap: FullEventRecap | null; corps: RecapCorpsRef[] };

// Session cache (client, per tab): a recap fetched once renders INSTANTLY when the
// section scrolls back into view or the list re-renders — no refetch, no blank
// flash. Public data, so a shared module map is safe. Never populated during SSR
// (the fetch lives in an effect), so there's no cross-request leak.
const recapCache = new Map<string, RecapData>();

// Rough recap-table geometry so the loading placeholder matches the real height
// and the lazy load doesn't shove the page down (the old fixed h-40 was way short
// for a 12+ corps table). Header block = class-filter toolbar + the multi-row
// caption/judge/subcaption thead; then one body row per scored corps.
const RECAP_HEADER_PX = 150;
const RECAP_ROW_PX = 44;
const estimateRecapHeight = (corpsCount: number) =>
  RECAP_HEADER_PX + Math.max(1, corpsCount) * RECAP_ROW_PX;

/**
 * One event on the `/scores` index: a heading (linking to its own page) plus the
 * full recap, fetched + rendered only once the section nears the viewport
 * (IntersectionObserver) so a long list of wide recap tables stays cheap. The
 * placeholder is sized to the expected recap height to minimise layout shift, and
 * a cached recap skips the fetch entirely and renders immediately.
 */
export function ScoreEventSection({
  slug,
  name,
  date,
  place,
  corpsCount = 0,
}: {
  slug: string;
  name: string;
  date: string | null;
  place: string | null;
  /** Expected scored-corps count (from the event's lineup_entries) — sizes the
   *  placeholder so the recap doesn't cause a big jump when it loads. */
  corpsCount?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  // Seed synchronously from the session cache so a revisit renders with zero blank.
  const [data, setData] = useState<RecapData | null>(() => recapCache.get(slug) ?? null);
  const [inView, setInView] = useState<boolean>(() => recapCache.has(slug));

  useEffect(() => {
    const el = ref.current;
    if (!el || inView || data) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '600px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, data]);

  useEffect(() => {
    if (!inView || data) return;
    let cancelled = false;
    void (async () => {
      const recap = await getHybridEventFullRecap({ data: slug }).catch(() => null);
      const keys = (recap?.corps ?? [])
        .map((c) => c.corpsKey)
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
      const corps = keys.length
        ? ((await getCorpsByKeys({ data: keys }).catch(() => [])) as RecapCorpsRef[])
        : [];
      const result: RecapData = { recap, corps };
      recapCache.set(slug, result);
      if (!cancelled) setData(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [inView, data, slug]);

  const year = yearOf(slug);
  const sub = [formatEventDate(date), place].filter(Boolean).join(' · ');

  return (
    <section ref={ref} className="space-y-3 scroll-mt-20">
      <div>
        <Link to="/scores/$slug" params={{ slug }} className="group inline-block">
          <h2 className="text-xl font-semibold transition-colors group-hover:text-primary">
            {name}
          </h2>
        </Link>
        {sub ? <p className="text-sm text-text-secondary">{sub}</p> : null}
      </div>
      {data?.recap && data.recap.corps.length > 0 ? (
        <motion.div variants={fadeIn} initial="hidden" animate="visible">
          <EventFullRecap recap={data.recap} corps={data.corps} yearSlug={year || undefined} />
        </motion.div>
      ) : data ? (
        <p className="text-sm text-text-secondary">No recap available for this event.</p>
      ) : (
        <div
          className="animate-pulse rounded-xl border border-border bg-muted/30"
          style={{ minHeight: estimateRecapHeight(corpsCount) }}
          aria-hidden
        />
      )}
    </section>
  );
}
