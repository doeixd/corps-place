# PageantryJobs Programmatic-SEO Landing Pages — Plan

**Status:** proposed (not implemented). **Owner:** —. **Last updated:** 2026-06-29.

## 0. Goal & the original ask

Rank PageantryJobs for long-tail job-search queries by generating dedicated,
indexable landing pages per **discipline × role (× query variant)**. Examples the
request named:

- "Bodybuilding Jobs", "Bodybuilding Coaches", "Bodybuilding Coaching Jobs"
- "Trumpet Instructor Jobs", "Trumpet Teachers"
- "Color Guard Instructor Jobs"
- …and the equivalent for **every discipline** and **every role that would exist**
  for that discipline.

Each page needs: real matching jobs, unique copy, **structured data, sitemap entry,
head tags, an H1, and internal navigation links**.

This is classic **programmatic SEO (pSEO)**. The make-or-break constraint is
Google's *doorway / thin-content* guidance: mass-generated pages that funnel to the
same place with little unique value get demoted. Every decision below is in service
of: *each indexed page must carry genuinely unique, useful content.*

## 1. Grounding — what already exists (reuse, don't rebuild)

- **`listJobs` server-fn** (`app/lib/server-fns/jobs.ts`) filters by `keyword`,
  `discipline`, `work` (remote/onsite), `location`, `sort`. Powers a landing page's
  job list directly.
- **Keyword matching is `jp.title LIKE '%kw%'` only** (`jobs-service.ts` ~L30) — it
  matches the posting **title**, not the body. Implication: role pages filter on
  **discipline (exact)** + **title keyword**. See §6 for the matching strategy and a
  future full-text enhancement.
- **`DISCIPLINES`** (`app/lib/jobs/disciplines.ts`, 25 values) — the discipline
  taxonomy (recently broadened: pageants, modeling, dance, cheer, bodybuilding,
  fitness, equestrian, dog-showing, theater, music, circus, judging, …).
- **`JobCard`** (`app/components/jobs/job-card.tsx`) — shared card; reuse for the
  job grid.
- **`seoHead` / `breadcrumbLd`** (`app/lib/seo.ts`) — now **brand-aware** via
  `siteBase()` (emits `pageantryjobs.com` canonical/OG on the jobs host).
- **Brand-aware sitemap** (`app/routes/sitemap[.]xml.ts`) — the `jobs` branch lists
  the board + every posting. Landing pages get added here.
- **JobPosting JSON-LD** already on `/jobs/$jobSlug` (per-posting). Landing pages add
  *list-level* structured data on top.
- **Jobs saved-search / alert** system (createJobPosting emails saved searches) —
  reuse for the "no openings yet, get notified" CTA (NOT the drum-corps score-notify
  component, which is a different domain).
- **Analytics** (`/admin/analytics`, web-vitals + pageviews) — landing pages
  auto-report; pair with Google Search Console for query/position data.

## 2. Architecture — one dynamic route + a generated taxonomy

Hundreds of pages, **one route file** + a **generated taxonomy config**. Adding a
discipline/role = edit the role map + regenerate.

```
/jobs/c/<slug>          ← single dynamic route (category/landing)
  └─ looks up LandingDef by slug in the generated taxonomy; 404 if absent
```

`/c/` namespaces landing pages so they can't collide with `/jobs/$jobSlug`
(individual postings). `/jobs/$jobSlug` is unchanged.

### 2.1 `LandingDef` (the unit)

```ts
type LandingFilter = { discipline?: DisciplineValue; keyword?: string; work?: 'remote' | 'onsite' };

interface LandingDef {
  slug: string;            // 'bodybuilding-coach', 'trumpet-instructor', 'color-guard-instructor'
  kind: 'discipline' | 'role' | 'discipline-role' | 'instrument-role';
  title: string;           // 'Bodybuilding Coach Jobs | PageantryJobs'
  h1: string;              // 'Bodybuilding Coach Jobs'
  subhead: string;         // weaves aliases: 'Find bodybuilding coaching jobs, posing & prep coaches'
  metaDescription: string; // ≤160 chars, unique
  intro: string;           // 1–2 unique paragraphs (AI-written once, stored)
  faq: { q: string; a: string }[];   // 2–3 curated Q&A
  filter: LandingFilter;
  aliases: string[];       // 'Bodybuilding Coaches', 'Bodybuilding Coaching Jobs', 'Prep Coach'
  parentSlug?: string;     // discipline page for a discipline-role page
  related: string[];       // sibling roles + cross-links (slugs)
}
```

