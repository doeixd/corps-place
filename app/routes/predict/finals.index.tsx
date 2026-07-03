// Drum Corps Finals Predictions (PREDICTION_BALLOT_PLAN M1–M3 + caption cards).
// Drag corps into your predicted finals order — Overall plus one card per
// caption, swiped/chip-switched. Defaults come from the MODEL's predicted
// championship ranking; the ▲▼ arrows compare YOUR order against each corps'
// PRIOR-SEASON championship placement (per caption on caption cards). The
// original /predict/palette is untouched.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FilterChips, type FilterChipItem } from '@/components/filter-chips';
import { BallotList, type BallotCorps } from '@/components/ballot/ballot-list';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { corpsLogoSource } from '@/components/corps-logo';
import { SignInButton } from '@/components/sign-in-button';
import { ShareButton } from '@/components/share-button';
import { seoHead, siteBase } from '@/lib/seo';
import { getRankingSeasons } from '@/lib/server-fns/rankings';
import {
  lockBallot,
  myBallots,
  getPredictionPool,
  BALLOT_CAPTIONS,
  type BallotCaption,
  type PredictionPoolCorps,
} from '@/lib/server-fns/ballot';
import { useSession } from '@/lib/auth-client';
import { useAsyncAction } from '@/lib/use-async-action';
import { recapGroup } from '@/lib/prediction-scenario';
import { track } from '@/lib/analytics/client';

// ── presets ───────────────────────────────────────────────────────────────────
const PRESETS = ['finals', 'semis', 'world', 'open', 'all'] as const;
type Preset = (typeof PRESETS)[number];
const PRESET_LABELS: Record<Preset, string> = {
  finals: 'Finalists (12)',
  semis: 'Semifinalists (25)',
  world: 'World Class',
  open: 'Open Class',
  all: 'All corps',
};

// ── dimensions (Overall + one card per caption) ───────────────────────────────
type Dim = 'overall' | BallotCaption;
const DIMENSIONS: Dim[] = ['overall', ...BALLOT_CAPTIONS];
const DIM_LABELS: Record<Dim, string> = {
  overall: 'Overall',
  GE1: 'GE 1',
  GE2: 'GE 2',
  VP: 'Visual Prof.',
  VA: 'Visual Anal.',
  CG: 'Color Guard',
  MB: 'Brass',
  MA: 'Music Anal.',
  MP: 'Percussion',
};

// A PredictionPoolCorps is structurally a BallotCorps (same identity/logo
// fields), so pool rows feed BallotList directly.
interface RankedCorps extends PredictionPoolCorps {
  group: string;
}

/** The preset's corps, in the pool's (predicted) order. */
function presetSlice(rows: RankedCorps[], preset: Preset): RankedCorps[] {
  const world = rows.filter((r) => r.group === 'world');
  const open = rows.filter((r) => r.group === 'open');
  switch (preset) {
    case 'finals':
      return world.slice(0, 12);
    case 'semis':
      return world.slice(0, 25);
    case 'world':
      return world;
    case 'open':
      return open;
    case 'all':
      return rows;
  }
}

interface BallotSearch {
  preset?: Preset;
  /** Edited Overall order — `~`-joined corps slugs. Absent = model's default. */
  o?: string;
  // Edited caption orders (same encoding), keyed by caption.
  GE1?: string;
  GE2?: string;
  VP?: string;
  VA?: string;
  CG?: string;
  MB?: string;
  MA?: string;
  MP?: string;
}

// URL order params: `~`-joined slug lists so an arrangement is shareable (and
// creatable) WITHOUT signing in — the URL is the draft; locking in is where
// sign-in happens. Slugs only (never indexes): the pool's predicted order
// changes nightly, so positional encodings would corrupt shared links.
const ORDER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const parseOrderParam = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const parts = v.split('~');
  return parts.length >= 2 && parts.every((p) => ORDER_SLUG_RE.test(p)) ? v : undefined;
};

