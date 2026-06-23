import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useMachine } from '@xstate/react';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { getJudgeProfile } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import { cn, searchString } from '@/lib/utils';
import { useSearchSync } from '@/lib/use-search-sync';
import { judgeProfileMachine, judgeProfileSearchCodec } from '@/machines/judge-profile-machine';
import { PageHeader } from '@/components/page-header';
import { BackLink } from '@/components/back-link';
import { SeasonChips } from '@/components/filter-chips';
import { useRegisterBackName } from '@/lib/use-register-back-name';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { corpsLogoSource } from '@/components/corps-logo';
import { CaptionChip } from '@/components/caption-chip';
import { CaptionMultiSelect } from '@/components/caption-multi-select';
import { JudgeCaptionDonut } from '@/components/judge-caption-donut';
import {
  availableCaptions,
  eventYearSlug,
  filterByCaptions,
  filterBySeason,
  groupAssignmentsByShow,
  groupScoresByCorps,
} from '@/lib/judge-profile';
import {
  ArrowDown01Icon as ChevronIcon,
  Calendar01Icon as CalendarIcon,
  ViewIcon,
  ViewOffIcon as ViewGroupIcon,
} from '@/components/icons/generated';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';

type GroupBy = 'show' | 'corps';

type JudgeSearch = { season?: string; groupBy?: GroupBy; captions?: string };

const GROUP_BY_OPTIONS: { value: GroupBy; label: string; icon: typeof ViewIcon }[] = [
  { value: 'show', label: 'By Show', icon: ViewIcon },
  { value: 'corps', label: 'By Corps', icon: ViewGroupIcon },
];

export const Route = createFileRoute('/judges/$judgeId')({
  validateSearch: (search: Record<string, unknown>): JudgeSearch => {
    const out: JudgeSearch = {};
    const season = searchString(search.season);
    if (season) out.season = season;
    const groupBy = searchString(search.groupBy);
    if (groupBy === 'show' || groupBy === 'corps') out.groupBy = groupBy;
    // Comma-joined caption names (mirrors the prediction page's `cls`).
    const captions = searchString(search.captions);
    if (captions) out.captions = captions;
    return out;
  },
  // On client navigation, read the static judges/<id>.json shard (CDN-cached, no
  // server round-trip); SSR and any fallback use the server fn.
  loader: async ({ params }) => ({
    profile: await loadDetailOrServer(`judges/${params.judgeId}.json`, () =>
      getJudgeProfile({ data: params.judgeId })
    ),
  }),
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    const p = d.profile;
    if (!p) return {};
    const seasons = p.seasons;
    const span = seasons.length
      ? seasons.length > 1
        ? `${seasons[seasons.length - 1]}–${seasons[0]}`
        : seasons[0]
      : '';
    return seoHead({
      title: `${p.display_name} — DCI Judge`,
      description: clampDescription(
        p.biography,
        `${p.display_name} is a DCI drum corps judge with ${p.assignments.length} adjudication assignment${p.assignments.length === 1 ? '' : 's'}${span ? ` (${span})` : ''}. Captions, scores and event history on DrumCorps.app.`
      ),
      path: `/judges/${p.judge_id}`,
      image: p.photo_url ?? undefined,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Person',
          name: p.display_name,
          jobTitle: 'Drum Corps Judge',
          ...(p.photo_url ? { image: p.photo_url } : {}),
          ...(p.biography ? { description: clampDescription(p.biography, p.display_name) } : {}),
          url: `${SITE_URL}/judges/${p.judge_id}`,
        },
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Judges', path: '/judges' },
          { name: p.display_name, path: `/judges/${p.judge_id}` },
        ]),
      ],
    });
  },
  staleTime: 60_000,
  component: JudgeProfilePage,
});