The taxonomy is emitted to a **generated file**
`app/lib/jobs/landing-taxonomy.generated.ts` (pattern: `merch-image-hosts.generated`),
exporting `LANDING_DEFS: LandingDef[]` + a `bySlug` map. Generated, never hand-edited.

## 3. Taxonomy content — what pages exist (curated, not combinatorial)

A blind cross-product (25 disciplines × ~15 roles × ~3 variants) is thousands of
junk pages. Instead, a **curated role map per discipline** + **query variants folded
into one canonical page** (not separate pages per phrasing).

### 3.1 Page families

1. **Discipline pages** (~25): "Bodybuilding Jobs", "Color Guard Jobs".
   `filter: { discipline }`. Slug = discipline value.
2. **Discipline × role** (the bulk): curated `ROLE_MAP[discipline] = role[]`.
   `filter: { discipline, keyword: roleTitleTerm }`. Slug = `<discipline>-<role>`.
3. **Cross-discipline role** (~10): "Instructor Jobs", "Coaching Jobs", "Judge Jobs",
   "Choreographer Jobs", "Designer Jobs". `filter: { keyword }`. Slug = `<role>`.
4. **Instrument × role** (music/marching): `INSTRUMENTS × {instructor, teacher}`
   → "Trumpet Instructor Jobs", "Trumpet Teachers". `filter: { keyword: '<instrument>' }`
   (+ discipline `music`/`drum-corps` where appropriate). Slug = `<instrument>-instructor`.
5. **Remote variant** (optional, later): "Remote Music Teacher Jobs" via `work: 'remote'`.

### 3.2 The curated maps (initial)

```
ROLE_MAP (per discipline cluster):
  marching arts (drum-corps, marching-band, color-guard, winter-guard,
    indoor-percussion, drumline, concert, baton-twirling):
      instructor, technician, coach, director, designer, arranger,
      caption-head, drill-writer, judge, choreographer,
      brass-instructor, percussion-instructor, guard-instructor, visual-tech
  music:        instructor, teacher, private-lessons, director, accompanist
  bodybuilding: coach, posing-coach, prep-coach, trainer, nutrition-coach, judge
  fitness:      coach, trainer, competition-coach, judge
  pageants:     coach, director, judge, choreographer, wardrobe, photographer
  dance:        instructor, choreographer, teacher, coach, judge
  cheer:        coach, choreographer, tumbling-instructor, judge
  gymnastics:   coach, instructor, judge
  figure-skating: coach, choreographer, instructor
  modeling:     agency, scout, coach, photographer
  equestrian:   trainer, instructor, coach, groom, judge
  dog-showing:  handler, trainer, groomer, judge
  theater:      director, choreographer, music-director, stage-manager, designer
  circus:       coach, instructor, performer, rigger
  production:   stage-manager, av-tech, lighting, sound, event-coordinator
  judging:      judge, adjudicator   (cross-discipline judge hub)

INSTRUMENTS (× instructor/teacher): trumpet, cornet, mellophone, french-horn,
  trombone, baritone, euphonium, tuba, sousaphone, clarinet, flute, oboe,
  saxophone, percussion, marimba, vibraphone, drum-set, guitar, bass, piano, voice
```

**Estimated initial set:** ~25 discipline + ~180 discipline-role + ~10 cross-role +
~42 instrument-role ≈ **~260 pages**. Expand the maps as inventory grows.

### 3.3 Query variants — one page, not many

For "Bodybuilding Coach", a single canonical page targets the whole cluster:
`aliases = ['Bodybuilding Coaches', 'Bodybuilding Coaching Jobs', 'Bodybuilding Prep Coach', 'Posing Coach Jobs']`.
Aliases appear in the **subhead, intro prose, FAQ, and a "people also search for"
block** — so Google associates them with the one page (no near-duplicate doorway
pages per phrasing). `<title>` uses the primary; aliases are body content.

## 4. The route — `/jobs/c/$slug.tsx` (sketch)

```tsx
export const Route = createFileRoute('/jobs/c/$slug')({
  loader: async ({ params }) => {
    const def = LANDING_BY_SLUG[params.slug];
    if (!def) throw notFound();
    const { rows } = await listJobs({ data: { ...def.filter, limit: 50, offset: 0 } });
    return { def, jobs: rows };
  },
  head: ({ loaderData }) => {
    const { def, jobs } = loaderData ?? {};
    if (!def) return {};
    const hasJobs = jobs.length > 0;
    return seoHead({
      title: def.title,
      description: def.metaDescription,
      path: `/jobs/c/${def.slug}`,
      image: 'https://pageantryjobs.com/og-jobs.png',
      noindex: !hasJobs,                 // ← only index pages with real content
      jsonLd: [breadcrumbLd([...]), itemListLd(def, jobs), collectionPageLd(def), faqLd(def)],
    });
  },
  component: LandingPage,
});
```

