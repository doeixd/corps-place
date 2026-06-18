// Pure model + derivations for the full DCI-style recap (per-judge breakdown).
// Kept React-free so it's testable and so the component stays presentational.
//
// The recap data is a tree: corps → categories → captions → judges →
// subcaptions. The table is a flat grid: one *leaf column* per sortable value.
// This module flattens the tree into ordered leaves, indexes each corps for O(1)
// value lookup, and provides scope-aware sorting + per-column ranking that mirror
// the compact recap table (`score-recap-table.tsx`).

import {
  recapGroup,
  RECAP_GROUP_ORDER,
  RECAP_GROUP_LABELS,
  type FullSortEntry,
  type RecapGroupKey,
  type SortMode,
} from '@/lib/prediction-scenario';
import type { FullRecapCorps, FullRecapJudge } from '@/components/prediction/full-recap-table';

// Display order for the category bands; unknown categories sort after, by name.
const CATEGORY_ORDER = ['General Effect', 'Visual', 'Music'];
const catOrder = (name: string) => {
  const i = CATEGORY_ORDER.indexOf(name);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

export type LeafKind =
  | 'subcaption' // a judge's Rep/Perf/Cont/Achv sub-score
  | 'judgeTot' // a judge's caption total
  | 'categorySub' // a category subtotal (the "Sub" column inside GE/Visual/Music)
  | 'subtotal' // overall subtotal across categories
  | 'penalty'
  | 'total';

export interface LeafJudge {
  id: string;
  name: string | null;
  initials: string | null;
  number: number | null;
}

/** One sortable column. `id` is opaque, URL-safe (no `,`/`!`), and stable. */
export interface FullLeaf {
  id: string;
  kind: LeafKind;
  label: string;
  category?: string;
  caption?: string;
  captionInitials?: string | null;
  judge?: LeafJudge;
}

/** A judge's column group within a caption (its subcaption leaves + the judge total). */
export interface JudgeCol {
  caption: string;
  captionInitials: string | null;
  judge: LeafJudge;
  leaves: FullLeaf[];
}

/** A caption within a band (e.g. "General Effect 1"), spanning its judge columns. */
export interface CaptionGroup {
  caption: string;
  captionInitials: string | null;
  judges: JudgeCol[];
}

/** A category band (General Effect / Visual / Music): its captions + its "Sub" leaf. */
export interface CategoryBand {
  category: string;
  captions: CaptionGroup[];
  /** Flat judge list across captions, in render order (matches body cell order). */
  judges: JudgeCol[];
  subLeaf: FullLeaf;
}

/** A standalone right-side column (Sub Total / Penalties / Total). */
export interface TailCol {
  leaf: FullLeaf;
}

export interface FullRecapModel {
  bands: CategoryBand[];
  tails: TailCol[];
  /** All leaves in render order — the value/sort/rank space. */
  leaves: FullLeaf[];
  hasPenalty: boolean;
}

// Leaf-id parts are joined with `~` and must avoid `,` and `!` (the URL sort
// delimiters in prediction-scenario). Sanitize the free-text pieces.
const safe = (s: string) => s.replace(/[,!~]/g, '_');

/**
 * Build the column model from the corps that exposes the most captions, so a
 * partial top row never truncates the grid.
 */
export const buildFullRecapModel = (corps: readonly FullRecapCorps[]): FullRecapModel => {
  const richest = corps.reduce<FullRecapCorps | null>(
    (best, c) =>
      !best ||
      c.categories.flatMap((cat) => cat.captions).length >
        best.categories.flatMap((cat) => cat.captions).length
        ? c
        : best,
    null
  );

  const orderedCats = [...(richest?.categories ?? [])].sort(
    (a, b) => catOrder(a.category) - catOrder(b.category) || a.category.localeCompare(b.category)
  );

  const leaves: FullLeaf[] = [];
  const bands: CategoryBand[] = orderedCats.map((cat) => {
    const judges: JudgeCol[] = [];
    const captions: CaptionGroup[] = [];
    for (const cap of cat.captions) {
      const capJudges: JudgeCol[] = [];
      for (const j of cap.judges) {
        const judge: LeafJudge = {
          id: j.judgeId,
          name: j.name,
          initials: j.initials,
          number: j.number,
        };
        const jLeaves: FullLeaf[] = [];
        // Some recaps carry aliased subcaptions for the same box (e.g. GE judges
        // expose both "Performance" and "Performance Effect", both initials
        // "Perf", with identical scores). Collapse by initials (then name) so a
        // judge shows each box once (Rep/Perf or Cont/Achv) — matching dci.org.
        const seenSub = new Set<string>();
        for (const s of j.subcaptions) {
          const dedupeKey = (s.initials ?? s.name).toLowerCase();
          if (seenSub.has(dedupeKey)) continue;
          seenSub.add(dedupeKey);
          const leaf: FullLeaf = {
            id: `${safe(cap.caption)}~${safe(j.judgeId)}~${safe(s.name)}`,
            kind: 'subcaption',
            label: s.initials ?? s.name,
            category: cat.category,
            caption: cap.caption,
            captionInitials: cap.initials,
            judge,
          };
          jLeaves.push(leaf);
          leaves.push(leaf);
        }
        const totLeaf: FullLeaf = {
          id: `${safe(cap.caption)}~${safe(j.judgeId)}~TOT`,
          kind: 'judgeTot',
          label: 'TOT',
          category: cat.category,
          caption: cap.caption,
          captionInitials: cap.initials,
          judge,
        };
        jLeaves.push(totLeaf);
        leaves.push(totLeaf);
        const col: JudgeCol = {
          caption: cap.caption,
          captionInitials: cap.initials,
          judge,
          leaves: jLeaves,
        };
        capJudges.push(col);
        judges.push(col);
      }
      captions.push({
        caption: cap.caption,
        captionInitials: cap.initials,
        judges: capJudges,
      });
    }
    const subLeaf: FullLeaf = {
      id: `cat~${safe(cat.category)}`,
      kind: 'categorySub',
      label: 'Sub',
      category: cat.category,
    };
    leaves.push(subLeaf);
    return { category: cat.category, captions, judges, subLeaf };
  });

  const hasPenalty = corps.some((c) => (c.penalty ?? 0) !== 0);
  // Sub Total only differs from Total when a penalty is applied; if every corps'
  // subtotal equals its total the column is redundant, so show Total alone.
  const showSubtotal = corps.some(
    (c) => c.subtotal != null && c.total != null && c.subtotal !== c.total
  );
  const tails: TailCol[] = [
    ...(showSubtotal
      ? [
          {
            leaf: {
              id: 'subtotal',
              kind: 'subtotal',
              label: 'Sub Total',
            } as FullLeaf,
          },
        ]
      : []),
    ...(hasPenalty
      ? [
          {
            leaf: { id: 'penalty', kind: 'penalty', label: 'Pen.' } as FullLeaf,
          },
        ]
      : []),
    { leaf: { id: 'total', kind: 'total', label: 'Total' } },
  ];
  for (const t of tails) leaves.push(t.leaf);

  return { bands, tails, leaves, hasPenalty };
};

// ---- per-corps value index --------------------------------------------------

export interface CorpsIndex {
  cat: Map<string, number | null>; // category → subtotal
  judge: Map<string, number | null>; // `${caption}|${judgeId}` → judge caption total
  sub: Map<string, number | null>; // `${caption}|${judgeId}|${subName}` → sub-score
  subtotal: number | null;
  penalty: number | null;
  total: number | null;
}

const jkey = (caption: string, judgeId: string) => `${caption}|${judgeId}`;
const skey = (caption: string, judgeId: string, sub: string) => `${caption}|${judgeId}|${sub}`;

export const indexCorps = (c: FullRecapCorps): CorpsIndex => {
  const cat = new Map<string, number | null>();
  const judge = new Map<string, number | null>();
  const sub = new Map<string, number | null>();
  for (const category of c.categories) {
    cat.set(category.category, category.score);
    for (const cap of category.captions) {
      for (const j of cap.judges) {
        judge.set(jkey(cap.caption, j.judgeId), j.score);
        for (const s of j.subcaptions) sub.set(skey(cap.caption, j.judgeId, s.name), s.score);
      }
    }
  }
  return {
    cat,
    judge,
    sub,
    subtotal: c.subtotal ?? null,
    penalty: c.penalty ?? null,
    total: c.total ?? null,
  };
};

/** Read a leaf's numeric value for an indexed corps (null when absent). */
export const leafValue = (leaf: FullLeaf, idx: CorpsIndex): number | null => {
  switch (leaf.kind) {
    case 'subcaption':
      return idx.sub.get(skey(leaf.caption!, leaf.judge!.id, leafSubName(leaf))) ?? null;
    case 'judgeTot':
      return idx.judge.get(jkey(leaf.caption!, leaf.judge!.id)) ?? null;
    case 'categorySub':
      return idx.cat.get(leaf.category!) ?? null;
    case 'subtotal':
      return idx.subtotal;
    case 'penalty':
      return idx.penalty;
    case 'total':
      return idx.total;
  }
};

// Subcaption leaves key their value by the subcaption *name*, but the label may
// be the initials. We stored the name in the id's last segment; recover it.
const leafSubName = (leaf: FullLeaf): string => {
  const parts = leaf.id.split('~');
  return parts[parts.length - 1];
};

// ---- sorting ----------------------------------------------------------------

/**
 * Sort corps by the active leaf sorts (exclusive: first entry only; stack: all,
 * in priority order), missing values sinking to the bottom, with the corps'
 * overall rank as a stable final tiebreak — matching the compact table.
 */
export const sortFullCorps = (
  corps: readonly FullRecapCorps[],
  index: Map<string, CorpsIndex>,
  leafById: Map<string, FullLeaf>,
  sorts: readonly FullSortEntry[],
  _mode: SortMode
): FullRecapCorps[] => {
  if (sorts.length === 0) return [...corps];
  const active = sorts
    .map((s) => ({ leaf: leafById.get(s.key), dir: s.dir }))
    .filter((s): s is { leaf: FullLeaf; dir: 'asc' | 'desc' } => s.leaf !== undefined);
  if (active.length === 0) return [...corps];
  return [...corps].sort((a, b) => {
    const ia = index.get(a.corpsKey)!;
    const ib = index.get(b.corpsKey)!;
    for (const { leaf, dir } of active) {
      const av = leafValue(leaf, ia);
      const bv = leafValue(leaf, ib);
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return dir === 'desc' ? bv - av : av - bv;
    }
    return (a.rank ?? Infinity) - (b.rank ?? Infinity);
  });
};

// ---- grouping ---------------------------------------------------------------

export interface FullSection {
  key: RecapGroupKey | null;
  label: string | null;
  corps: FullRecapCorps[];
}

export const groupFullCorps = (
  corps: readonly FullRecapCorps[],
  groupByClass: boolean,
  classCount: number
): FullSection[] => {
  if (!groupByClass || classCount <= 1) {
    return [{ key: null, label: null, corps: [...corps] }];
  }
  const byGroup = new Map<RecapGroupKey, FullRecapCorps[]>();
  for (const c of corps) {
    const key = recapGroup(c.division);
    const arr = byGroup.get(key);
    if (arr) arr.push(c);
    else byGroup.set(key, [c]);
  }
  return RECAP_GROUP_ORDER.filter((k) => byGroup.has(k)).map((k) => ({
    key: k,
    label: RECAP_GROUP_LABELS[k],
    corps: byGroup.get(k)!,
  }));
};

export const fullClassCount = (corps: readonly FullRecapCorps[]): number => {
  const set = new Set<string>();
  for (const c of corps) if (c.division) set.add(c.division);
  return set.size;
};

// ---- ranking ----------------------------------------------------------------

/**
 * Per-leaf rank of each corps within a scope (visible rows, or one section when
 * grouped). Higher score = rank 1; ties share the lower rank. Returns
 * `leafId → corpsKey → rankString`. Recomputed over scope so it tracks
 * filtering/grouping, exactly like the compact table's caption ranks.
 */
export const computeLeafRanks = (
  sections: readonly FullSection[],
  index: Map<string, CorpsIndex>,
  leaves: readonly FullLeaf[]
): Map<string, Map<string, string>> => {
  const byLeaf = new Map<string, Map<string, string>>();
  for (const leaf of leaves) {
    const map = new Map<string, string>();
    for (const section of sections) {
      const ranked = section.corps
        .map((c) => ({
          key: c.corpsKey,
          v: leafValue(leaf, index.get(c.corpsKey)!),
        }))
        .filter((x): x is { key: string; v: number } => x.v !== null && !Number.isNaN(x.v))
        .sort((a, b) => b.v - a.v);
      ranked.forEach((x, i) => {
        if (i > 0 && x.v === ranked[i - 1].v) map.set(x.key, map.get(ranked[i - 1].key)!);
        else map.set(x.key, String(i + 1));
      });
    }
    byLeaf.set(leaf.id, map);
  }
  return byLeaf;
};

/** Overall (or per-section) corps rank by total, ties sharing the lower rank. */
export const computeRowRanks = (sections: readonly FullSection[]): Map<string, string> => {
  const ranks = new Map<string, string>();
  for (const section of sections) {
    const ranked = section.corps
      .map((c) => ({
        key: c.corpsKey,
        rank: c.rank,
        total: typeof c.total === 'number' && !Number.isNaN(c.total) ? c.total : null,
      }))
      .sort((a, b) => {
        if (a.total !== null && b.total !== null && a.total !== b.total) return b.total - a.total;
        if (a.total === null && b.total !== null) return 1;
        if (a.total !== null && b.total === null) return -1;
        return (a.rank ?? Infinity) - (b.rank ?? Infinity);
      });
    ranked.forEach((entry, i) => {
      const prev = ranked[i - 1];
      if (prev && entry.total !== null && entry.total === prev.total) {
        ranks.set(entry.key, ranks.get(prev.key)!);
      } else {
        ranks.set(entry.key, String(i + 1));
      }
    });
  }
  return ranks;
};

const judgeLabel = (j: LeafJudge): string =>
  j.name ?? j.initials ?? (j.number != null ? `Judge ${j.number}` : 'Judge');
export { judgeLabel };

// Known subcaption initials → full words, for tooltips. The recap data usually
// already carries the full name (recovered via `leafSubName`); this only kicks
// in when a feed gives initials with no spelled-out name.
const SUBCAPTION_FULL: Record<string, string> = {
  rep: 'Repertoire',
  perf: 'Performance',
  cont: 'Content',
  achv: 'Achievement',
};

/** Full, spelled-out name of a subcaption leaf (expands known initials). */
const leafSubFull = (leaf: FullLeaf): string => {
  const name = leafSubName(leaf);
  // `name` is the data's subcaption name; prefer it when it's more than the
  // abbreviation shown in the column header, otherwise expand the initials.
  if (name && name.toLowerCase() !== leaf.label.toLowerCase()) return name;
  return SUBCAPTION_FULL[leaf.label.toLowerCase()] ?? name;
};

/**
 * A plain-language description of a column for header tooltips, expanding the
 * table's terse labels (Rep/Perf/Cont/Achv, TOT, Sub, Pen.) so the dense grid
 * stays legible.
 */
export const leafTooltip = (leaf: FullLeaf): string => {
  switch (leaf.kind) {
    case 'subcaption':
      return `${leaf.caption} · ${judgeLabel(leaf.judge!)} · ${leafSubFull(leaf)}`;
    case 'judgeTot':
      return `${leaf.caption} · ${judgeLabel(leaf.judge!)} · caption total`;
    case 'categorySub':
      return `${leaf.category} subtotal`;
    case 'subtotal':
      return 'Subtotal — sum of caption scores, before penalties';
    case 'penalty':
      return 'Penalties';
    case 'total':
      return 'Total score';
  }
};

export type { FullRecapJudge };
