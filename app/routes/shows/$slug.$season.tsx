import { createFileRoute } from '@tanstack/react-router';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { fadeIn } from '@/lib/motion-variants';
import { getCorps, getShowDetail } from '@/lib/server-fns/hybrid';
import { getShowContributions, getShowGovernance } from '@/lib/server-fns/contrib';
import { useSession } from '@/lib/auth-client';
import { PageGovernancePanel } from '@/components/contrib/page-governance-panel';
import { UniformSection } from '@/components/contrib/uniform-section';
import { CoverSection } from '@/components/contrib/cover-section';
import { StaffSection } from '@/components/contrib/staff-section';
import { MediaSection } from '@/components/contrib/media-section';
import { RepertoireSection } from '@/components/contrib/repertoire-section';
import { MovementSection } from '@/components/contrib/movement-section';
import {
  PropsSection,
  LinksSection,
  AboutSection,
} from '@/components/contrib/block-sections';
import type { FreeFormDoc } from '@/lib/contrib/free-form';
import { HistoryPanel } from '@/components/contrib/history-panel';
import { ReferencesSection } from '@/components/contrib/references-section';
import { listCitations } from '@/lib/server-fns/citations';
import { adaptUniform } from '@/lib/contrib/schemas';
import type {
  PropsInput,
  LinksInput,
  GalleryInput,
  CoverInput,
  StaffInput,
  MediaLinksInput,
} from '@/lib/contrib/schemas';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';
import { PageShell } from '@/components/page-shell';
import { ScoreNotifyButton } from '@/components/score-notify-button';
import { BackLink } from '@/components/back-link';
import { StatusCard } from '@/components/status-card';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import { RankingIcon, BookOpen01Icon } from '@/components/icons/generated';
import { SectionErrorBoundary } from '@/components/error-boundary';
import { LazyMount } from '@/components/lazy-mount';

export const Route = createFileRoute('/shows/$slug/$season')({
  loader: async ({ params }) => {
    const { slug, season } = params;
    const corps = await getCorps({ data: slug });
    const key = corps?.corps_key;
    // show / contributions / history / citations each depend only on the corps key â
    // NOT on one another â so fetch them in one parallel batch instead of a 4-deep
    // server-fn waterfall (one round-trip instead of four after the corps lookup).
    // Core, above-the-fold data only. history + governance are DEFERRED off this
    // blocking loader (Phase 1, INP): they feed below-the-fold panels, so the page
    // paints on core data and those panels fetch on mount (HistoryPanel self-fetches;
    // governance is fetched in the component for the moderator gate). citations stays
    // â repertoire/movements render inline citations above the fold.
    const [show, contributions, citations] = key
      ? await Promise.all([
          getShowDetail({ data: { corpsKey: key, season } }),
          getShowContributions({ data: { corpsKey: key, season } }),
          listCitations({ data: { corpsKey: key, season } }),
        ])
      : [null, null, [] as Awaited<ReturnType<typeof listCitations>>];
    // Authored contributions overlay (uniform/props/links, free-form concept).
    const blockContent = <T,>(key: string): T | null => {
      const block = contributions?.blocks.find((b) => b.pinned_key === key);
      if (!block) return null;
      try {
        return JSON.parse(block.content_json) as T;
      } catch {
        return null;
      }
    };
    const authored = {
      uniform: adaptUniform(blockContent<unknown>('uniform')),
      props: blockContent<PropsInput>('props'),
      links: blockContent<LinksInput>('links'),
      staff: blockContent<StaffInput>('staff'),
      media: blockContent<MediaLinksInput>('media'),
      gallery: blockContent<GalleryInput>('gallery'),
      cover: blockContent<CoverInput>('cover'),
      about: blockContent<FreeFormDoc>('about'),
    };
    const overrides = contributions?.overrides ?? [];
    return { corps, show, season, authored, citations, overrides };
  },
  head: ({ loaderData, params }) => {
    const d = loaderData;
    if (!d) return {};
    const s = d.show;
    const corps = d.corps;
    if (!s) return {};
    const corpsName = corps?.name ?? s.corpsName ?? '';
    const firstMedia = s.media.find((m) => m.thumbnailUrl || m.url);
    const image = firstMedia ? (firstMedia.thumbnailUrl ?? firstMedia.url) : undefined;
    // Authored-first description: prefer a contributor's concept/about prose (its
    // flattened `plain` text) over the generic scraped fallbacks when present.
    const authoredPlain = d.authored?.about?.plain?.trim() || null;
    const description = clampDescription(
      authoredPlain ?? s.description ?? s.tagline ?? s.subtitle ?? s.designerNotes,
      `${corpsName} ${d.season} drum corps production${s.title ? ` "${s.title}"` : ''} â program, repertoire, designers and media on DrumCorps.app.`
    );
    return seoHead({
      title: `${corpsName ? corpsName + ' ' : ''}${d.season} â ${s.title} (Drum Corps Show)`,
      description,
      path: `/shows/${params.slug}/${params.season}`,
      // Generated Satori OG card (show title + corps + season); the real media
      // thumbnail still appears in the CreativeWork JSON-LD image below.
      image: `${SITE_URL}/api/og/show/${params.slug}/${params.season}`,
      type: 'article',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'CreativeWork',
          name: s.title,
          ...(s.subtitle ? { alternateName: s.subtitle } : {}),
          ...(authoredPlain || s.description || s.tagline
            ? { description: clampDescription(authoredPlain ?? s.description ?? s.tagline, s.title) }
            : {}),
          ...(image ? { image } : {}),
          ...(corpsName ? { creator: { '@type': 'MusicGroup', name: corpsName } } : {}),
          ...(s.premiereDate ? { datePublished: s.premiereDate } : {}),
          genre: 'Drum Corps',
          url: `${SITE_URL}/shows/${params.slug}/${params.season}`,
        },
        breadcrumbLd([
          { name: 'Home', path: '/' },
          {
            name: corpsName || 'Corps',
            path: corps?.slug ? `/corps/${corps.slug}` : '/corps',
          },
          {
            name: `${d.season} ${s.title}`,
            path: `/shows/${params.slug}/${params.season}`,
          },
        ]),
      ],
    });
  },
  // Static read-model data (per-emit; client hard-reloads on deploy) — keep it
  // fresh for the session so repeat navs render instantly from the router cache.
  staleTime: Infinity,
  gcTime: Infinity,
  component: ShowDetailPage,
});

