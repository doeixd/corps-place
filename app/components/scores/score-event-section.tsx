import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { getHybridEventFullRecap, getCorpsByKeys } from '@/lib/server-fns/hybrid';
import { EventFullRecap, type RecapCorpsRef } from '@/components/scores/event-full-recap';
import type { FullEventRecap } from '@/components/prediction/full-recap-table';

const yearOf = (slug: string) => slug.match(/^(\d{4})/)?.[1] ?? '';

/**
 * One event on the `/scores` index: a heading (linking to its own page) plus the
 * full recap, which is fetched + rendered only once the section nears the
 * viewport (IntersectionObserver), so a long list of wide recap tables stays
 * cheap. Shows a skeleton until then.
 */
export function ScoreEventSection({
  slug,
  name,
  date,
  place,
}: {
  slug: string;
  name: string;
  date: string | null;
  place: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  const [data, setData] = useState<{ recap: FullEventRecap | null; corps: RecapCorpsRef[] } | null>(
    null
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '500px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

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
      if (!cancelled) setData({ recap, corps });
    })();
    return () => {
      cancelled = true;
    };
  }, [inView, data, slug]);

  const year = yearOf(slug);
  const sub = [date, place].filter(Boolean).join(' · ');

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
        <EventFullRecap recap={data.recap} corps={data.corps} yearSlug={year || undefined} />
      ) : data ? (
        <p className="text-sm text-text-secondary">No recap available for this event.</p>
      ) : (
        <div
          className="h-40 animate-pulse rounded-xl border border-border bg-muted/30"
          aria-hidden
        />
      )}
    </section>
  );
}
