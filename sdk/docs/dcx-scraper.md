# DCX Museum Scraper — Reference & Field Notes

The operational guide to scraping **dcxmuseum.org** ("Drum Corps Xperience", a
volunteer drum-corps history archive) into a standalone, queryable SQLite DB
(`sdk/dcx.db`). This is the "how it actually works + everything we learned" doc;
the forward-looking design lives in [`dcx-full-scrape-plan.md`](./dcx-full-scrape-plan.md),
and the general web-scraping playbook is
[`web-research-and-scraping-field-guide.md`](./web-research-and-scraping-field-guide.md).

> **Status:** every page family has a tested parser + a wired, restart-safe
> handler. Validated on samples (corps 17/25/34/27/8/45/1403 + full asset/photo
> sweeps). The full ~14,490-corps run has **not** been executed — it's a
> deliberate, on-request step.

---

## 1. TL;DR — how to run it

```bash
cd sdk

# create the DB + schema
npx tsx scripts/scrapeDcx.ts --init --db ./dcx.db

# scrape a few known corps + all the singleton rooms (sample)
npx tsx scripts/scrapeDcx.ts --rooms all --ids 17,25,34 --db ./dcx.db

# a single room family
npx tsx scripts/scrapeDcx.ts --rooms assets --db ./dcx.db
npx tsx scripts/scrapeDcx.ts --rooms photos --db ./dcx.db

# the whole corps directory (LONG — ~14.5k pages; throttled, hours)
npx tsx scripts/scrapeDcx.ts --rooms corps --db ./dcx.db

# add per-year composer/placement backfill (VERY long — corps × decades)
npx tsx scripts/scrapeDcx.ts --rooms corps --repyear --db ./dcx.db

# inspect / resume / recover
npx tsx scripts/scrapeDcx.ts --status --db ./dcx.db   # queue counts
npx tsx scripts/scrapeDcx.ts --reset  --db ./dcx.db   # requeue failed tasks
# (just re-run the same command to resume — see §5)
```

**Flags:** `--db <path>` (default `./dcx.db`), `--rooms a,b,c` (default `all` =
`corps,assets,photos,shows,people,hof`), `--ids 17,34` (specific corps, skips
enumerate), `--limit N` (cap enqueued corps — testing), `--concurrency N`
(default **2**, keep it polite), `--repyear` (opt into per-year backfill),
`--init` / `--status` / `--reset`.

---

## 2. The site, as reverse-engineered

A **ColdFusion** app: `index.cfm?roomid=<R>&view=<V>&option=<O>`. Numeric "rooms"
nest; "views" pick a renderer. **No Cloudflare** — plain `fetch`/`curl` with a
generic UA works (no Browserbase/puppeteer needed anywhere).

> ⚠️ **`robots.txt` is `Disallow: /`.** It's a volunteer archive. We scrape
> **politely**: concurrency ≤2, ~400 ms global spacing + jitter, a descriptive
> contact UA, fully resumable so we never re-hammer. Don't crank concurrency.

### Room map
| Room | Views (option) | What it is |
|---|---|---|
| 100 | `corps` lists: all/active/international/allgirl/junior/senior/soundsport/drumline/military/parade/alumni/minicorps/state | corps directory → detail hub |
| 200 | `shows` current/byyear/major; `assets` video/recordings | event/show listings |
| 300 | `shows` calendar/thisyear/summary; `repertoires` current; `photos` current | season views |
| 700 | `photos` recent/photographer/historical/current/season | photo galleries (grouped) |
| 800 | `people` members/halloffame/interviews/biographies/collection/contributor/donors | people |
| 900/1200 | ~25 `assets` rooms (jackets, hats, pins, programbooks, posters, …) | memorabilia |
| 1000 | `assets` guard/percussion/brass | instruments |
| 1100 | `assets` dcw/dcn/historybooks/newspaper; `bookcase`; `PublicationList` | publications |
| 1300 | `decade` 1301–1311 | decade browse (navigational; redundant) |

