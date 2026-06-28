import { useMemo, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { getAllShowTitles, getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { SeasonChips } from '@/components/filter-chips';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { searchString } from '@/lib/utils';
import { seoHead, breadcrumbLd } from '@/lib/seo';

interface ShowItem {
  season: string;
  slug: string;
  corpsName: string;
  title: string;
}

/**
 * `/shows` — the program directory: every corps' show (title + season) across the
 * archive, filterable by season, each linking to its show-detail wiki page. Makes
 * the show wiki discoverable + crawlable (it was previously only reachable via
 * corps pages).
 */
export const Route = createFileRoute('/shows/')({
  validateSearch: (s: Record<string, unknown>) => ({ season: searchString(s.season) || undefined }),
  loader: async () => {
    const [titles, corps] = await Promise.all([getAllShowTitles(), getCorpsDirectory()]);
    const byKey = new Map(corps.map((c) => [c.corps_key, c]));
    const shows: ShowItem[] = [];
    for (const t of titles) {
      const c = byKey.get(t.corpsKey);
      if (c?.slug) shows.push({ season: t.season, slug: c.slug, corpsName: c.name, title: t.title });
    }
    return { shows };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: 'DCI Show Programs & Repertoire',
      description: `Browse ${loaderData?.shows.length ?? 0} drum corps show programs — titles, repertoire, designers and media by season on DrumCorps.app.`,
      path: '/shows',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Shows', path: '/shows' },
        ]),
      ],
    }),
  staleTime: 60_000,
  component: ShowsIndex,
});

function ShowsIndex() {
  const { shows } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [q, setQ] = useState('');

  const seasons = useMemo(
    () => [...new Set(shows.map((s) => s.season))].sort((a, b) => b.localeCompare(a)),
    [shows]
  );
  const season = search.season && seasons.includes(search.season) ? search.season : (seasons[0] ?? '');

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return shows
      .filter((s) => s.season === season)
      .filter(
        (s) =>
          !needle ||
          s.corpsName.toLowerCase().includes(needle) ||
          s.title.toLowerCase().includes(needle)
      )
      .sort((a, b) => a.corpsName.localeCompare(b.corpsName));
  }, [shows, season, q]);

  return (
    <PageShell>
      <PageHeader
        title="Shows"
        subtitle="DCI show programs — titles, repertoire & media"
        backTo="/"
        backLabel="Home"
      />

      <div className="mb-6 flex items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="text"
            placeholder="Search shows by corps or title…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <SeasonChips
        seasons={seasons}
        value={season}
        onSelect={(s) => navigate({ search: { season: s } })}
        wrap={false}
        className="mb-6"
      />

      <h2 className="mb-4 text-xl font-semibold">
        {visible.length} {visible.length === 1 ? 'show' : 'shows'}
      </h2>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
          No shows match — try another season or clear the search.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((s) => (
            <Link
              key={`${s.slug}-${s.season}`}
              to="/shows/$slug/$season"
              params={{ slug: s.slug, season: s.season }}
              className="group rounded-lg border border-border p-3 transition-colors hover:border-primary/50 hover:bg-muted/40"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {s.corpsName} · {s.season}
              </p>
              <p className="mt-1 font-semibold leading-snug text-text-primary group-hover:text-primary">
                {s.title}
              </p>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
