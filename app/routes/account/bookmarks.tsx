import { createFileRoute, Link } from '@tanstack/react-router';
import { AccountShell } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { ProductCard } from '@/components/merch/product-card';
import { useBookmarks } from '@/stores/bookmark-store';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/bookmarks')({
  head: () => buildSeo({ title: 'Your bookmarks',
      description: 'Merch you saved on this device.', path: '/account/bookmarks', noindex: true }),
  component: AccountBookmarks,
});

// Bookmarks are stored on this device (localStorage) — no sign-in required, no
// loader. The full-featured view (search/sort/filter) lives at /shop/bookmarks;
// this tab is the account-page window onto the same store.
function AccountBookmarks() {
  const bookmarks = useBookmarks();

  return (
    <AccountShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Bookmarked products</h2>
            <p className="text-xs text-text-muted">
              Saved on this device — they don&rsquo;t follow your account between devices yet.
            </p>
          </div>
          <Link to="/shop/bookmarks" className="shrink-0 text-sm text-primary hover:underline">
            Open full view
          </Link>
        </div>
        {bookmarks.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-text-secondary">
              Nothing saved yet — tap the heart on any{' '}
              <Link to="/shop" className="text-primary hover:underline">
                shop
              </Link>{' '}
              product to keep it here.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {bookmarks.slice(0, 24).map((item) => (
              <ProductCard key={item.productId} product={item} />
            ))}
          </div>
        )}
        {bookmarks.length > 24 ? (
          <p className="text-sm text-text-secondary">
            Showing 24 of {bookmarks.length} —{' '}
            <Link to="/shop/bookmarks" className="text-primary hover:underline">
              see all
            </Link>
            .
          </p>
        ) : null}
      </div>
    </AccountShell>
  );
}