### The corps-detail hub — `index.cfm?view=corpslist&corpsid=<N>`
**The single richest page** and the bulk of the data (~14,490 corps IDs from
`roomid=101&option=all`). One ~280 KB fetch returns **all 7 tabs inline** as
Bootstrap `.tab-pane` `#tab-1..7` — the `tab=` query param is a *client-side
toggle only* (every `tab=N` returns the identical page). Tabs:

1. **Repertoire** — `#RepDiv table`, rows: Year (`onclick="repDisplayYear(corps,YEAR)"`),
   Position/Score (empty inline — they live in tab-4 / RepYear), Theme/Songs
   (`<a>` per song, `*`-separated). Song links carry `view=search&song=…`.
2. **Photos** — `#PhotoDiv .col-sm-3` photo *groups* (year + count badge + thumb).
3. **History** — `.panel-body p` narrative prose.
4. **Scores** — `ul.notes > li`: `.score-year`, `.score-count`,
   `.score-details` ("…placed N with a score of NN.NNN"), `.high-score-footer`.
5. **Members** — `#memberFoo` footable: `[icon] | Name(modalmembers.cfm?MemberID=N) | Role | Years`.
6. **Collections** — the corps's own memorabilia, **same gallery markup as the
   asset rooms** (we reuse the asset parser, scoped to `#tab-6`).
7. **Links** — external links (`#tab-7 a[href^=http]`: home page, wiki, …).

Header block also carries: `<h1>` name, `<p>` "City, ST Country / Founded: YYYY",
a right-rail `<div align=right>` "**Active Junior**<br>**World Class**"
(= status + division + class), and a `images/corpslogos/<id>.png` **logo**.

### Per-year repertoire detail — `Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=<N>&CorpsYear=<Y>`
The inline tab-1 lists songs but **no composers**. This endpoint returns the
richer per-year view (show title, **composer per work**, final position + score).
Parsed by the pre-existing `parseRepYearHtml` in `src/showScraperDcx.ts`.

### Shows by year — `index.cfm?roomid=202&view=shows&option=byyear`
Server-rendered (not JS — an early wrong assumption). One `ul.list-group` **per
show**: `li.active` = date, `li .alert-info` = event name, `li .alert-warning
a[onclick=setMainDIV('show.cfm?…ShowID=N')]` = location + showId, then
`li a[onclick=showChangeYear(year,_,corpsId)]` = the corps lineup.

### People — `roomid=80x&view=people&option=…`
- `biographies` → `.col-sm-3.well` cards, each a **PDF document**
  (`<a href="assets/*.pdf" title="…">` + caption "… Contributed by <name>").
- `halloffame` → an **index** of links to individual halls (`view=wdchof`,
  `view=dcihof`, `view=bughof`, …). Those sub-pages are **prose articles**
  (`<article>` with an embedded base64 image), *not* structured inductee rows —
  so we capture each hall's title + body text, not a member list.

### Memorabilia / publication galleries — `roomid=<R>&view=assets&option=<cat>`
Each card: `<a href="assets/<file>" title="<title>" class="swipebox"><img
src="assets/thumbnail/<file>"></a>` + `<span id="Caption…">` full caption + an
optional owning-corps link (`…corpslist&CorpsID=N`). Caption format:
"<title> from the <X> Collection Contributed by <Y>" → we parse collection +
contributor. **See §3 for the pagination, which was the trickiest bit.**

### Photo rooms — `roomid=70x&view=photos&option=…`
Render photo **groups** inline (`#PhotoDiv .col-sm-3`): `<h4><year> <span
class=badge>N Photos</span></h4>` + thumb + `PhotoShowModal.cfm?PictureYear=&
Photographer=&corpsid=`. **No pagination.** Per scope we index the groups, not
the individual images behind the modal.

