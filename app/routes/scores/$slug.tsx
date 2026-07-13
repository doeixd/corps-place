import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import {
  getHybridEventBasic,
  getHybridEventFullRecap,
  getCorpsByKeys,
  getHybridAllEvents,
} from '@/lib/server-fns/hybrid';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { EventFullRecap, type RecapCorpsRef } from '@/components/scores/event-full-recap';
import { StatusCard } from '@/components/status-card';
import { ScoreNotifyButton } from '@/components/score-notify-button';
import { seoHead, breadcrumbLd, SITE_URL } from '@/lib/seo';
import { buildEventJsonLd } from '@/lib/event-jsonld';
import { formatEventDate } from '@/lib/format';

const yearOf = (slug: string) => slug.match(/^(\d{4})/)?.[1] ?? '';
const isYear = (slug: string) => /^\d{4}$/.test(slug);
const place = (city?: string | null, state?: string | null) =>
  [city, state].filter(Boolean).join(', ');

/**
 * `/scores/$slug` — the canonical, indexable results page for one scored event.
 * SSR: the heading + full recap render server-side, with a SportsEvent +
 * breadcrumb JSON-LD payload and a generated title/description for search. The
 * slug is the year-prefixed, globally-unique event slug.
 */
export const Route = createFileRoute('/scores/$slug')({
  loader: async ({ params }) => {
    const slug = params.slug;
    // A bare 4-digit slug (e.g. /scores/2025) is a SEASON archive page, not an
    // event — event slugs are year-prefixed but always have more (2025-dci-...).
    if (isYear(slug)) {
      const all = await getHybridAllEvents().catch(() => []);
      const events = all
        .filter((e) => e.season === slug && e.scores_released)
        .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));
      return { kind: 'season' as const, season: slug, events };
    }
    const event = await getHybridEventBasic({ data: slug }).catch(() => null);
    if (!event) throw notFound();
    const recap = await getHybridEventFullRecap({ data: slug }).catch(() => null);
    const keys = (recap?.corps ?? [])
      .map((c) => c.corpsKey)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
    const corps = keys.length
      ? ((await getCorpsByKeys({ data: keys }).catch(() => [])) as RecapCorpsRef[])
      : [];
    return { kind: 'event' as const, slug, event, recap, corps };
  },
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    // Season archive page (/scores/$year).
    if (d.kind === 'season') {
      const n = d.events.length;
      return seoHead({
        title: `${d.season} Drum Corps Scores & Results`,
        description:
          n > 0
            ? `Final scores and full recaps from all ${n} ${d.season} drum corps shows — placements and caption breakdowns by competition.`
            : `${d.season} drum corps scores will appear here as shows are scored.`,
        path: `/scores/${d.season}`,
        image: `${SITE_URL}/api/og/score/${d.season}`,
        noindex: n === 0,
        jsonLd: [
          breadcrumbLd([
            { name: 'Home', path: '/' },
            { name: 'Scores', path: '/scores' },
            { name: `${d.season} Scores`, path: `/scores/${d.season}` },
          ]),
          {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: `${d.season} Drum Corps Scores`,
            itemListElement: d.events.slice(0, 100).map((e, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: `${SITE_URL}/scores/${e.slug}`,
              name: `${e.event_name || e.name || e.slug} — Scores`,
            })),
          },
        ],
      });
    }
    const { slug, event, recap } = d;
    const year = yearOf(slug);
    const name = event.event_name || event.name || slug;
    const loc = place(event.location_city, event.location_state);
    const corpsList = recap?.corps ?? [];
    const winner = [...corpsList].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0]?.corps;
    const hasScores = corpsList.length > 0;

    // "Results" leads — it's what people actually search after a show
    // ("<event> results"); scores/recap keep the secondary intents.
    const title = `${name}${year ? ` ${year}` : ''} Results — Scores & Full Recap`;
    const description = hasScores
      ? `Final scores and the complete caption-by-caption recap from ${name}` +
        `${event.start_date ? ` on ${formatEventDate(event.start_date)}` : ''}${loc ? ` in ${loc}` : ''}.` +
        `${winner ? ` ${winner} placed first.` : ''}`
      : `Results for ${name} haven't been posted yet — scores and the full recap will appear here.`;

    const sportsEvent = hasScores
      ? buildEventJsonLd(event, {
          name: `${name}${year ? ` ${year}` : ''}`,
          description,
          url: `${SITE_URL}/scores/${slug}`,
          corps: [...corpsList]
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
            .map((c) => c.corps)
            .filter((n): n is string => Boolean(n)),
          image: `${SITE_URL}/api/og/score/${slug}`,
          scored: true,
        })
      : null;

    return seoHead({
      title,
      description,
      path: `/scores/${slug}`,
      image: `${SITE_URL}/api/og/score/${slug}`,
      noindex: !hasScores,
      jsonLd: [
        sportsEvent,
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Scores', path: '/scores' },
          { name, path: `/scores/${slug}` },
        ]),
      ],
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast.
  staleTime: 5 * 60_000,
  component: ScoresEventPage,
});

function ScoresEventPage() {
  const data = Route.useLoaderData();

  // Season archive view (/scores/$year): list every scored show that season.
  if (data.kind === 'season') {
    const { season, events } = data;
    return (
      <PageShell>
        <PageHeader
          title={`${season} Drum Corps Scores`}
          subtitle={`Final results & full recaps from the ${season} season`}
          backTo="/scores"
          backLabel="All seasons"
        />
        {events.length === 0 ? (
          <StatusCard
            tone="info"
            title="No scores yet"
            description={`${season} results will appear here as shows are scored.`}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {events.map((e) => (
              <Link
                key={e.slug}
                to="/scores/$slug"
                params={{ slug: e.slug }}
                className="group rounded-lg border border-border p-3 transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <p className="font-semibold leading-snug text-text-primary group-hover:text-primary">
                  {e.event_name || e.name || e.slug}
                </p>
                <p className="mt-1 text-xs uppercase tracking-wide text-text-muted">
                  {[formatEventDate(e.start_date), place(e.location_city, e.location_state)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </Link>
            ))}
          </div>
        )}
      </PageShell>
    );
  }

  const { slug, event, recap, corps } = data;
  const year = yearOf(slug);
  const name = event.event_name || event.name || slug;
  const loc = place(event.location_city, event.location_state);
  const hasScores = (recap?.corps?.length ?? 0) > 0;

  return (
    <PageShell>
      <PageHeader
        title={`${name}${year ? ` ${year}` : ''}`}
        subtitle={['Results, scores & full recap', formatEventDate(event.start_date), loc]
          .filter(Boolean)
          .join(' · ')}
        backTo="/scores"
        backLabel="All scores"
      />

      {hasScores && recap ? (
        <div className="space-y-4">
          <EventFullRecap recap={recap} corps={corps} yearSlug={year || undefined} />
          {year ? (
            <Link
              to="/events/$yearSlug/$slug/prediction"
              params={{ yearSlug: year, slug }}
              className="inline-block text-sm font-medium text-primary hover:underline"
            >
              View event details &amp; prediction →
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <StatusCard
            tone="info"
            title="Scores not posted yet"
            description="Results for this event haven't been published. Get notified the moment they land instead of checking back."
          />
          {/* Peak-intent placement: someone on a scoreless event page is exactly
              who wants a "scores are in" ping. Event-slug subscriptions are
              matched directly by notifyScoreSubscribers. */}
          <ScoreNotifyButton
            targetKind="event"
            targetSlug={slug}
            targetLabel={`${name}${year ? ` ${year}` : ''}`}
          />
        </div>
      )}
    </PageShell>
  );
}
