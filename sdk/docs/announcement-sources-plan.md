# Staff Announcement-Post Sources — Integration Plan (2026-06-16)

Extends `staff-scraping-plan.md`. Goal: harvest staff from **news/blog-style announcement
posts** ("Corps Announces 2018 Visual Staff", DCI news roundups). These posts often carry the
**bios + headshots the roster grids omit** (see §0c: big corps publish bio-less grids), and they
are **explicitly season-stamped**, so they improve coverage, the bio/photo gap, AND the
photo-based identity-merge tactics (T3/T4).

## Source diagnosis (looked at the 4 example pages)

| Source | Engine | Name fmt | Title fmt | Bio | Photo | Season signal |
|---|---|---|---|---|---|---|
| jerseysurf.org/…2018-visual-staff… | WordPress (static) | ALL-CAPS in body ("MIKE DURBOROW") | *italic/bold* after name | ✅ multi-para | ✅ per-person, filename `Mike_Durborow-250x264.jpg` | **title** ("2018") |
| bostoncrusaders.org/2016/11/2017-brass-staff/ | WordPress (static) | `<h2/h3>` heading ("Steve Bentley") | woven in bio prose | ✅ per-person | ✅ `Stephen_Bentley-150x300.jpg` | title + URL `/2016/11/` |
| scvanguard.org/19-scv-caption-managers/ | Wix/Cloudflare | **bold** name | `(Title)` in parens | ❌ ("click HERE") | ❌ group photo, positional caption | title ("2019") |
| dci.org/news/corps-news-and-announcements-YYYYMMDD | DCI CMS | in prose | in prose ("brass caption manager Tim Snyder") | ❌ | ❌ | publish date → next season |

**Three findings that drive the design:**
1. **Season ≠ publish date.** "2017 Brass Staff" was published 2016-11. Season lives in the
   title/slug, not the timestamp — the snapshot-date temporal model would mis-date every one.
2. **These are the bio+photo gold we lack.** Boston/SCV roster grids have zero bios; their
   announcement posts have full bios + name-filename headshots → also feed T3/T4 merges.
3. **Discovery must change.** Current discovery EXCLUDES `/news|blog|20\d\d`
   (`NON_STAFF_LINK_RE`). Announcements need a dedicated, opt-in discovery path.

## Design

### A1 — Schema & provenance
`links_json.kind = 'announcement'` + `publishedDate`; record `seasonSource: 'title'|'url'|'published'`.
No new tables — announcements coalesce into `corps_staff`/`corps_staff_assignments`.
Helper `seasonFromAnnouncement(title, url, publishedDate)`: first `19xx|20xx` in title → URL
`/20YY/` → published-year + fall heuristic (Sep–Dec announce next season). Clamp ≤ current+1.

### A2 — Announcement discovery (new, opt-in; `task_type='staff-announcement'`)
- **WordPress REST API first**: `GET /wp-json/wp/v2/posts?search=staff&per_page=100` (and
  `?search=caption|brass|percussion|visual|guard`) → `{title, date, content.rendered, _links}`.
  Cheapest/cleanest; Jersey Surf & Boston are WP.
- **HTML fallback** (REST disabled): scan `/news`, `/blog`, `/category/*`, `/20YY/` archives +
  `sitemap.xml`; keep posts whose **title or slug** matches `(19|20)\d\d` AND a caption/staff
  word (`staff|caption|brass|percussion|visual|colou?r.?guard|design|education|front.ensemble|
  drum.major|team`).
- **DCI roundups** (A4): enumerate `dci.org/news/corps-news-and-announcements-YYYYMMDD` via DCI
  news index/sitemap.
- **Wayback CDX** for historical posts (2013→). Bound per corps (cap N, rank by title-match
  score); resumable.

### A3 — Announcement extractor (deterministic, archetype-aware)
- **Body-scope** to `article`/`.entry-content`/`<main>` — kills "Recent Posts / Related /
  Categories" sidebar noise (observed in both WP pages).