---

## 3. The asset-gallery pagination puzzle (read before touching assets)

Asset rooms show only **20 items per page** but report e.g. "299 items". Getting
the rest took real digging — here's the model so you don't re-derive it:

1. The room shell (`index.cfm?...` **or** `assets.cfm?roomid=R&option=O`) embeds
   a JS array:
   ```js
   var AssetPage = [];
   AssetPage[AssetPage.length] = '2829,2830,…';   // 20 caption-ids, page 1
   AssetPage[AssetPage.length] = '2849,2850,…';   // page 2
   // … one element per page
   ```
   `parseAssetPageChunks()` pulls these chunks out.
2. Each chunk loads its 20 cards via:
   ```
   assets_display.cfm?roomid=<R>&option=<O>&assetlist=<comma-ids>
   ```
   **Gotchas that cost time:**
   - A **bare** `assets_display.cfm?assetlist=…` (no roomid/option) returns
     **HTTP 500**. You MUST include `roomid` + `option`.
   - `assets.cfm?...&page=2` / `&startrow=21` / `&PageNum=2` are all **ignored**
     (always returns page 1). Pagination is *only* via the `assetlist` chunks.
3. So the `asset-room` task fetches `assets.cfm`, extracts the chunks, and
   **fans out one durable `asset-page` task per chunk** (each fetches
   `assets_display.cfm` → parses → upserts). This rides the same restart-safe
   queue, so a kill mid-gallery resumes cleanly.

**Dedup:** many items have an alternate "`--2`" view image
(`JA0001-.jpg` + `JA0001--2.jpg`). Both collapse to one `asset_code` (we keep the
primary). So a "299 items" room yields ~126 unique assets — expected, not a bug.

**Photo rooms do NOT use this** — their groups are fully inline (§2).

---

## 4. Architecture (all Effect)

```
scripts/scrapeDcx.ts          CLI orchestrator: enqueue top-level tasks → drain queue
src/dcxScrape/
  dcxClient.ts                throttled polite fetch (UA, global spacing+jitter, retry)
  dcxQueue.ts                 durable claimable queue + Effect worker pool
  dcxDb.ts                    schema DDL + coalescing upserts (one per table family)
  enumerate.ts                list→id parsing + every room URL + room registries
  parseCorps.ts               corps-detail hub: all 7 tabs + header (pure)
  parseAssets.ts              gallery cards + AssetPage chunk extraction (pure)
  parsePhotos.ts              photo-room groups (pure)
  parseShows.ts               shows-by-year + lineup (pure)
  parsePeople.ts              biographies + HOF index + HOF article pages (pure)
src/showScraperDcx.ts         (pre-existing) parseRepYearHtml — reused for backfill
```

**Layering:** `LibsqlClient.layer({url:"file:dcx.db"})` provides `SqlClient`;
`DcxQueueLive` + `DcxClientLive` are `Context.Service`s on top. All parsers are
**pure functions over an HTML string** (no network) — that's why they're trivially
unit-tested against saved fixtures in `test/fixtures/dcx/`.

### Task types (all flow through the durable queue)
| task_type | params | does |
|---|---|---|
| `corps` | `{id, withRepYear}` | fetch detail → upsert; if `withRepYear`, fan out `repyear` per score-year |
| `repyear` | `{id, year}` | fetch RepYear → fill composer/show-title/placement/score |
| `asset-room` | `{roomid, option}` | fetch `assets.cfm` → fan out `asset-page` per chunk |
| `asset-page` | `{roomid, option, assetlist}` | fetch `assets_display.cfm` → upsert cards |
| `photo-room` | `{roomid, option}` | fetch photo room → upsert groups |
| `shows` | `{}` | fetch shows-by-year → upsert shows + lineup |
| `bios` | `{}` | fetch biographies → upsert PDF docs |
| `hof-index` | `{}` | fetch HOF index → fan out `hof-page` per hall |
| `hof-page` | `{view, name}` | fetch hall article → upsert title+body |

