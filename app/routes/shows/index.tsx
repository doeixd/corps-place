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
import { seoHead, breadcrumbLd, SITE_URL } from '@/lib/seo';

interface ShowItem {
  season: string;
  slug: string;
  corpsName: string;
  title: string;
}

/**
 * `/shows` â the program directory: every corps' show (title + season) across the
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
      title: 'Drum Corps Show Programs & Repertoire by Season',
      description: `Browse ${loaderData?.shows.length ?? 0} drum corps show programs â titles, repertoire, designers and media by season on DrumCorps.app.`,
      path: '/shows',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Shows', path: '/shows' },
        ]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: (loaderData?.shows ?? []).slice(0, 100).map((s, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${SITE_URL}/shows/${s.slug}/${s.season}`,
            name: `${s.corpsName} ${s.season} â ${s.title}`,
          })),
        },
      ],
    }),
  // Static read-model data (per-emit; client hard-reloads on deploy) — keep it
  // fresh for the session so repeat navs render instantly from the router cache.
  staleTime: Infinity,
  gcTime: Infinity,
  component: ShowsIndex,
});

function ShowsIndex() {
  const { shows } = Route.useLoaderData();
  const [q, setQ] = useState('');

  const seasons = useMemo(
    () => [...new Set(shows.map((s) => s.season))].sort((a, b) => b.localeCompare(a)),
    [shows]
  );
  const [active, setActive] = useState(seasons[0] ?? '');

  // Group ALL shows by season so every show is a server-rendered, crawlable link
  // (not just the selected season). The search box filters across all seasons.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return seasons
      .map((sea) => ({
        season: sea,
        items: shows
          .filter((s) => s.season === sea)
          .filter(
            (s) =>
              !needle ||
              s.corpsName.toLowerCase().includes(needle) ||
              s.title.toLowerCase().includes(needle)
          )
          .sort((a, b) => a.corpsName.localeCompare(b.corpsName)),
      }))
      .filter((g) => g.items.length > 0);
  }, [shows, seasons, q]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  const jump = (s: string) => {
    setActive(s);
    if (typeof document !== 'undefined')
      document.getElementById(`season-${s}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <PageShell>
      <PageHeader
        title="Drum Corps Shows & Programs"
        subtitle="Every drum corps show by season â titles, repertoire & media"
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
            placeholder="Search shows by corps or titleâ¦"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Season chips jump to each season's section (all seasons are rendered). */}
      <SeasonChips seasons={seasons} value={active} onSelect={jump} wrap={false} className="mb-6" />

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
          No shows match â try another search.
        </p>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.season} id={`season-${g.season}`} className="scroll-mt-20">
              <h2 className="mb-3 text-xl font-semibold text-text-primary">
                {g.season}{' '}
                <span className="text-sm font-normal text-text-secondary">
                  Â· {g.items.length} {g.items.length === 1 ? 'show' : 'shows'}
                </span>
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {g.items.map((s) => (
                  <Link
                    key={`${s.slug}-${s.season}`}
                    to="/shows/$slug/$season"
                    params={{ slug: s.slug, season: s.season }}
                    className="group rounded-lg border border-border p-3 transition-colors hover:border-primary/50 hover:bg-muted/40"
                  >
                    <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                      {s.corpsName} Â· {s.season}
                    </p>
                    <p className="mt-1 font-semibold leading-snug text-text-primary group-hover:text-primary">
                      {s.title}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
