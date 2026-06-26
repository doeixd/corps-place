import { createFileRoute } from '@tanstack/react-router';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';
import { useMachine } from '@xstate/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Show, For } from 'jotai-solid-api';
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import { predictionMachine, predictionSearchCodec } from '@/machines/prediction-machine';
import {
  getHybridEventFullRecap,
  getHybridEventPredictionPageData,
  getHybridPrediction,
} from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import {
  SCORE_COLUMNS,
  SCENARIO_WINDOWS,
  WINDOW_LABELS,
  classShortName,
  computeRankRanges,
  computedRanges,
  fmt,
  fmtRange,
  fmtRankRange,
  type Range,
  recapGroup,
  RECAP_GROUP_ORDER,
  RECAP_GROUP_LABELS,
  type RangeKey,
  type RecapRow,
  type RecapGroupKey,
  type ScenarioWindow,
  cycleSortGeneric,
  type FullSortEntry,
} from '@/lib/prediction-scenario';
import type { SortMode, PredictionView } from '@/machines/prediction-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { searchString } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Toggle } from '@/components/ui/toggle';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/reui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/reui/alert';
import { PageHeader } from '@/components/page-header';
import { useRegisterBackName } from '@/lib/use-register-back-name';
import { useStickyScroll, useSuppressLayoutOnce } from '@/lib/table-interactions';
import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard';
import { PageShell } from '@/components/page-shell';
import { LoadingState } from '@/components/loading-state';
import { StatusCard } from '@/components/status-card';
import { StatusPill } from '@/components/status-pill';
import { ClassBadge } from '@/components/class-badge';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { CorpsRegistryProvider } from '@/components/corps-registry';
import { Icon, type IconComponent } from '@/components/icon';
import { DicesIcon } from '@/components/icons/dices';
import { EventSeasonTitle } from '@/components/prediction/event-season-title';
import { SortableScoreHeader } from '@/components/prediction/score-header';
import { PastSeasonScoresPage } from '@/components/prediction/past-season-scores';
import { ScoreRecapTable } from '@/components/prediction/score-recap-table';
import { DiffRecapTable } from '@/components/prediction/diff-recap-table';
import { computeDiff } from '@/lib/diff';
import type { FullEventRecap } from '@/components/prediction/full-recap-table';
import { LineupSchedule } from '@/components/prediction/lineup-schedule';
import { RecapSectionRow } from '@/components/prediction/recap-section-row';
import { motion, AnimatePresence } from 'motion/react';
import { fadeIn } from '@/lib/motion-variants';

import { formatEventDate } from '@/lib/format';
import type { EventDirectoryRow, EventScheduleRow, EventSeasonOption } from '@/lib/event-directory';
import { dciLinks, type DciLinks } from '@/lib/dci-links';
import {
  AiMagicIcon as PredictionIcon,
  Analytics01Icon as ScoresTabIcon,
  ArrowUp02Icon as DiffTabIcon,
  ChartCandlestickIcon as HugeiconsChartCandlestick,
  ChartScatterIcon as HugeiconsChartScatter,
  CheckmarkCircle02Icon as CheckmarkCircleIcon,
  CircleIcon as HugeiconsCircle,
  Clock01Icon as TimesIcon,
  GroupItemsIcon as HugeiconsGroupItems,
  HelpCircleIcon as HugeiconsHelpCircle,
  InformationCircleIcon as InformationIcon,
  JusticeScale01Icon as JudgesIcon,
  KeyframeIcon as HugeiconsKeyframe,
  KeyframesDoubleAddIcon as HugeiconsKeyframesDoubleAdd,
  LinkSquare02Icon as LinkExternalIcon,
  Location01Icon as LocationIcon,
  MenuTwoLineIcon as HugeiconsMenuTwoLine,
  RankingIcon as ScoresIcon,
  RefreshIcon,
  RestoreBinIcon,
  Sorting01Icon as HugeiconsSorting01,
  Target02Icon as HugeiconsTarget02,
  UserMultipleIcon as LineupIcon,
} from '@/components/icons/generated';

// The prediction payload as returned by the server fn (summarized cache/generated
// result). Nested fields stay loose (their source payload is untyped), but the
// top-level shape is enough to type the details panel.
type EventPrediction = NonNullable<Awaited<ReturnType<typeof getHybridPrediction>>>;

// The `status` region of the parallel machine's state value.
type StatusValue = 'idle' | 'loading' | 'error' | 'ready';

// Toggle for the advanced generation panel (Mode / Percent Through / Force /
// Refresh). Hidden for now; a future "Edit prediction" button will surface these
// settings. The XState machine retains all the underlying events either way.
const SHOW_ADVANCED_CONTROLS = false;

// Icon per likelihood window for the toggle-group control.
const WINDOW_ICONS: Record<ScenarioWindow, IconComponent> = {
  '0.5': HugeiconsTarget02, // Likely
  '0.8': HugeiconsCircle, // Possible
  '0.95': HugeiconsHelpCircle, // Unlikely
};

// Tooltip copy explaining what each likelihood window covers.
const WINDOW_DESCRIPTIONS: Record<ScenarioWindow, string> = {
  '0.5': 'Tightest range — where scores land about half the time',
  '0.8': 'Wider range — where scores land roughly 80% of the time',
  '0.95': 'Widest range — covers ~95% of outcomes, including unlikely ones',
};

// Shareable view state carried in the query string. `seed` deterministically
// reproduces a rolled scenario (see prediction-machine `applyScenario`); the rest
// restore the table view. All optional so a bare URL is valid.
interface PredictionSearch {
  seed?: string;
  win?: ScenarioWindow;
  ranges?: boolean;
  cls?: string;
  sort?: string;
  smode?: SortMode;
  group?: boolean;
  /** Past-season scores: full DCI-style recap expanded. */
  recap?: 'full';
  /** Full-recap per-leaf sort, e.g. `GE1:judge-1!desc,total!asc`. */
  fsort?: string;
  /** Roll count, so the "Scenario N" badge survives refresh / shared links. */
  n?: number;
  /**
   * Dev/test hook: synthesize 2026 scores from the prediction so the Scores/Diff
   * views can be exercised before real scores land. OFF unless `?fakeScores=1`.
   */
  fakeScores?: boolean;
}

const isWindow = (v: unknown): v is ScenarioWindow =>
  (SCENARIO_WINDOWS as readonly string[]).includes(v as string);

const validatePredictionSearch = (search: Record<string, unknown>): PredictionSearch => {
  const out: PredictionSearch = {};
  // seed/win can decode as number (all-digit seed, or `0.8`) — coerce to string.
  const seed = searchString(search.seed);
  if (seed) out.seed = seed;
  const win = searchString(search.win);
  if (isWindow(win)) out.win = win;
  if (typeof search.ranges === 'boolean') out.ranges = search.ranges;
  else if (search.ranges === 'true' || search.ranges === 'false')
    out.ranges = search.ranges === 'true';
  if (typeof search.cls === 'string' && search.cls) out.cls = search.cls;
  if (typeof search.sort === 'string' && search.sort) out.sort = search.sort;
  if (search.smode === 'exclusive' || search.smode === 'stack') out.smode = search.smode;
  if (search.recap === 'full') out.recap = 'full';
  if (typeof search.fsort === 'string' && search.fsort) out.fsort = search.fsort;
  if (typeof search.group === 'boolean') out.group = search.group;
  else if (search.group === 'true' || search.group === 'false') out.group = search.group === 'true';
  const n = typeof search.n === 'number' ? search.n : Number(search.n);
  if (Number.isFinite(n) && n > 1) out.n = Math.floor(n);
  if (search.fakeScores === true || search.fakeScores === '1' || search.fakeScores === 'true')
    out.fakeScores = true;
  return out;
};