- **Structured** (Boston): name = body heading; bio = paragraphs until next heading; photo =
  adjacent `img` with name-matching filename (strip `-\d+x\d+` size suffix → original).
- **Caps + filename** (Jersey Surf): caps names → title-case (guard Mc/Mac/O'/hyphens); title =
  italic/bold sibling; photo via name-filename.
- **Parenthetical list** (SCV): regex `Name (Title)`; group photo → names only, NO face attribution.
- **Season from title/slug**; clamp.

### A4 — Prose / multi-corps (DCI) via AI (Pattern B)
Segment roundup by corps heading; per corps, AI-extract `(name, title)` with `nameInSource`
grounding (anti-hallucination). Conservative: low confidence → review; never cross-attribute
between corps sections.

### A5 — Coalesce / dedup / apply
Dedup by `(corpsKey, season, normalized-name)` vs existing roster rows; **prefer the
announcement's bio + photo** (fill nulls, upgrade generic titles), keep richest fields. `--dry-run`
report → `--apply`. New name-filename photos strengthen T3/T4 merges downstream.

### A6 — Pilot then broaden
Pilot Jersey Surf, Boston, SCV (+ one DCI roundup); measure bios/photos gained + identity-merge
delta; widen.

## Edge cases
Season≠publish-date (title-derived; fall→next year) · multi-corps pages & cross-attribution ·
sidebar/related-posts noise (body-scoping) · ALL-CAPS normalization (McBride/O'Neil/hyphen) ·
group photos w/ positional captions (names only) · WP image size-suffix + nickname-vs-formal
filename (Steve vs `Stephen_Bentley`) · titles preceding names in prose · WP REST disabled →
HTML fallback · re-announced/UPDATE posts · false-positive titles ("staff retreat") → require ≥2
person-names · honorifics/credentials · discovery-cost bounding + resume · expiring photo URLs
(existing verify+cache) · pre-2013/future clamp · announced-but-cut (provenance marks source).

## Verification
Unit-test the 4 URLs (names/titles/season/bio/photo) · season-from-title (2017 from a 2016 post)
· dedup idempotency vs roster · DCI attribution no cross-leak · report bios/photos gained +
identity-merge delta.

## Agentic search tier (2026-06-16)

Goal: a search fallback for holdout corps (Colts, Madison Scouts, BD/Cadets) whose announcements
aren't in REST/sitemap/news. **Finding: automated search scraping is impossible from this box** —
Google CAPTCHAs the datacenter IP ("unusual traffic"), DuckDuckGo's HTML endpoint returns 202,
and `browser-tools.ts start` can't launch the snap chromium as root (no `--no-sandbox`). The only
working search here is the **agent's `WebSearch` tool** (runs off-box). So the tier is *agentic*:

- **Seed table** `announcement_seeds(corps_key, url, title, published, source)` — URLs the agent
  harvests via `WebSearch` (domain-filtered to the corps site / dci.org).
- **Ingest tier** in `scrapeAnnouncements`: loads a corps' seeds, dedupes against discovery, runs
  the identical render→extract→coalesce path. Built + typecheck clean.
- **Proven plumbing**: harvested 6 real Colts `/news/NNN` announcement URLs via WebSearch →
  seeded → rendered → ingested.
- **BUT** Colts announcements are **prose** ("…led by Visual Caption Head Zac Chowning…") on a
  custom SPA. The deterministic archetype passes (heading/caps/parenthetical) can't parse prose
  and instead matched the SPA's member-resources **nav menu** ("Travel Plans", "What To Bring") →
  11 junk "people", 0 real. Cleaned up. **Conclusion: the search tier delivers URLs, but holdout
  corps need A4 (prose/AI extraction) to extract correctly — the two unlock together.** Colts
  seeds retained as A4 input.

## A4 — AI prose extraction (2026-06-16)

`extractAnnouncementWithAI(html, sourceUrl, corpsName)` in `staffAiExtract.ts`: prose/role-aware
prompt + the engine ladder **`claude -p` → `codex exec` → `opencode` (DeepSeek
`opencode/deepseek-v4-flash-free`)** and `nameInSource` anti-hallucination grounding. Each tier
is tried only if the prior FAILED. The opencode tier uses the **`@opencode-ai/sdk`** one-shot
session (`createOpencode` → `session.create` → `session.prompt` with `agent:"plan"`, model
`{providerID:"opencode", modelID:"deepseek-v4-flash-free"}`) — NOT the CLI (whose default `build`
agent launches a tool loop and hangs). Lazy singleton server, reused; `OPENCODE_MODEL` overrides.
Verified: with claude+codex forced to fail, `engine=opencode` extracted all 7 Colts percussion
staff cleanly. Explicitly rejects nav/menu/event labels (the deterministic passes'
failure mode) and other-corps people. Wired into `scrapeAnnouncements` behind `--ai`: **when set,
the AI extractor is AUTHORITATIVE** for every candidate post (it parses prose AND returns `[]` for
non-staff pages), since the deterministic passes emit nav junk on custom SPAs. Without `--ai`,
the fast deterministic passes run (great for WP/Wix structured posts).

Validated on Colts seed posts — clean, real staff, zero junk:
- percussion post → Travis Peterman, Andrew Monteiro, James Ancona, Mark Eichenberger, Charlie
  Gorham, Sam Fleming, Vicki MacFarlane
- visual post → Zac Chowning, Nancy Fleming, Chad Miller + visual techs + directors

Operational: AI is slow (~1 min/post incl. render) → run `--ai` for holdout/prose corps in the
background; keep the no-`--ai` deterministic path for the WP/Wix majority. **Recommended split:**
WP/Wix corps via deterministic discovery; Colts/Madison Scouts/DCI prose via seeds + `--ai`.
**DCI multi-corps roundups — DONE.** `extractDciRoundupWithAI(html,url)` → `(corps,name,title,bio)`
tuples (same claude→codex→opencode ladder; grounding requires BOTH the name AND corps to appear
in the page, guarding mis-attribution). `scripts/scrapeDciRoundups.ts`: discovers roundups from
DCI's WP `post-sitemap*.xml` (slug `corps-news-and-announcements-YYYYMMDD`), AI-extracts, maps
each corps name → our `corps_key` (normalized + contains-match; unmapped skipped), seasons from
the URL date (fall→next), coalesces per corps. `--url` for one / `--limit` to discover; `--apply`.
Validated: the 2018-10-26 roundup → 14 tuples, **14/14 mapped** (Blue Devils→John Meehan,
Mandarins→Tim Snyder, SCV→David Yunis…), season 2019, applied with `dci-roundup` provenance.

## Status
- **A1 DONE** — `seasonFromAnnouncement(title,url,published)` + `normalizeCapsName` in
  `staffScraper.ts`; season from title→url-tail→published+fall-heuristic, clamped. Unit-tested.
- **A3 DONE** — `extractStaffFromAnnouncement(html,url,postTitle)`: body-scoped (≥500-char
  container, sidebars stripped), 3 passes (parenthetical / heading-delimited / caps-inline),
  name→photo via size-stripped filename (surname fallback), intra-post dedup by shared headshot.
  Validated live: **SCV 10/10 caption managers; Boston 6/6 with bios+photos; Jersey Surf 11
  unique + 9 photos**. Typecheck clean.
- **A2 DONE** — `discoverAnnouncementPosts(website)`: Tier 1 WordPress REST
  (`/wp-json/wp/v2/posts?search=<term>` over staff/caption/brass/percussion/visual/guard/design;
  title+date+**body HTML in one call**, reaches site inception) → Tier 2 sitemap fallback
  (`sitemap_index.xml` → post/staff sub-sitemaps → slug-filtered; covers non-WP/Wix + REST-off).
  Title/slug gate = caption-word + trigger (year | joins/welcomes/announces/…). Validated live:
  **Boston 29 posts → 41 people; Jersey Surf 21 posts → 60 people back to 2013** — correct
  seasons, inline HTML for all. Empirically: WordPress keeps all historical posts, so REST already
  reaches the past; **Wayback CDX only needed for DELETED posts / defunct sites** (future add).
  Known false-positives for A5's "≥2 real people or drop" guard to clean: org names ("Madison
  Scouts"), role-labels from non-instructional posts ("Student Leadership Team" → "Section Leaders").
- **A2 breadth test (60 corps sites):** discovery generalizes well across CMS types once Tier 2
  recurses into nested sitemaps (Wix names its sitemap INDEX "sitemap.xml" and points to
  `blog-posts-sitemap.xml` etc. — recurse ONE level into post/blog/staff/news/dynamic sub-maps).
  Working: Boston, Mandarins (40), Troopers (40), Bluecoats, Cavaliers, SCV, Seattle Cascades (25),
  Ascend, Regiment, Crossmen, Arizona, Blue Stars, Spartans, Genesis, Carolina Crown, Hawthorne…
  **Known gaps:** Blue Devils (custom `article.php` CMS) and Cadets (Webflow `/lander`) — no
  WP-REST/standard sitemap; would need a bespoke crawl or Wayback (deferred).
  **Render note:** Squarespace/Wix announcement posts (Cavaliers, SCV) discover correctly but are
  JS-rendered SPAs — plain fetch returns an empty shell, so A5 MUST render them (the "0 people"
  in a plain-fetch test is a render artifact, not a discovery/extraction failure).
- **A5 DONE** — `scripts/scrapeAnnouncements.ts`: per corps discover → use WP-REST inline HTML or
  RENDER url-only (SPA) posts → `extractStaffFromAnnouncement` → season from title → drop posts
  with <2 people → coalesce into `corps_staff` (PREFER announcement bio/photo, never null) with
  `links.kind='announcement'`. `--apply`/`--dry-run`/`--corps`/`--limit`/`--max-posts`/`--force`;
  resumable per corps (`scraper_progress` task_type='staff-announcement'). Typecheck clean.
- **A6 pilot DONE** (WP-REST corps): Boston **0→33 bios, 14→29 photos, +27 people**; Jersey Surf
  49 people (2013–2019); + Blue Knights/Genesis/Phantom Regiment/Hawthorne. Dataset bios
  **334→415**; distinct people 3537→3675; rm_staff re-emitted at 3675. Also fixed a data bug:
  Jersey Surf's `corps.website` was stored as a `web.archive.org/...` URL.
- **Coverage diagnosis (why initial hit-rate looked low) + fixes (2026-06-16):**
  - **WAF blocking** — bare `Mozilla/5.0` got 403/406 from Cloudflare-style WAFs on active corps
    (Pacific Crest, Madison Scouts). FIX: full desktop-Chrome UA + `Accept-Language` on all
    fetches (`USER_AGENT`/`ACCEPT_LANGUAGE`). Unblocked Pacific Crest → 11 posts.
  - **WordPress-core sitemap name** — some WP sites use `wp-sitemap.xml` (core) not
    `sitemap_index.xml` (Yoast). FIX: seed `wp-sitemap.xml` too.
  - **Legit-empty** — some corps genuinely have ~no staff announcements (Carolina Gold = 2 blog
    posts total). 0 is correct there, not a bug.
  - **Still hard (lower ROI):** Madison Scouts (REST disabled / non-WP), Colts (HTML `/news` only,
    no REST/sitemap), Oregon Crusaders (sitemap lacks post sub-maps). Need an HTML news-index
    scan tier and/or render-fallback for blocked XML/JSON — deferred.
- **Remaining:** render-heavy corps (Mandarins/Troopers/Cascades/Cavaliers/SCV/Bluecoats) not yet
  applied — run as a background `--apply` batch (each post renders). The `<2 people` guard drops
  single-person prose adds ("X joins Y") — those are A4's job (DCI roundups + prose). 44 new
  cross-corps name collisions queued for the merge pass.
