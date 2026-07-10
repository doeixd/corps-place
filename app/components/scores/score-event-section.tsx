import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { formatEventDate } from '@/lib/format';
import { fadeIn } from '@/lib/motion-variants';
import { EventFullRecap, type RecapCorpsRef } from '@/components/scores/event-full-recap';
import type { FullEventRecap } from '@/components/prediction/full-recap-table';

const yearOf = (slug: string) => slug.match(/^(\d{4})/)?.[1] ?? '';

// Quick global switch for the `/scores` list animations (skeleton pulse + recap
// fade-in + recap row layout animation). Off for now to kill the layout shift;
// flip back to `true` to re-enable. Typed `boolean` (not the `false` literal) so
// the gated branches type-check either way.
const SCORES_ANIMATIONS: boolean = false;

export type ScoreRecapData = { recap: FullEventRecap | null; corps: RecapCorpsRef[] };
type RecapData = ScoreRecapData;

// In-memory session cache of fetched recaps, keyed by event slug. The service
// worker already caches the `/read-model/recaps/` responses (SWR), but that
// fetch is still async — so on a remount (scroll away/back, client nav back to
// /scores) `data` would start null and flash the placeholder. This synchronous
// cache means a placeholder never reappears for data we already have this session.
const recapCache = new Map<string, RecapData>();

// Rough recap-table geometry so the loading placeholder matches the real height
// and the lazy load doesn't shove the page down. Header block = class-filter
// toolbar + the multi-row caption/judge/subcaption thead; then one body row per
// scored corps.
const RECAP_HEADER_PX = 150;
const RECAP_ROW_PX = 44;
const estimateRecapHeight = (corpsCount: number) =>
  RECAP_HEADER_PX + Math.max(1, corpsCount) * RECAP_ROW_PX;

/**
 * One event on the `/scores` index: a heading (linking to its own page) plus the
 * full recap, fetched only once the section nears the viewport
 * (IntersectionObserver). The recap comes from the cacheable `/read-model/recaps/`
 * route, so the service worker serves it instantly on revisit (StaleWhileRevalidate)
 * while staying fresh. The placeholder is sized to the expected recap height to
 * minimise layout shift.
 */
export function ScoreEventSection({
  slug,
  name,
  date,
  place,
  corpsCount = 0,
  initial = null,
}: {
  slug: string;
  name: string;
  date: string | null;
  place: string | null;
  /** Expected scored-corps count (from the event's lineup_entries) — sizes the
   *  placeholder so the recap doesn't cause a big jump when it loads. */
  corpsCount?: number;
  /** SSR-inlined recap (the /scores loader ships the first couple so the top of
   *  the page shows real tables at first paint instead of skeletons-until-
   *  hydration). Renders on the server too — no observer, no fetch. */
  initial?: RecapData | null;
}) {
  const ref = useRef<HTMLElement>(null);
  // Seed from the session cache or the SSR-inlined payload: render immediately
  // (no observer, no placeholder). Lazy initializers so the lookup runs once at
  // mount, not on every render.
  // recapCache is browser-only: on the server the module is a cross-request
  // singleton, and caching there would pin stale recaps into SSR HTML.
  const inBrowser = typeof document !== 'undefined';
  const [inView, setInView] = useState(() => (inBrowser && recapCache.has(slug)) || !!initial);
  const [data, setData] = useState<RecapData | null>(() => {
    const seeded = (inBrowser ? recapCache.get(slug) : null) ?? initial ?? null;
    if (seeded && inBrowser && !recapCache.has(slug)) recapCache.set(slug, seeded);
    return seeded;
  });

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
      // The service worker caches this /read-model/ response (SWR), so a recap
      // loaded once is instant next time yet still revalidates to fresh data.
      const res = await fetch(`/read-model/recaps/${encodeURIComponent(slug)}`).catch(() => null);
      const json =
        res && res.ok ? ((await res.json().catch(() => null)) as RecapData | null) : null;
      const next: RecapData = json ?? { recap: null, corps: [] };
      recapCache.set(slug, next);
      if (!cancelled) setData(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [inView, data, slug]);

  const year = yearOf(slug);
  const sub = [formatEventDate(date), place].filter(Boolean).join(' · ');

  return (
    // content-visibility: skip style/layout/paint for sections far off-screen —
    // /scores renders up to ~100 of these and the recalc/layout cost of the
    // off-screen recap tables dominated the trace. Same proven coarse-section
    // pattern as shows/$slug (NOT the per-card variant that clipped borders and
    // was reverted twice — see app.css .collection-card note). The intrinsic-size
    // estimate mirrors the loading placeholder so scrollbar geometry is stable;
    // IntersectionObserver (data fetch) still fires normally for cv:auto content.
    <section
      ref={ref}
      className="space-y-3 scroll-mt-20 [content-visibility:auto]"
      style={{ containIntrinsicSize: `auto ${estimateRecapHeight(corpsCount) + 70}px` }}
    >
      <div>
        <Link to="/scores/$slug" params={{ slug }} className="group inline-block">
          <h2 className="text-xl font-semibold transition-colors group-hover:text-primary">
            {name}
          </h2>
        </Link>
        {sub ? <p className="text-sm text-text-secondary">{sub}</p> : null}
      </div>
      {data?.recap && data.recap.corps.length > 0 ? (
        // Fade-in + row layout animation re-enable together via SCORES_ANIMATIONS.
        SCORES_ANIMATIONS ? (
          <motion.div variants={fadeIn} initial="hidden" animate="visible">
            <EventFullRecap recap={data.recap} corps={data.corps} yearSlug={year || undefined} />
          </motion.div>
        ) : (
          <EventFullRecap
            recap={data.recap}
            corps={data.corps}
            yearSlug={year || undefined}
            animateRows={false}
          />
        )
      ) : data ? (
        <p className="text-sm text-text-secondary">No recap available for this event.</p>
      ) : (
        <div
          className={cn(
            'rounded-xl border border-border bg-muted/30',
            SCORES_ANIMATIONS && 'animate-pulse'
          )}
          style={{ minHeight: estimateRecapHeight(corpsCount) }}
          aria-hidden
        />
      )}
    </section>
  );
}