---

## 5. The durable queue (the stop/restart guarantee)

The defining requirement: **kill the process at any point, relaunch, and it
resumes without losing or repeating work.** A plain status table can't tell
"in-flight" from "never started" after a crash, so we use a **SQLite-backed,
lease-based claimable queue** (`scrape_queue` in `dcx.db`).

- **Enqueue** = `INSERT … ON CONFLICT DO NOTHING` (idempotent; re-running enqueues
  nothing already present).
- **Claim** = one atomic `UPDATE … WHERE status='pending' OR (status='claimed'
  AND lease_expires_at < now) ORDER BY priority, enqueued_at LIMIT 1 RETURNING *`.
  Atomicity means two workers never grab the same row.
- **Lease** (5 min): a worker that **crashes** leaves a `claimed` row whose lease
  lapses → it becomes claimable again automatically. No manual cleanup.
- **Settle:** success → `done`; "nothing here" → `empty` (honest gap, terminal);
  error → requeue `pending` (attempts++) until `max_attempts`, then `failed`.
- **Workers:** N fibers (`--concurrency`) each loop *claim→handle→settle*; the
  pool drains when no claimable rows remain.
- **Restart procedure:** literally just re-run the same command. On startup the
  CLI re-creates the schema (idempotent) and calls `reclaimExpired()`; `done`/
  `empty` rows are skipped, `pending` resume, crashed leases reclaim. `--reset`
  requeues terminally-`failed` rows.

**Delivery is at-least-once:** a task interrupted *after* fetch but *before*
settle will re-run on resume. Every handler is therefore idempotent (upserts key
on stable PKs; `repyear` does delete-by-(corps,year) then insert).

Proven by `test/dcxQueue.restart.test.ts`: enqueue 12 → crash mid-drain at done=4
→ expire leases → reclaim → resume → done=12, no loss, 14 total handles (2
redeliveries).

---

## 6. The database (`dcx.db`)

Standalone — **does not touch `dci-relational.db`**. (Linking DCX ids into the
main DB is a separate concern; `scripts/backfillDcxMuseumLinks.ts` already maps
corps↔DCX.) Tables:

| table | grain | key columns |
|---|---|---|
| `scrape_queue` | one per task | `task_key`, `status`, `priority`, lease |
| `corps` | one per corps | id, name, nickname, city/state/country, founded/disbanded, **status/division/class**, **logo_url**, history_text |
| `corps_links` | corps × link | url, label (tab-7) |
| `corps_repertoire` | corps × year × work | show_title, work_title, **composer** (RepYear), arranger |
| `corps_scores` | corps × year × event | placement, score, event_name |
| `corps_members` | corps × person | name, role, years, member id |
| `assets` | one per asset_code | category, title, caption, year, **collection**, **contributor**, owning corps, image/thumb |
| `photos` | photo group | year, count(caption), photographer, owner_type=`corps`/`room-<opt>`, owner_id |
| `shows` | one per show | year, show_date, event_name, location |
| `show_corps` | show × corps | lineup (corps id + name) |
| `publications` | one per doc | collection (`biography`/`dcw`/…), title, image_url |
| `hof_pages` | one per hall | view, title, body_text |

**Coalescing vs replace:** `corps` upsert COALESCEs (a thin re-scrape never nulls
an existing value). Child rows are the full current set per parent → `INSERT OR
REPLACE` on their PK. Every row carries `source_url`.

Handy queries:
```bash
sqlite3 dcx.db "SELECT year,work_title,composer FROM corps_repertoire WHERE dcx_corps_id='17' AND year=2024;"
sqlite3 dcx.db "SELECT category,COUNT(*) FROM assets GROUP BY category ORDER BY 2 DESC;"
sqlite3 dcx.db "SELECT event_name,location,show_date FROM shows ORDER BY show_date;"
sqlite3 dcx.db "SELECT status,COUNT(*) FROM scrape_queue GROUP BY status;"   # progress
```

