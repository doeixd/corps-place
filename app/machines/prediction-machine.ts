import { setup, assign, fromPromise } from 'xstate';
import { getHybridPrediction } from '@/lib/server-fns/hybrid';
import type { EventPredictionRequest } from '@/lib/event-prediction-api';
import * as PredictionPredicates from '@/predicates/prediction';
import {
  cycleSort,
  rollScenario,
  encodeSorts,
  decodeSorts,
  SCENARIO_WINDOWS,
  type RangeKey,
  type RecapRow,
  type ScenarioWindow,
  type SortDir,
  type SortEntry,
  type SortMode,
} from '@/lib/prediction-scenario';
import { createRng, randomSeed } from '@/lib/seeded-rng';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

export type { SortDir, SortEntry, SortMode };

/** Which of the three tri-modal recap views is active (see SCORES_PREDICTION_DIFF_TABS_PLAN). */
export type PredictionView = 'scores' | 'prediction' | 'diff';

/** Loaded prediction payload (same shape the route loader returns). */
export type Prediction = NonNullable<Awaited<ReturnType<typeof getHybridPrediction>>>;

// The compact recap columns (Total + each aggregate + the 8 subcaptions) are
// shared across all three views, so a sort on one is mirrored onto the others'
// sort lists. `sorts` keys both the Scores and Prediction views (they share the
// same row shape); `diffSorts` keys the Diff view. The key space is identical
// (`RangeKey`), so every key overlaps — direction mirrors 1:1. Follows the
// compact↔full mirroring precedent in `score-table-machine.ts:24-59`.
const dirOf = (arr: readonly SortEntry[], key: RangeKey): SortDir | null =>
  arr.find((s) => s.key === key)?.dir ?? null;

// Reflect a shared column's post-cycle direction onto the other view's sort
// list, matching the same none→desc→asc + stack/exclusive placement so the two
// stay consistent without disturbing that view's view-only sorts.
const mirrorSort = (
  target: readonly SortEntry[],
  key: RangeKey,
  newDir: SortDir | null,
  mode: SortMode
): SortEntry[] => {
  const make = (dir: SortDir): SortEntry => ({ key, dir });
  const without = target.filter((s) => s.key !== key);
  if (mode === 'exclusive') return newDir ? [make(newDir)] : [];
  if (newDir === null) return without;
  // `desc` = freshly added in the source → becomes primary here too.
  if (newDir === 'desc') return [make('desc'), ...without];
  // `asc` = an existing sort flipped → update in place, or add if absent.
  return target.some((s) => s.key === key)
    ? target.map((s) => (s.key === key ? make('asc') : s))
    : [make('asc'), ...target];
};

export interface PredictionContext {
  slug: string | null;
  request: Partial<EventPredictionRequest>;
  prediction: Prediction | null;
  error: string | null;
  // Tri-modal view (Scores / Prediction / Diff). Additive: with no scores the
  // page stays on the default `prediction` view and behaves exactly as before.
  view: PredictionView;
  // Actual scored recap (real scores), seeded from the route loader. `null` when
  // no scores exist yet (today's normal 2026 case) → only the Prediction view.
  scoredRecap: RecapRow[] | null;
  // Sort list for the Diff view, parallel to `sorts` (which keys Scores +
  // Prediction). Shared columns mirror direction between the two lists.
  diffSorts: SortEntry[];
  // Scenario (Monte Carlo) state — owned by the machine, derived for display in the component.
  baseRecap: RecapRow[];
  currentRecap: RecapRow[];
  scenarioCount: number;
  // Seed of the currently displayed roll (null = base prediction, not rolled).
  // Deterministically reproduces `currentRecap` via `createRng` — stored in the URL.
  seed: string | null;
  window: ScenarioWindow;
  showRanges: boolean;
  classFilters: string[];
  // Column sort: ordered list of active sorts (click order = priority). `exclusive`
  // keeps one column at a time; `stack` keeps the whole list.
  sortMode: SortMode;
  sorts: SortEntry[];
  groupByClass: boolean;
  // Whether the user explicitly chose a grouping. While false, `groupByClass`
  // tracks the data-driven default (grouped when the recap spans >1 class) and
  // is kept out of the URL; an explicit choice is persisted.
  groupTouched: boolean;
}

