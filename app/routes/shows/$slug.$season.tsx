import { createFileRoute } from '@tanstack/react-router';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { fadeIn } from '@/lib/motion-variants';
import { getCorps, getShowDetail } from '@/lib/server-fns/hybrid';
import { getShowContributions, getShowHistory } from '@/lib/server-fns/contrib';
import { UniformSection } from '@/components/contrib/uniform-section';
import {
  PropsSection,
  LinksSection,
  SymbolismSection,
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
  SymbolismInput,
  GalleryInput,
} from '@/lib/contrib/schemas';
import type { ShowDetail } from '@sdk/src/readModel/builders/shows.js';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { StatusCard } from '@/components/status-card';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import { ProgressiveImage } from '@/components/progressive-image';
import {
  MusicNote03Icon,
  UserGroupIcon,
  KeyframeIcon,
  ViewIcon,
  RankingIcon,
  BookOpen01Icon,
} from '@/components/icons/generated';

export const Route = createFileRoute('/shows/$slug/$season')({
  loader: async ({ params }) => {
    const { slug, season } = params;
    const corps = await getCorps({ data: slug });
    const show = corps?.corps_key
      ? await getShowDetail({ data: { corpsKey: corps.corps_key, season } })
      : null;
    // Authored contributions overlay (uniform/props/links/symbolism, free-form).
    const contributions = corps?.corps_key
      ? await getShowContributions({ data: { corpsKey: corps.corps_key, season } })
      : null;
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
    const history = corps?.corps_key
      ? await getShowHistory({ data: { corpsKey: corps.corps_key, season } })
      : [];
    const citations = corps?.corps_key
      ? await listCitations({ data: { corpsKey: corps.corps_key, season } })
      : [];
    return { corps, show, season, authored, history, citations };
  },
  staleTime: 60_000,
  component: ShowDetailPage,
});

function ShowDetailPage() {
  const { corps, show, season, authored, history, citations } = Route.useLoaderData();
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

          {/* Repertoire (scraped) */}
          <Show when={show.repertoire.length > 0} fallback={<RepertoirePlaceholder />}>
            <Section icon={MusicNote03Icon} title="Repertoire">
              <ul className="divide-y divide-foreground/10">
                <For each={show.repertoire}>
                  {(piece) => (
                    <li className="py-2 first:pt-0 last:pb-0">
                      <div className="font-medium text-text-primary">
                        <Show when={piece.hyperlink} fallback={piece.workTitle}>
                          {(href) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                            >
                              {piece.workTitle}
                            </a>
                          )}
                        </Show>
                      </div>
                      <Show when={creditLine(piece.composer, piece.arranger)}>
                        {(credit) => <p className="text-sm text-text-secondary">{credit}</p>}
                      </Show>
                      <Show when={piece.notes}>
                        {(n) => <p className="text-sm text-text-secondary">{n}</p>}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </Show>

          {/* Movements (scraped) */}
          <Show when={show.movements.length > 0}>
            <Section icon={KeyframeIcon} title="Movements">
              <ol className="space-y-2">
                <For each={show.movements}>
                  {(mv) => (
                    <li className="flex gap-3">
                      <span className="text-text-secondary tabular-nums">{mv.ordinal}.</span>
                      <div className="min-w-0">
                        <Show
                          when={mv.title}
                          fallback={<span className="text-text-secondary">Untitled movement</span>}
                        >
                          {(t) => <span className="font-medium text-text-primary">{t}</span>}
                        </Show>
                        <Show when={mv.description}>
                          {(d) => <p className="text-sm text-text-secondary">{d}</p>}
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ol>
            </Section>
          </Show>

          {/* Staff / designers (scraped) */}
          <Show when={show.designers.length > 0} fallback={<StaffPlaceholder />}>
            <Section icon={UserGroupIcon} title="Design & staff">
              <ul className="grid gap-2 sm:grid-cols-2">
                <For each={show.designers}>
                  {(d) => (
                    <li className="flex justify-between gap-3 border-b border-foreground/10 pb-2">
                      <span className="text-text-secondary">{d.role}</span>
                      <span className="text-right font-medium text-text-primary">{d.name}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </Show>

          {/* Media (scraped) */}
          <Show when={show.media.length > 0} fallback={<MediaPlaceholder />}>
            <Section icon={ViewIcon} title="Media">
              <ul className="grid gap-3 sm:grid-cols-2">
                <For each={show.media}>
                  {(m) => (
                    <li>
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex gap-3 rounded-lg p-2 ring-1 ring-foreground/10 hover:bg-foreground/5"
                      >
                        <Show when={m.thumbnailUrl}>
                          {(thumb) => (
                            <ProgressiveImage
                              src={thumb}
                              alt=""
                              width={112}
                              fit="cover"
                              lazy
                              className="size-14 shrink-0 rounded"
                            />
                          )}
                        </Show>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text-primary">
                            {m.title || m.mediaType || 'Media'}
                          </span>
                          <Show when={m.attribution}>
                            {(a) => (
                              <span className="block truncate text-xs text-text-secondary">
                                {a}
                              </span>
                            )}
                          </Show>
                        </span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Section>
          </Show>

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
          <AboutSection corpsKey={corps.corps_key} season={show.season} initial={authored.about} />
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
        <aside className="lg:w-80 lg:shrink-0">
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

// An inviting empty state that "calls out" for a contribution (plan: "Empty is an
// invitation"). Read-only in M1 — the editor + sign-in CTA arrive in M2/M3.
function ContributePrompt({
  icon,
  title,
  hint,
}: {
  icon: IconComponent;
  title: string;
  hint: string;
}) {
  return (
    <Card className="border-2 border-dashed border-foreground/15 ring-0">
      <CardContent className="flex items-center gap-3 py-5 text-text-secondary">
        <Icon icon={icon} size="lg" className="opacity-60" />
        <div>
          <p className="font-medium text-text-primary">{title}</p>
          <p className="text-sm">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

const RepertoirePlaceholder = () => (
  <ContributePrompt
    icon={MusicNote03Icon}
    title="Repertoire"
    hint="No repertoire on file yet — add the works, composers and arrangers."
  />
);
const StaffPlaceholder = () => (
  <ContributePrompt
    icon={UserGroupIcon}
    title="Design & staff"
    hint="The design team and staff for this show haven't been added yet."
  />
);
const MediaPlaceholder = () => (
  <ContributePrompt
    icon={ViewIcon}
    title="Media"
    hint="Cover images, clips and photos are waiting to be contributed."
  />
);

const creditLine = (composer: string | null, arranger: string | null): string => {
  const parts: string[] = [];
  if (composer) parts.push(`by ${composer}`);
  if (arranger) parts.push(`arr. ${arranger}`);
  return parts.join(' · ');
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'source';
  }
};