**Component renders:** `<h1>` (def.h1), subhead (aliases), the **unique intro**, a
salary-range line (aggregate min/max of `jobs`), the **`JobCard` grid**, a
**"Related searches"** internal-link block (def.related → other landing pages + the
parent discipline), and:

- jobs present → grid + "Browse all jobs" + per-job apply.
- **empty** → "No open {role} roles right now" + **jobs saved-search/alert subscribe**
  + links to related categories + the discipline page (which is more likely to have
  jobs). Page is `noindex` while empty.

## 5. Structured data (per page)

- **BreadcrumbList**: Home → Jobs (`/jobs/board`) → [Discipline] (`/jobs/c/<discipline>`)
  → [Role] — brand-aware URLs via `siteBase()`.
- **ItemList** of matching **JobPosting** items (each → its `/jobs/$slug` URL +
  minimal JobPosting fields). Eligible for list-style enhancements.
- **CollectionPage** wrapper (name = h1, description = intro).
- **FAQPage** (2–3 curated Q&A) — extra SERP real estate; must be genuinely useful.

`jsonLd` helpers live next to the route (`itemListLd`, `collectionPageLd`, `faqLd`).

## 6. Job-matching strategy & a future enhancement

- **Discipline pages** → `discipline = ?` (exact, reliable).
- **Role pages** → `discipline = ?` + `title LIKE '%kw%'` (keyword = the role's common
  title term, e.g. `instructor`, `coach`, `trumpet`).