export type PredictionEvent =
  | { type: 'SET_SLUG'; slug: string }
  | { type: 'SET_MODE'; mode: string }
  | { type: 'SET_PERCENT_THROUGH'; percentThrough: string | number }
  | { type: 'SET_FORCE'; force: boolean }
  | { type: 'SET_REFRESH'; refresh: boolean }
  | { type: 'LOAD_PREDICTION' }
  | { type: 'RESET' }
  // Scenario events
  | { type: 'ROLL' }
  | { type: 'APPLY_SCENARIO'; seed: string }
  | { type: 'RESET_SCENARIO' }
  | { type: 'SET_WINDOW'; window: ScenarioWindow }
  | { type: 'SET_RANGES'; showRanges: boolean }
  | { type: 'SET_CLASS_FILTERS'; classFilters: string[] }
  | { type: 'SET_GROUP_BY_CLASS'; groupByClass: boolean }
  // Switch the active tri-modal view (preserves shared sort/group/filter state).
  | { type: 'SET_VIEW'; view: PredictionView }
  // Column sorting
  | { type: 'CYCLE_SORT'; key: RangeKey }
  | { type: 'SET_SORTS'; sorts: SortEntry[] }
  | { type: 'SET_SORT_MODE'; mode: SortMode }
  // URL → machine: apply a decoded slice of view state (see useSearchSync).
  | SyncEvent<PredictionContext>;

const initialScenario = {
  baseRecap: [] as RecapRow[],
  currentRecap: [] as RecapRow[],
  scenarioCount: 0,
  seed: null as string | null,
  window: '0.8' as ScenarioWindow,
  showRanges: false,
  classFilters: [] as string[],
  sortMode: 'exclusive' as SortMode,
  sorts: [] as SortEntry[],
  diffSorts: [] as SortEntry[],
  groupByClass: false,
  groupTouched: false,
};

/** Whether a recap spans more than one division/class (the auto-group default). */
const multiClass = (recap: RecapRow[]): boolean => {
  const seen = new Set<string>();
  for (const row of recap) if (row.division) seen.add(row.division);
  return seen.size > 1;
};

// Optional seed supplied by the route loader (SSR / preloaded prediction) so the
// machine can start in `ready` with no client fetch / first-load spinner. The
// view-state fields let it hydrate directly from the URL (see useSearchSync), so
// initial context matches the search params with no mount-time round trip.
export interface PredictionInput {
  slug?: string;
  prediction?: Prediction | null;
  seed?: string | null;
  window?: ScenarioWindow;
  showRanges?: boolean;
  classFilters?: string[];
  sortMode?: SortMode;
  sorts?: SortEntry[];
  diffSorts?: SortEntry[];
  groupByClass?: boolean;
  scenarioCount?: number;
  // Initial tri-modal view (from the URL codec). When omitted the context init
  // picks the dynamic default: `scores` if scoredRecap exists, else `prediction`.
  view?: PredictionView;
  // Actual scored recap rows, seeded from the route loader's recap data.
  scoredRecap?: RecapRow[] | null;
}

const recapOf = (prediction: Prediction | null | undefined): RecapRow[] =>
  (prediction?.recap ?? []) as RecapRow[];