function ShowDetailPage() {
  const { corps, show, season, authored, citations, overrides } = Route.useLoaderData();
  const { slug } = Route.useParams();
  // Governance is deferred off the blocking loader (Phase 1). Only signed-in users
  // can moderate, so anonymous visitors (the majority) skip the fetch entirely; the
  // panel self-hides until canLock/canModerate resolve.
  const { data: session } = useSession();
  const [governance, setGovernance] = useState<Awaited<
    ReturnType<typeof getShowGovernance>
  > | null>(null);
  const userId = session?.user?.id;
  useEffect(() => {
    // Depend on the stable user id (not the session object, whose reference can
    // change each render) so this fetches once per sign-in, not on every render.
    if (userId && corps && show)
      void getShowGovernance({ data: { corpsKey: corps.corps_key, season: show.season } })
        .then(setGovernance)
        .catch(() => {});
  }, [userId, corps, show]);

  if (!corps || !show) {
    return (
      <PageShell>
        <BackLink to="/corps" label="Back to Corps" />
        <div className="mt-4">
          <StatusCard
            tone="empty"
            title="Show not found"
            description={`We don't have a ${season} program page for this corps yet.`}
          />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <BackLink to="/corps/$slug/{-$season}" params={{ slug }} label={`Back to ${corps.name}`} />

      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
        <motion.div
          className="min-w-0 flex-1 space-y-6"
          variants={fadeIn}
          initial={false}
          animate="visible"
        >
          {/* Cover image (authored hero) */}
          <CoverSection corpsKey={corps.corps_key} season={show.season} initial={authored.cover} />

          {/* Identity / header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <CorpsLogo
              name={corps.name}
              logo={corpsLogoSource(corps)}
              width={72}
              className="size-12 sm:size-[72px]"
            />
            <div className="min-w-0 space-y-1">
              <h1 className="text-2xl font-bold text-text-primary">
                {show.title}
                <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {corps.name} Â· {show.season}
                </span>
              </h1>
              <Show when={show.subtitle}>{(s) => <p className="text-text-secondary">{s}</p>}</Show>
              <Show when={show.tagline}>
                {(t) => <p className="text-sm italic text-text-secondary">â{t}â</p>}
              </Show>
              <div className="pt-1">
                <ScoreNotifyButton
                  targetKind="event"
                  targetSlug={`${corps.slug}/${show.season}`}
                  // This subscription is keyed by corps+season, so it fires for
                  // EVERY scored show this corps performs this season â the label
                  // must say so rather than imply this single show.
                  targetLabel={`every ${corps.name} show in ${show.season}`}
                />
              </div>
            </div>
          </div>

          {/* Description / about (scraped) */}
          <Show when={show.description}>
            {(d) => (
              <Section icon={BookOpen01Icon} title="About this show">
                <p className="whitespace-pre-line text-text-secondary">{d}</p>
                <Show when={show.designerNotes}>
                  {(n) => (
                    <p className="mt-3 whitespace-pre-line text-sm text-text-secondary">{n}</p>
                  )}
                </Show>
              </Section>
            )}
          </Show>

          {/* Repertoire (scraped seed + per-row override wiki) */}
          <SectionErrorBoundary label="the repertoire section">
            <RepertoireSection
              corpsKey={corps.corps_key}
              season={show.season}
              scraped={show.repertoire}
              overrides={overrides}
              citations={citations}
              dcxMuseumUrl={corps.dcx_museum_url}
              corpsName={corps.name}
            />
          </SectionErrorBoundary>

          {/* Movements (scraped seed + per-row override wiki) */}
          <SectionErrorBoundary label="the movements section">
            <MovementSection
              corpsKey={corps.corps_key}
              season={show.season}
              scraped={show.movements}
              overrides={overrides}
              citations={citations}
            />
          </SectionErrorBoundary>

          {/* Design & staff (scraped seed + authored overlay) */}
          <SectionErrorBoundary label="the design & staff section">
            <StaffSection
              corpsKey={corps.corps_key}
              season={show.season}
              initial={authored.staff}
              scraped={show.designers}
            />
          </SectionErrorBoundary>

          {/* Media (scraped seed + authored overlay) â below the fold; defer its
              mount (video facades) until scrolled near to cut initial render cost. */}
          <SectionErrorBoundary label="the media section">
            <LazyMount minHeight={240}>
              <MediaSection
                corpsKey={corps.corps_key}
                season={show.season}
                initial={authored.media}
                scraped={show.media}
                gallery={authored.gallery}
              />
            </LazyMount>
          </SectionErrorBoundary>

          {/* Reviews (scraped) */}
          <Show when={show.reviews.length > 0}>
            <Section icon={RankingIcon} title="Reviews">
              <ul className="space-y-3">
                <For each={show.reviews}>
                  {(r) => (
                    <li className="border-b border-foreground/10 pb-3 last:border-0 last:pb-0">
                      <Show when={r.summary}>
                        {(s) => <p className="text-text-primary">{s}</p>}
                      </Show>
                      <Show when={r.authorName || r.publication}>
                        {() => (
                          <p className="mt-1 text-xs text-text-secondary">
                            {[r.authorName, r.publication].filter(Boolean).join(' Â· ')}
                          </p>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </Show>

          {/* ââ Authored sections (live wiki editing) ââ */}
          <SectionErrorBoundary label="the synopsis section">
            <AboutSection
              corpsKey={corps.corps_key}
              season={show.season}
              initial={authored.about}
              citations={citations}
            />
          </SectionErrorBoundary>
          <SectionErrorBoundary label="the uniform section">
            <UniformSection
              corpsKey={corps.corps_key}
              season={show.season}
              initial={authored.uniform}
            />
          </SectionErrorBoundary>
          <SectionErrorBoundary label="the props section">
            <PropsSection
              corpsKey={corps.corps_key}
              season={show.season}
              initial={authored.props}
            />
          </SectionErrorBoundary>
          <SectionErrorBoundary label="the links section">
            <LinksSection
              corpsKey={corps.corps_key}
              season={show.season}
              initial={authored.links}
            />
          </SectionErrorBoundary>

          {/* References / citations (M11a) â off-screen on load; skip its render
              until scrolled near (content-visibility) to cut initial paint cost. */}
          <div className="[contain-intrinsic-size:auto_300px] [content-visibility:auto]">
            <SectionErrorBoundary label="the references section">
              <ReferencesSection
                corpsKey={corps.corps_key}
                season={show.season}
                initial={citations}
              />
            </SectionErrorBoundary>
          </div>

          {/* Source attribution */}
          <Show when={show.sourceUrl}>
            {(src) => (
              <p className="text-xs text-text-secondary">
                Source:{' '}
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {hostOf(src)}
                </a>
              </p>
            )}
          </Show>
        </motion.div>
        <aside className="space-y-4 [contain-intrinsic-size:auto_400px] [content-visibility:auto] lg:w-80 lg:shrink-0">
          {governance && (governance.canLock || governance.canModerate) ? (
            <SectionErrorBoundary label="the governance panel">
              <PageGovernancePanel
                corpsKey={corps.corps_key}
                season={show.season}
                initial={governance}
              />
            </SectionErrorBoundary>
          ) : null}
          <SectionErrorBoundary label="the edit history">
            <HistoryPanel corpsKey={corps.corps_key} season={show.season} />
          </SectionErrorBoundary>
        </aside>
      </div>
    </PageShell>
  );
}

// ââ Presentational helpers âââââââââââââââââââââââââââââââââââââââââââââââââââ

function Section({
  icon,
  title,
  children,
}: {
  icon: IconComponent;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          <Icon icon={icon} size="sm" />
          {title}
        </h2>
        {children}
      </CardContent>
    </Card>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'source';
  }
};
