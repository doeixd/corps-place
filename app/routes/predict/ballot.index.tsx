// Prediction Ballot (PREDICTION_BALLOT_PLAN M1) — palette v2. Drag corps into
// your predicted finals order (season-high standing for non-finalists — the same
// quantity /rankings shows). M1 scope: presets + the reorderable Overall list +
// add/remove + sessionStorage autosave. Caption cards, lock-in, and sharing land
// in M2–M4. The original /predict/palette is untouched.
import { useEffect, useMemo, useState } from 'react';
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
import { seoHead } from '@/lib/seo';
import { getRankings, getRankingSeasons } from '@/lib/server-fns/rankings';
import { lockBallot, myBallots } from '@/lib/server-fns/ballot';
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

/** The preset's corps slugs, in current-rank order, from the full ranked pool. */
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

interface RankedCorps extends BallotCorps {
  rank: number;
  score: number;
  group: string;
}

interface BallotSearch {
  preset?: Preset;
}

export const Route = createFileRoute('/predict/ballot/')({
  validateSearch: (s: Record<string, unknown>): BallotSearch => ({
    preset: PRESETS.includes(s.preset as Preset) ? (s.preset as Preset) : undefined,
  }),
  loader: async () => {
    const { seasons } = await getRankingSeasons();
    const season = seasons[0] ?? '2026';
    // One fetch covers every preset (they're client-side slices of this pool).
    const result = await getRankings({
      data: { season, metric: 'total', agg: 'best', div: ['world', 'open'] },
    });
    const pool: RankedCorps[] = result.rows.map((r) => ({
      corpsSlug: r.corpsSlug,
      corpsName: r.corpsName,
      division: r.division,
      corpsLogo: r.corpsLogo,
      corpsLogoDark: r.corpsLogoDark,
      corpsLogoDarkUrl: r.corpsLogoDarkUrl,
      rank: r.rank,
      score: r.score,
      group: recapGroup(r.division),
    }));
    return { season, pool };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: `${loaderData?.season ?? ''} Prediction Ballot — rank the corps yourself`.trim(),
      description:
        'Drag drum corps into your predicted finals order, compare against the live DCI rankings, and (soon) lock in and share your ballot.',
      path: '/predict/ballot',
    }),
  staleTime: 5 * 60_000,
  component: BallotPage,
});

// sessionStorage autosave (plan §5): a sign-in round-trip or accidental nav must
// not lose an arranged ballot. Keyed per season+preset; the saved order is
// reconciled against the live pool on restore (departed corps drop, new corps
// append at the bottom).
const draftKey = (season: string, preset: Preset) => `ballot-draft:${season}:${preset}`;
const loadDraft = (season: string, preset: Preset): string[] | null => {
  try {
    const raw = sessionStorage.getItem(draftKey(season, preset));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null;
  } catch {
    return null;
  }
};
const saveDraft = (season: string, preset: Preset, order: string[]): void => {
  try {
    sessionStorage.setItem(draftKey(season, preset), JSON.stringify(order));
  } catch {
    /* private mode — draft just isn't persisted */
  }
};

