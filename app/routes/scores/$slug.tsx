import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import {
  getHybridEventBasic,
  getHybridEventFullRecap,
  getCorpsByKeys,
} from '@/lib/server-fns/hybrid';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { EventFullRecap, type RecapCorpsRef } from '@/components/scores/event-full-recap';
import { StatusCard } from '@/components/status-card';
import { seoHead, breadcrumbLd, SITE_URL } from '@/lib/seo';
import { formatEventDate } from '@/lib/format';

const yearOf = (slug: string) => slug.match(/^(\d{4})/)?.[1] ?? '';
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
    const event = await getHybridEventBasic({ data: slug }).catch(() => null);
    if (!event) throw notFound();
    const recap = await getHybridEventFullRecap({ data: slug }).catch(() => null);
    const keys = (recap?.corps ?? [])
      .map((c) => c.corpsKey)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
    const corps = keys.length
      ? ((await getCorpsByKeys({ data: keys }).catch(() => [])) as RecapCorpsRef[])
      : [];
    return { slug, event, recap, corps };
  },
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d?.event) return {};
    const { slug, event, recap } = d;
    const year = yearOf(slug);
    const name = event.event_name || event.name || slug;
    const loc = place(event.location_city, event.location_state);
    const corpsList = recap?.corps ?? [];
    const winner = [...corpsList].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0]?.corps;
    const hasScores = corpsList.length > 0;

    const title = `${name}${year ? ` ${year}` : ''} — Scores & Full Recap`;
    const description = hasScores
      ? `Final scores and the complete caption-by-caption recap from ${name}` +
        `${event.start_date ? ` on ${formatEventDate(event.start_date)}` : ''}${loc ? ` in ${loc}` : ''}.` +
        `${winner ? ` ${winner} placed first.` : ''}`
      : `Results for ${name} haven't been posted yet — scores and the full recap will appear here.`;

    const sportsEvent = hasScores
      ? {
          '@context': 'https://schema.org',
          '@type': 'SportsEvent',
          name: `${name}${year ? ` ${year}` : ''}`,
          sport: 'Drum and Bugle Corps',
          ...(event.start_date ? { startDate: event.start_date } : {}),
          ...(loc ? { location: { '@type': 'Place', name: loc } } : {}),
          url: `${SITE_URL}/scores/${slug}`,
          competitor: [...corpsList]
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
            .map((c) => ({ '@type': 'SportsTeam', name: c.corps })),
        }
      : null;

    return seoHead({
      title,
      description,
      path: `/scores/${slug}`,
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
  component: ScoresEventPage,
});

function ScoresEventPage() {
  const { slug, event, recap, corps } = Route.useLoaderData();
  const year = yearOf(slug);
  const name = event.event_name || event.name || slug;
  const loc = place(event.location_city, event.location_state);
  const hasScores = (recap?.corps?.length ?? 0) > 0;

  return (
    <PageShell>
      <PageHeader
        title={`${name}${year ? ` ${year}` : ''}`}
        subtitle={['Scores & full recap', formatEventDate(event.start_date), loc]
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
        <StatusCard
          tone="info"
          title="Scores not posted yet"
          description="Results for this event haven't been published. Check back after the show."
        />
      )}
    </PageShell>
  );
}