export const Route = createFileRoute('/predict/finals/')({
  validateSearch: (s: Record<string, unknown>): BallotSearch => ({
    preset: PRESETS.includes(s.preset as Preset) ? (s.preset as Preset) : undefined,
    o: parseOrderParam(s.o),
    ...Object.fromEntries(BALLOT_CAPTIONS.map((c) => [c, parseOrderParam(s[c])])),
  }),
  loader: async () => {
    const { seasons } = await getRankingSeasons();
    const season = seasons[0] ?? '2026';
    // EVERY corps performing this season (event lineups, so pre-debut corps are
    // included), pre-ordered by the model's PREDICTED finals ranking. One fetch
    // covers every preset (they're client-side slices of this pool).
    const rows = await getPredictionPool({ data: season });
    const pool: RankedCorps[] = rows.map((r) => ({
      ...r,
      group: recapGroup(r.division),
    }));
    // og:image for shared links: capture ?o=/preset from the REQUEST during SSR
    // (crawlers never run JS, and the loader has no search deps by design — a
    // client-side reorder doesn't need fresh meta). Dynamic import keeps the
    // server module out of the client bundle.
    let ogQuery = '';
    if (typeof document === 'undefined') {
      try {
        const { getWebRequest } = await import('@tanstack/react-start/server');
        const url = new URL(getWebRequest().url);
        const qp = new URLSearchParams();
        const o = url.searchParams.get('o');
        const preset = url.searchParams.get('preset');
        if (o) qp.set('o', o);
        if (preset) qp.set('preset', preset);
        qp.set('season', season);
        ogQuery = `?${qp.toString()}`;
      } catch {
        /* non-request SSR context — generic image */
      }
    }
    return { season, pool, ogQuery };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: `${loaderData?.season ?? ''} Drum Corps Finals Predictions — make your DCI picks`.trim(),
      description:
        `Predict the ${loaderData?.season ?? ''} DCI World Championship Finals: drag World Class and Open Class drum corps into your predicted finals order — overall and by caption — starting from the model's projected rankings, then lock in and share your prediction.`.trim(),
      path: '/predict/finals',
      image: `${siteBase().url}/api/og/finals${loaderData?.ogQuery ?? ''}`,
    }),
  staleTime: 5 * 60_000,
  component: BallotPage,
});

// sessionStorage autosave: a sign-in round-trip or accidental nav must not lose
// an arranged prediction. Keyed per season+preset; v2 stores per-dimension
// orders. Restored orders are reconciled against the live pool (departed corps
// drop; membership changes flow from the Overall card).
type Orders = Partial<Record<Dim, string[]>>;
const draftKey = (season: string, preset: Preset) => `finals-draft-v2:${season}:${preset}`;
const loadDraft = (season: string, preset: Preset): Orders | null => {
  try {
    const raw = sessionStorage.getItem(draftKey(season, preset));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Orders;
  } catch {
    return null;
  }
};
const saveDraft = (season: string, preset: Preset, orders: Orders): void => {
  try {
    sessionStorage.setItem(draftKey(season, preset), JSON.stringify(orders));
  } catch {
    /* private mode — draft just isn't persisted */
  }
};

/** Order `members` by a per-corps metric (desc), stable on the incoming order. */
const orderByMetric = (
  members: string[],
  metric: (slug: string) => number | null | undefined
): string[] =>
  members
    .map((slug, i) => ({ slug, i, v: metric(slug) }))
    .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity) || a.i - b.i)
    .map((x) => x.slug);

/** Positions (1-based) of `members` ordered by a prior-season rank (asc). */
const baselineFromPrior = (
  members: string[],
  prior: (slug: string) => number | null | undefined
): Map<string, number> => {
  const ranked = members
    .map((slug) => ({ slug, r: prior(slug) }))
    .filter((x): x is { slug: string; r: number } => typeof x.r === 'number')
    .sort((a, b) => a.r - b.r);
  return new Map(ranked.map((x, i) => [x.slug, i + 1]));
};

