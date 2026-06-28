# `/scores` — completed-event results & full recaps

Status: **DRAFT for review** — not started. A results/archive counterpart to `/events`.

## 0. TL;DR / Goal

`/scores` is the **results archive**, and it's primarily an **SEO play**. Two surfaces:

- **`/scores`** — a reverse-chronological, filterable index of every **scored** event, each shown as its **full DCI recap** under a heading. Same header/filter chrome as `/events`.
- **`/scores/$slug`** — a **dedicated, SSR, indexable page per scored event** (the canonical "results" URL), with a strong title/description, `SportsEvent` structured data, and the full recap. Every one is **enumerated in `sitemap.xml`** so search engines crawl them.

Event slugs are already **year-prefixed and globally unique** (`2025-dci-world-championship-finals`), so a single-segment `/scores/$slug` is unique *and* descriptive — ideal for SEO. Where `/events` answers "what's coming up," `/scores` answers "what were the results."

## 1. Grounding — what already exists (verified 2026-06-28)

- **`/events`** (`app/routes/events/index.tsx`) — the model to mirror: `getHybridAllEvents()` → `eventFilterMachine` + `eventFilterSearchCodec` → `useSearchSync` (filters ↔ URL) → `selectEvents(events, filter)` → `ScrollableEventCardGrid`, with `SeasonChips` + a search box. Filter state is shareable via the query string.
- **Event data** (`rm_events`, `EventListItem`): `slug`, `event_name`, `start_date`, `location_city/state`, `venue_name`, `competition_slug`, `season`, and crucially **`scores_released: number`** — the flag that says "this event has results."
- **Full recap** — `FullRecapTable` (`app/components/prediction/full-recap-table.tsx`) renders ONE event's complete recap (categories → captions → judges → subcaptions, sortable, sticky columns) from **`getHybridEventFullRecap(slug)`**. Already used for scored/past events on the prediction page (`recap: 'full'`). `ScoreRecapTable` is the lighter placements+totals view.
- **Chrome:** `PageShell`, `PageHeader`, `SeasonChips`/`filter-chips`, `ClassBadge`, `CorpsNameCell`, `seoHead`/`breadcrumbLd`.

## 2. Design decisions (finalized 2026-06-28)

1. **A straight list of full recap tables, each under a heading.** Not an accordion, not master-detail — the page is a vertical stack: for each scored event, a **heading** (event name · date · city · class) immediately followed by its **full `FullRecapTable`**. Reads like a results document; newest event first.
2. **Lazy-render each table on scroll (the key perf move).** Rendering every wide recap at once is too heavy. Each event's **heading renders immediately**; its recap **fetches (`getHybridEventFullRecap`) + mounts only when the heading nears the viewport** (IntersectionObserver), showing a skeleton until then. So it's visually "just a list of tables," but only the tables near the viewport are live. Per-slug cache so scrolling back is instant.
3. **Bound the set with the season filter.** Default to the latest season; a single season keeps the list to a sane length. (Add "load more"/virtualization only if a season proves too large.)
3. **Reuse, don't fork.** Same `FullRecapTable` as the prediction/results pages (recaps look identical site-wide); same filter machine/codec as `/events`. New code is the page, the accordion item, and the lazy-recap hook.
4. **Filters live in the URL** (shareable), mirroring `/events`, plus an `open` param for the expanded event so a specific result is linkable.

## 3. Data

- **List:** `getHybridAllEvents()` → filter to `scores_released === 1`, sort by `start_date` **descending** (most recent first). No new server-fn needed.
- **Per-event recap (on expand):** `getHybridEventFullRecap({ data: { slug, season } })` (the existing fn behind `FullRecapTable`), called client-side from the accordion item; cache per slug so re-expanding is instant.
- Optional later: a tiny `winners` projection (top placement per event) so the **collapsed** summary doesn't need the full recap — either add `top_corps`/`top_score` to the `rm_events` listing, or derive from a light `getHybridEventResultsSummary(slug)`. v1 can lazy-load the full recap on expand and skip the collapsed winner, or show it after first expand.

## 4. Layout / style