function JudgeProfilePage() {
  const { profile } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Name this entry so back controls reached from here read "Back to <judge>".
  useRegisterBackName(profile?.display_name);

  // View state (season / groupBy / captions) lives in a machine, seeded from the
  // URL and kept in two-way sync with it — same mechanism as the directory pages.
  const codec = useMemo(() => judgeProfileSearchCodec(), []);
  const [state, send] = useMachine(judgeProfileMachine, { input: codec.decode(search) });
  const filter = state.context;
  useSearchSync({
    context: filter,
    send,
    search,
    codec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
  });

  const groupBy = filter.groupBy;
  const selectedSeason = filter.season;
  const selectedCaptions = filter.captions;

  const setSeason = (season: string) => send({ type: 'SET_SEASON', season });
  const setGroupBy = (groupBy: GroupBy) => send({ type: 'SET_GROUP_BY', groupBy });
  const setCaptions = (captions: string[]) => send({ type: 'SET_CAPTIONS', captions });

  // Derivation lives in pure selectors (`app/lib/judge-profile.ts`); React
  // Compiler memoizes these calls, so no manual useMemo. When the profile is
  // missing the component early-returns below, so default to empty here.
  // Caption options come from the *career* assignments (stable across seasons);
  // the filter then narrows the season-scoped rows, before grouping, in both
  // group modes (assignments and corps scores both carry `caption_name`).
  const captionOptions = profile ? availableCaptions(profile.assignments) : [];
  const seasonAssignments = profile ? filterBySeason(profile.assignments, selectedSeason) : [];
  const seasonCorpsScores = profile ? filterBySeason(profile.corpsScores, selectedSeason) : [];
  const filteredAssignments = filterByCaptions(seasonAssignments, selectedCaptions);
  const filteredCorpsScores = filterByCaptions(seasonCorpsScores, selectedCaptions);
  const showGroups = groupAssignmentsByShow(filteredAssignments);
  const corpsGroups = groupScoresByCorps(filteredCorpsScores);

  const [expandedCorps, setExpandedCorps] = useState<ReadonlySet<string>>(new Set());
  const toggleCorps = (key: string) =>
    setExpandedCorps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!profile) {
    return (
      <PageShell>
        <PageHeader title="Judge not found" backTo="/judges" backLabel="Back to Judges" />
        <StatusCard
          tone="empty"
          title="No such judge"
          description="This judge doesn't exist or has no profile yet."
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <BackLink to="/judges" label="Back to Judges" />

      <motion.div
        className="mt-4 space-y-6"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.37, ease: 'easeOut' }}
      >
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          {/* Season-scoped but NOT caption-filtered: the donut is the at-a-glance
              caption *distribution*, so the caption filter must not narrow it. */}
          <JudgeCaptionDonut
            name={profile.display_name}
            photoUrl={profile.photo_url}
            assignments={seasonAssignments}
          />
          <div className="min-w-0 space-y-1 text-center sm:text-left">
            <h1 className="text-[2.5rem] font-bold leading-tight text-text-primary">
              {profile.display_name}
            </h1>
            <div className="flex flex-wrap items-center justify-center gap-3 text-text-secondary sm:justify-start">
              <span>
                {profile.assignments.length} assignment
                {profile.assignments.length !== 1 ? 's' : ''}
              </span>
              <Show when={profile.seasons.length > 0}>
                <span className="inline-flex items-center gap-2">
                  <span>&middot;</span>
                  <span>
                    {profile.seasons[profile.seasons.length - 1]}&ndash;
                    {profile.seasons[0]}
                  </span>
                </span>
              </Show>
            </div>
          </div>
        </div>

        <Show when={!!profile.biography}>
          <Card>
            <CardContent className="py-5">
              <h3 className="-mt-[4px] mb-2 text-base font-semibold">About</h3>
              <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">
                {profile.biography}
              </p>
            </CardContent>
          </Card>
        </Show>

        <Show
          when={
            !!profile.bioFacts &&
            (profile.bioFacts.education.length > 0 ||
              profile.bioFacts.awards.length > 0 ||
              profile.bioFacts.performed.length > 0 ||
              !!profile.bioFacts.currentPosition ||
              !!profile.bioFacts.hometown)
          }
        >
          <Card>
            <CardContent className="py-5">
              <h3 className="-mt-[4px] mb-3 text-base font-semibold">Background</h3>
              <dl className="flex flex-col gap-2 text-sm">
                <Show when={!!profile.bioFacts?.currentPosition}>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-text-secondary">Currently</dt>
                    <dd>
                      {profile.bioFacts?.currentPosition?.title ?? ''}
                      {profile.bioFacts?.currentPosition?.org
                        ? ` @ ${profile.bioFacts?.currentPosition?.org}`
                        : ''}
                    </dd>
                  </div>
                </Show>
                <Show when={!!profile.bioFacts?.hometown}>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-text-secondary">Hometown</dt>
                    <dd>{profile.bioFacts?.hometown ?? ''}</dd>
                  </div>
                </Show>
                <Show when={(profile.bioFacts?.performed.length ?? 0) > 0}>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-text-secondary">Marched</dt>
                    <dd>
                      {(profile.bioFacts?.performed ?? [])
                        .map(
                          (p) =>
                            p.group +
                            (p.startYear
                              ? ` (${p.startYear}${p.endYear && p.endYear !== p.startYear ? `–${p.endYear}` : ''})`
                              : '')
                        )
                        .join('; ')}
                    </dd>
                  </div>
                </Show>
                <Show when={(profile.bioFacts?.education.length ?? 0) > 0}>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-text-secondary">Education</dt>
                    <dd>
                      {(profile.bioFacts?.education ?? [])
                        .map((e) => [e.degree, e.field, e.institution].filter(Boolean).join(', '))
                        .join('; ')}
                    </dd>
                  </div>
                </Show>
                <Show when={(profile.bioFacts?.awards.length ?? 0) > 0}>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-text-secondary">Awards</dt>
                    <dd>
                      {(profile.bioFacts?.awards ?? [])
                        .map((a) => a.name + (a.year ? ` (${a.year})` : ''))
                        .join('; ')}
                    </dd>
                  </div>
                </Show>
              </dl>
            </CardContent>
          </Card>
        </Show>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Assignments</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Show when={captionOptions.length > 1}>
                <CaptionMultiSelect
                  available={captionOptions}
                  selected={selectedCaptions}
                  onChange={setCaptions}
                />
              </Show>
              <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                <For each={GROUP_BY_OPTIONS} fallback={null}>
                  {(opt) => (
                    <button
                      type="button"
                      onClick={() => setGroupBy(opt.value)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                        groupBy === opt.value
                          ? 'bg-primary text-primary-foreground'
                          : 'text-text-secondary hover:text-foreground'
                      )}
                    >
                      <Icon icon={opt.icon} size="sm" />
                      {opt.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>

          <Show when={profile.seasons.length > 1}>
            <SeasonChips seasons={profile.seasons} value={selectedSeason} onSelect={setSeason} />
          </Show>

          <Show when={groupBy === 'show'}>
            <Show
              when={showGroups.length > 0}
              fallback={
                <StatusCard
                  tone="empty"
                  title="No assignments"
                  description="No assignments found for the selected filters."
                />
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <For each={showGroups} fallback={null}>
                  {(g) => (
                    <Card>
                      <CardContent className="py-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link
                              to="/events/$yearSlug/$slug/prediction"
                              params={{
                                yearSlug: eventYearSlug(g.season, g.competition_slug),
                                slug: g.competition_slug,
                              }}
                              className="font-semibold text-primary hover:underline line-clamp-2"
                            >
                              {g.event_name}
                            </Link>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                              <Show when={g.season}>
                                <span className="inline-flex items-center gap-1">
                                  <Icon icon={CalendarIcon} size="sm" />
                                  {g.season}
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <For each={g.captions} fallback={null}>
                            {(caption) => <CaptionChip key={caption} caption={caption} />}
                          </For>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <Show when={groupBy === 'corps'}>
            <Show
              when={corpsGroups.length > 0}
              fallback={
                <StatusCard
                  tone="empty"
                  title="No scores"
                  description="No corps scores found for the selected filters."
                />
              }
            >
              <div className="space-y-3">
                <For each={corpsGroups} fallback={null}>
                  {(g) => {
                    const open = expandedCorps.has(g.corps_key);
                    return (
                      <Card key={g.corps_key}>
                        <button
                          type="button"
                          onClick={() => toggleCorps(g.corps_key)}
                          aria-expanded={open}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left"
                        >
                          <Icon
                            icon={ChevronIcon}
                            size="sm"
                            className={cn(
                              'shrink-0 text-text-secondary transition-transform',
                              open ? 'rotate-0' : '-rotate-90'
                            )}
                          />
                          <CorpsNameCell
                            name={g.corps_name}
                            slug={g.corps_slug ?? g.corps_key}
                            logo={corpsLogoSource(g)}
                            className="font-semibold"
                            logoClassName="size-7 sm:size-8"
                          />
                          <span className="ml-auto shrink-0 text-sm text-text-secondary">
                            {g.entries.length} score{g.entries.length !== 1 ? 's' : ''}
                          </span>
                        </button>
                        <Show when={open}>
                          <CardContent className="px-0 pb-2 pt-0">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-t border-border text-left text-xs uppercase tracking-wide text-text-muted">
                                  <th className="px-4 py-2 font-medium">Show</th>
                                  <th className="px-4 py-2 font-medium">Caption</th>
                                  <th className="px-4 py-2 text-right font-medium">Score</th>
                                  <th className="px-4 py-2 text-right font-medium">Rank</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={g.entries} fallback={null}>
                                  {(entry) => (
                                    <tr
                                      key={`${entry.competition_slug}-${entry.caption_name}`}
                                      className="border-t border-border/60"
                                    >
                                      <td className="px-4 py-2">
                                        <Link
                                          to="/events/$yearSlug/$slug/prediction"
                                          params={{
                                            yearSlug: eventYearSlug(
                                              entry.season,
                                              entry.competition_slug
                                            ),
                                            slug: entry.competition_slug,
                                          }}
                                          className="text-text-secondary hover:text-primary"
                                        >
                                          {entry.event_name}
                                        </Link>
                                      </td>
                                      <td className="px-4 py-2">
                                        <CaptionChip caption={entry.caption_name} />
                                      </td>
                                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                                        {entry.score != null ? entry.score.toFixed(2) : '—'}
                                      </td>
                                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                                        {entry.rank != null ? `#${entry.rank}` : '—'}
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </CardContent>
                        </Show>
                      </Card>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </section>

        <p className="mt-8 text-xs text-muted-foreground text-center">
          Information was obtained using publicly available information from the internet, and may
          be wrong.
        </p>
      </motion.div>
    </PageShell>
  );
}
