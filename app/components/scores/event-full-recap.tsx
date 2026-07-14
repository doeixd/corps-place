import { useMemo, useState } from 'react';
import {
  FullRecapTableStatic,
  type FullEventRecap,
} from '@/components/prediction/full-recap-table-static';
import {
  cycleSortGeneric,
  type FullSortEntry,
  type SortMode,
  type RecapRow,
} from '@/lib/prediction-scenario';
import { useStickyScroll } from '@/lib/table-interactions';
import { CorpsRegistryProvider } from '@/components/corps-registry';

export interface RecapCorpsRef {
  corps_key: string | null;
  slug: string | null;
  name: string | null;
  division_name?: string | null;
  // Logo fields — consumed by CorpsRegistryProvider so CorpsNameCell can resolve
  // each corps's logo inside the recap table.
  corps_logo?: string | null;
  corps_logo_dark?: number | null;
  corps_logo_dark_url?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * One event's full DCI recap, self-contained: it owns the sort / class-filter /
 * sticky-scroll interaction state so a page can drop it in with just the recap +
 * a corps list (for name links). Used by `/scores/$slug` and the `/scores` index.
 */
export function EventFullRecap({
  recap,
  corps,
  yearSlug,
  animateRows,
}: {
  recap: FullEventRecap;
  corps: RecapCorpsRef[];
  yearSlug?: string;
  /** Forwarded to FullRecapTable — off on the `/scores` index (many tables). */
  animateRows?: boolean;
}) {
  const [sorts, setSorts] = useState<FullSortEntry[]>([]);
  const [classFilters, setClassFilters] = useState<string[]>([]);
  const sortMode: SortMode = 'exclusive';
  const onStickyScroll = useStickyScroll();

  const corpsLookup = useMemo(() => {
    type Info = { slug: string | null; division: string | null };
    const byKey = new Map<string, Info>();
    const byName = new Map<string, Info>();
    for (const c of corps) {
      const info: Info = { slug: c.slug ?? null, division: c.division_name ?? null };
      if (c.corps_key) byKey.set(c.corps_key, info);
      if (c.name) byName.set(norm(c.name), info);
    }
    return (row: RecapRow): Info | undefined => {
      const ck = typeof row.corps_key === 'string' ? row.corps_key : null;
      const nm = typeof row.corps === 'string' ? row.corps : null;
      return (ck ? byKey.get(ck) : undefined) ?? (nm ? byName.get(norm(nm)) : undefined);
    };
  }, [corps]);

  return (
    <CorpsRegistryProvider corps={corps}>
      <FullRecapTableStatic
        recap={recap}
        corpsLookup={corpsLookup}
        classFilters={classFilters}
        onSetClassFilters={setClassFilters}
        // Group recap rows into division sections (World/Open/…), each with its
        // own recomputed ranks. groupFullCorps no-ops for single-division events,
        // so those still render as one flat table.
        groupByClass={true}
        sorts={sorts}
        sortMode={sortMode}
        onCycleSort={(key) => setSorts((s) => cycleSortGeneric(s, key, sortMode))}
        yearSlug={yearSlug}
        onStickyScroll={onStickyScroll}
        animateRows={animateRows}
      />
    </CorpsRegistryProvider>
  );
}