- **Header — same upper area as `/events`** (verbatim pattern): `PageHeader` (title "Scores", subtitle "DCI results & full recaps", `backTo="/"`), then the search `Input` (placeholder "Search scored shows by name or city…"), then `SeasonChips`, then an "Scores" `h2` with the date-direction sort toggle — i.e. lift `/events/index.tsx`'s header block and retarget it.
- **Division/class** toggle (World / Open / All-Age) · **sort** (Newest / Oldest / A–Z) added alongside.
- **Body — accordion list**, newest first. Each `ScoreEventRow`:
  - **Collapsed:** event name · date · city, state · class badge(s) · winner + score (once known) · a chevron. Reads like an `/events` card but rank-oriented.
  - **Expanded:** the event meta header (reuse `score-header`/`EventSeasonTitle`) + the **`FullRecapTable`** for that event, horizontally scrollable inside the card. A "View event page →" link to `/events/$yearSlug/$slug` for the full detail.
- Empty/loading: skeleton rows while a recap loads; an empty state when filters match nothing ("No scored shows match — try another season").
- Mobile: the recap table keeps its horizontal scroll; collapsed rows stack cleanly.

## 4b. `/scores/$slug` — the per-event page (the SEO surface)

The canonical, indexable URL for one scored event's results. SSR, no JS required to read it.

