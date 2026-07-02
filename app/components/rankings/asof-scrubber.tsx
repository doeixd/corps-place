// /rankings as-of scrubber (plan M4). A horizontal-scroll row of competition-date
// pills (mobile swipe; desktop prev/next arrows) — picking one sets the as-of
// date so standings + the bump chart show "as of" that show. Mechanics mirror
// ShopSection (edges/scrollByPage/ResizeObserver).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icon';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

const fmtDate = (d: string) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const pill = (active: boolean) =>
  cn(
    'shrink-0 snap-start rounded-md border px-2.5 py-1 text-xs whitespace-nowrap transition-colors',
    active
      ? 'border-primary/60 bg-accent text-foreground'
      : 'border-border text-muted-foreground hover:text-foreground'
  );

export function AsofScrubber({
  dates,
  asof,
  onSelect,
}: {
  dates: string[];
  asof: string | null;
  onSelect: (date: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setEdges({ left: scrollLeft > 1, right: scrollLeft < scrollWidth - clientWidth - 1 });
  }, []);

  useEffect(() => {
    updateEdges();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, dates]);

  const scrollByPage = (dir: number) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  if (dates.length === 0) return null;
  const latest = dates[dates.length - 1];
  const onLatest = !asof || asof === latest;
  // Most recent first: reading order matches relevance (Latest pill, then
  // yesterday, then further back as you scroll right). The newest date itself is
  // dropped — it's the same state as the Latest pill (selecting it normalizes to
  // null), so showing it was a dead duplicate that never rendered active.
  const newestFirst = [...dates].reverse().filter((d) => d !== latest);

  const arrow = (dir: number, show: boolean) => (
    <button
      type="button"
      aria-label={dir < 0 ? 'Scroll dates left' : 'Scroll dates right'}
      onClick={() => scrollByPage(dir)}
      className={cn(
        'absolute top-1/2 z-10 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-text-secondary shadow-sm transition-opacity sm:flex',
        dir < 0 ? 'left-0' : 'right-0',
        show ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
    >
      <Icon icon={dir < 0 ? ArrowLeft01Icon : ArrowRight01Icon} size="sm" className="size-4" />
    </button>
  );

  return (
    <div className="relative">
      {arrow(-1, edges.left)}
      <div
        ref={ref}
        onScroll={updateEdges}
        // Left-aligned: no left padding — at scroll 0 the left arrow is hidden, so
        // nothing sits under it; pills only pass beneath it once scrolled.
        className="carousel-scrollbar flex snap-x gap-1.5 overflow-x-auto pb-1 sm:pr-8"
      >
        <button type="button" className={pill(onLatest)} onClick={() => onSelect(null)}>
          Latest
        </button>
        {newestFirst.map((d) => (
          <button
            key={d}
            type="button"
            className={pill(!onLatest && asof === d)}
            onClick={() => onSelect(d)}
          >
            {fmtDate(d)}
          </button>
        ))}
      </div>
      {arrow(1, edges.right)}
    </div>
  );
}