export const predictionMachine = setup({
  types: {
    context: {} as PredictionContext,
    events: {} as PredictionEvent,
    input: {} as PredictionInput,
  },
  actions: {
    updateRequestMode: assign({
      request: ({ context, event }) => ({
        ...context.request,
        mode: (event as Extract<PredictionEvent, { type: 'SET_MODE' }>).mode,
      }),
    }),
    updateRequestPercent: assign({
      request: ({ context, event }) => {
        const { percentThrough } = event as Extract<
          PredictionEvent,
          { type: 'SET_PERCENT_THROUGH' }
        >;
        return {
          ...context.request,
          percentThrough:
            typeof percentThrough === 'number' ? percentThrough.toString() : percentThrough,
        };
      },
    }),
    updateRequestForce: assign({
      request: ({ context, event }) => ({
        ...context.request,
        force: (event as Extract<PredictionEvent, { type: 'SET_FORCE' }>).force,
      }),
    }),
    updateRequestRefresh: assign({
      request: ({ context, event }) => ({
        ...context.request,
        refresh: (event as Extract<PredictionEvent, { type: 'SET_REFRESH' }>).refresh,
      }),
    }),
    // When a freshly loaded prediction arrives, rebuild the recap. Preserve the
    // current view state (window/filter/sort), and if a seed is set (e.g. one
    // hydrated from the URL before the recap loaded), roll its scenario now that
    // `baseRecap` exists — otherwise show the base recap.
    seedScenarioFromPrediction: assign(({ context, event }) => {
      const output = (event as { output?: Prediction }).output;
      const base: RecapRow[] = recapOf(output).map((row) => ({ ...row }));
      const hasSeed = !!context.seed && base.length > 0;
      return {
        baseRecap: base,
        currentRecap: hasSeed
          ? rollScenario(base, context.window, createRng(context.seed!))
          : base.map((row) => ({ ...row })),
        scenarioCount: hasSeed ? 1 : 0,
        // Apply the data-driven grouping default unless the user chose explicitly.
        groupByClass: context.groupTouched ? context.groupByClass : multiClass(base),
      };
    }),
    // View-aware sort cycle: dispatch to the active view's sort list (`sorts`
    // for Scores/Prediction, `diffSorts` for Diff) and mirror the resulting
    // direction onto the other list, since every compact column is shared.
    cycleSort: assign(({ context, event }) => {
      if (event.type !== 'CYCLE_SORT') return {};
      if (context.view === 'diff') {
        const diffSorts = cycleSort(context.diffSorts, event.key, context.sortMode);
        return {
          diffSorts,
          sorts: mirrorSort(context.sorts, event.key, dirOf(diffSorts, event.key), context.sortMode),
        };
      }
      const sorts = cycleSort(context.sorts, event.key, context.sortMode);
      return {
        sorts,
        diffSorts: mirrorSort(
          context.diffSorts,
          event.key,
          dirOf(sorts, event.key),
          context.sortMode
        ),
      };
    }),
    // Switch view. Shared sort/group/class-filter state is held in single
    // context fields (sorts/diffSorts/groupByClass/classFilters) and is never
    // cleared here, so it is preserved across views by construction. Sort
    // direction is already kept mirrored between `sorts` and `diffSorts` by
    // `cycleSort`, so no re-mirror is needed on switch.
    setView: assign({
      view: ({ event }) => (event as Extract<PredictionEvent, { type: 'SET_VIEW' }>).view,
    }),
    // Collapsing to single-column keeps only the highest-priority sort.
    setSortMode: assign(({ context, event }) => {
      const { mode } = event as Extract<PredictionEvent, { type: 'SET_SORT_MODE' }>;
      return {
        sortMode: mode,
        sorts: mode === 'exclusive' ? context.sorts.slice(0, 1) : context.sorts,
        diffSorts: mode === 'exclusive' ? context.diffSorts.slice(0, 1) : context.diffSorts,
      };
    }),
    // Replace the whole sort list at once (used to hydrate from the URL).
    setSorts: assign({
      sorts: ({ event }) => (event as Extract<PredictionEvent, { type: 'SET_SORTS' }>).sorts,
    }),
    // Mint a fresh seed and roll deterministically from it; the seed lands in the URL.
    roll: assign(({ context }) => {
      const seed = randomSeed();
      return {
        seed,
        currentRecap: rollScenario(context.baseRecap, context.window, createRng(seed)),
        scenarioCount: context.scenarioCount + 1,
      };
    }),
    // Reproduce a roll from a given seed (URL hydration) — no new seed minted.
    applyScenario: assign(({ context, event }) => {
      const { seed } = event as Extract<PredictionEvent, { type: 'APPLY_SCENARIO' }>;
      return {
        seed,
        currentRecap: rollScenario(context.baseRecap, context.window, createRng(seed)),
        scenarioCount: 1,
      };
    }),
    resetScenario: assign(({ context }) => ({
      currentRecap: context.baseRecap.map((row) => ({ ...row })),
      scenarioCount: 0,
      seed: null,
    })),
  },
  actors: {
    loadPrediction: fromPromise(
      async ({ input }: { input: { slug: string; request: Partial<EventPredictionRequest> } }) => {
        const { request } = input;

        const fullRequest: EventPredictionRequest = {
          slug: input.slug,
          mode: PredictionPredicates.isValidPredictionMode(request.mode) ? request.mode : 'auto',
          // Leave percentThrough undefined unless the user explicitly set it, so the
          // SDK auto-computes season progress from the event date (the legacy
          // default). Hardcoding '50' inflated/reordered scores.
          percentThrough: PredictionPredicates.isValidPercentThrough(request.percentThrough)
            ? String(request.percentThrough)
            : undefined,
          force: !!request.force,
          refresh: !!request.refresh,
          modelDir: request.modelDir,
          division: request.division,
        };
        return await getHybridPrediction({ data: fullRequest });
      }
    ),
  },
}).createMachine({
  id: 'prediction',
  type: 'parallel',
  context: ({ input }) => {
    const base = recapOf(input?.prediction).map((row) => ({ ...row }));
    const window = input?.window ?? initialScenario.window;
    const seed = input?.seed ?? null;
    // Seed-hydrated view: roll the scenario now if the recap is already present;
    // otherwise keep the seed and roll once it loads (seedScenarioFromPrediction).
    const rolled = seed && base.length > 0;
    const scoredRecap = input?.scoredRecap ?? null;
    return {
      slug: input?.slug ?? null,
      request: { mode: 'auto' },
      prediction: input?.prediction ?? null,
      error: null,
      ...initialScenario,
      // Tri-modal view. Explicit URL choice wins; otherwise the dynamic default
      // shows real data first (`scores` when scored data exists, else `prediction`).
      view: input?.view ?? (scoredRecap ? 'scores' : 'prediction'),
      scoredRecap,
      diffSorts: input?.diffSorts ?? initialScenario.diffSorts,
      window,
      showRanges: input?.showRanges ?? initialScenario.showRanges,
      classFilters: input?.classFilters ?? initialScenario.classFilters,
      sortMode: input?.sortMode ?? initialScenario.sortMode,
      sorts: input?.sorts ?? initialScenario.sorts,
      // Grouping: an explicit URL choice wins; otherwise default from the data
      // (grouped when the recap spans >1 class). `groupTouched` records whether
      // the value is explicit so it's only persisted to the URL when it is.
      groupByClass: input?.groupByClass ?? multiClass(base),
      groupTouched: input?.groupByClass !== undefined,
      seed,
      // Restore the roll count from the URL (input.scenarioCount) when present;
      // otherwise a seeded view implies 1, an unseeded one 0.
      scenarioCount: input?.scenarioCount ?? (rolled ? 1 : 0),
      baseRecap: base,
      currentRecap: rolled
        ? rollScenario(base, window, createRng(seed))
        : base.map((row) => ({ ...row })),
    };
  },
  states: {
    status: {
      initial: 'idle',
      states: {
        idle: {
          // If the loader seeded a prediction, skip the client fetch and render it.
          always: {
            guard: ({ context }) => context.prediction != null,
            target: 'ready',
          },
          on: {
            LOAD_PREDICTION: {
              guard: ({ context }) => typeof context.slug === 'string' && context.slug.length > 0,
              target: 'loading',
            },
          },
        },
        loading: {
          invoke: {
            src: 'loadPrediction',
            input: ({ context }) => ({
              slug: context.slug!,
              request: context.request,
            }),
            onDone: {
              target: 'ready',
              actions: [
                assign({
                  prediction: ({ event }) => event.output,
                  error: () => null,
                }),
                'seedScenarioFromPrediction',
              ],
            },
            onError: {
              target: 'error',
              actions: assign({
                error: ({ event }) => (event.error as any)?.message ?? 'Prediction failed',
                prediction: () => null,
              }),
            },
          },
        },
        error: {
          on: {
            LOAD_PREDICTION: 'loading',
          },
        },
        ready: {
          on: {
            LOAD_PREDICTION: 'loading',
          },
        },
      },
    },
    params: {
      on: {
        SET_SLUG: {
          actions: assign({ slug: ({ event }) => event.slug }),
        },
        SET_MODE: { actions: 'updateRequestMode' },
        SET_PERCENT_THROUGH: { actions: 'updateRequestPercent' },
        SET_FORCE: { actions: 'updateRequestForce' },
        SET_REFRESH: { actions: 'updateRequestRefresh' },
        // Scenario controls
        ROLL: { actions: 'roll' },
        APPLY_SCENARIO: { actions: 'applyScenario' },
        RESET_SCENARIO: { actions: 'resetScenario' },
        // Selecting a likelihood only affects the displayed *ranges*, so turn
        // ranges on — otherwise picking a likelihood appears to do nothing (the
        // point scores don't depend on the window).
        SET_WINDOW: {
          actions: assign({ window: ({ event }) => event.window, showRanges: () => true }),
        },
        SET_RANGES: { actions: assign({ showRanges: ({ event }) => event.showRanges }) },
        SET_CLASS_FILTERS: { actions: assign({ classFilters: ({ event }) => event.classFilters }) },
        SET_GROUP_BY_CLASS: {
          actions: assign({
            groupByClass: ({ event }) => event.groupByClass,
            groupTouched: () => true,
          }),
        },
        SET_VIEW: { actions: 'setView' },
        CYCLE_SORT: { actions: 'cycleSort' },
        SET_SORTS: { actions: 'setSorts' },
        SET_SORT_MODE: { actions: 'setSortMode' },
        // URL → machine (see useSearchSync): apply the decoded view slice. Unlike
        // SET_WINDOW this does *not* force ranges on (the URL carries the real
        // ranges value), and a seed re-rolls its scenario when the recap is loaded.
        SYNC: {
          actions: assign(({ context, event }) => {
            const p = event.patch;
            const next = { ...context };
            if (p.window !== undefined) next.window = p.window;
            if (p.showRanges !== undefined) next.showRanges = p.showRanges;
            if (p.classFilters !== undefined) next.classFilters = p.classFilters;
            if (p.sortMode !== undefined) next.sortMode = p.sortMode;
            if (p.sorts !== undefined) next.sorts = p.sorts;
            if (p.diffSorts !== undefined) next.diffSorts = p.diffSorts;
            if (p.view !== undefined) next.view = p.view;
            if (p.groupByClass !== undefined) {
              next.groupByClass = p.groupByClass;
              next.groupTouched = true;
            }
            if (p.seed !== undefined) {
              next.seed = p.seed;
              if (p.seed && next.baseRecap.length > 0) {
                next.currentRecap = rollScenario(next.baseRecap, next.window, createRng(p.seed));
                // Honor a count carried alongside the seed (shared link / refresh);
                // fall back to 1 for a plain seeded link.
                next.scenarioCount = p.scenarioCount ?? 1;
              } else if (!p.seed) {
                next.currentRecap = next.baseRecap.map((row) => ({ ...row }));
                next.scenarioCount = 0;
              }
            } else if (p.scenarioCount !== undefined) {
              next.scenarioCount = p.scenarioCount;
            }
            return next;
          }),
        },
        RESET: {
          actions: assign({
            error: () => null,
            prediction: () => null,
            request: () => ({ mode: 'auto' }),
            slug: () => null,
            ...initialScenario,
          }),
          target: '#prediction.status.idle',
        },
      },
    },
  },
});

