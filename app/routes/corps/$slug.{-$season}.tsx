import { useEffect, useState } from 'react';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { CorpsSeasonSnapshotRow } from '@/lib/corps-directory';
import { useMachine } from '@xstate/react';
import { For, Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { fadeIn } from '@/lib/motion-variants';
import {
  getCorps,
  getCorpsAppearances,
  getCorpsAppearanceResults,
  getCorpsSeasonScores,
  getCorpsSeasonSnapshots,
  getCorpsMerch,
  getShowDetail,
} from '@/lib/server-fns/hybrid';
import { ProductGrid } from '@/components/merch/product-grid';
import type { CorpsMerchTeaser } from '@/lib/merch-types';
import { loadDetailOrServer } from '@/db/detail-shard';
import { eventFilterMachine } from '@/machines/event-filter-machine';
import { availableSeasons, selectEvents } from '@/lib/event-filtering';
import { cn } from '@/lib/utils';
import { CorpsScoreChart } from '@/components/corps-score-chart';
import { EventCardGrid } from '@/components/event-card';
import { PageHeader } from '@/components/page-header';
import { ScoreNotifyButton } from '@/components/score-notify-button';
import { BackLink } from '@/components/back-link';
import { SeasonChips } from '@/components/filter-chips';
import { useRegisterBackName } from '@/lib/use-register-back-name';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { ClassBadge } from '@/components/class-badge';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { ProgressiveImage } from '@/components/progressive-image';
import { FavoriteCorpsButton } from '@/components/favorite-corps-button';
import { toFavoriteInput } from '@/stores/favorite-corps-store';
import { Icon, type IconComponent } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  Facebook01Icon as FacebookIcon,
  GlobalIcon,
  InstagramIcon,
  Linkedin01Icon,
  Location01Icon as LocationIcon,
  NewTwitterIcon as TwitterIcon,
  YoutubeIcon,
  GiftIcon,
} from '@/components/icons/generated';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';