function BallotPage() {
  const { season, pool } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();
  const preset: Preset = search.preset ?? 'finals';
  const { data: session } = useSession();

  // Lock-in inputs: the prediction's own name + the author name for the image.
  const [title, setTitle] = useState('');
  const [displayName, setDisplayName] = useState('');
  // The signed-in user's saved predictions (dropdown). Fetched client-side so the
  // page itself stays cacheable/anonymous-friendly.
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

  const byArrangement = useMemo(() => {
    const slice = presetSlice(pool, preset);
    return {
      defaultOrder: slice.map((c) => c.corpsSlug),
      // Baseline = the corps' position within THIS preset's current ranking —
      // drives the ▲/▼ "you moved them" indicators.
      baselineRanks: new Map(slice.map((c, i) => [c.corpsSlug, i + 1])),
    };
  }, [pool, preset]);

  const corpsBySlug = useMemo(
    () => new Map<string, BallotCorps>(pool.map((c) => [c.corpsSlug, c])),
    [pool]
  );

  const [order, setOrder] = useState<string[]>(byArrangement.defaultOrder);
  const [addOpen, setAddOpen] = useState(false);

  // Restore the draft (or reset to defaults) whenever the preset changes.
  useEffect(() => {
    const draft = loadDraft(season, preset);
    if (draft) {
      const valid = draft.filter((slug) => corpsBySlug.has(slug));
      setOrder(valid.length > 0 ? valid : byArrangement.defaultOrder);
    } else {
      setOrder(byArrangement.defaultOrder);
    }
    setAddOpen(false);
  }, [season, preset, byArrangement, corpsBySlug]);

  const update = (next: string[]) => {
    setOrder(next);
    saveDraft(season, preset, next);
  };

  const edited =
    order.length !== byArrangement.defaultOrder.length ||
    order.some((slug, i) => byArrangement.defaultOrder[i] !== slug);

  const addable = useMemo(() => {
    const inBallot = new Set(order);
    return pool.filter((c) => !inBallot.has(c.corpsSlug));
  }, [pool, order]);

  const lock = useAsyncAction(async () => {
    const overall = order
      .map((slug) => corpsBySlug.get(slug))
      .filter((c): c is BallotCorps => Boolean(c))
      .map((c) => ({ slug: c.corpsSlug, name: c.corpsName }));
    const res = await lockBallot({
      data: {
        season,
        preset: edited && order.length !== byArrangement.defaultOrder.length ? 'custom' : preset,
        title: title.trim() || undefined,
        displayName: displayName.trim() || undefined,
        overall,
      },
    });
    track('ballot_lock', { preset, n: overall.length });
    await routerNavigate({ to: '/predict/ballot/$id', params: { id: res.ballotId } });
  });

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={`${season} Prediction Ballot`}
        subtitle="Drag corps into your predicted finals order — season-high standing for corps outside finals. Your arrangement autosaves in this browser; locking in and sharing are coming next."
      />

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="Preset"
          className="min-w-0"
          value={preset}
          items={PRESETS.map((p): FilterChipItem => ({ value: p, label: PRESET_LABELS[p] }))}
          onSelect={(p) =>
            void navigate({
              search: (prev) => ({ ...prev, preset: p === 'finals' ? undefined : (p as Preset) }),
              replace: true,
            })
          }
        />
        {edited ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              track('ballot_reset', { preset });
              update(byArrangement.defaultOrder);
            }}
          >
            Reset to current ranks
          </Button>
        ) : null}
        {saved.length > 0 ? (
          <select
            aria-label="My saved predictions"
            className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-text-secondary"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) void routerNavigate({ to: '/predict/ballot/$id', params: { id } });
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
        ) : null}
      </div>

      <Card>
        <CardContent className="py-4">
          <p className="mb-3 text-xs text-muted-foreground">
            Drag the handle to reorder · ▲▼ show how far you've moved a corps from its current
            rank · tap a name to open its page.
          </p>
          <BallotList
            order={order}
            corps={corpsBySlug}
            baselineRanks={byArrangement.baselineRanks}
            onReorder={(next) => {
              track('ballot_reorder', { preset, n: next.length });
              update(next);
            }}
            onRemove={(slug) => {
              track('ballot_remove', { preset });
              update(order.filter((s) => s !== slug));
            }}
          />

          {/* Add corps from outside the preset (plan §2) — appended at the bottom. */}
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
                      update([...order, c.corpsSlug]);
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
        </CardContent>
      </Card>

      {/* Lock it in (plan §5): immutable once saved — a new take is a new ballot. */}
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <div>
            <h2 className="font-semibold">Lock it in</h2>
            <p className="text-sm text-muted-foreground">
              Locking saves this prediction permanently — it can't be edited afterward (you can
              always lock a new one). You'll get a share link with an image of your rankings.
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
              disabled={lock.busy || order.length < 2}
              onClick={() => void lock.run()}
            >
              {lock.busy ? 'Locking…' : 'Lock it in'}
            </Button>
          ) : (
            <div className="flex flex-col gap-1">
              <SignInButton callbackURL="/predict/ballot" className="w-full sm:w-auto">
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