export const Route = createFileRoute('/events/$yearSlug/$slug/prediction')({
  validateSearch: validatePredictionSearch,
  // Cache-only lookup during navigation/preload: if a prediction is already
  // cached, SSR the page with the recap populated (no spinner). If not, this
  // returns null *immediately* so navigation is instant and the component shows
  // its loader while the machine generates the prediction client-side — rather
  // than blocking navigation on the heavy ML op.
  // Thread the fake-scores test hook into the loader. Only this search field
  // affects the loaded data; the rest are pure view state.
  // Robust to both the validated boolean and the raw `?fakeScores=1` string —
  // loaderDeps can see the search before validateSearch normalization.
  loaderDeps: ({ search }) => ({
    fakeScores:
      (search.fakeScores as unknown) === true ||
      search.fakeScores === '1' ||
      (search.fakeScores as unknown) === 'true',
  }),
  loader: async ({ params, deps }) => {
    const { yearSlug, slug } = params;
    const fakeScores = deps?.fakeScores === true;
    const empty = {
      prediction: null,
      event: null,
      schedule: [],
      corps: [],
      recap: null,
      seasonOptions: [],
      showTitles: {},
      showInfo: {},
      fullRecap: null,
    };

    const isPastSeason = yearSlug !== '2026';

    // PAST-SEASON: unchanged. Static shard on client nav (CDN-cached), falling
    // back to the server fns on SSR/miss/error. Full recap always preloaded.
    if (isPastSeason) {
      const fromServer = async () => {
        try {
          const [data, fullRecap] = await Promise.all([
            getHybridEventPredictionPageData({ data: { yearSlug, slug } }),
            getHybridEventFullRecap({ data: slug }).catch(() => null),
          ]);
          return { ...data, fullRecap };
        } catch {
          return empty;
        }
      };
      return loadDetailOrServer(`prediction-page/${yearSlug}/${slug}.json`, fromServer);
    }

    // 2026: stays on the server fn (its prediction is live-regenerable and must
    // not be frozen into a shard). Fetch page data first — it now also returns a
    // recap (real, or synthesized when ?fakeScores=1). Preload the judge-level
    // full recap whenever a recap exists so the Scores view's Full Recap toggle
    // needs no client fetch. (Synthesized fake recaps have no DB full recap, so
    // the preload simply degrades to null there.)
    try {
      const data = await getHybridEventPredictionPageData({
        data: { yearSlug, slug, fakeScores },
      });
      const hasRecap = (data.recap?.scores?.length ?? 0) > 0;
      const fullRecap = hasRecap
        ? await getHybridEventFullRecap({ data: slug }).catch(() => null)
        : null;
      return { ...data, fullRecap };
    } catch {
      return empty;
    }
  },
  head: ({ loaderData, params }) => {
    const d = loaderData as any;
    if (!d) return {};
    const e = d.event;
    if (!e) return {};
    const ename = e.event_name ?? e.name;
    const loc = [e.location_city, e.location_state].filter(Boolean).join(', ');
    const corpsCount = d.corps?.length ?? 0;
    const place =
      e.venue_name || loc
        ? {
            location: {
              '@type': 'Place',
              ...(e.venue_name ? { name: e.venue_name } : {}),
              address: [e.venue_address, loc].filter(Boolean).join(', ') || undefined,
            },
          }
        : {};
    return seoHead({
      title: `${ename} ${params.yearSlug} — Schedule, Scores & Predictions`,
      description: clampDescription(
        null,
        `${ename} (${params.yearSlug})${loc ? ` in ${loc}` : ''}${corpsCount ? `, ${corpsCount} corps` : ''} — schedule, lineup, scores and AI score predictions on DrumCorps.app.`
      ),
      path: `/events/${params.yearSlug}/${params.slug}/prediction`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Event',
          name: `${ename} ${params.yearSlug}`,
          ...(e.start_date ? { startDate: e.start_date } : {}),
          url: `${SITE_URL}/events/${params.yearSlug}/${params.slug}/prediction`,
          ...place,
        },
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Events', path: '/events' },
          {
            name: `${ename} ${params.yearSlug}`,
            path: `/events/${params.yearSlug}/${params.slug}/prediction`,
          },
        ]),
      ],
    });
  },
  staleTime: 30_000,
  component: PredictionPage,
});

const eventLabel = (slug: string) =>
  slug
    .split('-')
    .filter(Boolean)
    .filter((part, index) => index !== 0 || !/^\d{4}$/.test(part))
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

// Readiness chips rendered inline in the subtitle. Each declares a hover-only
// theme tint for its icon and a `ready` predicate over the directory row; a chip
// shows only when its predicate holds, so an event missing a lineup/judges/etc.
// just shows fewer.
const READINESS_CHIPS: {
  label: string;
  icon: IconComponent;
  iconClassName: string;
  ready: Predicate.Predicate<EventDirectoryRow>;
}[] = [
  {
    label: 'Lineup',
    icon: LineupIcon,
    iconClassName: 'group-hover:text-info',
    ready: (e) => (e.lineup_entries ?? 0) > 0,
  },
  {
    label: 'Times',
    icon: TimesIcon,
    iconClassName: 'group-hover:text-focus',
    ready: (e) => Boolean(e.all_times_present),
  },
  {
    label: 'Judges',
    icon: JudgesIcon,
    iconClassName: 'group-hover:text-warning',
    ready: (e) => (e.judge_assignments ?? 0) > 0,
  },
  {
    label: 'Scores',
    icon: ScoresIcon,
    iconClassName: 'group-hover:text-success',
    ready: (e) => Boolean(e.scores_released),
  },
  {
    label: 'Prediction',
    icon: PredictionIcon,
    iconClassName: 'group-hover:text-primary',
    ready: (e) => (e.prediction_runs ?? 0) > 0,
  },
];

function PredictionPage() {
  const params = Route.useParams() as { yearSlug: string; slug: string };
  const slug = params.slug;
  const loaderData = Route.useLoaderData() as any;
  const { prediction: seededPrediction, event, schedule, corps, recap, seasonOptions } = loaderData;
  const showTitles: Record<string, string> = loaderData.showTitles ?? {};
  const showInfo = loaderData.showInfo ?? {};
  const isPastSeason = params.yearSlug !== '2026';

  // Lookup from a recap row's corps_key (preferred) or name → profile slug + logo,
  // so each corps in the table can link to its page with its logo. Built from the
  // corps directory loaded alongside the prediction.
  const corpsLookup = useMemo(() => {
    type LookupInfo = {
      slug: string | null;
      division: string | null;
    };
    const byKey = new Map<string, LookupInfo>();
    const byName = new Map<string, LookupInfo>();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const c of corps ?? []) {
      const info = {
        slug: c.slug,
        division: c.division_name,
      };
      if (c.corps_key) byKey.set(c.corps_key, info);
      if (c.name) byName.set(norm(c.name), info);
    }
    return (row: RecapRow) => {
      const key = typeof row.corps_key === 'string' ? row.corps_key : undefined;
      const name = typeof row.corps === 'string' ? row.corps : '';
      return (key ? byKey.get(key) : undefined) ?? byName.get(norm(name));
    };
  }, [corps]);

  const readinessChips = event ? READINESS_CHIPS.filter((chip) => chip.ready(event)) : [];
  const hasScoreData = (recap?.scores?.length ?? 0) > 0;
  const dci = dciLinks(event, slug, { hasRecap: hasScoreData, hasScores: hasScoreData });
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  if (isPastSeason) {
    return (
      <CorpsRegistryProvider corps={corps ?? []}>
        <PastSeasonScoresPage
          key={`${params.yearSlug}:${slug}`}
          yearSlug={params.yearSlug}
          slug={slug}
          event={event}
          recap={recap ? { scores: recap.scores } : null}
          seededFullRecap={loaderData.fullRecap ?? null}
          schedule={schedule}
          corpsLookup={corpsLookup}
          seasonOptions={seasonOptions}
          showTitles={showTitles}
          showInfo={showInfo}
          search={search}
          navigate={({ search: s, replace, resetScroll }) =>
            navigate({ search: s, replace, resetScroll })
          }
        />
      </CorpsRegistryProvider>
    );
  }

  return (
    <CorpsRegistryProvider corps={corps ?? []}>
      <CurrentPredictionPage
        key={`${params.yearSlug}:${slug}`}
        params={params}
        slug={slug}
        seededPrediction={seededPrediction}
        event={event}
        schedule={schedule}
        corpsLookup={corpsLookup}
        showTitles={showTitles}
        showInfo={showInfo}
        seasonOptions={seasonOptions}
        readinessChips={readinessChips}
        dci={dci}
        search={search}
        navigate={navigate}
        // Actual scored recap rows (real scores), seeded from the loader. Null
        // when no scores exist yet (today's 2026 case) → Prediction view only.
        scoredRecap={hasScoreData ? (recap.scores as RecapRow[]) : null}
        // Judge-level full recap for the Scores view's Full Recap toggle,
        // preloaded by the loader whenever a recap exists (null otherwise).
        seededFullRecap={(loaderData.fullRecap as FullEventRecap | null) ?? null}
      />
    </CorpsRegistryProvider>
  );
}

