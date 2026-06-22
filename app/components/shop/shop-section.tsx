import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icon';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

/**
 * A landing-page section that lays its cards out in a horizontally-scrollable row
 * by default, and expands to a wrapped 2D grid on demand. Generic over the item
 * type — pass the data + a card renderer; the section owns the layout + toggle.
 *
 * In the scrollable state it overlays prev/next arrow buttons (matching the merch
 * product-gallery carousel) that fade in/out based on how far the row is scrolled:
 * the left arrow hides at the start, the right arrow hides at the end, and both
 * stay hidden when everything already fits without scrolling.
 */
export function ShopSection<T>({
  title,
  count,
  items,
  getKey,
  renderCard,
}: {
  title: string;
  count?: number;
  items: readonly T[];
  getKey: (item: T) => string;
  renderCard: (item: T) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether the row can still scroll further left / right (drives arrow visibility).
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setEdges({
      left: scrollLeft > 1,
      right: scrollLeft < scrollWidth - clientWidth - 1,
    });
  }, []);

  // Recompute edges when collapsed, when items change, and on resize. The grid
  // (expanded) state doesn't scroll, so we skip the observer there.
  useEffect(() => {
    if (expanded) return;
    updateEdges();
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, items.length, updateEdges]);

  const scrollByPage = (dir: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {title}
          {count != null ? (
            <span className="ml-2 text-sm font-normal text-text-secondary">{count}</span>
          ) : null}
        </h2>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 text-sm text-primary hover:underline"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      </div>

      {expanded ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item) => (
            <div key={getKey(item)}>{renderCard(item)}</div>
          ))}
        </div>
      ) : (
        <div className="relative">
          <div
            ref={scrollerRef}
            onScroll={updateEdges}
            className="carousel-scrollbar flex snap-x gap-3 overflow-x-auto pt-1 pb-2"
          >
            {items.map((item) => (
              <div key={getKey(item)} className="w-36 shrink-0 snap-start sm:w-40">
                {renderCard(item)}
              </div>
            ))}
          </div>

          {/* Arrow buttons match the product-gallery carousel. Touch users swipe,
              so they only show on hover-capable pointers (sm+). The scrollbar sits
              at the bottom, so the cards' vertical center is a few px above the
              container's; nudge the buttons up to sit on the cards. */}
          <button
            type="button"
            aria-label="Scroll left"
            onClick={() => scrollByPage(-1)}
            className={cn(
              'absolute left-1 top-[calc(50%-6px)] z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow transition-opacity hover:bg-background sm:flex',
              edges.left ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            <Icon icon={ArrowLeft01Icon} size="md" className="size-[1.125rem]" />
          </button>
          <button
            type="button"
            aria-label="Scroll right"
            onClick={() => scrollByPage(1)}
            className={cn(
              'absolute right-1 top-[calc(50%-6px)] z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow transition-opacity hover:bg-background sm:flex',
              edges.right ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
          >
            <Icon icon={ArrowRight01Icon} size="md" className="size-[1.125rem]" />
          </button>
        </div>
      )}
    </section>
  );
}