- **Route:** `app/routes/scores/$slug.tsx`. `$slug` is the year-prefixed unique event slug (`/scores/2025-dci-world-championship-finals`). Loader: `getHybridEventBasic`/`getHybridEvent` for meta + `getHybridEventFullRecap({ slug })` for the table; 404 (or redirect to `/scores`) if the event isn't scored.
- **Heading (`<h1>`):** `"{Event Name} — {Year} Scores"` with a sub-line of **date · venue · city, state · # corps · winner**. Reuse `score-header`/`EventSeasonTitle`.
- **Body:** the full `FullRecapTable` + a "View event details / prediction →" link to `/events/$yearSlug/$slug`.
- **`<title>`:** `"{Event} {Year} — Scores & Full Recap | DrumCorps.app"`.
- **Meta description:** generated — `"Final scores and the complete caption-by-caption recap from {Event} on {date} in {city}. {Winner} placed first with {score}."`
- **Canonical:** `https://drumcorps.app/scores/{slug}` — and this page is the **canonical for the "results" intent**, so the existing `/events/.../prediction` recap should point its canonical here (or stay distinct as the *prediction* view) to avoid duplicate-content dilution.
- **Structured data (JSON-LD via `seoHead`'s `jsonLd`):** a `SportsEvent` (name, `startDate`, `location` → `Place` with the venue/city, `superEvent` = the season/circuit) carrying `competitor`/`subEvent` entries for the placements (corps + `result`/score) — plus a `BreadcrumbList` (`breadcrumbLd`: Home → Scores → Event). This is the payload that wins rich results.
- **OG/Twitter:** title + description + a representative image (corps logo of the winner, or a generic scores card).

## 4c. Sitemap & crawlability (the "pre-generated" part)

`app/routes/sitemap[.]xml.ts` already enumerates corps/shows/merch per request (cached a day). Extend it:
- Add `'/scores'` to `STATIC_PATHS`.
- Fetch scored events (a small `listScoredEvents()` server-fn, or `getHybridAllEvents().filter(scores_released)`) and `paths.add('/scores/' + slug)` for each. So **every scored-event page is in the sitemap automatically**, regenerated as new results land.
- `robots.txt` already allows crawling; nothing to change there.
- Internal linking (matters as much as the sitemap): the `/scores` index links each heading to its `/scores/$slug`; `/events` cards for *completed* events link to `/scores/$slug`; the corps page's season-scores rows deep-link the show into `/scores/$slug`. Dense internal links = faster discovery + authority flow.

## 5. State & URLs

Reuse `/events`' approach. Search params:
- `season` (or default = latest), `q` (search), `cls` (division), `sort` (`new` default | `old` | `az`) — driven by a filter machine + `useSearchSync` (extend `eventFilterMachine` or a sibling `scoresFilterMachine` if sort/division aren't already there).
- `open=<slug>` — the expanded event (single-open accordion), so a link opens straight to one show's recap. Deep-link scrolls it into view.

Examples: `/scores?season=2025&cls=World&sort=new` · `/scores?open=2025-dci-world-championship-finals`.

## 6. Components

- NEW `app/routes/scores/$slug.tsx` — **the per-event SEO page** (SSR loader, `seoHead` + `SportsEvent`/breadcrumb JSON-LD, heading + `FullRecapTable`).
- NEW `app/routes/scores/index.tsx` — the index: `/events`-style header + filters + the list of headings → lazy `FullRecapTable`s.
- NEW `app/components/scores/score-event-section.tsx` — a heading + its lazy-on-scroll recap (IntersectionObserver), used by the index; the heading links to `/scores/$slug`.
- NEW `app/components/scores/use-event-recap.ts` — fetch + per-slug cache for `getHybridEventFullRecap`.
- NEW server-fn `listScoredEvents()` (or reuse `getHybridAllEvents` + filter) — for the index *and* the sitemap.
- MODIFY `app/routes/sitemap[.]xml.ts` — add `/scores` + every `/scores/$slug`.
- REUSE `FullRecapTable`, `score-header`/`EventSeasonTitle`, `SeasonChips`, `ClassBadge`, `CorpsNameCell`, `useSearchSync`, `seoHead`/`breadcrumbLd`.
- MAYBE extend `event-filtering.ts` with `scored`-only + sort modes (or a thin `selectScoredEvents`).

## 7. Fit with the rest of the site

- **Nav + discovery:** add `/scores` to the top nav and an Explore card on the home page (next to "2026 Events"), e.g. icon `RankingIcon`/medal, "Scores — results & full recaps."
- **Cross-links:** each `/events` card for a *completed* event links to its `/scores?open=…` (or its event page's recap). The corps page's season-scores section can deep-link a show into `/scores`.
- **SEO:** `seoHead` + `breadcrumbLd`; per-season titles ("2025 DCI Scores & Recaps"). The page is SSR-friendly (list renders server-side; recaps hydrate on expand).
- Consistent recap visuals because it's the same `FullRecapTable`.

## 8. Phases (SEO-first ordering)

Because this is mostly an SEO play, ship the **indexable detail pages + sitemap first**.

- **P0 — Per-event pages + sitemap (the SEO core):** `/scores/$slug` SSR page (heading + `FullRecapTable`), full `seoHead` (title/description/canonical/OG) + `SportsEvent` & breadcrumb JSON-LD; `listScoredEvents` server-fn; sitemap enumerates `/scores` + every `/scores/$slug`. Crawlable from day one.
- **P1 — Index page:** `/scores` with the `/events`-style header + season/search filters + the list of headings, each linking to its detail page and lazy-rendering its `FullRecapTable` on scroll.
- **P2 — Filters/sort + internal linking:** division/class + sort in the URL; wire `/events` (completed) and corps season-scores rows to `/scores/$slug`.
- **P3 — Integration/polish:** top-nav entry, home Explore card, empty/skeleton states, OG images, canonical reconciliation with the prediction recap.

## 9. Open questions

1. **Recaps inline (accordion) vs. link-out.** Recommended: inline accordion (the ask). Alternative: `/scores` is a list that links to each event's existing recap page — lighter but not "show the recaps here."
2. **Collapsed winner summary in v1?** Showing it without expanding needs a light results-summary (extra projection or a per-row fetch). Defer to P2, or add a `top_corps/top_score` column to the events listing.
3. **Default expansion** — newest event auto-expanded, or all collapsed? (Recommend newest-expanded.)
4. **Single-open vs multi-open accordion** (URL `open` is one slug → single-open is simpler/shareable).
5. **Scope of "scored"** — all `scores_released` events, or only finals/championships? (Recommend all; division filter covers narrowing.)
6. **Which recap** — the full judge-by-judge `FullRecapTable` (recommended, "full recaps") or the lighter `ScoreRecapTable` placements view, with a toggle between them?

## 10. Non-goals (v1)

- No editing (that's the Prediction Palette).
- No new ingestion — purely a read view over existing scored data.
- No cross-event aggregation/leaderboards (that's `/rankings`).