/**
 * Shared shell for the prediction area's non-ready states (empty / loading /
 * error). Mirrors the ready layout — same "Recap Prediction" section heading
 * and the lineup schedule below — with a fixed-height status body, so state
 * changes never shift the header or surrounding sections.
 */
function PredictionStatusShell({
  children,
  event,
  schedule,
  showTitles,
  showInfo,
  corpsLookup,
}: {
  children: ReactNode;
  event: EventDirectoryRow | null;
  schedule: EventScheduleRow[];
  showTitles: Record<string, string>;
  showInfo: Record<string, any>;
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
}) {
  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <h2 className="text-lg font-medium text-text-primary pl-[1px]">Recap Prediction</h2>
        <div className="flex min-h-[200px] items-center justify-center [&>*]:w-full">
          {children}
        </div>
      </section>
      <LineupSchedule
        event={event}
        schedule={schedule}
        showTitles={showTitles}
        showInfo={showInfo}
        corpsLookup={(row) =>
          corpsLookup({ corps_key: row.corps_key, corps: row.unit_name } as RecapRow)
        }
      />
    </div>
  );
}

function CurrentPredictionPage({
  params,
  slug,
  seededPrediction,
  event,
  schedule,
  corpsLookup,
  showTitles,
  showInfo,
  seasonOptions,
  readinessChips,
  dci,
  search,
  navigate,
  scoredRecap,
  seededFullRecap,
}: {
  params: { yearSlug: string; slug: string };
  slug: string;
  seededPrediction: EventPrediction | null;
  event: EventDirectoryRow | null;
  schedule: EventScheduleRow[];
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
  showTitles: Record<string, string>;
  showInfo: Record<string, any>;
  seasonOptions: EventSeasonOption[];
  readinessChips: typeof READINESS_CHIPS;
  dci: DciLinks;
  search: PredictionSearch;
  navigate: ReturnType<typeof Route.useNavigate>;
  scoredRecap: RecapRow[] | null;
  seededFullRecap: FullEventRecap | null;
}) {
  // Name this entry so a back control on a page reached from here reads
  // "Back to <event>" instead of the generic section label.
  useRegisterBackName(event?.event_name ?? event?.name ?? eventLabel(slug));

  // Seed the machine from the URL so initial view state matches the search params
  // (no mount-time round trip); useSearchSync keeps them in sync thereafter.
  const [snapshot, send] = useMachine(predictionMachine, {
    input: {
      ...predictionSearchCodec.decode(search),
      slug,
      prediction: seededPrediction,
      // Provides both the data and the dynamic default view (scores-first) when
      // the URL omits `view`; the decoded `view` (if present) overrides it.
      scoredRecap,
    },
  });

  // Seed slug only. We deliberately do NOT auto-fire LOAD_PREDICTION on a
  // loader miss: predictions are pre-generated into the read-model, and the
  // serving host has no ML model — an auto-fetch just spins and then errors.
  // A genuine miss renders the "coming soon" card below; the manual
  // "Run Prediction" button still covers dev/regenerate flows.
  useEffect(() => {
    if (slug) send({ type: 'SET_SLUG', slug });
  }, [slug, send]);

  // Parallel machine → `value` is `{ status, params }`; read the status region.
  const status = (snapshot.value as { status: StatusValue }).status;
  const isLoading = status === 'loading';
  const ctx = snapshot.context;
  const prediction = ctx.prediction;

  // --- Tri-modal view (Scores / Prediction / Diff) --------------------------
  // The active view comes from the machine (URL-seeded). Tabs are shown only for
  // the data sources that exist: Scores when real/fake scores landed, Prediction
  // when a prediction exists, Diff only when BOTH are present. With no scores
  // (today's normal 2026 case) only Prediction is available → no tab control,
  // plain heading, and the page renders byte-for-byte as before.
  const view = ctx.view;
  const hasScores = (ctx.scoredRecap?.length ?? 0) > 0;
  const hasPrediction = !!prediction;
  const tabItems = useMemo(() => {
    const items: { value: PredictionView; label: string; icon: IconComponent }[] = [];
    if (hasScores) items.push({ value: 'scores', label: 'Scores', icon: ScoresTabIcon });
    if (hasPrediction)
      items.push({ value: 'prediction', label: 'Prediction', icon: PredictionIcon });
    if (hasScores && hasPrediction)
      items.push({ value: 'diff', label: 'Diff', icon: DiffTabIcon });
    return items;
  }, [hasScores, hasPrediction]);
  const showTabs = tabItems.length > 1;

  // Diff view rows: full outer join of the real scored recap vs the predicted
  // means (`baseRecap`, the rows the Prediction view's base table renders).
  // Pure (no Effect / DB), memoized so it only recomputes when either side moves.
  const diffRows = useMemo(
    () => computeDiff(ctx.scoredRecap ?? [], ctx.baseRecap),
    [ctx.scoredRecap, ctx.baseRecap]
  );

  // Scores-view Full Recap toggle. The prediction machine carries no full-recap
  // state (it's prediction-first), so the Scores view owns a small local toggle
  // + per-leaf sort list, mirroring the score-table machine's behavior. The
  // payload itself is loader-preloaded (`seededFullRecap`) — no client fetch.
  const [scoresShowFullRecap, setScoresShowFullRecap] = useState(false);
  const [scoresFullSorts, setScoresFullSorts] = useState<FullSortEntry[]>([]);

  // --- Shareable URL state --------------------------------------------------
  // Two-way sync of the view state (seed/window/ranges/class filter/sort) with
  // the query string via the shared hook. `ready` gates on the recap so a
  // URL-seeded scenario rolls against loaded data; `seed` reproduces a shared
  // roll deterministically.
  useSearchSync({
    context: ctx,
    send,
    search,
    codec: predictionSearchCodec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
    ready: ctx.baseRecap.length > 0,
  });

  const { copied: linkCopied, copy } = useCopyToClipboard();
  const copyShareLink = () => {
    if (typeof window !== 'undefined') copy(window.location.href);
  };

  // Percent-through to display on the slider: the user's override if set,
  // otherwise the season progress the SDK auto-computed from the event date
  // (shown in the prediction's readiness), falling back to 50 before load.
  const percentDisplay = ctx.request.percentThrough
    ? Math.round(parseFloat(ctx.request.percentThrough))
    : prediction?.readiness?.percent_through != null
      ? Math.round(prediction.readiness.percent_through)
      : 50;

  const [showDetails, setShowDetails] = useState(false);

  // Divisions available for the class filter (derived from current recap).
  const divisions = useMemo(() => {
    const set = new Set<string>();
    ctx.currentRecap.forEach((r) => {
      if (r.division) set.add(r.division);
    });
    return Array.from(set).sort();
  }, [ctx.currentRecap]);

  // Stable lookup for the unrolled prediction rows. Roll mutates `currentRecap`
  // by sampling scores, but displayed ranges should remain the model intervals
  // around the base prediction.
  const baseRecapByCorps = useMemo(() => {
    const rows = new Map<string, RecapRow>();
    for (const row of ctx.baseRecap) rows.set(String(row.corps), row);
    return rows;
  }, [ctx.baseRecap]);

  // Rank ranges (computed over the full base recap so ranks stay overall, not
  // per-filter, and do not drift when a scenario is rolled) — only when Ranges
  // are on.
  const rankRanges = useMemo(
    () => (ctx.showRanges ? computeRankRanges(ctx.baseRecap, ctx.window) : null),
    [ctx.showRanges, ctx.baseRecap, ctx.window]
  );

  // Overall (ungrouped) point rank by total score, ties sharing the lower rank.
  // The stored `row.rank` is rank-*within-class*, so it can't be shown directly
  // in the overall ranking. Computed over the full recap so ranks stay overall
  // even when a class filter narrows the visible rows (matches `rankRanges`).
  const overallPointRanks = useMemo(() => {
    const ranks = new Map<string, string>();
    const ranked = ctx.currentRecap
      .map((row) => ({
        key: String(row.corps),
        rank: row.rank,
        total: typeof row.total === 'number' && !Number.isNaN(row.total) ? row.total : null,
      }))
      .sort((a, b) => {
        if (a.total !== null && b.total !== null && a.total !== b.total) return b.total - a.total;
        if (a.total === null && b.total !== null) return 1;
        if (a.total !== null && b.total === null) return -1;
        return (a.rank ?? Infinity) - (b.rank ?? Infinity);
      });
    ranked.forEach((entry, index) => {
      const previous = ranked[index - 1];
      if (previous && entry.total !== null && entry.total === previous.total) {
        ranks.set(entry.key, ranks.get(previous.key)!);
      } else {
        ranks.set(entry.key, String(index + 1));
      }
    });
    return ranks;
  }, [ctx.currentRecap]);

  const classFilterActive = ctx.classFilters.length > 0;
  const selectedClassFilters = new Set(ctx.classFilters);
  const classFilterLabel = Match.value(ctx.classFilters.length).pipe(
    Match.when(0, () => 'Class'),
    Match.when(1, () => classShortName(ctx.classFilters[0])),
    Match.orElse((count) => `${count} classes`)
  );
  const tableControlsActive = classFilterActive || ctx.sorts.length > 0;

  const engageStickyScroll = useStickyScroll();

  // Rows visible after the class filter.
  const visibleRows: RecapRow[] = useMemo(
    () =>
      ctx.classFilters.length === 0
        ? ctx.currentRecap
        : ctx.currentRecap.filter((r) => r.division && ctx.classFilters.includes(r.division)),
    [ctx.currentRecap, ctx.classFilters]
  );

  // --- Column sorting -------------------------------------------------------
  // State lives in the machine (alongside window / showRanges / classFilters); the
  // 3-state cycle + exclusive/stack logic is in `cycleSort` / `setSortMode` there.
  // Sort always uses the raw point value (`row[key]`), independent of the Ranges
  // toggle, so ranges/points display the same ordering.
  const sortMode = ctx.sortMode;
  const sorts = ctx.sorts;

  // Animate row layout for sort *reorders*, but not for the render where
  // Ranges↔Scores flips (that resizes columns and would animate a horizontal
  // shift / fight the scroll position).
  const animateLayout = useSuppressLayoutOnce(ctx.showRanges);

  const sortedRows = useMemo(() => {
    if (sorts.length === 0) return visibleRows;
    const num = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
    return [...visibleRows].sort((a, b) => {
      for (const s of sorts) {
        const av = num(a[s.key]);
        const bv = num(b[s.key]);
        if (av === null && bv === null) continue;
        if (av === null) return 1; // missing values sink to the bottom
        if (bv === null) return -1;
        if (av !== bv) return s.dir === 'desc' ? bv - av : av - bv;
      }
      // Stable tiebreaker so equal scores keep a deterministic (predicted-rank) order.
      return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    });
  }, [visibleRows, sorts]);

  // Calculate the number of distinct classes for conditional UI. The default
  // grouping (grouped when >1 class) is owned by the machine — see its context
  // init / seedScenarioFromPrediction — so there's no post-load effect here.
  const classCount = useMemo(() => {
    const classes = new Set(visibleRows.map((row) => row.division));
    return classes.size;
  }, [visibleRows]);

  const recapSections = useMemo(() => {
    if (!ctx.groupByClass || classCount <= 1)
      return [
        {
          key: null as RecapGroupKey | null,
          label: null as string | null,
          rows: sortedRows,
        },
      ];
    const byGroup = new Map<RecapGroupKey, RecapRow[]>();
    for (const row of sortedRows) {
      const key = recapGroup(row.division);
      const arr = byGroup.get(key);
      if (arr) arr.push(row);
      else byGroup.set(key, [row]);
    }
    return RECAP_GROUP_ORDER.filter((k) => byGroup.has(k)).map((k) => ({
      key: k,
      label: RECAP_GROUP_LABELS[k],
      rows: byGroup.get(k)!,
    }));
  }, [sortedRows, ctx.groupByClass, classCount]);

  const rankWithinGroup = useMemo(() => {
    if (!ctx.groupByClass || classCount <= 1) return null;

    const ranks = new Map<string, string>();
    for (const section of recapSections) {
      const sectionRanges = ctx.showRanges
        ? computeRankRanges(
            section.rows
              .map((row) => baseRecapByCorps.get(String(row.corps)))
              .filter((row): row is RecapRow => !!row),
            ctx.window
          )
        : null;
      const pointRanks = new Map<string, string>();
      const ranked = section.rows
        .map((row) => ({
          key: String(row.corps),
          rank: row.rank,
          total: typeof row.total === 'number' && !Number.isNaN(row.total) ? row.total : null,
        }))
        .sort((a, b) => {
          if (a.total !== null && b.total !== null && a.total !== b.total) return b.total - a.total;
          if (a.total === null && b.total !== null) return 1;
          if (a.total !== null && b.total === null) return -1;
          return (a.rank ?? Infinity) - (b.rank ?? Infinity);
        });
      ranked.forEach((entry, index) => {
        const previous = ranked[index - 1];
        if (previous && entry.total !== null && entry.total === previous.total) {
          pointRanks.set(entry.key, pointRanks.get(previous.key)!);
        } else {
          pointRanks.set(entry.key, String(index + 1));
        }
      });

      section.rows.forEach((row) => {
        const key = String(row.corps);
        ranks.set(
          key,
          sectionRanges
            ? fmtRankRange(sectionRanges.get(key), pointRanks.get(key))
            : (pointRanks.get(key) ?? '')
        );
      });
    }
    return ranks;
  }, [ctx.groupByClass, classCount, recapSections, ctx.showRanges, ctx.window, baseRecapByCorps]);

  const predictionRowsAvailable = ctx.currentRecap.length > 0;
  const emptyPredictionDescription = Match.value({
    lineupRows: Number(prediction?.readiness?.lineup_rows ?? 0),
    skippedRows: Number(prediction?.readiness?.skipped_lineup_rows ?? 0),
  }).pipe(
    Match.when(
      ({ lineupRows, skippedRows }) => lineupRows > 0 && skippedRows >= lineupRows,
      () => 'This lineup is outside the divisions currently supported by the V9 prediction model.'
    ),
    Match.when(
      ({ lineupRows }) => lineupRows === 0,
      () => 'No scored lineup rows are available for this event yet.'
    ),
    Match.orElse(() => 'No scored prediction rows were produced for this event.')
  );

  // Per-column rank of each corps within the visible set, shown subtly under
  // each score. Keyed column → corps → display string. In points mode it's a
  // single rank (highest = 1, ties share the lower rank). In range mode it's an
  // interval rank derived from each caption's score range (same best/worst logic
  // as the total rank range): best = 1 + corps whose low still beats this high,
  // worst = N − corps whose high still falls below this low.
  // Precompute each visible row's full range set once (range mode only), keyed by
  // corps. Ranges are based on the unrolled prediction, not the sampled scenario,
  // so pressing Roll changes point scores without moving the interval bands.
  // Reused by both the per-cell display and the caption-rank computation so
  // `computedRanges` — which does a lot of `toFixed` rounding — runs once per row
  // instead of once per cell (~12×) on every window change.
  const rowRanges = useMemo(() => {
    if (!ctx.showRanges) return null;
    const m = new Map<string, Record<RangeKey, Range>>();
    for (const row of ctx.baseRecap) m.set(String(row.corps), computedRanges(row, ctx.window));
    return m;
  }, [ctx.showRanges, ctx.baseRecap, ctx.window]);

  const captionRanks = useMemo(() => {
    const byCol = new Map<RangeKey, Map<string, string>>();
    const scopes =
      ctx.groupByClass && classCount > 1
        ? recapSections.map((section) => section.rows)
        : [visibleRows];
    for (const col of SCORE_COLUMNS) {
      const map = new Map<string, string>();
      for (const rows of scopes) {
        if (ctx.showRanges) {
          // Reuse the precomputed per-row range sets (see `rowRanges`).
          const ranged = rows
            .map((r) => ({
              corps: String(r.corps),
              ranges: rowRanges!.get(String(r.corps)),
            }))
            .filter(
              (entry): entry is { corps: string; ranges: Record<RangeKey, Range> } => !!entry.ranges
            );
          const cells = ranged
            .map(({ corps, ranges }) => ({ corps, range: ranges[col.key] }))
            .filter((c): c is { corps: string; range: { low: number; high: number } } => !!c.range);

          // Optimized O(n log n) ranking using sorted arrays + binary search
          // instead of O(n²) pairwise comparisons.
          const sortedByLow = [...cells].sort((a, b) => a.range.low - b.range.low);
          const sortedByHigh = [...cells].sort((a, b) => a.range.high - b.range.high);
          const lows = sortedByLow.map((c) => c.range.low);
          const highs = sortedByHigh.map((c) => c.range.high);

          // Binary search: find first index where value > target
          const upperBound = (arr: number[], target: number) => {
            let lo = 0,
              hi = arr.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (arr[mid] <= target) lo = mid + 1;
              else hi = mid;
            }
            return lo;
          };

          // Binary search: find first index where value >= target
          const lowerBound = (arr: number[], target: number) => {
            let lo = 0,
              hi = arr.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (arr[mid] < target) lo = mid + 1;
              else hi = mid;
            }
            return lo;
          };

          cells.forEach(({ corps, range }) => {
            // above = count of cells where other.low > this.high
            const above = cells.length - upperBound(lows, range.high);
            // below = count of cells where other.high < this.low
            const below = lowerBound(highs, range.low);
            map.set(corps, fmtRankRange({ low: 1 + above, high: cells.length - below }, ''));
          });
        } else {
          const ranked = rows
            .map((r) => ({ corps: String(r.corps), v: r[col.key] }))
            .filter((x) => typeof x.v === 'number' && !Number.isNaN(x.v))
            .sort((a, b) => (b.v as number) - (a.v as number));
          ranked.forEach((x, i) => {
            if (i > 0 && x.v === ranked[i - 1].v) map.set(x.corps, map.get(ranked[i - 1].corps)!);
            else map.set(x.corps, String(i + 1));
          });
        }
      }
      byCol.set(col.key, map);
    }
    return byCol;
  }, [
    visibleRows,
    ctx.groupByClass,
    classCount,
    recapSections,
    ctx.showRanges,
    ctx.window,
    rowRanges,
  ]);

  return (
    <PageShell>
      <PageHeader
        className="mb-8"
        title={
          <EventSeasonTitle
            year={params.yearSlug}
            label={event?.event_name ?? event?.name ?? eventLabel(slug) ?? 'Event'}
            dci={dci}
            seasons={seasonOptions}
          />
        }
        titleClassName="text-3xl pb-2"
        subtitle={
          <span className="flex flex-nowrap items-center gap-x-1.5 overflow-x-auto pr-4 text-sm text-text-secondary [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="shrink-0">{event ? formatEventDate(event.start_date) : ''}</span>
            <Show when={event?.location_city}>
              {(city) => (
                <>
                  <span className="shrink-0 text-text-muted">•</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <Icon icon={LocationIcon} size="sm" className="size-3.5" />
                    {city}
                    <Show when={event && event.location_state}>{(state) => `, ${state}`}</Show>
                  </span>
                </>
              )}
            </Show>
            <Show when={readinessChips.length > 0}>
              <span className="shrink-0 text-text-muted">•</span>
              <For each={readinessChips}>
                {(chip) => (
                  <span className="relative top-px shrink-0">
                    <StatusPill
                      label={chip.label}
                      active
                      icon={chip.icon}
                      iconClassName={chip.iconClassName}
                    />
                  </span>
                )}
              </For>
            </Show>
          </span>
        }
        backTo="/events/$yearSlug"
        backParams={{ yearSlug: params.yearSlug }}
        backLabel="Back to Events"
        // Refresh action hidden for now — re-enable by restoring the Button below.
        // It re-pulls lineup data and regenerates if the inputs changed (force
        // stays off — the freshness check decides). The old separate "Regenerate"
        // (force:true) lives on via the machine's SET_FORCE event for the future
        // "Edit prediction" panel.
        // actions={
        //   <Button
        //     variant="outline"
        //     disabled={isLoading}
        //     onClick={() => {
        //       send({ type: 'SET_FORCE', force: false });
        //       send({ type: 'SET_REFRESH', refresh: true });
        //       send({ type: 'LOAD_PREDICTION' });
        //     }}
        //   >
        //     <Icon icon={RefreshIcon} size="sm" />
        //     Refresh
        //   </Button>
        // }
      />
      {/* Advanced generation controls (Mode / Percent Through / Force / Refresh).
          Hidden for now — the machine still supports SET_MODE / SET_PERCENT_THROUGH
          / SET_FORCE / SET_REFRESH, so flipping SHOW_ADVANCED_CONTROLS back on (or
          wiring a future "Edit prediction" button to this panel) restores it with
          no other changes. */}
      {SHOW_ADVANCED_CONTROLS ? (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-end gap-4 pt-6">
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select
                value={ctx.request.mode || 'auto'}
                onValueChange={(mode) => send({ type: 'SET_MODE', mode: mode ?? 'auto' })}
                disabled={isLoading}
              >
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="as_of_show_date">as_of_show_date</SelectItem>
                  <SelectItem value="preseason_forecast">preseason_forecast</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Percent Through</Label>
              <div className="flex items-center gap-2">
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={[percentDisplay]}
                  onValueChange={(v) =>
                    send({
                      type: 'SET_PERCENT_THROUGH',
                      percentThrough: String(Array.isArray(v) ? v[0] : v),
                    })
                  }
                  className="w-44"
                  disabled={isLoading}
                />
                <span className="text-sm tabular-nums w-12">{percentDisplay}%</span>
              </div>
            </div>

            <Button onClick={() => send({ type: 'LOAD_PREDICTION' })} disabled={isLoading || !slug}>
              <Icon icon={RefreshIcon} size="sm" />
              {isLoading ? 'Generating…' : 'Run Prediction'}
            </Button>

            <Button variant="outline" onClick={() => send({ type: 'RESET' })} disabled={isLoading}>
              <Icon icon={RestoreBinIcon} size="sm" />
              Reset
            </Button>

            <Separator orientation="vertical" className="h-9" />

            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={!!ctx.request.force}
                onCheckedChange={(force) => send({ type: 'SET_FORCE', force: !!force })}
                disabled={isLoading}
              />
              Force regenerate
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={!!ctx.request.refresh}
                onCheckedChange={(refresh) => send({ type: 'SET_REFRESH', refresh: !!refresh })}
                disabled={isLoading}
              />
              Refresh lineup data
            </Label>
          </CardContent>
        </Card>
      ) : null}
      {/* Exhaustive status rendering via effect/Match (per migration plan).
          Every non-ready state renders inside the SAME shell as the ready
          page — the "Recap Prediction" section heading, a fixed-height status
          body, and the lineup schedule (loader-supplied, available in every
          state) — so swapping between message/loading/error/table never shifts
          the surrounding layout. */}
      {Match.value(status).pipe(
        // No prediction in the read-model yet (e.g. lineup just announced and
        // the builder hasn't run). Calm empty state — never a spinner: nothing
        // is being fetched.
        Match.when('idle', () => (
          <PredictionStatusShell
            event={event}
            schedule={schedule}
            showTitles={showTitles}
            showInfo={showInfo}
            corpsLookup={corpsLookup}
          >
            <StatusCard
              tone="empty"
              title="Prediction coming soon"
              description="This event's score prediction hasn't been generated yet. Check back shortly — predictions are produced automatically once the lineup is in."
            />
          </PredictionStatusShell>
        )),
        // Only reachable via the manual "Run Prediction" button.
        Match.when('loading', () => (
          <PredictionStatusShell
            event={event}
            schedule={schedule}
            showTitles={showTitles}
            showInfo={showInfo}
            corpsLookup={corpsLookup}
          >
            <LoadingState label="Checking cache / generating recap forecast via the model…" />
          </PredictionStatusShell>
        )),
        Match.when('error', () => (
          <PredictionStatusShell
            event={event}
            schedule={schedule}
            showTitles={showTitles}
            showInfo={showInfo}
            corpsLookup={corpsLookup}
          >
            <Alert variant="destructive">
              <AlertTitle>Prediction unavailable</AlertTitle>
              <AlertDescription>{ctx.error}</AlertDescription>
            </Alert>
          </PredictionStatusShell>
        )),
        Match.when('ready', () => (
          <Show
            when={!!prediction}
            fallback={
              <PredictionStatusShell
                event={event}
                schedule={schedule}
                showTitles={showTitles}
                showInfo={showInfo}
                corpsLookup={corpsLookup}
              >
                <StatusCard tone="info" title="No prediction" description="No prediction data." />
              </PredictionStatusShell>
            }
          >
            <motion.div className="space-y-4" variants={fadeIn} initial={false} animate="visible">
              <section className="space-y-4">
                {/* Tri-modal heading: a segmented control when more than one data
                    source is available (Scores / Prediction / Diff), otherwise the
                    plain section heading — today's behavior with no scores. */}
                <Show
                  when={showTabs}
                  fallback={
                    <h2 className="text-lg font-medium text-text-primary pl-[1px]">
                      {hasScores && !hasPrediction ? 'Scores' : 'Recap Prediction'}
                    </h2>
                  }
                >
                  <ToggleGroup
                    variant="outline"
                    spacing={0}
                    value={[view]}
                    onValueChange={(v) => {
                      const next = v[0] as PredictionView | undefined;
                      if (next) send({ type: 'SET_VIEW', view: next });
                    }}
                  >
                    <For each={tabItems}>
                      {(item) => (
                        <ToggleGroupItem value={item.value}>
                          <Icon icon={item.icon} size="sm" className="size-3.5" />
                          {item.label}
                        </ToggleGroupItem>
                      )}
                    </For>
                  </ToggleGroup>
                </Show>

                {/* ---- Scores view (P4): real scored recap, same table as past
                    seasons, seeded from the machine's scoredRecap. ---- */}
                <Show when={view === 'scores'}>
                  <ScoreRecapTable
                    rows={ctx.scoredRecap ?? []}
                    corpsLookup={corpsLookup}
                    title="Scores"
                    classFilters={ctx.classFilters}
                    onSetClassFilters={(filters) =>
                      send({ type: 'SET_CLASS_FILTERS', classFilters: filters })
                    }
                    sorts={ctx.sorts}
                    onCycleSort={(key) => send({ type: 'CYCLE_SORT', key })}
                    onSetSorts={(sorts) => send({ type: 'SET_SORTS', sorts })}
                    sortMode={ctx.sortMode}
                    onSetSortMode={(mode) => send({ type: 'SET_SORT_MODE', mode })}
                    // Real scores carry no prediction intervals → no Ranges toggle.
                    showRanges={false}
                    onSetShowRanges={() => {}}
                    groupByClass={ctx.groupByClass}
                    onSetGroupByClass={(groupByClass) =>
                      send({ type: 'SET_GROUP_BY_CLASS', groupByClass })
                    }
                    showFullRecap={scoresShowFullRecap}
                    onToggleFullRecap={setScoresShowFullRecap}
                    fullRecap={seededFullRecap}
                    fullStatus="ready"
                    fullSorts={scoresFullSorts}
                    onCycleFullSort={(key) =>
                      setScoresFullSorts((prev) => cycleSortGeneric(prev, key, ctx.sortMode))
                    }
                    onSetFullSorts={setScoresFullSorts}
                    yearSlug={params.yearSlug}
                  />
                </Show>

                {/* ---- Diff view (P5): scored-vs-predicted comparison table.
                    Diff rows join scoredRecap against the predicted means
                    (baseRecap). Sort cycling routes through the machine's
                    view-aware CYCLE_SORT (keyed by caption → diffSorts). ---- */}
                <Show when={view === 'diff'}>
                  <DiffRecapTable
                    rows={diffRows}
                    corpsLookup={corpsLookup}
                    classFilters={ctx.classFilters}
                    onSetClassFilters={(filters) =>
                      send({ type: 'SET_CLASS_FILTERS', classFilters: filters })
                    }
                    groupByClass={ctx.groupByClass}
                    diffSorts={ctx.diffSorts}
                    sortMode={ctx.sortMode}
                    onCycleSort={(key) => send({ type: 'CYCLE_SORT', key })}
                    yearSlug={params.yearSlug}
                  />
                </Show>

                {/* ---- Prediction view: the existing Monte Carlo recap toolbar +
                    table, unchanged. Only renders in the prediction view. ---- */}
                <Show when={view === 'prediction'}>
                {/* Recap toolbar + table */}
                <Show
                  when={predictionRowsAvailable}
                  fallback={
                    <StatusCard
                      tone="info"
                      title="No recap prediction"
                      description={emptyPredictionDescription}
                    />
                  }
                >
                  <Card>
                    <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-start">
                      {/* On mobile, shrink the toolbar controls a touch: smaller button/
                        toggle text and smaller icons (descendant utilities keep it in
                        one place rather than per-control). */}
                      <div className="flex flex-wrap items-center gap-3 max-sm:[&_button]:text-xs max-sm:[&_svg]:size-3.5">
                        <Button
                          variant="default"
                          onClick={() => send({ type: 'ROLL' })}
                          title="Roll a possible recap from the prediction intervals"
                        >
                          <Icon icon={DicesIcon} size="sm" />
                          Roll
                        </Button>

                        {/* Reset + counter + share link only make sense once a scenario
                        has been rolled. Mounted on demand (no reserved space) and
                        slid in with motion; the URL carries the full view state, so
                        Copy link reproduces this exact scenario and view. */}
                        <AnimatePresence initial={false}>
                          {ctx.scenarioCount > 0 ? (
                            <motion.div
                              className="flex flex-none items-center gap-3 overflow-hidden whitespace-nowrap"
                              initial={{ opacity: 0, width: 0 }}
                              animate={{ opacity: 1, width: 'auto' }}
                              exit={{ opacity: 0, width: 0 }}
                              transition={{ duration: 0.18, ease: 'easeOut' }}
                            >
                              <Button
                                variant="ghost"
                                onClick={() => send({ type: 'RESET_SCENARIO' })}
                              >
                                Reset
                              </Button>
                              <Badge variant="info-light" aria-live="polite">
                                Scenario{' '}
                                <span className="inline-block min-w-[2ch] text-right tabular-nums">
                                  {ctx.scenarioCount}
                                </span>
                              </Badge>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      onClick={copyShareLink}
                                      aria-label="Copy share link"
                                    />
                                  }
                                >
                                  <Icon
                                    icon={linkCopied ? CheckmarkCircleIcon : LinkExternalIcon}
                                    size="sm"
                                  />
                                  {linkCopied ? 'Copied' : 'Copy link'}
                                </TooltipTrigger>
                                <TooltipContent>
                                  Copy a shareable link that reproduces this exact scenario and view
                                </TooltipContent>
                              </Tooltip>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>

                        <div className="flex items-center gap-2">
                          {/* <Label className="text-xs text-muted-foreground">Likelihood</Label> */}

                          {/* Likelihood control. Single-select; the guard ignores
                          deselecting the active item (a window is required). */}
                          <ToggleGroup
                            variant="outline"
                            spacing={0}
                            value={[ctx.window]}
                            onValueChange={(v) => {
                              const next = v[0] as ScenarioWindow | undefined;
                              if (next) send({ type: 'SET_WINDOW', window: next });
                            }}
                          >
                            <For each={SCENARIO_WINDOWS as readonly ScenarioWindow[]}>
                              {(w) => (
                                <Tooltip>
                                  <TooltipTrigger render={<ToggleGroupItem value={w} />}>
                                    <Icon icon={WINDOW_ICONS[w]} size="sm" className="size-3.5" />
                                    {WINDOW_LABELS[w]}
                                  </TooltipTrigger>
                                  <TooltipContent>{WINDOW_DESCRIPTIONS[w]}</TooltipContent>
                                </Tooltip>
                              )}
                            </For>
                          </ToggleGroup>

                          {/* Original dropdown — kept commented in case we prefer it.
                      <Select
                        value={ctx.window}
                        onValueChange={(v) =>
                          send({ type: 'SET_WINDOW', window: (v ?? '0.8') as ScenarioWindow })
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue>
                            {(value) => WINDOW_LABELS[value as ScenarioWindow] ?? String(value)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <For each={SCENARIO_WINDOWS as readonly ScenarioWindow[]}>
                            {(w) => <SelectItem value={w}>{WINDOW_LABELS[w]}</SelectItem>}
                          </For>
                        </SelectContent>
                      </Select>
                      */}
                        </div>

                        {/* Divider: separates the likelihood group from the view
                        toggles. */}
                        <Separator orientation="vertical" className="h-7" />

                        {/* Two-state mode switch: pressed = score ranges (candlestick),
                        unpressed = single point scores (target). The label/icon
                        reflect the current view, and the tooltip explains the swap. */}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Toggle
                                variant="outline"
                                pressed={ctx.showRanges}
                                onPressedChange={(pressed) =>
                                  send({
                                    type: 'SET_RANGES',
                                    showRanges: pressed,
                                  })
                                }
                                aria-label={
                                  ctx.showRanges ? 'Showing score ranges' : 'Showing point scores'
                                }
                              />
                            }
                          >
                            <Icon
                              icon={
                                ctx.showRanges ? HugeiconsChartCandlestick : HugeiconsChartScatter
                              }
                              size="sm"
                            />
                            {ctx.showRanges ? 'Ranges' : 'Scores'}
                          </TooltipTrigger>
                          <TooltipContent>
                            {ctx.showRanges
                              ? 'Showing likely score ranges — switch to single point scores'
                              : 'Showing single point scores — switch to likely score ranges'}
                          </TooltipContent>
                        </Tooltip>

                        {/* Group by Class toggle - only show if there are multiple classes */}
                        <Show when={classCount > 1}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Toggle
                                  variant="outline"
                                  pressed={ctx.groupByClass}
                                  onPressedChange={(pressed) =>
                                    send({
                                      type: 'SET_GROUP_BY_CLASS',
                                      groupByClass: pressed,
                                    })
                                  }
                                  aria-label={
                                    ctx.groupByClass ? 'Grouped by class' : 'Overall ranking'
                                  }
                                />
                              }
                            >
                              <Icon
                                icon={ctx.groupByClass ? HugeiconsGroupItems : HugeiconsSorting01}
                                size="sm"
                              />
                              {ctx.groupByClass ? 'Group by Class' : 'Overall'}
                            </TooltipTrigger>
                            <TooltipContent>
                              {ctx.groupByClass
                                ? 'Grouped by class — switch to overall event ranking'
                                : 'Overall event ranking — switch to class groups'}
                            </TooltipContent>
                          </Tooltip>
                        </Show>

                        {/* Sort mode: Exclusive (one column at a time) ↔ Stack (multiple
                        columns, newest first). Label + icon reflect the current mode.
                        Only shown when at least one column is sorted. */}
                        <Show when={sorts.length > 0}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Toggle
                                  variant="outline"
                                  pressed={sortMode === 'stack'}
                                  onPressedChange={(pressed) =>
                                    send({
                                      type: 'SET_SORT_MODE',
                                      mode: pressed ? 'stack' : 'exclusive',
                                    })
                                  }
                                  aria-label={
                                    sortMode === 'stack'
                                      ? 'Stack column sorting'
                                      : 'Exclusive column sorting'
                                  }
                                />
                              }
                            >
                              <Icon
                                icon={
                                  sortMode === 'stack'
                                    ? HugeiconsKeyframesDoubleAdd
                                    : HugeiconsKeyframe
                                }
                                size="sm"
                              />
                              {sortMode === 'stack' ? 'Stack Sort' : 'Exclusive Sort'}
                            </TooltipTrigger>
                            <TooltipContent>
                              {sortMode === 'stack'
                                ? 'Stacking sorts — new columns become primary, older columns break ties'
                                : 'Sorting one column at a time — switch to stack multiple column sorts'}
                            </TooltipContent>
                          </Tooltip>
                        </Show>

                        <Show when={tableControlsActive}>
                          <Separator orientation="vertical" className="h-7" />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              send({
                                type: 'SET_CLASS_FILTERS',
                                classFilters: [],
                              });
                              send({ type: 'SET_SORTS', sorts: [] });
                            }}
                          >
                            Clear Filters
                          </Button>
                        </Show>
                      </div>
                    </CardHeader>

                    <CardContent className="px-0 py-0 sm:px-2">
                      {/* Default container = overflow-x-auto, so the (themed, fade-on-
                        hover) scrollbar only appears when the table actually overflows. */}
                      <Table
                        className="min-w-[1040px] text-sm tabular-nums"
                        // Keep the sticky columns in normal flow (crisp) at rest and
                        // promote to `position: sticky` only while scrolling. Engaging
                        // on wheel/touch *before* the scroll moves avoids a first-tick
                        // jiggle. See `.sticky-col` rules in app.css.
                        containerProps={{
                          onWheel: (e) => engageStickyScroll(e.currentTarget),
                          onTouchStart: (e) => engageStickyScroll(e.currentTarget),
                          onScroll: (e) => engageStickyScroll(e.currentTarget),
                        }}
                      >
                        <TableHeader>
                          <TableRow>
                            <TableHead className="sticky-col sticky left-0 z-20 w-[48px] min-w-[48px] max-w-[48px] px-1 sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:px-2 text-center">
                              Rank
                            </TableHead>
                            <TableHead className="sticky-col sticky-col-edge sticky left-[48px] sm:left-[64px] z-20">
                              Corps
                            </TableHead>
                            {/* The Class column header doubles as its filter. */}
                            <TableHead className="p-0">
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label="Filter by class"
                                      className={
                                        'flex h-full w-full cursor-pointer items-center gap-1.5 px-2 py-2 text-left transition-colors hover:text-foreground focus-visible:outline-none ' +
                                        (classFilterActive
                                          ? 'text-foreground'
                                          : 'text-muted-foreground')
                                      }
                                    />
                                  }
                                >
                                  <Icon
                                    icon={HugeiconsMenuTwoLine}
                                    size="sm"
                                    className={
                                      'size-3.5 ' +
                                      (classFilterActive
                                        ? 'text-foreground'
                                        : 'text-muted-foreground/60')
                                    }
                                  />
                                  <span>{classFilterLabel}</span>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="min-w-44">
                                  <DropdownMenuItem
                                    closeOnClick={false}
                                    onClick={() =>
                                      send({
                                        type: 'SET_CLASS_FILTERS',
                                        classFilters: [],
                                      })
                                    }
                                  >
                                    All classes
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <For each={divisions}>
                                    {(d) => (
                                      <DropdownMenuCheckboxItem
                                        checked={selectedClassFilters.has(d)}
                                        closeOnClick={false}
                                        onCheckedChange={(checked) => {
                                          const next = new Set(ctx.classFilters);
                                          if (checked) next.add(d);
                                          else next.delete(d);
                                          send({
                                            type: 'SET_CLASS_FILTERS',
                                            classFilters: Array.from(next),
                                          });
                                        }}
                                      >
                                        {classShortName(d)}
                                      </DropdownMenuCheckboxItem>
                                    )}
                                  </For>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableHead>
                            {/* Plain .map, NOT <For>: `For` freezes children for a constant
                                `each`, so sort direction / range headers wouldn't update. */}
                            {SCORE_COLUMNS.map((col) => {
                              const sortIndex = sorts.findIndex((s) => s.key === col.key);
                              const dir = sortIndex >= 0 ? sorts[sortIndex].dir : undefined;
                              return (
                                <SortableScoreHeader
                                  key={col.key}
                                  col={col}
                                  showRanges={ctx.showRanges}
                                  dir={dir}
                                  priority={
                                    sortMode === 'stack' && dir !== undefined && sorts.length > 1
                                      ? sortIndex + 1
                                      : null
                                  }
                                  onSort={() => send({ type: 'CYCLE_SORT', key: col.key })}
                                />
                              );
                            })}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* Flat list with section headers interleaved - allows Framer Motion to track rows across grouping changes */}
                          {recapSections.flatMap((section) => [
                            ...(section.key !== null
                              ? [
                                  <RecapSectionRow
                                    key={`header-${section.key}`}
                                    sectionKey={section.key}
                                    label={section.label ?? ''}
                                    trailingColSpan={1 + SCORE_COLUMNS.length}
                                  />,
                                ]
                              : []),
                            ...section.rows.map((row) => (
                              <motion.tr
                                key={String(row.corps)}
                                layout={animateLayout ? 'position' : false}
                                transition={{
                                  type: 'spring',
                                  stiffness: 500,
                                  damping: 50,
                                  mass: 1,
                                }}
                                data-slot="table-row"
                                className="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
                              >
                                <TableCell className="sticky-col sticky left-0 z-10 w-[48px] min-w-[48px] max-w-[48px] px-1 sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:px-2 text-center text-muted-foreground">
                                  {rankWithinGroup?.get(String(row.corps)) ??
                                    (rankRanges
                                      ? fmtRankRange(
                                          rankRanges.get(String(row.corps)),
                                          overallPointRanks.get(String(row.corps))
                                        )
                                      : overallPointRanks.get(String(row.corps)))}
                                </TableCell>
                                <TableCell className="sticky-col sticky-col-edge sticky left-[48px] sm:left-[64px] z-10 font-medium">
                                  {(() => {
                                    const info = corpsLookup(row);
                                    return (
                                      <CorpsNameCell
                                        name={String(row.corps ?? '')}
                                        slug={info?.slug}
                                        corpsKey={
                                          typeof row.corps_key === 'string' ? row.corps_key : null
                                        }
                                      />
                                    );
                                  })()}
                                </TableCell>
                                <TableCell>
                                  <ClassBadge
                                    division={
                                      row.division ?? corpsLookup(row)?.division ?? undefined
                                    }
                                  />
                                </TableCell>
                                {/* Plain .map, NOT <For>: `For` (jotai-solid-api) keys children by
                                    item identity and only re-runs when `each` changes. SCORE_COLUMNS
                                    is constant, so the cells would freeze at first render and never
                                    reflect a roll (new scores) or window/ranges change. */}
                                {SCORE_COLUMNS.map((col) => {
                                  const rank = captionRanks.get(col.key)?.get(String(row.corps));
                                  return (
                                    <TableCell
                                      key={col.key}
                                      className={
                                        'relative py-3.5 text-right font-mono' +
                                        (col.key === 'total' ? ' font-bold' : '') +
                                        (col.separator ? ' border-r border-border pr-4' : '')
                                      }
                                    >
                                      {ctx.showRanges
                                        ? (() => {
                                            const r = rowRanges?.get(String(row.corps))?.[col.key];
                                            return r
                                              ? fmtRange(r.low, r.high)
                                              : fmt(row[col.key], 3);
                                          })()
                                        : fmt(row[col.key], 3)}
                                      {rank ? (
                                        <span className="pointer-events-none absolute inset-x-0 bottom-[4.5px] text-center text-[10px] font-normal leading-none text-muted-foreground/50 tabular-nums">
                                          {rank}
                                        </span>
                                      ) : null}
                                    </TableCell>
                                  );
                                })}
                              </motion.tr>
                            )),
                          ])}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </Show>

                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full leading-none opacity-70 transition-opacity hover:opacity-100"
                    aria-expanded={showDetails}
                    onClick={() => setShowDetails((v) => !v)}
                  >
                    <Icon icon={InformationIcon} size="sm" />
                    <span className="relative top-px">Prediction details</span>
                  </Button>
                </div>

                <AnimatePresence initial={false}>
                  <Show when={showDetails && prediction}>
                    {(p) => <PredictionDetails prediction={p} />}
                  </Show>
                </AnimatePresence>
                </Show>
              </section>

              {/* Full event schedule — performing lineup + non-performance
                  segments, in a table matching the recap above. */}
              <LineupSchedule
                event={event}
                schedule={schedule}
                showTitles={showTitles}
                showInfo={showInfo}
                corpsLookup={(row) =>
                  corpsLookup({
                    corps_key: row.corps_key,
                    corps: row.unit_name,
                  } as RecapRow)
                }
              />
            </motion.div>
          </Show>
        )),
        Match.orElse(() => (
          <PredictionStatusShell
            event={event}
            schedule={schedule}
            showTitles={showTitles}
            showInfo={showInfo}
            corpsLookup={corpsLookup}
          >
            <div className="text-muted-foreground text-sm">Unexpected machine status.</div>
          </PredictionStatusShell>
        ))
      )}
    </PageShell>
  );
}

