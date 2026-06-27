import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { getJudgeDirectory } from '@/lib/server-fns/hybrid';
import { judgesCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import type { JudgeSummary } from '@/lib/judge-directory';
import { cn, searchString } from '@/lib/utils';
import { availableSeasons, selectJudges } from '@/lib/judge-filtering';
import { judgeFilterMachine, judgeFilterSearchCodec } from '@/machines/judge-filter-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { SeasonChips } from '@/components/filter-chips';
import { Icon } from '@/components/icon';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { StaggeredGrid } from '@/components/staggered-grid';
import { DataDisclaimer } from '@/components/data-disclaimer';
import { JudgeAvatarRing } from '@/components/judge-avatar-ring';
import { ArrowDown01Icon, ArrowRight02Icon, Search01Icon } from '@/components/icons/generated';
import { seoHead, breadcrumbLd } from '@/lib/seo';

type JudgesSearch = { season?: string; q?: string; sort?: string; dir?: 'asc' };

export const Route = createFileRoute('/judges/')({
  validateSearch: (search: Record<string, unknown>): JudgesSearch => {
    const out: JudgesSearch = {};
    const season = searchString(search.season);
    if (season) out.season = season;
    const q = searchString(search.q);
    if (q) out.q = q;
    const sort = searchString(search.sort);
    if (sort === 'name') out.sort = sort;
    if (searchString(search.dir) === 'asc') out.dir = 'asc';
    return out;
  },
  loader: async () => ({ judges: await getJudgeDirectory() }),
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    const n = d.judges.length;
    return seoHead({
      title: 'DCI Judges Directory — Adjudicators & Caption Assignments',
      description: `Browse ${n} DCI drum corps judges and adjudicators — caption assignments, scores given, and event history by season on DrumCorps.app.`,
      path: '/judges',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Judges', path: '/judges' },
        ]),
      ],
    });
  },
  staleTime: 60_000,
  component: JudgesDirectory,
});

function JudgesDirectory() {
  const { judges } = Route.useLoaderData();
  return (
    <HybridCollection collection={judgesCollection} loader={judges}>
      {(rows) => <JudgesDirectoryContent judges={rows} />}
    </HybridCollection>
  );
}

function JudgesDirectoryContent({ judges }: { judges: JudgeSummary[] }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const seasons = availableSeasons(judges);
  const defaultSeason = seasons[0] ?? 'all';
  const codec = useMemo(() => judgeFilterSearchCodec(defaultSeason), [defaultSeason]);

  const [state, send] = useMachine(judgeFilterMachine, {
    input: codec.decode(search),
  });
  const filter = state.context;
  useSearchSync({
    context: filter,
    send,
    search,
    codec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
  });

  const ordered = selectJudges(judges, filter);

  return (
    <PageShell>
      <PageHeader
        title="Judge Directory"
        subtitle="DCI judges and their assignments"
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
            placeholder="Search judges by name…"
            value={filter.search}
            onChange={(e) => send({ type: 'SET_SEARCH', search: e.target.value })}
            className="pl-9"
          />
        </div>
      </div>

      {/* At the top so it's actually seen on a long judge list. */}
      <DataDisclaimer className="mb-4" />

      <SeasonChips
        seasons={seasons}
        value={filter.season}
        onSelect={(season) => send({ type: 'SET_SEASON', season })}
        className="mb-6"
      />

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">
          Judges ({ordered.length}
          <Show when={filter.search || filter.season !== 'all'}>{` of ${judges.length}`}</Show>)
        </h2>

        <Show when={ordered.length > 1}>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => send({ type: 'SET_SORT_FIELD', sortField: 'name' })}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  filter.sortField === 'name'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-text-secondary hover:text-foreground'
                )}
              >
                Name
              </button>
              <button
                type="button"
                onClick={() => send({ type: 'SET_SORT_FIELD', sortField: 'assignments' })}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  filter.sortField === 'assignments'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-text-secondary hover:text-foreground'
                )}
              >
                Assignments
              </button>
            </div>
            <button
              type="button"
              onClick={() => send({ type: 'TOGGLE_SORT_DIR' })}
              aria-label={filter.sortDir === 'desc' ? 'Sort ascending' : 'Sort descending'}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
            >
              <motion.span
                className="inline-flex"
                animate={{ rotate: filter.sortDir === 'desc' ? 0 : 180 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <Icon icon={ArrowDown01Icon} size="sm" />
              </motion.span>
              {filter.sortDir === 'desc' ? 'Desc' : 'Asc'}
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={ordered.length > 0}
        fallback={
          <StatusCard
            tone="empty"
            title="No matching judges"
            description="Try a different search term or season."
          />
        }
      >
        <StaggeredGrid
          items={ordered}
          getKey={(j) => j.judge_id}
          step={0.06}
          gap="gap-3"
          // Replay the entrance stagger only on season/sort changes — NOT on every
          // search keystroke, which would remount and re-animate all ~240 cards
          // (each with an SVG avatar ring) on each character typed.
          animationKey={`${filter.season}|${filter.sortField}|${filter.sortDir}`}
          renderItem={(j) => (
            <Link
              to="/judges/$judgeId"
              params={{ judgeId: j.judge_id }}
              className="group block h-full"
            >
              <Card className="card-hover h-full">
                <CardContent className="flex items-center gap-4 py-4">
                  <JudgeAvatarRing
                    name={j.display_name}
                    photoUrl={j.photo_url}
                    breakdown={j.captionBreakdown}
                    size={60}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{j.display_name}</div>
                    <div className="truncate text-sm text-text-secondary">
                      {j.assignment_count} assignment
                      {j.assignment_count !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <Icon
                    icon={ArrowRight02Icon}
                    size="sm"
                    className="icon-shift shrink-0 text-text-muted group-hover:text-primary"
                  />
                </CardContent>
              </Card>
            </Link>
          )}
        />
      </Show>
    </PageShell>
  );
}
