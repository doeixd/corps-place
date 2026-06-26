import { createFileRoute } from '@tanstack/react-router';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { fadeIn } from '@/lib/motion-variants';
import { getCorps, getShowDetail } from '@/lib/server-fns/hybrid';
import { getShowContributions, getShowHistory, getShowGovernance } from '@/lib/server-fns/contrib';
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
  GallerySection,
  AboutSection,
} from '@/components/contrib/block-sections';
import type { FreeFormDoc } from '@/lib/contrib/free-form';
import { HistoryPanel } from '@/components/contrib/history-panel';
import { ReferencesSection } from '@/components/contrib/references-section';
import { listCitations } from '@/lib/server-fns/citations';
import type {
  UniformInput,
  PropsInput,
  LinksInput,
  GalleryInput,
  CoverInput,
  StaffInput,
  MediaLinksInput,
} from '@/lib/contrib/schemas';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { StatusCard } from '@/components/status-card';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import { RankingIcon, BookOpen01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/shows/$slug/$season')({
  loader: async ({ params }) => {
    const { slug, season } = params;
    const corps = await getCorps({ data: slug });
    const key = corps?.corps_key;
    // show / contributions / history / citations each depend only on the corps key —
    // NOT on one another — so fetch them in one parallel batch instead of a 4-deep
    // server-fn waterfall (one round-trip instead of four after the corps lookup).
    const [show, contributions, history, citations, governance] = key
      ? await Promise.all([
          getShowDetail({ data: { corpsKey: key, season } }),
          getShowContributions({ data: { corpsKey: key, season } }),
          getShowHistory({ data: { corpsKey: key, season } }),
          listCitations({ data: { corpsKey: key, season } }),
          getShowGovernance({ data: { corpsKey: key, season } }),
        ])
      : [
          null,
          null,
          [] as Awaited<ReturnType<typeof getShowHistory>>,
          [] as Awaited<ReturnType<typeof listCitations>>,
          null as Awaited<ReturnType<typeof getShowGovernance>> | null,
        ];
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
      uniform: blockContent<UniformInput>('uniform'),
      props: blockContent<PropsInput>('props'),
      links: blockContent<LinksInput>('links'),
      staff: blockContent<StaffInput>('staff'),
      media: blockContent<MediaLinksInput>('media'),
      gallery: blockContent<GalleryInput>('gallery'),
      cover: blockContent<CoverInput>('cover'),
      about: blockContent<FreeFormDoc>('about'),
    };
    const overrides = contributions?.overrides ?? [];
    return { corps, show, season, authored, history, citations, overrides, governance };
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
    return seoHead({
      title: `${corpsName ? corpsName + ' ' : ''}${d.season} — ${s.title} (Drum Corps Show)`,
      description: clampDescription(
        s.description ?? s.tagline ?? s.subtitle ?? s.designerNotes,
        `${corpsName} ${d.season} drum corps production${s.title ? ` "${s.title}"` : ''} — program, repertoire, designers and media on DrumCorps.app.`
      ),
      path: `/shows/${params.slug}/${params.season}`,
      image,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'CreativeWork',
          name: s.title,
          ...(s.subtitle ? { alternateName: s.subtitle } : {}),
          ...(s.description || s.tagline
            ? { description: clampDescription(s.description ?? s.tagline, s.title) }
            : {}),
          ...(corpsName ? { creator: { '@type': 'MusicGroup', name: corpsName } } : {}),
          ...(s.premiereDate ? { datePublished: s.premiereDate } : {}),
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
  staleTime: 60_000,
  component: ShowDetailPage,
});

function ShowDetailPage() {
  const { corps, show, season, authored, history, citations, overrides, governance } =
    Route.useLoaderData();
  const { slug } = Route.useParams();

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
              <h1 className="text-2xl font-bold text-text-primary">{show.title}</h1>
              <Show when={show.subtitle}>{(s) => <p className="text-text-secondary">{s}</p>}</Show>
              <Show when={show.tagline}>
                {(t) => <p className="text-sm italic text-text-secondary">“{t}”</p>}
              </Show>
              <p className="text-xs uppercase tracking-wide text-text-secondary">
                {corps.name} · {show.season}
              </p>
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
          <RepertoireSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.repertoire}
            overrides={overrides}
            citations={citations}
            dcxMuseumUrl={corps.dcx_museum_url}
            corpsName={corps.name}
          />

          {/* Movements (scraped seed + per-row override wiki) */}
          <MovementSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.movements}
            overrides={overrides}
            citations={citations}
          />

          {/* Design & staff (scraped seed + authored overlay) */}
          <StaffSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.staff}
            scraped={show.designers}
          />

          {/* Media (scraped seed + authored overlay) */}
          <MediaSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.media}
            scraped={show.media}
          />

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
                            {[r.authorName, r.publication].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </Show>

          {/* ── Authored sections (live wiki editing) ── */}
          <AboutSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.about}
            citations={citations}
          />
          <UniformSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.uniform}
          />
          <PropsSection corpsKey={corps.corps_key} season={show.season} initial={authored.props} />
          <GallerySection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.gallery}
          />
          <LinksSection corpsKey={corps.corps_key} season={show.season} initial={authored.links} />

          {/* References / citations (M11a) */}
          <ReferencesSection corpsKey={corps.corps_key} season={show.season} initial={citations} />

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
        <aside className="space-y-4 lg:w-80 lg:shrink-0">
          {governance && (governance.canLock || governance.canModerate) ? (
            <PageGovernancePanel
              corpsKey={corps.corps_key}
              season={show.season}
              initial={governance}
            />
          ) : null}
          <HistoryPanel corpsKey={corps.corps_key} season={show.season} initial={history} />
        </aside>
      </div>
    </PageShell>
  );
}

// ── Presentational helpers ───────────────────────────────────────────────────

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