---

## 7. Scope & deliberate omissions

- **"Everything but media bytes."** We store image/doc **URLs** and rich metadata,
  but do **not** download files. (Re-hosting bytes is a separate media-cache step
  if ever wanted — see field-guide §10.)
- **Normalized tables only** (no raw-HTML archive table). Trade-off: a parser fix
  means re-fetching. Mitigated by the polite, resumable queue + saved fixtures.
- **Photo individuals** behind `PhotoShowModal.cfm` are not expanded — we index
  the groups (counts + thumbs). Same for video/recordings rooms (not yet wired).
- **HOF inductees** aren't structured on the site (prose articles) — captured as
  text, not rows.
- **Decade (1300) views** skipped — redundant with corps/shows.

---

## 8. Lessons learned (the time-savers)

1. **All 7 corps tabs are one fetch.** Don't fetch `tab=1..7` separately — the
   param is cosmetic; you'd 7× the load for identical bytes.
2. **"JS-loaded" was wrong for people/shows.** They're server-rendered with
   unfamiliar markup (cards/`ul.list-group`), not ajax. Always grep the static
   body for the *data* (names, dates) before assuming you need a renderer.
3. **Asset pagination is via an `AssetPage[]` id-array + `assets_display.cfm`,
   and that endpoint 500s without `roomid`+`option`.** `&page=`/`&startrow=` are
   ignored. (§3.)
4. **Generic UA only.** Same field-guide rule: a plain `Mozilla/5.0`/contact UA
   is fine; no need to spoof Chrome (and DCX has no Cloudflare anyway).
5. **Effect 4 beta API drift:** `Effect.fork` → **`Effect.forkChild`**;
   `Schedule.compose` → **`Schedule.both`** for capped retries; services use
   **`Context.Service`** (dominant in this repo) not `Context.Tag`; SQL via
   `effect/unstable/sql/SqlClient` + `sql.unsafe(ddl)` for raw DDL.
6. **Caption provenance is structured prose:** "from the X Collection Contributed
   by Y" parses cleanly into collection + contributor.
7. **Dedup the `--2` alternate-view images** or asset counts look wrong.
8. **Test against real saved pages, not hand-mocks.** Every parser has a fixture
   in `test/fixtures/dcx/` captured with curl; that caught the off-by-one (a
   `showChangeYear` template ref outside any `ul.list-group`) and the member
   blank-row filtering.

---

## 9. Tests

Plain `tsx`-run assert harness (repo convention), all against **real saved
fixtures** in `test/fixtures/dcx/`:

```bash
cd sdk
npx tsx test/parseCorpsDetail.test.ts     # 45 — corps hub, all tabs + robustness
npx tsx test/parseAssets.test.ts          # 23 — gallery + provenance + pagination chunks
npx tsx test/parseShowsPeople.test.ts     # 19 — shows lineup + bios + HOF index
npx tsx test/parsePhotos.test.ts          #  8 — photo-room groups
npx tsx test/dcxQueue.restart.test.ts     #  9 — durable-queue crash/resume proof
```

104 assertions total. Add a fixture (`curl -A "<UA>" "<url>" -o
test/fixtures/dcx/<name>.html`) whenever you touch a parser.

---

## 10. What's left for a complete mirror

- **The full corps run** (`--rooms corps`, ~14,490 pages) — throttled background
  job, hours. Then optionally a **second `--repyear` pass** (corps × decades — very
  large; keep it separate so the base corps data lands first).
- **Verification counts** after a full run (rows vs. the site's list counts).
- Not yet wired (low value / out of scope): video & recordings rooms (200),
  `interviews`/`collection`/`contributor`/`donors` people options, bookcase/
  PublicationList (1100), decade browse.
