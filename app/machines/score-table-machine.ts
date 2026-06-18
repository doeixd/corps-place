import { setup, assign } from 'xstate';
import {
  cycleSort,
  cycleSortGeneric,
  decodeFullSorts,
  decodeSorts,
  encodeFullSorts,
  encodeSorts,
  type FullSortEntry,
  type RangeKey,
  type RecapRow,
  type SortDir,
  type SortEntry,
  type SortMode,
} from '@/lib/prediction-scenario';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

export type { SortMode };

// Columns that exist in BOTH the compact and full recap, so a sort on one is
// mirrored to the other (keeping the views in step). Compact `RangeKey` ⇄ full
// leaf id: Total, and each category subtotal (the full recap's "Sub" column,
// id `cat~<Category>` — see `app/lib/full-recap.ts`).
const COMPACT_TO_FULL: Partial<Record<RangeKey, string>> = {
  total: 'total',
  GE: 'cat~General Effect',
  Visual: 'cat~Visual',
  Music: 'cat~Music',
};
const FULL_TO_COMPACT: Record<string, RangeKey> = {
  total: 'total',
  'cat~General Effect': 'GE',
  'cat~Visual': 'Visual',
  'cat~Music': 'Music',
};

const dirOf = (arr: readonly { key: string; dir: SortDir }[], key: string): SortDir | null =>
  arr.find((s) => s.key === key)?.dir ?? null;

// Reflect a shared column's post-cycle direction onto the other view's sort
// list, matching the same none→desc→asc + stack/exclusive placement so the two
// stay consistent without disturbing that view's view-only sorts.
const mirrorSort = <E extends { key: string; dir: SortDir }>(
  target: readonly E[],
  mappedKey: E['key'],
  newDir: SortDir | null,
  mode: SortMode
): E[] => {
  const make = (dir: SortDir) => ({ key: mappedKey, dir }) as E;
  const without = target.filter((s) => s.key !== mappedKey);
  if (mode === 'exclusive') return newDir ? [make(newDir)] : [];
  if (newDir === null) return without;
  // `desc` = freshly added in the source → becomes primary here too.
  if (newDir === 'desc') return [make('desc'), ...without];
  // `asc` = an existing sort flipped → update in place, or add if absent.
  return target.some((s) => s.key === mappedKey)
    ? target.map((s) => (s.key === mappedKey ? make('asc') : s))
    : [make('asc'), ...target];
};

export interface ScoreTableContext {
  rows: RecapRow[];
  classFilters: string[];
  sortMode: SortMode;
  sorts: SortEntry[];
  showRanges: boolean;
  groupByClass: boolean;
  // Whether the user explicitly chose a grouping. While false, `groupByClass`
  // tracks the data-driven default (grouped when the rows span >1 class) and is
  // kept out of the URL; an explicit choice is persisted.
  groupTouched: boolean;
  // Whether the full DCI-style recap (per-judge breakdown) is expanded.
  showFullRecap: boolean;
  // Sort state for the full recap's per-judge leaf columns. Separate key space
  // from `sorts` (which keys the compact `RangeKey` columns) so neither view
  // clobbers the other; the shared `sortMode` governs whichever table is shown.
  fullSorts: FullSortEntry[];
}

/** Whether the rows span more than one division/class (the auto-group default). */
const multiClass = (rows: RecapRow[]): boolean => {
  const seen = new Set<string>();
  for (const row of rows) if (row.division) seen.add(row.division);
  return seen.size > 1;
};

export type ScoreTableEvent =
  | { type: 'SET_ROWS'; rows: RecapRow[] }
  | { type: 'SET_CLASS_FILTERS'; classFilters: string[] }
  | { type: 'CYCLE_SORT'; key: RangeKey }
  | { type: 'SET_SORTS'; sorts: SortEntry[] }
  | { type: 'SET_SORT_MODE'; mode: SortMode }
  | { type: 'SET_SHOW_RANGES'; showRanges: boolean }
  | { type: 'SET_GROUP_BY_CLASS'; groupByClass: boolean }
  | { type: 'SET_SHOW_FULL_RECAP'; showFullRecap: boolean }
  | { type: 'CYCLE_FULL_SORT'; key: string }
  | { type: 'SET_FULL_SORTS'; sorts: FullSortEntry[] }
  | SyncEvent<ScoreTableContext>;

const initialContext: Omit<ScoreTableContext, 'rows'> = {
  classFilters: [] as string[],
  sortMode: 'exclusive' as SortMode,
  sorts: [] as SortEntry[],
  showRanges: false,
  groupByClass: false,
  groupTouched: false,
  showFullRecap: false,
  fullSorts: [] as FullSortEntry[],
};

export interface ScoreTableInput {
  rows?: RecapRow[];
  classFilters?: string[];
  sortMode?: SortMode;
  sorts?: SortEntry[];
  showRanges?: boolean;
  groupByClass?: boolean;
  showFullRecap?: boolean;
  fullSorts?: FullSortEntry[];
}

