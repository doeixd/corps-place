import { createFileRoute } from '@tanstack/react-router';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { fadeIn } from '@/lib/motion-variants';
import { getCorps, getShowDetail } from '@/lib/server-fns/hybrid';
import {
  getShowContributions,
  getShowGovernance,
  getShowHistory,
  type HistoryEntry,
} from '@/lib/server-fns/contrib';
import { UniformSection } from '@/components/contrib/uniform-section';
import { RepertoireSection } from '@/components/contrib/repertoire-section';
import { DesignStaffSection } from '@/components/contrib/design-staff-section';
import { MovementSection } from '@/components/contrib/movement-section';
import { MediaSection } from '@/components/contrib/media-section';
import {
  PropsSection,
  LinksSection,
  SymbolismSection,
  GallerySection,
  AboutSection,
} from '@/components/contrib/block-sections';
import type { FreeFormDoc } from '@/lib/contrib/free-form';
import { HistoryPanel } from '@/components/contrib/history-panel';
import { PageGovernancePanel } from '@/components/contrib/page-governance-panel';
import {
  ReferencesSection,
  collectScrapedReferences,
} from '@/components/contrib/references-section';
import { listCitations, type Citation } from '@/lib/server-fns/citations';
import type {
  UniformInput,
  PropsInput,
  LinksInput,
  SymbolismInput,
  GalleryInput,
} from '@/lib/contrib/schemas';
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
    // The scraped show, contributions overlay, history, governance and citations
    // are independent reads — fan them out in parallel rather than awaiting serially.
    const corpsKey = corps?.corps_key;
    const arg = corpsKey ? { data: { corpsKey, season } } : null;
    const [show, contributions, history, governance, citations] = arg
      ? await Promise.all([
          getShowDetail(arg),
          getShowContributions(arg),
          getShowHistory(arg),
          getShowGovernance(arg),
          listCitations(arg),
        ])
      : [null, null, [] as HistoryEntry[], null, [] as Citation[]];
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
      symbolism: blockContent<SymbolismInput>('symbolism'),
      gallery: blockContent<GalleryInput>('gallery'),
      about: blockContent<FreeFormDoc>('about'),
    };
    return {
      corps,
      show,
      season,
      authored,
      overrides: contributions?.overrides ?? [],
      history,
      governance,
      citations,
    };
  },
  staleTime: 60_000,
  component: ShowDetailPage,
});

function ShowDetailPage() {
  const { corps, show, season, authored, overrides, history, governance, citations } =
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
          {/* Identity / header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <CorpsLogo name={corps.name} logo={corpsLogoSource(corps)} width={72} />
            <div className="min-w-0 space-y-1">
              <p className="text-xs uppercase tracking-wide text-text-secondary">
                {corps.name} · {show.season}
              </p>
              <h1 className="text-2xl font-bold text-text-primary">{show.title}</h1>
              <Show when={show.subtitle}>{(s) => <p className="text-text-secondary">{s}</p>}</Show>
              <Show when={show.tagline}>
                {(t) => <p className="text-sm italic text-text-secondary">“{t}”</p>}
              </Show>
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

          <RepertoireSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.repertoire}
            overrides={overrides}
            citations={citations}
          />

          <MovementSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.movements}
            overrides={overrides}
            citations={citations}
          />

          <DesignStaffSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.designers}
            overrides={overrides}
            citations={citations}
          />

          <MediaSection
            corpsKey={corps.corps_key}
            season={show.season}
            scraped={show.media}
            overrides={overrides}
            citations={citations}
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
          <SymbolismSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.symbolism}
          />
          <GallerySection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={authored.gallery}
          />
          <LinksSection corpsKey={corps.corps_key} season={show.season} initial={authored.links} />

          {/* References / citations (M11a) + scraped/yearbook provenance (M11c) */}
          <ReferencesSection
            corpsKey={corps.corps_key}
            season={show.season}
            initial={citations}
            provenance={collectScrapedReferences(show)}
          />

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
          <Show when={governance}>
            {(g) => (
              <PageGovernancePanel corpsKey={corps.corps_key} season={show.season} initial={g} />
            )}
          </Show>
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