function PredictionDetails({ prediction }: { prediction: EventPrediction }) {
  const audit = prediction.input_audit ?? {};
  const readiness = audit.readiness ?? {};
  const modelMeta = prediction.model_metadata ?? {};
  const modelDir: string = prediction.model_dir ?? '';
  const modelName = modelDir.split(/[/\\]/).filter(Boolean).pop() ?? modelDir;
  const featureContract = modelMeta.supports_caption_fingerprints
    ? `fingerprints on (${modelMeta.model_static_dim}/${modelMeta.feature_static_dim})`
    : modelMeta.model_static_dim
      ? `legacy static shape (${modelMeta.model_static_dim}/${modelMeta.feature_static_dim ?? `?`})`
      : '';

  const scored = (readiness.scored_lineup_rows ?? prediction.readiness?.lineup_rows ?? 0) as number;
  const excludedCount = (readiness.excluded_lineup_rows ??
    (audit.exclusions ?? []).length) as number;
  const summary = `${scored} scored, ${excludedCount} excluded, ${readiness.readiness_status ?? `unknown`}`;

  const event = prediction.event ?? {};
  const competition = prediction.competition ?? {};
  const eventMeta = [event.event_name ?? event.name, event.start_date, competition.slug]
    .filter(Boolean)
    .join(' | ');

  const chips: { label: string; value: unknown }[] = [
    { label: 'Source', value: prediction.source },
    { label: 'Mode', value: prediction.readiness?.mode },
    { label: 'Model', value: modelName },
    { label: 'Features', value: featureContract },
    { label: 'Builder', value: prediction.builder_version },
  ];

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden"
    >
      <Card className="border-2 border-[hsl(20_40%_93.5%/1)] bg-[hsl(20_40%_98.5%/1)] dark:border-[hsl(20_15%_16%/1)] dark:bg-[hsl(20_15%_10%/1)]">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Prediction Details</CardTitle>
          <div className="flex items-center gap-3">
            <Badge variant="success-light">{summary}</Badge>
            <Show when={!!prediction.generated_at}>
              <time className="text-xs text-muted-foreground">
                {new Date(prediction.generated_at).toLocaleString()}
              </time>
            </Show>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <For each={chips.filter((c) => c.value)}>
              {(chip) => (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(20_40%_96%/1)] px-2.5 py-1 text-xs dark:bg-[hsl(20_15%_13%/1)]">
                  <span className="text-muted-foreground">{chip.label}</span>
                  <span className="font-medium">{String(chip.value)}</span>
                </span>
              )}
            </For>
          </div>

          <Show when={!!eventMeta}>
            <p className="text-xs text-muted-foreground">{eventMeta}</p>
          </Show>

          <Separator />

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Scored Lineup</h3>
              <ol className="space-y-1 text-xs text-muted-foreground">
                <For each={(audit.lineup ?? []) as any[]}>
                  {(row, i) => (
                    <li key={i()}>
                      {row.performance_order ?? '-'} | {row.corps} ({row.division ?? 'unknown'})
                    </li>
                  )}
                </For>
              </ol>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Excluded</h3>
              <ol className="space-y-1 text-xs text-muted-foreground">
                <For each={(audit.exclusions ?? []) as any[]}>
                  {(row, i) => (
                    <li key={i()}>
                      {row.performance_order ?? '-'} | {row.unit_name} — {row.exclusion_reason}
                    </li>
                  )}
                </For>
              </ol>
            </div>
          </div>

          <Show when={(prediction.caveats ?? []).length > 0}>
            <Alert variant="warning">
              <AlertTitle>Caveats</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  <For each={prediction.caveats as string[]}>
                    {(c, i) => <li key={i()}>{c}</li>}
                  </For>
                </ul>
              </AlertDescription>
            </Alert>
          </Show>
        </CardContent>
      </Card>
    </motion.div>
  );
}
