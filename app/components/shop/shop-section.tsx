import { useState } from 'react';

/**
 * A landing-page section that lays its cards out in a horizontally-scrollable row
 * by default, and expands to a wrapped 2D grid on demand. Generic over the item
 * type — pass the data + a card renderer; the section owns the layout + toggle.
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

      <div
        className={
          expanded
            ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
            : 'carousel-scrollbar flex snap-x gap-3 overflow-x-auto pt-1 pb-2'
        }
      >
        {items.map((item) => (
          <div key={getKey(item)} className={expanded ? '' : 'w-36 shrink-0 snap-start sm:w-40'}>
            {renderCard(item)}
          </div>
        ))}
      </div>
    </section>
  );
}