- **Limitation:** title-only matching misses postings whose title doesn't contain the
  term (e.g. "Brass Caption Head" won't match `instructor`).
- **Phase-2+ enhancement options** (pick one): (a) extend `listPostings` keyword to
  also `LIKE` the flattened description plain-text; (b) add an SQLite **FTS5** index
  over title+body; (c) add a structured **`role` tag** to postings (post form + a
  backfill classifier) for precise filtering. Recommend (a) short-term, (c) long-term.

## 7. Sitemap

Extend the **jobs branch** of `sitemap[.]xml.ts`:

- For each `LandingDef`, run its filter (cheap count) and include
  `/jobs/c/<slug>` **only if ≥1 matching job** (else it's `noindex` — keep it out).
- `lastmod` = most recent matching posting's published date.
- Implementation: a single `listJobs` per def is wasteful at ~260 defs; instead do
  **one pass** — `SELECT discipline, COUNT(*), MAX(published_at) GROUP BY discipline`
  for discipline pages, and a small batched count for keyword/role pages, computed in
  the sitemap handler (cached 1 day with the existing sitemap cache headers).
- We're far under the 50k-URL sitemap limit; revisit a sitemap **index** only if it
  ever grows large.

## 8. Navigation / internal linking (discovery + authority flow)

- **Hub page** `/jobs/categories` — all landing pages grouped by discipline (and a
  "by role" view). The primary internal-link surface so Google discovers + flows
  PageRank to the leaves.
- **`/jobs/board`** gets a "Browse jobs by discipline & role" section linking the hub
  + top categories; the **discipline filter chips** link to the discipline landing
  page.
- **Footer** (jobs brand): top disciplines + roles.
- **Each landing page** cross-links `related` (sibling roles, parent discipline,
  popular cross-links) — a dense, sensible internal graph (not a link farm).

## 9. Slugs, canonical, indexability rules

- Slugs: lowercase kebab, role-descriptive, **no "-jobs" suffix** (the `/jobs/`
  prefix implies it): `bodybuilding-coach`, `trumpet-instructor`,
  `color-guard-instructor`. The **title/H1** carry "Jobs".
- Canonical: self-referencing `https://pageantryjobs.com/jobs/c/<slug>` (brand-aware
  `seoHead`).
- **`noindex` when 0 matching jobs** — the central anti-thin-content lever; pages
  become indexable automatically as jobs post, and drop out when they go stale.
- One canonical page per role-cluster (aliases folded in) — never separate pages per
  phrasing.

## 10. Content generation (the unique-copy engine)

A generator script (`sdk/scripts/genJobsLandingTaxonomy.ts`, run via `vp exec tsx`):

1. Build the def list from `DISCIPLINES` × `ROLE_MAP` × `INSTRUMENTS` (+ cross-role).
2. Derive slug/title/h1/subhead/breadcrumb/related deterministically.
3. **AI-write `intro` + `faq` per def once** (Anthropic API) with a prompt that
   yields distinct, useful, non-keyword-stuffed prose per role/discipline; store the
   result in the generated file so it's stable + reviewable in git (no per-request AI
   cost, no flakiness).
4. Emit `landing-taxonomy.generated.ts`. Re-running is idempotent; new defs get new
   intros, existing ones are preserved (cache by slug) unless `--regen`.

This keeps every page's prose genuinely unique (the doorway-page guard) while staying
a config-driven, regenerable system.

## 11. Anti-doorway compliance checklist (gate before indexing)

- [ ] Page has ≥1 real matching job (else `noindex`).
- [ ] Unique intro prose (AI-written per def, not template fill).
- [ ] Unique meta title + description.
- [ ] Curated FAQ adds real info.
- [ ] Salary/context derived from real postings.
- [ ] Genuine internal links to related + parent (not boilerplate).
- [ ] Single canonical per role-cluster (no phrasing duplicates).
- [ ] Reasonable, curated taxonomy (not blind combinatorial).

## 12. Phased implementation + acceptance

- **Phase 0 — Taxonomy + generator.** `LandingDef` type; `ROLE_MAP`/`INSTRUMENTS`;
  `genJobsLandingTaxonomy.ts` (incl. AI intros/FAQ); emit
  `landing-taxonomy.generated.ts`.
  *Accept:* ~260 defs generated with unique intros; typed; committed.
- **Phase 1 — `/jobs/c/$slug` route.** Loader + brand-aware head + component (H1,
  intro, JobCard grid, empty-state CTA, related links); `noindex` when empty.
  *Accept:* a sample of slugs render with correct title/H1/jobs; empty slug is
  `noindex` + shows the alert CTA; non-existent slug 404s.
- **Phase 2 — Structured data.** Breadcrumb + ItemList(JobPosting) + CollectionPage +
  FAQ. *Accept:* Rich Results Test passes for a populated page.
- **Phase 3 — Sitemap.** Single-pass inclusion of indexable landing pages + lastmod.
  *Accept:* `pageantryjobs.com/sitemap.xml` lists populated `/jobs/c/*`, excludes
  empties, has correct lastmod.
- **Phase 4 — Navigation.** `/jobs/categories` hub + board section + chip links +
  footer + related blocks. *Accept:* every landing page reachable within 2 clicks
  from the jobs home; hub crawlable.
- **Phase 5 — Measurement + iterate.** Watch `/admin/analytics` (pageviews/INP) +
  **Google Search Console** (impressions/clicks/position per `/jobs/c/*`). Prune
  non-performers; expand `ROLE_MAP` where there's query demand; consider the §6
  full-text/role-tag enhancement once volume justifies it.

## 13. MVP (first slice to ship)

Phase 0 + 1 for a **focused first batch** to validate before scaling: the ~25
discipline pages + the highest-intent roles (`instructor`, `coach`, `director`,
`judge`, `choreographer`, `designer`) across the disciplines that have them + the top
~10 instruments × `instructor`. ~120 pages. Then layer Phases 2–4.

## 14. Risks & mitigations (summary)

| Risk | Mitigation |
|---|---|
| Doorway / thin-content demotion | Unique AI intros + FAQ; real listings; `noindex` empties; curated taxonomy; real internal hub |
| Duplicate content across phrasings | One canonical per role-cluster; aliases folded into body |
| Weak title-only matching | Phase-2 full-text / role-tag enhancement (§6) |
| Crawl budget waste | Only indexable pages in sitemap; clean internal linking |
| Maintenance drift | Generated taxonomy — add discipline/role via config + regenerate |
| AI intro cost/flakiness | Generate once, store in git; no per-request AI |

## 15. Open decisions

- URL: `/jobs/c/<slug>` (proposed) vs `/jobs/<descriptive-slug>` (collision-risk with
  postings) vs `/jobs/hire/<slug>`. → recommend `/jobs/c/`.
- Whether to add a `role` tag to the post form now (precise matching) or defer to a
  classifier backfill. → defer; start with discipline + title-keyword.
- FAQ on every page vs only high-traffic ones (avoid FAQ spam). → start curated, all
  pages; revisit if GSC flags.
</content>