/** Search params that mirror the prediction view state. */
export interface PredictionSearchParams {
  seed?: string;
  win?: ScenarioWindow;
  ranges?: boolean;
  cls?: string;
  sort?: string;
  smode?: SortMode;
  group?: boolean;
  /** Roll count, so the "Scenario N" badge survives refresh / shared links. */
  n?: number;
  /** Active tri-modal view; omitted when it equals the dynamic default. */
  view?: PredictionView;
}

const isView = (v: unknown): v is PredictionView =>
  v === 'scores' || v === 'prediction' || v === 'diff';

const isWindow = (v: unknown): v is ScenarioWindow =>
  (SCENARIO_WINDOWS as readonly string[]).includes(v as string);

/**
 * Codec for syncing the prediction view state with the URL (see useSearchSync).
 * Defaults are omitted from the URL so a bare link stays clean; `win` is written
 * whenever a scenario is seeded so a shared roll reproduces under any window.
 */
export const predictionSearchCodec: SearchCodec<PredictionContext, PredictionSearchParams> = {
  encode: (ctx) => ({
    // Omit when it equals the dynamic default (`scores` if real scored data
    // exists, else `prediction`), keeping a bare prediction link clean.
    view: ctx.view !== (ctx.scoredRecap ? 'scores' : 'prediction') ? ctx.view : undefined,
    seed: ctx.seed ?? undefined,
    win: ctx.seed || ctx.window !== '0.8' ? ctx.window : undefined,
    ranges: ctx.showRanges ? true : undefined,
    cls: ctx.classFilters.length > 0 ? ctx.classFilters.join(',') : undefined,
    sort: ctx.sorts.length ? encodeSorts(ctx.sorts) : undefined,
    smode: ctx.sortMode !== 'exclusive' ? ctx.sortMode : undefined,
    // Persist grouping only when the user chose explicitly; the unset default is
    // data-driven (grouped when >1 class) and reproduces from the recap.
    group: ctx.groupTouched ? ctx.groupByClass : undefined,
    // Only persist the count past the implied 1 (init already restores 1 from a seed).
    n: ctx.scenarioCount > 1 ? ctx.scenarioCount : undefined,
  }),
  decode: (s) => ({
    seed: s.seed ?? null,
    window: isWindow(s.win) ? s.win : '0.8',
    showRanges: s.ranges === true,
    classFilters: s.cls?.split(',').filter(Boolean) ?? [],
    sortMode: s.smode === 'stack' || s.smode === 'exclusive' ? s.smode : 'exclusive',
    sorts: decodeSorts(s.sort),
    // Only include grouping when explicitly present so the machine can apply its
    // data-driven default otherwise (see context init / seedScenarioFromPrediction).
    ...(typeof s.group === 'boolean' ? { groupByClass: s.group } : {}),
    ...(typeof s.n === 'number' && s.n > 1 ? { scenarioCount: s.n } : {}),
    // Only include the view when explicitly present in the URL so the machine
    // applies its dynamic default (scores-first) otherwise — decode has no
    // scoredRecap to compute the default from (see context init).
    ...(isView(s.view) ? { view: s.view } : {}),
  }),
};
