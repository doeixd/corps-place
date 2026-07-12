import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { listMyContributions } from '@/lib/server-fns/account';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/contributions')({
  validateSearch: (s: Record<string, unknown>): { page?: number } => {
    const n = Number(s.page);
    return Number.isFinite(n) && n > 1 ? { page: Math.floor(n) } : {};
  },
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: async ({ deps }) => {
    const [mine, corps] = await Promise.all([
      listMyContributions({ data: { offset: (deps.page - 1) * 50 } }),
      getCorpsDirectory(),
    ]);
    return { ...mine, corps, page: deps.page };
  },
  staleTime: 0,
  head: () =>
    buildSeo({
      title: 'Your contributions',
      description: 'Wiki edits you have made to show pages.',
      path: '/account/contributions',
      noindex: true,
    }),
  component: AccountContributions,
});

const OP_LABEL: Record<string, string> = {
  create: 'Created',
  edit: 'Edited',
  revert: 'Reverted',
  reorder: 'Reordered',
  add: 'Added',
  hide: 'Hid',
  restore: 'Restored',
};

function AccountContributions() {
  const { signedIn, total, contributions, corps, page } = Route.useLoaderData();

  const corpsByKey = useMemo(() => {
    const m = new Map<string, { name: string; slug: string | null }>();
    for (const c of corps as { corps_key?: string; name?: string; slug?: string | null }[]) {
      if (c.corps_key) m.set(c.corps_key, { name: c.name ?? c.corps_key, slug: c.slug ?? null });
    }
    return m;
  }, [corps]);

  if (!signedIn) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/contributions" />
      </AccountShell>
    );
  }

  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <AccountShell>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Wiki contributions</h2>
          <p className="text-sm text-text-secondary">
            {total === 0
              ? 'Edits you make to show pages will appear here.'
              : `${total} revision${total === 1 ? '' : 's'} across show pages.`}
          </p>
        </div>
        {contributions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-text-secondary">
              Nothing yet — visit any{' '}
              <Link
                to="/shows"
                search={{ season: undefined }}
                className="text-primary hover:underline"
              >
                show page
              </Link>{' '}
              and hit Edit to add repertoire, uniform notes and more.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {contributions.map((c) => {
              const corpsInfo = c.corpsKey ? corpsByKey.get(c.corpsKey) : undefined;
              const label = corpsInfo
                ? `${corpsInfo.name}${c.season ? ` ${c.season}` : ''}`
                : (c.season ?? 'Show page');
              return (
                <Card key={c.revisionId}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="outline" radius="full">
                          {OP_LABEL[c.op] ?? c.op}
                        </Badge>
                        {corpsInfo?.slug && c.season ? (
                          <Link
                            to="/shows/$slug/$season"
                            params={{ slug: corpsInfo.slug, season: c.season }}
                            className="truncate font-medium text-primary hover:underline"
                          >
                            {label}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">{label}</span>
                        )}
                        <span className="text-text-muted">{c.targetKind}</span>
                      </div>
                      {c.summary ? (
                        <div className="truncate text-sm text-text-secondary">{c.summary}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-xs text-text-muted">
                      {new Date(c.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
        {pages > 1 ? (
          <div className="flex items-center gap-2 text-sm">
            {page > 1 ? (
              <Link
                to="/account/contributions"
                search={page - 1 > 1 ? { page: page - 1 } : {}}
                className="text-primary hover:underline"
              >
                ← Newer
              </Link>
            ) : null}
            <span className="text-text-muted">
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Link
                to="/account/contributions"
                search={{ page: page + 1 }}
                className="text-primary hover:underline"
              >
                Older →
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </AccountShell>
  );
}