export const Route = createFileRoute('/corps/$slug/{-$season}')({
  // On client navigation, read the three static corps shards (CDN-cached, no
  // server round-trip); SSR and any fallback use the server fns.
  loader: async ({ params }) => {
    const { slug, season } = params;
    // NOTE: the prediction-history matrix (getCorpsSeasonSnapshots — the chart's
    // "as of" date slider) is deliberately NOT loaded here. TSR serializes loader
    // data into the SSR HTML, and that one dataset bloated this document to 651KB
    // (measured), dominating download + hydration cost on mobile. It's a
    // below-the-fold interactive extra, so the page fetches it client-side after
    // mount instead (see the useSeasonSnapshots hook in the component).
    const [corps, seasonScores, appearances, appearanceResults, corpsMerch] = await Promise.all([
      loadDetailOrServer(`corps/${slug}.json`, () => getCorps({ data: slug })),
      loadDetailOrServer(`corps-scores/${slug}.json`, () => getCorpsSeasonScores({ data: slug })),
      loadDetailOrServer(`corps-appearances/${slug}.json`, () =>
        getCorpsAppearances({ data: slug })
      ),
      // NOTE: called directly, not via loadDetailOrServer — there is no
      // corps-appearance-results shard emitted, so loadDetailOrServer would fetch
      // a 404 (+ manifest) on every client nav before falling back here anyway.
      // getCorpsAppearanceResults is a hybrid server-fn, so this GET is browser-
      // and edge-cacheable (the _serverFn cache rule) — a real cached hop instead
      // of a wasted 404 + fallback.
      getCorpsAppearanceResults({ data: slug }),
      loadDetailOrServer<CorpsMerchTeaser | null>(`corps-merch/${slug}.json`, () =>
        getCorpsMerch({ data: slug })
      ),
    ]);

    // `season` is a path-level view filter over the already-loaded appearances —
    // it doesn't change the data fetched above. Canonicalize the URL so there's
    // exactly one per view: the latest season is the default and lives at the
    // bare `/corps/$slug`, and an unknown season (or one the corps never danced)
    // redirects there too. `all` is only a real view when there are ≥2 seasons.
    const seasons = availableSeasons(appearances);
    const defaultSeason = seasons[0] ?? 'all';
    const validSeasons = new Set(seasons.length > 1 ? [...seasons, 'all'] : seasons);
    if (season !== undefined && (season === defaultSeason || !validSeasons.has(season))) {
      // season must be EXPLICITLY unset: redirect params merge with the current
      // ones, so omitting it kept season in the target URL — an infinite
      // self-redirect (ERR_TOO_MANY_REDIRECTS on /corps/<slug>/<defaultSeason>).
      throw redirect({
        to: '/corps/$slug/{-$season}',
        params: { slug, season: undefined },
        replace: true,
      });
    }

    // The season currently in view (for slicing appearances below). NOTE: "is
    // there a rich show page for this season" (getShowDetail) is NOT resolved
    // here — it only feeds a below-the-fold promo card, and as a sequential
    // dependent hop (needs corps_key from the batch above) it added a second wave
    // to every SSR and a live _serverFn round-trip to every client nav. The
    // component fetches it after mount instead (useShowForSeason).
    const activeSeason = season ?? defaultSeason;

    // Thumbhash for the cover photo — look it up from the media cache during SSR
    // so the placeholder renders instantly with zero network requests. Client-side
    // navigations fall back to the ProgressiveImage fetch (the prop stays null).
    let coverThumbDataUrl: string | null = null;
    if (typeof document === 'undefined' && corps?.corps_photo) {
      try {
        const { getThumbhash } = await import('@/lib/media-cache');
        const hash = await getThumbhash(corps.corps_photo);
        if (hash) {
          const { thumbHashToDataURL } = await import('thumbhash');
          const bytes = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
          coverThumbDataUrl = thumbHashToDataURL(bytes);
        }
      } catch {
        // best-effort — missing thumbhash just means the WebP fallback shows
      }
    }

    return {
      corps,
      seasonScores,
      // Slim the SSR payload: `appearances` is one FULL event-directory row per
      // career appearance (327 rows / ~300KB TSR-serialized for Bluecoats) but a
      // season view renders only that season's shows. Serialize just the active
      // season; the component backfills the career client-side from the immutable
      // corps-appearances shard (useFullAppearances) for season switching. The
      // explicit 'all' view keeps the full list — it IS the content there.
      appearances:
        activeSeason === 'all' ? appearances : appearances.filter((a) => a.season === activeSeason),
      // Season chips + validation need the full season list even though the rows
      // are sliced.
      appearanceSeasons: seasons,
      appearanceResults,
      corpsMerch,
      coverThumbDataUrl,
    };
  },
  head: ({ loaderData, params }) => {
    const d = loaderData;
    if (!d) return {};
    const c = d.corps;
    if (!c) return {};
    const slug = c.slug ?? params.slug;
    const where = c.display_city ? ` from ${c.display_city}` : '';
    const div = c.division_name ? ` (${c.division_name})` : '';
    const image = c.corps_photo ?? c.corps_logo ?? undefined;

    const sameAs = [c.website, c.facebook, c.instagram, c.twitter, c.youtube].filter(
      Boolean
    ) as string[];

    const musicGroup: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'MusicGroup',
      name: c.name,
      url: `${SITE_URL}/corps/${slug}`,
    };
    if (image) musicGroup.image = image;
    if (c.corps_logo) musicGroup.logo = c.corps_logo;
    if (c.about || c.description)
      musicGroup.description = clampDescription(c.about ?? c.description, c.name);
    if (sameAs.length > 0) musicGroup.sameAs = sameAs;
    if (c.city || c.state)
      musicGroup.location = {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: c.city ?? undefined,
          addressRegion: c.state ?? undefined,
          addressCountry: c.country ?? undefined,
        },
      };

    return seoHead({
      title: `${c.name} — Drum Corps${where}${div}`,
      description: clampDescription(
        c.about ?? c.description,
        `${c.name}${where}: scores, schedules, show programs, staff history and official merch on DrumCorps.app.`
      ),
      path: `/corps/${slug}`,
      image,
      jsonLd: [
        musicGroup,
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Corps', path: '/corps' },
          { name: c.name, path: `/corps/${slug}` },
        ]),
      ],
    });
  },
  // Corps detail is read-model data that changes on each emit (nightly predictions
  // + every-5-min score ingest). A short staleTime keeps season tab / revisit nav
  // instant from the router cache while still letting a same-session visitor pick
  // up fresh predictions & actuals (was Infinity, which pinned the whole session to
  // whatever state existed on first view — mid-season score updates never appeared).
  // gcTime stays long so navigating away and back is still a cache hit.
  staleTime: 5 * 60 * 1000,
  gcTime: Infinity,
  component: CorpsDetailPage,
});

type SocialLink = { label: string; href: string | null; icon: IconComponent };