function BallotPage() {
  const { season, pool } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();
  const preset: Preset = search.preset ?? 'finals';
  const { data: session } = useSession();

  const [title, setTitle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [dim, setDim] = useState<Dim>('overall');
  const [addOpen, setAddOpen] = useState(false);
  const [saved, setSaved] = useState<
    Array<{ ballotId: string; title: string | null; preset: string; lockedAt: string }>
  >([]);
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    void myBallots()
      .then((rows) => {
        if (!cancelled) setSaved(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  const corpsBySlug = useMemo(
    () => new Map<string, RankedCorps>(pool.map((c) => [c.corpsSlug, c])),
    [pool]
  );
  const defaultOverall = useMemo(
    () => presetSlice(pool, preset).map((c) => c.corpsSlug),
    [pool, preset]
  );

  // Orders encoded in the URL (shared links / signed-out creation). Read via a
  // ref inside the seed effect so param writes don't re-trigger seeding.
  const urlOrders = useMemo(() => {
    const out: Orders = {};
    if (search.o) out.overall = search.o.split('~');
    for (const c of BALLOT_CAPTIONS) {
      const v = search[c];
      if (typeof v === 'string' && v) out[c] = v.split('~');
    }
    return out;
  }, [search]);
  const urlOrdersRef = useRef(urlOrders);
  urlOrdersRef.current = urlOrders;

  // Per-dimension orders. `overall` is always present; a caption key exists only
  // once the user has touched that card (untouched cards derive from the model's
  // predicted caption scores at render time and are omitted from the lock).
  const [orders, setOrders] = useState<Orders>({ overall: defaultOverall });

  useEffect(() => {
    const sanitize = (src: Orders): Orders => {
      const clean: Orders = {};
      for (const [k, list] of Object.entries(src)) {
        const valid = (list ?? []).filter((slug) => corpsBySlug.has(slug));
        if (valid.length >= 2) clean[k as Dim] = valid;
      }
      return clean;
    };
    // URL params win (a shared link IS the draft); else this browser's draft.
    const fromUrl = sanitize(urlOrdersRef.current);
    if (fromUrl.overall || Object.keys(fromUrl).length > 0) {
      setOrders({ overall: fromUrl.overall ?? defaultOverall, ...fromUrl });
    } else {
      const draft = loadDraft(season, preset);
      const clean = draft ? sanitize(draft) : {};
      setOrders(clean.overall || Object.keys(clean).length ? { overall: clean.overall ?? defaultOverall, ...clean } : { overall: defaultOverall });
    }
    setDim('overall');
  }, [season, preset, defaultOverall, corpsBySlug]);

  const membership = orders.overall ?? defaultOverall;

  // The list shown for the current card: explicit order when touched, else the
  // membership sorted by the model's predicted score for that dimension.
  const currentOrder = useMemo(() => {
    if (dim === 'overall') return membership;
    const touched = orders[dim];
    if (touched) {
      const inSet = new Set(membership);
      const kept = touched.filter((s) => inSet.has(s));
      const missing = membership.filter((s) => !touched.includes(s));
      return [...kept, ...missing];
    }
    return orderByMetric(membership, (slug) => corpsBySlug.get(slug)?.predictedCaptions?.[dim]);
  }, [dim, membership, orders, corpsBySlug]);

  // ▲▼ baseline = PRIOR-SEASON championship placement (per caption on caption
  // cards), positioned within the current corps set. Corps that didn't appear at
  // last season's championship simply show no arrow.
  const baselineRanks = useMemo(
    () =>
      baselineFromPrior(currentOrder, (slug) =>
        dim === 'overall'
          ? corpsBySlug.get(slug)?.priorRank
          : corpsBySlug.get(slug)?.priorCaptionRanks?.[dim]
      ),
    [currentOrder, dim, corpsBySlug]
  );

  const sameList = (a: string[] | undefined, b: string[]) =>
    !!a && a.length === b.length && a.every((x, i) => b[i] === x);
  const applyOrders = (next: Orders) => {
    setOrders(next);
    saveDraft(season, preset, next);
    // Mirror to the URL so the current arrangement is shareable without an
    // account — default (untouched) dims stay out to keep the URL short.
    void navigate({
      search: (prev) => ({
        ...prev,
        o: next.overall && !sameList(next.overall, defaultOverall) ? next.overall.join('~') : undefined,
        ...Object.fromEntries(BALLOT_CAPTIONS.map((c) => [c, next[c]?.join('~')])),
      }),
      replace: true,
      resetScroll: false, // param writes are state mirrors, not navigation
    });
  };
  const updateCurrent = (list: string[]) => {
    applyOrders({ ...orders, [dim]: list });
  };

  const overallEdited =
    membership.length !== defaultOverall.length ||
    membership.some((slug, i) => defaultOverall[i] !== slug);
  const currentEdited = dim === 'overall' ? overallEdited : Boolean(orders[dim]);
  const touchedCaptions = BALLOT_CAPTIONS.filter((c) => Boolean(orders[c]));

  const addable = useMemo(() => {
    const inBallot = new Set(membership);
    return pool.filter((c) => !inBallot.has(c.corpsSlug));
  }, [pool, membership]);

  // Horizontal swipe between caption cards (drag stays on the row handles).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('[aria-label^="Reorder"]')) return;
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 64 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const idx = DIMENSIONS.indexOf(dim);
    const next = DIMENSIONS[idx + (dx < 0 ? 1 : -1)];
    if (next) {
      track('ballot_dim', { dim: next, via: 'swipe' });
      setDim(next);
    }
  };

  const lock = useAsyncAction(async () => {
    const entries = (list: string[]) =>
      list
        .map((slug) => corpsBySlug.get(slug))
        .filter((c): c is RankedCorps => Boolean(c))
        .map((c) => ({ slug: c.corpsSlug, name: c.corpsName }));
    const res = await lockBallot({
      data: {
        season,
        preset: membership.length !== defaultOverall.length ? 'custom' : preset,
        title: title.trim() || undefined,
        displayName: displayName.trim() || undefined,
        overall: entries(membership),
        captions: touchedCaptions.length
          ? Object.fromEntries(
              touchedCaptions.map((c) => [
                c,
                entries([...(orders[c] ?? [])].filter((s) => membership.includes(s))),
              ])
            )
          : undefined,
      },
    });
    track('ballot_lock', { preset, n: membership.length, captions: touchedCaptions.length });
    await routerNavigate({ to: '/predict/finals/$id', params: { id: res.ballotId } });
  });

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={`${season} Drum Corps Finals Predictions`}
        subtitle={`Predict the ${season} DCI World Championship Finals: every World Class and Open Class corps performing this season, pre-ordered by the model’s projected finals ranking. Drag to make it yours — overall and caption by caption — it autosaves in this browser until you lock it in.`}
        subtitleClassName="text-sm"
      />

      {saved.length > 0 ? (
        <div className="flex items-center">
          <select
            aria-label="My saved predictions"
            className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-text-secondary"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) void routerNavigate({ to: '/predict/finals/$id', params: { id } });
            }}
          >
            <option value="">My predictions ({saved.length})</option>
            {saved.map((b) => (
              <option key={b.ballotId} value={b.ballotId}>
                {(b.title || `${PRESET_LABELS[b.preset as Preset] ?? b.preset} prediction`) +
                  ` — ${new Date(b.lockedAt).toLocaleDateString()}`}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-text-secondary">Corps set</span>
        <FilterChips
          ariaLabel="Preset"
          className="min-w-0"
          value={preset}
          items={PRESETS.map((p): FilterChipItem => ({ value: p, label: PRESET_LABELS[p] }))}
          onSelect={(p) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                preset: p === 'finals' ? undefined : (p as Preset),
                o: undefined,
                ...Object.fromEntries(BALLOT_CAPTIONS.map((c) => [c, undefined])),
              }),
              replace: true,
              resetScroll: false,
            })
          }
        />
      </div>

      {/* Caption cards: chips switch, horizontal swipe on touch. A dot marks
          cards you've arranged (they're the ones saved when you lock in). Reset
          lives out here, above the list section it acts on. */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-text-secondary">Ranking</span>
        <FilterChips
          ariaLabel="Prediction dimension"
          className="min-w-0 flex-1"
          value={dim}
          items={DIMENSIONS.map((d): FilterChipItem => ({
            value: d,
            label: orders[d as BallotCaption] && d !== 'overall' ? `${DIM_LABELS[d]} •` : DIM_LABELS[d],
          }))}
          onSelect={(d) => {
            track('ballot_dim', { dim: d, via: 'chip' });
            setDim(d as Dim);
          }}
        />
        {currentEdited ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              track('ballot_reset', { preset, dim });
              if (dim === 'overall') applyOrders({ ...orders, overall: defaultOverall });
              else {
                const next = { ...orders };
                delete next[dim];
                applyOrders(next);
              }
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-2 pb-4" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <BallotList
            order={currentOrder}
            corps={corpsBySlug}
            baselineRanks={baselineRanks}
            onReorder={(next) => {
              track('ballot_reorder', { preset, dim, n: next.length });
              updateCurrent(next);
            }}
            onRemove={
              dim === 'overall'
                ? (slug) => {
                    track('ballot_remove', { preset });
                    applyOrders({ ...orders, overall: membership.filter((s) => s !== slug) });
                  }
                : undefined
            }
          />

          <p className="mt-3 text-xs text-muted-foreground">
            {dim === 'overall'
              ? `Drag to reorder · ▲▼ vs each corps' ${Number(season) - 1} championship placement · swipe for captions · tap a name to open its page.`
              : orders[dim]
                ? `Your ${DIM_LABELS[dim]} order · ▲▼ vs ${Number(season) - 1} finals ${DIM_LABELS[dim]} rank.`
                : `Model's predicted ${DIM_LABELS[dim]} order — drag to make it yours · ▲▼ vs ${Number(season) - 1} finals rank.`}
          </p>

          {/* Membership edits live on the Overall card; captions inherit its corps set. */}
          {dim === 'overall' ? (
            <div className="mt-4 border-t border-border pt-3">
              <Button variant="ghost" size="sm" onClick={() => setAddOpen((o) => !o)}>
                {addOpen ? 'Hide' : `+ Add corps (${addable.length} more)`}
              </Button>
              {addOpen ? (
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {addable.map((c) => (
                    <button
                      key={c.corpsSlug}
                      type="button"
                      onClick={() => {
                        track('ballot_add', { preset });
                        applyOrders({ ...orders, overall: [...membership, c.corpsSlug] });
                      }}
                      className="flex items-center gap-2 rounded-lg border border-border p-2 text-left text-sm hover:bg-muted"
                    >
                      <CorpsNameCell
                        name={c.corpsName}
                        slug={null}
                        logo={corpsLogoSource({
                          corps_logo: c.corpsLogo ?? null,
                          corps_logo_dark: c.corpsLogoDark ?? null,
                          corps_logo_dark_url: c.corpsLogoDarkUrl ?? null,
                        })}
                        logoClassName="size-5 sm:size-5"
                        className="min-w-0 flex-1"
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">add</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Share the working arrangement — the URL carries the full state, so no
          account is needed to create or share; locking in is where sign-in lives. */}
      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          <div>
            <h2 className="font-semibold">Share this prediction</h2>
            <p className="text-sm text-muted-foreground">
              Your arrangement lives in the link — share it as-is, no account needed. Anyone who
              opens it can keep editing their own copy.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ShareButton
              url={typeof window !== 'undefined' ? window.location.href : ''}
              title={`My ${season} drum corps finals prediction`}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                track('ballot_image_download', { locked: false });
                const qp = new URLSearchParams(window.location.search);
                qp.set('season', season);
                const res = await fetch(`/api/og/finals?${qp.toString()}`);
                const blob = await res.blob();
                const href = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = href;
                a.download = `finals-prediction-${season}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(href);
              }}
            >
              Download image
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Lock it in: immutable once saved — a new take is a new prediction. */}
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <div>
            <h2 className="font-semibold">Lock it in</h2>
            <p className="text-sm text-muted-foreground">
              Signing in is only needed here: locking saves this prediction permanently under your
              account — it can't be edited afterward (you can always lock a new one). Your Overall order
              {touchedCaptions.length
                ? ` and ${touchedCaptions.length} caption ${touchedCaptions.length === 1 ? 'order' : 'orders'}`
                : ''}{' '}
              will be saved, with a share link and an image of your rankings.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="ballot-title">Prediction name (optional)</Label>
              <Input
                id="ballot-title"
                value={title}
                maxLength={80}
                placeholder={`e.g. My ${season} finals call`}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="ballot-name">Your name (optional — shown on the image)</Label>
              <Input
                id="ballot-name"
                value={displayName}
                maxLength={60}
                placeholder="e.g. Patrick"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </div>
          {session?.user ? (
            <Button
              className="w-full sm:w-auto"
              disabled={lock.busy || membership.length < 2}
              onClick={() => void lock.run()}
            >
              {lock.busy ? 'Locking…' : 'Lock it in'}
            </Button>
          ) : (
            <div className="flex flex-col gap-1">
              <SignInButton callbackURL="/predict/finals" className="w-full sm:w-auto">
                Sign in to lock it in
              </SignInButton>
              <p className="text-xs text-muted-foreground">
                Your arrangement is saved in this browser and will still be here after signing in.
              </p>
            </div>
          )}
          {lock.error ? <p className="text-sm text-destructive">{lock.error}</p> : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}
