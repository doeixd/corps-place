import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StatusCard } from '@/components/status-card';
import { ProductCard } from '@/components/merch/product-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GroupMultiSelect } from '@/components/merch/group-multi-select';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { bookmarkStore, useBookmarks, type BookmarkItem } from '@/stores/bookmark-store';
import { buildSeo } from '@/lib/seo';

type BookmarkSort = 'last-added' | 'name' | 'group';

const SORTS: { value: BookmarkSort; label: string }[] = [
  { value: 'last-added', label: 'Last added' },
  { value: 'name', label: 'Name' },
  { value: 'group', label: 'Drum corps' },
];

export const Route = createFileRoute('/shop/bookmarks')({
  head: () =>
    buildSeo({
      title: 'Your Bookmarks — Shop',
      description: 'Drum corps merch you’ve saved.',
      noindex: true,
    }),
  component: BookmarksPage,
});

const byName = (a: BookmarkItem, b: BookmarkItem) => a.title.localeCompare(b.title);
const byGroup = (a: BookmarkItem, b: BookmarkItem) =>
  a.storeName.localeCompare(b.storeName) || byName(a, b);

function BookmarksPage() {
  const bookmarks = useBookmarks();
  const [search, setSearch] = useState('');
  const [stores, setStores] = useState<string[]>([]);
  const [sort, setSort] = useState<BookmarkSort>('last-added');

  const storeOptions = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const item of bookmarks) {
      const cur = counts.get(item.storeId);
      if (cur) cur.count += 1;
      else counts.set(item.storeId, { name: item.storeName, count: 1 });
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
      .map(([id, v]) => ({ value: id, label: `${v.name} (${v.count})` }));
  }, [bookmarks]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const storeSet = new Set(stores);
    const filtered = bookmarks.filter((item) => {
      const matchesStore = storeSet.size === 0 || storeSet.has(item.storeId);
      const matchesSearch =
        q.length === 0 ||
        item.title.toLowerCase().includes(q) ||
        item.storeName.toLowerCase().includes(q);
      return matchesStore && matchesSearch;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return byName(a, b);
      if (sort === 'group') return byGroup(a, b);
      return Date.parse(b.addedAt) - Date.parse(a.addedAt);
    });
  }, [bookmarks, search, sort, stores]);

  // Defer the empty-state card until the cards have finished animating out, so it
  // doesn't overlap the still-exiting cards (popLayout pulls them out of flow).
  const visibleCount = visible.length;
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  const [showEmpty, setShowEmpty] = useState(visibleCount === 0);
  useEffect(() => {
    if (visibleCount > 0) setShowEmpty(false);
  }, [visibleCount]);

  return (
    <PageShell>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Icon icon={FavouriteIcon} size="md" className="text-primary" />
            Bookmarks
          </span>
        }
        subtitle={`${bookmarks.length} saved product${bookmarks.length === 1 ? '' : 's'}`}
        backTo="/shop"
        backLabel="Shop"
        actions={
          <Link
            to="/shop/all"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            All products
          </Link>
        }
      />

      {/* Controls hide once the list is empty. */}
      {bookmarks.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-80">
            <Icon
              icon={Search01Icon}
              size="sm"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <Input
              type="search"
              placeholder="Search bookmarks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <GroupMultiSelect
            options={storeOptions}
            selected={stores}
            onChange={setStores}
            ariaLabel="Filter bookmarks by group"
          />
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            {SORTS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSort(s.value)}
                className={
                  sort === s.value
                    ? 'rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground'
                    : 'rounded-md px-3 py-1.5 text-sm text-text-secondary hover:text-foreground'
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => bookmarkStore.trigger.clear()}
          >
            Clear bookmarks
          </Button>
        </div>
      ) : null}

      {bookmarks.length > 0 && visible.length > 0 ? (
        <div className="mb-3 inline-flex items-center gap-1.5 text-sm text-text-secondary">
          <Icon icon={FavouriteIcon} size="sm" className="text-primary" />
          {visible.length} shown
        </div>
      ) : null}

      {/* Always-mounted so cards can animate out on unbookmark / clear all. The
          grid container is a plain div (matching StaggeredGrid): only the cards
          carry `layout`. Putting `layout` on the container projects a transform
          onto the whole grid, which clips the leftmost card's outset ring. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <AnimatePresence
          mode="popLayout"
          initial={false}
          onExitComplete={() => {
            if (visibleCountRef.current === 0) setShowEmpty(true);
          }}
        >
          {visible.map((product) => (
            <motion.div
              key={product.productId}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{
                duration: 0.2,
                ease: 'easeOut',
                layout: { duration: 0.25, ease: 'easeOut' },
              }}
            >
              <ProductCard product={product} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {showEmpty && visibleCount === 0 ? (
        bookmarks.length === 0 ? (
          <StatusCard
            tone="empty"
            title="No bookmarks yet"
            description="Use the heart button on product cards to save merch here."
          />
        ) : (
          <StatusCard
            tone="empty"
            title="No matching bookmarks"
            description="Try another search term or group filter."
          />
        )
      ) : null}
    </PageShell>
  );
}