export const scoreTableMachine = setup({
  types: {
    context: {} as ScoreTableContext,
    events: {} as ScoreTableEvent,
    input: {} as ScoreTableInput,
  },
  actions: {
    // Cycle a compact column, mirroring the change onto the full recap when the
    // column is shared (Total / category subtotals).
    cycleSort: assign(({ context, event }) => {
      if (event.type !== 'CYCLE_SORT') return {};
      const sorts = cycleSort(context.sorts, event.key, context.sortMode);
      const mapped = COMPACT_TO_FULL[event.key];
      if (!mapped) return { sorts };
      const fullSorts = mirrorSort(
        context.fullSorts,
        mapped,
        dirOf(sorts, event.key),
        context.sortMode
      );
      return { sorts, fullSorts };
    }),
    // Cycle a full-recap leaf, mirroring onto the compact view when shared.
    cycleFullSort: assign(({ context, event }) => {
      if (event.type !== 'CYCLE_FULL_SORT') return {};
      const fullSorts = cycleSortGeneric(context.fullSorts, event.key, context.sortMode);
      const mapped = FULL_TO_COMPACT[event.key];
      if (!mapped) return { fullSorts };
      const sorts = mirrorSort(
        context.sorts,
        mapped,
        dirOf(fullSorts, event.key),
        context.sortMode
      );
      return { fullSorts, sorts };
    }),
  },
}).createMachine({
  id: 'scoreTable',
  context: ({ input }) => ({
    rows: input?.rows ?? [],
    classFilters: input?.classFilters ?? initialContext.classFilters,
    sortMode: input?.sortMode ?? initialContext.sortMode,
    sorts: input?.sorts ?? initialContext.sorts,
    showRanges: input?.showRanges ?? initialContext.showRanges,
    // Grouping: an explicit URL choice wins; otherwise default from the data
    // (grouped when the rows span >1 class). `groupTouched` records whether the
    // value is explicit so it's only persisted to the URL when it is.
    groupByClass: input?.groupByClass ?? multiClass(input?.rows ?? []),
    groupTouched: input?.groupByClass !== undefined,
    showFullRecap: input?.showFullRecap ?? initialContext.showFullRecap,
    fullSorts: input?.fullSorts ?? initialContext.fullSorts,
  }),
  on: {
    SET_ROWS: {
      // Re-apply the data-driven grouping default for the new rows unless the
      // user already chose explicitly.
      actions: assign(({ context, event }) => {
        if (event.type !== 'SET_ROWS') return {};
        return {
          rows: event.rows,
          groupByClass: context.groupTouched ? context.groupByClass : multiClass(event.rows),
        };
      }),
    },
    SET_CLASS_FILTERS: {
      actions: assign({ classFilters: ({ event }) => event.classFilters }),
    },
    CYCLE_SORT: {
      actions: 'cycleSort',
    },
    SET_SORTS: {
      actions: assign({ sorts: ({ event }) => event.sorts }),
    },
    SET_SORT_MODE: {
      actions: assign({ sortMode: ({ event }) => event.mode }),
    },
    SET_SHOW_RANGES: {
      actions: assign({ showRanges: ({ event }) => event.showRanges }),
    },
    SET_GROUP_BY_CLASS: {
      actions: assign({
        groupByClass: ({ event }) => event.groupByClass,
        groupTouched: () => true,
      }),
    },
    SET_SHOW_FULL_RECAP: {
      actions: assign({ showFullRecap: ({ event }) => event.showFullRecap }),
    },
    CYCLE_FULL_SORT: {
      actions: 'cycleFullSort',
    },
    SET_FULL_SORTS: {
      actions: assign({ fullSorts: ({ event }) => event.sorts }),
    },
    SYNC: {
      actions: assign(({ context, event }) => {
        const patch = event.patch as Partial<ScoreTableContext>;
        return {
          ...context,
          ...patch,
          // An explicit grouping arriving from the URL marks the choice as the
          // user's, so it stays persisted.
          groupTouched: patch.groupByClass !== undefined ? true : context.groupTouched,
        };
      }),
    },
  },
});

// The route's `validateSearch` already coerces these to booleans, but tolerate
// the raw string form too so the codec is robust on its own.
const readBool = (v: unknown): boolean | undefined =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;

export const scoreTableSearchCodec: SearchCodec<ScoreTableContext, Record<string, unknown>> = {
  // Every managed key is emitted on every encode — `undefined` for defaults — so
  // clearing a value actually removes it from the URL. useSearchSync mirrors via
  // `{ ...currentSearch, ...encode(ctx) }` then strips `undefined`; a key omitted
  // here would leave the stale URL value in place (it never gets overridden), so
  // Clear Filters / un-sorting wouldn't persist and would re-hydrate on refresh.
  encode: (ctx) => ({
    sort: ctx.sorts.length > 0 ? encodeSorts(ctx.sorts) : undefined,
    smode: ctx.sortMode !== 'exclusive' ? ctx.sortMode : undefined,
    ranges: ctx.showRanges ? true : undefined,
    cls: ctx.classFilters.length > 0 ? ctx.classFilters.join(',') : undefined,
    // Persist grouping only when the user chose explicitly; the unset default is
    // data-driven (grouped when >1 class) and reproduces from the rows.
    group: ctx.groupTouched ? ctx.groupByClass : undefined,
    recap: ctx.showFullRecap ? 'full' : undefined,
    fsort: ctx.fullSorts.length > 0 ? encodeFullSorts(ctx.fullSorts) : undefined,
  }),
  decode: (search) => {
    const sort = typeof search.sort === 'string' ? search.sort : undefined;
    const smode =
      search.smode === 'stack' || search.smode === 'exclusive' ? search.smode : undefined;
    const cls =
      typeof search.cls === 'string' && search.cls.length > 0
        ? search.cls.split(',').filter(Boolean)
        : [];
    const group = readBool(search.group);
    return {
      sorts: sort ? decodeSorts(sort) : [],
      sortMode: smode ?? 'exclusive',
      showRanges: readBool(search.ranges) ?? false,
      classFilters: cls,
      // Only include grouping when explicitly present so the machine can apply
      // its data-driven default otherwise (see context init / SET_ROWS).
      ...(group !== undefined ? { groupByClass: group } : {}),
      showFullRecap: search.recap === 'full',
      fullSorts: decodeFullSorts(typeof search.fsort === 'string' ? search.fsort : undefined),
    };
  },
};