// Client-side fetch of the prediction-history matrix (the chart's "as of" date
// slider). Kept OUT of the route loader on purpose — serialized into the SSR
// document it ballooned the page to 651KB; loaded here it arrives after first
// paint, from the SW/HTTP-cached hybrid server-fn, and the chart's `snapshots`
// prop is optional so the slider simply appears when ready.
function useSeasonSnapshots(slug: string) {
  const [snapshots, setSnapshots] = useState<CorpsSeasonSnapshotRow[]>([]);
  useEffect(() => {
    let live = true;
    setSnapshots([]);
    getCorpsSeasonSnapshots({ data: slug })
      .then((rows) => {
        if (live) setSnapshots(rows ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug]);
  return snapshots;
}

// Client-side fetch of "is there a rich show page for this season" — a
// below-the-fold promo card. Kept off the loader (it was a sequential dependent
// hop on the SSR path + a live _serverFn round-trip on client nav). getShowDetail
// is browser/edge-cacheable (hybrid _serverFn cache rule), so repeat views are
// cheap; the card just fills in shortly after mount.
function useShowForSeason(corpsKey: string | null, season: string) {
  const [show, setShow] = useState<Awaited<ReturnType<typeof getShowDetail>> | null>(null);
  useEffect(() => {
    let live = true;
    setShow(null);
    if (!corpsKey || !season || season === 'all') return;
    getShowDetail({ data: { corpsKey, season } })
      .then((d) => {
        if (live) setShow(d ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [corpsKey, season]);
  return show;
}

// Client-side fetch of the corps's FULL appearance history. The loader slims
// `appearances` to the active season (one full event row per career show was
// ~300KB serialized); this backfills the career after mount — same immutable
// corps-appearances shard, SW/browser-cached — so season switching is instant
// and complete.
function useFullAppearances(slug: string) {
  const [full, setFull] = useState<Awaited<ReturnType<typeof getCorpsAppearances>> | null>(null);
  useEffect(() => {
    let live = true;
    setFull(null);
    loadDetailOrServer(`corps-appearances/${slug}.json`, () => getCorpsAppearances({ data: slug }))
      .then((rows) => {
        if (live && rows) setFull(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug]);
  return full;
}

function CorpsDetailPage() {
  const {
    corps,
    seasonScores,
    appearances: loaderAppearances,
    appearanceSeasons,
    appearanceResults,
    corpsMerch,
    coverThumbDataUrl,
  } = Route.useLoaderData();
  // This corps's per-appearance place + total, keyed by `eventCardKey` (the server
  // returns it so keyed); shown subtly on each appearance card.
  const resultByKey = new Map(Object.entries(appearanceResults ?? {}));
  // Name this entry so back controls reached from here read "Back to <corps>".
  useRegisterBackName(corps?.name);
  // Season is the source of truth in the URL (optional path param): the latest
  // season is the default and lives at the bare URL, other seasons at
  // /corps/$slug/<season>, and "All" at /corps/$slug/all. The loader has already
  // redirected unknown/default-equal seasons, so resolve defensively here and
  // fall back to the default if anything slips through.
  const { slug, season } = Route.useParams();
  const seasonSnapshots = useSeasonSnapshots(slug);
  // Career appearances: prefer the client-fetched full list; until it lands, the
  // loader's active-season slice covers the rendered view (season chips come from
  // the loader's full `appearanceSeasons`, so they never depend on the slice).
  const appearances = useFullAppearances(slug) ?? loaderAppearances;
  const navigate = Route.useNavigate();
  const defaultSeason = appearanceSeasons[0] ?? 'all';
  const isValidSeason = (s: string | undefined): s is string =>
    !!s && (appearanceSeasons.includes(s) || (s === 'all' && appearanceSeasons.length > 1));
  const activeSeason = isValidSeason(season) ? season : defaultSeason;
  // Deferred (below-the-fold show-promo card): fetched after mount so it's off
  // the loader's critical path — see the loader note.
  const showForSeason = useShowForSeason(corps?.corps_key ?? null, activeSeason);
  const goSeason = (next: string) =>
    navigate({
      to: '/corps/$slug/{-$season}',
      // Default season → bare URL (drop the segment) to keep URLs canonical.
      params: { slug, season: next === defaultSeason ? undefined : next },
      replace: true,
      resetScroll: false,
    });

  // Sort direction stays ephemeral (machine-only); season is driven by the URL.
  const [filterState, sendFilter] = useMachine(eventFilterMachine, {
    input: { dir: 'asc', season: activeSeason },
  });
  const filter = filterState.context;
  const orderedAppearances = selectEvents(appearances, {
    season: activeSeason,
    search: filter.search,
    dir: filter.dir,
  });

  if (!corps) {
    return (
      <PageShell>
        <PageHeader title="Corps not found" backTo="/corps" backLabel="Back to Corps" />
        <StatusCard
          tone="empty"
          title="No such corps"
          description="This corps doesn't exist or has no profile yet."
        />
      </PageShell>
    );
  }

  const about = corps.about || corps.description || '';
  const links: SocialLink[] = [
    { label: 'Website', href: corps.website, icon: GlobalIcon },
    { label: 'Facebook', href: corps.facebook, icon: FacebookIcon },
    { label: 'Instagram', href: corps.instagram, icon: InstagramIcon },
    { label: 'Twitter', href: corps.twitter, icon: TwitterIcon },
    { label: 'YouTube', href: corps.youtube, icon: YoutubeIcon },
    { label: 'LinkedIn', href: corps.linked_in, icon: Linkedin01Icon },
    { label: 'DCX Museum', href: corps.dcx_museum_url, icon: BookOpen01Icon },
    { label: 'Shop', href: corpsMerch?.storeUrl ?? null, icon: GiftIcon },
  ];
  const activeLinks = links.filter((l) => l.href);

  const hasSocial = activeLinks.length > 0;
  const showSubsections = hasSocial;
  const badgeDivision = corps.is_alumni ? 'Alumni' : (corps.division_name ?? undefined);

  return (
    <PageShell>
      <BackLink to="/corps" label="Back to Corps" />

      {/* SSR'd content: start visible (initial={false}) to avoid the blank-then-
          fade FOUC on first paint; children still inherit the variants for any
          interactive animation. */}
      <motion.div className="mt-4 space-y-6" variants={fadeIn} initial={false} animate="visible">
        {/* Identity on one side, cover image floating on the opposite side. The
            round logo chip bottom-aligns with the name/class/city block. */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-8">
            <CorpsLogo
              name={corps.name}
              logo={corpsLogoSource(corps)}
              className="size-28 shrink-0 sm:size-32"
              width={128}
            />
            <div className="min-w-0 space-y-2.5">
              <h1 className="text-[2.5rem] font-bold leading-tight text-text-primary">
                {corps.name}
              </h1>
              <div className="flex flex-wrap items-center gap-3 text-lg">
                <Show when={badgeDivision}>
                  <ClassBadge division={badgeDivision} />
                </Show>
                <Show when={corps.display_city}>
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    <Icon icon={LocationIcon} size="sm" />
                    {corps.display_city}
                  </span>
                </Show>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <FavoriteCorpsButton
                  corps={toFavoriteInput(corps)}
                  size="md"
                  showLabel
                  className="h-9"
                />
                <ScoreNotifyButton
                  targetKind="corps"
                  targetSlug={slug}
                  targetLabel={corps.name}
                  className="h-9"
                />
                <Show when={showForSeason}>
                  {(show) => (
                    <Link
                      to="/shows/$slug/$season"
                      params={{ slug, season: activeSeason }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
                    >
                      <Icon icon={BookOpen01Icon} size="md" />
                      {activeSeason} show: {show.title}
                    </Link>
                  )}
                </Show>
              </div>
            </div>
          </div>

          <Show when={corps.corps_photo}>
            {(photo) => (
              <ProgressiveImage
                src={photo}
                alt={corps.name}
                width={480}
                widths={[384, 480, 640, 768, 896, 1024]}
                sizes="(min-width: 1024px) 28rem, 100vw"
                lazy={false}
                priority
                assumeCached
                thumbDataUrl={coverThumbDataUrl}
                className="h-52 w-full shrink-0 rounded-xl lg:w-[28rem]"
              />
            )}
          </Show>
        </div>

        <Show when={!!about || showSubsections}>
          <Card>
            <CardContent className="py-5">
              <Show when={!!about}>
                <div>
                  <h3 className="-mt-[4px] mb-2 text-base font-semibold">About</h3>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">
                    {about}
                  </p>
                </div>
              </Show>

              <Show when={showSubsections}>
                <div className={cn('mt-4 space-y-3 text-sm', !about && 'mt-0')}>
                  <Show when={hasSocial}>
                    <div className="flex flex-wrap gap-2">
                      <For each={activeLinks} fallback={null}>
                        {(link) => (
                          <a
                            href={link.href!}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
                          >
                            <Icon icon={link.icon} size="sm" />
                            {link.label}
                          </a>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </CardContent>
          </Card>
        </Show>

        <Show when={seasonScores.length > 0}>
          <Card>
            <CardContent className="py-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h3 className="-mt-[4px] text-base font-semibold">2026 Season Scores</h3>
                {/* Seed the VS comparison tool with this corps (plan M6). The rich
                    single-corps chart above stays; VS is where you stack others. */}
                <Link
                  to="/vs"
                  search={{ s: `corps~${slug}~2026,corps~${slug}~2025` }}
                  className="shrink-0 text-sm font-medium text-primary hover:underline"
                >
                  Add more to compare →
                </Link>
              </div>
              <CorpsScoreChart
                data={seasonScores}
                snapshots={seasonSnapshots}
                colors={{ primary: corps.color_primary, secondary: corps.color_secondary }}
              />
            </CardContent>
          </Card>
        </Show>

        {showForSeason ? (
          <section className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Synopsis</h3>
              <Link
                to="/shows/$slug/$season"
                params={{ slug, season: activeSeason }}
                className="text-sm text-primary hover:underline"
              >
                Full show entry
              </Link>
            </div>
            <Card>
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:gap-5">
                <div className="w-full shrink-0 overflow-hidden rounded-lg sm:w-44">
                  {(() => {
                    const thumb = showForSeason.media.find((m) => m.thumbnailUrl)?.thumbnailUrl;
                    return thumb ? (
                      <ProgressiveImage
                        src={thumb}
                        alt={`${corps.name} — ${showForSeason.title}`}
                        width={352}
                        widths={[256, 352, 448]}
                        sizes="(min-width: 640px) 11rem, 100vw"
                        className="aspect-video w-full"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted text-text-muted">
                        <Icon icon={BookOpen01Icon} size="lg" />
                      </div>
                    );
                  })()}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                      {activeSeason} Production
                    </p>
                    <h4 className="text-lg font-semibold leading-tight">{showForSeason.title}</h4>
                    {showForSeason.subtitle ? (
                      <p className="text-sm text-text-secondary">{showForSeason.subtitle}</p>
                    ) : null}
                  </div>
                  <p className="text-sm leading-relaxed text-text-secondary line-clamp-4">
                    {showForSeason.description ??
                      showForSeason.tagline ??
                      `A synopsis for ${corps.name}'s ${activeSeason} production hasn't been added yet — open the full show entry for the repertoire, designers and movements.`}
                  </p>
                  <Link
                    to="/shows/$slug/$season"
                    params={{ slug, season: activeSeason }}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                  >
                    <Icon icon={BookOpen01Icon} size="sm" />
                    See the full show entry →
                  </Link>
                </div>
              </CardContent>
            </Card>
          </section>
        ) : null}

        {corpsMerch && corpsMerch.products.length > 0 ? (
          <section className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Merch</h3>
              <Link
                to="/shop/group/$storeId"
                params={{ storeId: corpsMerch.storeSlug }}
                className="text-sm text-primary hover:underline"
              >
                Shop all
              </Link>
            </div>
            {/* Cap to 2 rows (4 cards) on mobile; show the rest at sm+. The
                "Shop all" link covers the overflow. */}
            <ProductGrid
              products={corpsMerch.products}
              className="[&>*:nth-child(n+5)]:hidden sm:[&>*:nth-child(n+5)]:block"
            />
          </section>
        ) : null}

        <Show when={appearances.length > 0}>
          <section className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Appearances</h3>
              <Show when={orderedAppearances.length > 1}>
                <button
                  type="button"
                  onClick={() => sendFilter({ type: 'TOGGLE_DIR' })}
                  aria-label={
                    filter.dir === 'desc'
                      ? 'Sort by date, earliest first'
                      : 'Sort by date, latest first'
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
                >
                  <motion.span
                    className="inline-flex"
                    animate={{ rotate: filter.dir === 'desc' ? 180 : 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                  >
                    <Icon icon={ArrowDown01Icon} size="sm" />
                  </motion.span>
                  {filter.dir === 'desc' ? 'Latest first' : 'Earliest first'}
                </button>
              </Show>
            </div>

            {/* Season filter chips (only when the corps spans multiple seasons). */}
            <Show when={appearanceSeasons.length > 1}>
              <SeasonChips seasons={appearanceSeasons} value={activeSeason} onSelect={goSeason} />
            </Show>

            <EventCardGrid
              events={orderedAppearances}
              animationKey={`${activeSeason}|${filter.dir}`}
              resultByKey={resultByKey}
            />
          </section>
        </Show>
      </motion.div>
    </PageShell>
  );
}
