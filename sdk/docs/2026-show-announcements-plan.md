# 2026 DCI Show Announcement Research & Ingestion Plan

**Status:** In Progress — Milestones 1-5 Partially Complete  
**Last Updated:** 2026-06-08  
**Author:** OpenCode Agent  
**Related Docs:** `dci-website-scraping.md`, `ingest-scrape-data-generation.md`, `CORPS_SCRAPING_PLAN.md`

---

## Quick Status (as of 2026-06-08)

| Milestone | Status | Notes |
|-----------|--------|-------|
| 1. Schema Extension | ✅ Done | `corps_show_designers`, `corps_show_movements`, `show_announcement_scrapes` tables + indexes |
| 2. Effect Services | ✅ Done | `showErrors.ts`, `showScraperDcx.ts`, `showScraperFlomarching.ts`, `showScraperAgent.ts`, `showIngestion.ts`, `showOrchestrator.ts`, `showLayers.ts` |
| 3. Entry Script | ✅ Done | `ingestShowAnnouncements.ts` with `--apply`, `--report`, `--source dcx\|flomarching\|agent\|dciorg\|all` |
| 4. DCX Museum Scraper | ✅ Done | 81 shows, 150 repertoire entries, 34 real titles, 47 placeholders |
| 5. Agent Scraper | ⚠️ Partial | browser-tools CLI works, but `extractShowFromHtml()` produces garbage titles; reverted |
| 6. FloMarching Scraper | ✅ Done | Paywall detection, article parsing, search function |
| 7. DCI.org Scraper | ✅ Stub | Cloudflare-blocked, `DciOrgScraper` service wired, returns empty |
| 8. Reporting | ✅ Done | `showReport.ts` with class breakdown, missing titles, recently updated |
| 9. Tests | ✅ Done | 71 tests passing (30 parser + 41 orchestrator) |
| 10. Media Download | ❌ Not Started | Deferred — media download for existing entries |

---

## Current DB State (2026 season)

- **81 shows** total
- **34 with real titles** (from DCX Museum)
- **47 with placeholder titles** (corps haven't announced yet)
- **150 repertoire entries** (DCX Museum)
- **0 designers/movements** (DCX doesn't have this data)
- **1 media asset** (Spark show)

---

## Executive Summary

This plan documents a systematic, multi-source pipeline for researching and ingesting 2026 DCI season show announcements (titles, repertoire, designers, movements, media) into the existing `corps_shows` family of tables. It leverages **four source tiers**: (1) DCX Museum for structured repertoire, (2) FloMarching for rich narrative articles, (3) DCI.org for official press releases, and (4) a **browser-enabled agent (Codex)** that explores corps websites, social media (Instagram, Twitter/X, YouTube, TikTok, Facebook), and the open web to fill gaps with confidence-scored data. The agent uses a **three-tier browser stack**: Tier 1 (built-in free browser for public sites), Tier 2 (Playwright connected to your Edge browser via CDP for login-gated content), and Tier 3 (Browserbase cloud browser as expensive last resort for Cloudflare-blocked pages). The pipeline extends the relational schema with new tables for designers and movements, and targets **50 competitive corps** (World, Open, All-Age) already confirmed in the 2026 event lineup.

---

## 1. Background & Context

### 1.1 Current DB State

The relational DB (`sdk/dci-relational.db`, ~2.5 GB) already contains:

- **81 events** for the 2026 season (event directory from `ingestEventsFromWebsite.ts`)
- **1,042 event lineup entries** across 99 distinct corps (from event page scrapes)
- **0 rows** in `corps_shows`, `corps_show_repertoire`, `corps_show_media`, `corps_show_tags`, `corps_show_reviews` — the schema exists but has never been populated
- Established corps identity via `corps_key` (DCI Salesforce-style IDs for most; custom slugs for newer corps like `zephyrus-drum-bugle-corps`)

### 1.2 Why This Matters

Show data (repertoire, designers, themes, social media presence) is a core feature request. It enables:
- **Prediction context** — repertoire/genre/style features for ML models
- **Fan experience** — show pages with titles, descriptions, photos, videos, social media links
- **Historical analysis** — cross-season show evolution, designer influence
- **Discovery** — find corps by composer, theme, arranger
- **Real-time updates** — social media often announces shows before official press releases; the agent captures these early signals

### 1.3 Existing Infrastructure We Reuse

| Component | File | Reuse Pattern |
|---|---|---|
| Browserbase bypass | `sdk/src/browserbaseService.ts` | All Cloudflare-protected fetches |
| Website scraper API | `sdk/src/websiteApi.ts` | Caching layer (website_recaps, api_responses) |
| Corps parser | `sdk/src/corpsParser.ts` | Name normalization (`matchExistingCorpsKey`) |
| Media caching | `sdk/src/mediaService.ts` + `media-cache.db` | Photo byte storage |
| Relational schema | `sdk/src/relational.ts` | New table CREATEs + INSERT/UPSERT helpers |
| Domain schemas | `sdk/src/extraDomain.ts` | Extend `CorpsShowSchema` |
| Agent browser skill | `agent-browser` (available skill) | Browser automation for corps sites + social media |

### 1.4 The 2026 Season Timeline

- **April–June:** Show announcements roll out (designers announced, repertoire published)
- **Late June:** Season opens (first shows)
- **Early July:** Tour begins in earnest
- **We are here:** Early June — many but not all corps have announced. Top World Class corps (Madison Scouts, Blue Stars, Bluecoats, Cavaliers) still show "No title yet" on DCX Museum.

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. **Identify and rank** all 2026 competitive corps by class and show count (done via existing DB query)
2. **Scrape 3 structured sources** (DCX Museum → FloMarching → DCI.org) to collect per-corps show data
3. **Use a browser-enabled agent (Codex)** to explore corps websites, social media, and the open web to fill gaps with confidence-scored data
4. **Extend schema** with `corps_show_designers`, `corps_show_movements`, `show_announcement_scrapes`
5. **Ingest structured data** into `corps_shows`, `corps_show_repertoire`, `corps_show_designers`, `corps_show_movements`, `corps_show_media`, `corps_show_tags`
6. **Download all referenced photos/media** into `media-cache.db`
7. **Archive every raw scrape and agent report** for re-parsing and time-travel (mirrors `corps_page_scrapes` pattern)

### 2.2 Non-Goals

- **Do NOT** write data back to `corps` table (the existing corps directory data is authoritative)
- **Do NOT** attempt to populate `corps_show_reviews` (critic reviews are out of scope for this pass)
- **Do NOT** scrape non-competitive corps (SoundSport, Exhibition, Drumline, International, Alumni, Minicorps) unless the user explicitly requests
- **Do NOT** run destructive `DROP TABLE` operations in `ensureRelationalSchema` (learned from prior incident — see AGENTS.md)

---

## 3. Target Corps

Queried from `event_participants` + `events` + `corps` on 2026-06-08. Ordered by class (World → Open → All-Age) then by show count descending.

### 3.1 World Class (20 corps, 16–20 shows each)

| Rank | Corps | corps_key | Shows |
|---|---|---|---|
| 1 | Madison Scouts | `001j000000i6lenaa3` | 20 |
| 1 | Blue Stars | `001j000000iwwsqaal` | 20 |
| 1 | Seattle Cascades | `001j000000iwx93aad` | 20 |
| 1 | Colts | `001j000000iwx98aad` | 20 |
| 1 | The Cavaliers | `001j000000iwxafaa1` | 20 |
| 1 | Troopers | `001j000000iwxajaa1` | 20 |
| 7 | Phantom Regiment | `001j000000h3xrnaav` | 19 |
| 7 | Santa Clara Vanguard | `001j000000h3xwcaav` | 19 |
| 7 | Blue Knights | `001j000000iwwsoaal` | 19 |
| 7 | Bluecoats | `001j000000iwwsraal` | 19 |
| 7 | The Academy | `001j000000iwxaeaa1` | 19 |
| 12 | Blue Devils | `001j000000i6i9saav` | 18 |
| 12 | Boston Crusaders | `001j000000iwwssaal` | 18 |
| 12 | Music City | `001j000000iwxa5aal` | 18 |
| 12 | Pacific Crest | `001j000000iwxa7aad` | 18 |
| 12 | Spirit of Atlanta | `001j000000iwxadaa1` | 18 |
| 17 | Carolina Crown | `001j000000iwx91aad` | 17 |
| 17 | Crossmen | `001j000000iwx9aaat` | 17 |
| 17 | Genesis | `001j000000iwx9oaad` | 17 |
| 20 | Spartans | `001j000000iwxacaa1` | 16 |

> **Note:** Mandarins (`001j000000iwxa1aal`) are inactive for 2026 and excluded from this list.

### 3.2 Open Class (17 corps, 3–17 shows each)

| Rank | Corps | corps_key | Shows |
|---|---|---|---|
| 1 | Gold | `001j000000iwx9paad` | 17 |
| 2 | Colt Cadets | `001j000000iwx97aad` | 13 |
| 3 | 7th Regiment | `001j000000iwwslaal` | 12 |
| 3 | Les Stentors | `001j000000iwxa1aal` | 12 |
| 3 | River City Rhythm | `001j000000qzs1qaaf` | 12 |
| 3 | The Battalion | `001j0000012y6bqaac` | 12 |
| 7 | Raiders | `001j000000iwxaaaa1` | 11 |
| 8 | Memphis Blues | `0015b00002byuh0aap` | 9 |
| 9 | Columbians | `001j000000iwx99aad` | 8 |
| 9 | Impulse | `001j000000iwx9uaad` | 8 |
| 11 | Blue Devils "B" | `001j000000i6jmbaaf` | 7 |
| 11 | Golden Empire | `001j000000iwx9qaad` | 7 |
| 11 | Heat Wave | `001j000000iwx9taad` | 7 |
| 14 | Zephyrus | `zephyrus-drum-bugle-corps` | 6 |
| 15 | Blue Devils "C" | `001j000000i6kalaa3` | 5 |
| 16 | Guardians | `001j000000iwx9saad` | 3 |
| 17 | Blue Saints | `001j000000iwwspaal` | 1 |

### 3.3 All-Age Class (13 corps, 2–8 shows each)

| Rank | Corps | corps_key | Shows |
|---|---|---|---|
| 1 | Bushwackers | `bushwackers-drum-corps` | 8 |
| 2 | Reading Buccaneers | `0010a00001e2pfhaam` | 7 |
| 2 | Atlanta CV | `001j000000iwwsnaal` | 7 |
| 2 | Cincinnati Tradition | `001j000000iwx94aad` | 7 |
| 2 | Hurricanes | `hurricanes` | 7 |
| 6 | Hawthorne Caballeros | `0015b00001mpuwcaak` | 6 |
| 6 | Rogues Hollow Regiment | `001j000000cap31aaa` | 6 |
| 6 | Govenaires | `001j000000iwx9raad` | 6 |
| 9 | Sunrisers | `0010a00001iqmzuaah` | 5 |
| 9 | White Sabers | `001jw00000d0zlniaj` | 5 |
| 11 | Fusion Core | `001j000000gbtqyaac` | 3 |
| 11 | Columbus Saints | `001j000000hiripaaz` | 3 |
| 11 | MBI | `mbi` | 3 |

> **Excluded from scope:** SoundSport, Exhibition, International, Alumni, Minicorps, Drumline corps (per user preference: "only the ones with appearances in 2026" ordered by class). These have 1–6 shows but are not competitive DCI classes.

---

## 4. Data Sources — Deep Dive

### 4.1 Source 1: DCX Museum (`dcxmuseum.org`)

**Primary source** — structured, server-rendered HTML, no Cloudflare, no paywall.

#### URLs
- Master repertoires list: `https://www.dcxmuseum.org/index.cfm?roomid=302&view=repertoires&option=current`
- Per-corps detail: `https://www.dcxmuseum.org/index.cfm?view=corpslist&corpsid=<ID>&corpsyear=2026`

#### Data Available (repertoires page)
- Corps name
- Show title (or "No title yet")
- Full repertoire list: song titles with hyperlinks to song pages
- Class/division (implied by page section headers: "Junior", "All Age", etc.)
- Some corps have composers in song links (e.g. `Volker Bertelmann`, `Zacarías M. de la Riva`)

#### Data Available (corps detail page) — unverified, assumed
- More detailed show description
- Movement breakdowns
- Composer/arranger per song
- Photo gallery links

#### Edge Cases
- **"(Repertoire not available)"** — some corps have a title but no songs listed
- **"No title yet"** — some corps have repertoire but no formal title (e.g. Blue Devils 2026)
- **Formatting anomalies** — repertoire is a single line with `*` separators; song titles may contain commas, parentheses, accents
- **Duplicate song titles** — some corps list the same song twice (e.g. "Young and Beautiful" listed twice for Spartans)
- **Inconsistent artist attribution** — some songs have artist names inline, some link to artist pages, some have no attribution
- **Class section headers change** — Junior vs All Age vs Alumni vs International — we must map these to our `division_name`

#### Fetch Method
- Plain `fetch()` (Node.js native) — no Browserbase needed
- Cache raw HTML in `show_announcement_scrapes` with `source_type='dcx_museum'`
- Parse with `cheerio` (already in project dependencies)

### 4.2 Source 2: FloMarching (`flomarching.com`)

**Secondary source** — rich narrative content, JS-rendered, requires Browserbase.

#### URLs
- Running list: `https://www.floMarching.com/articles/14791418-a-running-list-of-drum-corps-international-2026-show-announcements`
- Individual articles: `https://www.floMarching.com/articles/<id>-<slug>`
- Search: `https://www.floMarching.com/search?q=2026+show+announcement+DCI`

#### Data Available (individual articles)
- Show title + subtitle
- Full narrative description
- Design team members (brass arranger, percussion arranger, visual designer, color guard designer, etc.)
- Movement breakdowns (titles + descriptions)
- Repertoire (song titles + artists + composers)
- Direct quotes from designers/directors
- Hero image / photo URLs

#### Data Available (running list)
- Corps → show title mapping
- Links to individual articles
- Some repertoire snippets

#### Edge Cases
- **Paywall** — articles may require FloMarching subscription. If hit, we get a teaser/snippet only. We should archive what we get and flag as partial.
- **JS-rendered** — `fetch()` returns shell HTML without article content. Must use Browserbase (which renders JS).
- **Article quality varies** — some are full announcements with designers; some are brief title-only posts
- **Photo URLs are CDN-hosted** — `d2779tscntxxsw.cloudfront.net` — may have expiry or require referer
- **Search pagination** — 25 results per page; running list may span multiple pages

#### Fetch Method
- Browserbase for all FloMarching URLs
- Cache raw rendered HTML in `show_announcement_scrapes` with `source_type='flomarching_article'` or `'flomarching_running_list'`
- Parse with `cheerio`

### 4.3 Source 3: DCI.org News (`dci.org/news` or blog)

**Tertiary source** — official, most authoritative, but sparse.

#### URLs
- News/blog section: `https://www.dci.org/news/` or `https://www.dci.org/blog/`
- Individual articles: `https://www.dci.org/news/<slug>/`

#### Data Available
- Official press releases
- Designer quotes
- Repertoire announcements
- Photos

#### Edge Cases
- **Behind Cloudflare** — DCI.org is now behind Cloudflare. Direct `fetch()` returns challenge page. Browserbase required.
- **Sparse coverage** — DCI.org does not announce every corps' show; they may only cover high-profile announcements
- **Article discovery** — no clear search API; may need to browse listing pages

#### Fetch Method
- Browserbase for all DCI.org URLs
- Cache in `show_announcement_scrapes` with `source_type='dci_org'`

### 4.4 Source 4: Corps Websites & Social Media (Codex Agent)

**Gap-filling source** — a browser-enabled agent (Codex) explores the open web, corps websites, and social media to find details missing from the structured sources above.

#### Why an Agent?

Structured scrapers are brittle against:
- **JavaScript-heavy corps websites** (React/Vue single-page apps where `fetch()` returns empty shell HTML)
- **Social media embeds** (Instagram grids, Facebook posts, TikTok embeds) that require JS rendering and human-like interaction
- **Unstructured blog posts** on corps websites (designer interviews, announcement blog posts) with no consistent DOM pattern
- **YouTube descriptions** linked from corps sites — show titles, movement names, and designer credits often appear in video descriptions before they appear anywhere else

A browser-enabled agent can:
- Navigate a corps website, click "2026 Season" or "Shows" nav links, read the resulting page
- Search Google for `"<corps name>" 2026 show announcement`
- Browse Instagram/Twitter posts for 2026 show reveals (photo captions often contain titles, designer names, repertoire snippets)
- Extract data from YouTube video descriptions (official show reveal videos)
- Provide **confidence scores** alongside every fact it discovers

#### Data Available

| Platform | What We Get |
|---|---|
| **Corps website** (e.g. `bluestars.org`, `cavaliers.org`) | Official show title, subtitle, narrative description, design team roster, show concept write-ups, press-release PDFs |
| **Instagram** (`instagram.com/<corps handle>`) | Reveal photos/videos with captions containing titles, designer credits, movement names; Stories highlights for 2026 season |
| **Twitter/X** (`x.com/<corps handle>`) | Announcement tweets with show titles, designer threads, video links |
| **Facebook** (`facebook.com/<corps page>`) | Event posts, photo albums, announcement posts |
| **YouTube** (`youtube.com/<corps channel>`) | Show reveal videos — titles, descriptions, comments from designers; performance videos from spring training |
| **TikTok** (`tiktok.com/<corps handle>`) | Short-form content, behind-the-scenes with designers |
| **Google Search** | Find corps-specific blog posts, local news articles, fan forum discussions |

#### Agent Prompt Template

For each corps with missing data after Sources 1–3, dispatch an agent with this prompt:

```
You are researching the 2026 DCI show for <CORPS_NAME>.

What we already know:
- Show title: <KNOWN_TITLE or "unknown">
- Repertoire: <KNOWN_SONGS or "unknown">
- Designers: <KNOWN_DESIGNERS or "unknown">
- Movements: <KNOWN_MOVEMENTS or "unknown">

Please explore the internet to find MISSING details. Focus on:
1. The corps' official website — look for "2026 Season", "Show", "Repertoire" pages
2. The corps' Instagram, Twitter/X, Facebook, YouTube, TikTok accounts
3. Google search for "<corps name> 2026 show announcement"
4. YouTube search for "<corps name> 2026" — check video titles and descriptions

For each fact you find, report:
- The fact (e.g. "Show title is 'Into Darkness'")
- The source URL
- Your confidence (HIGH / MEDIUM / LOW)
- Why you have that confidence (e.g. "HIGH — stated explicitly on official corps website", "MEDIUM — from a fan comment on Instagram", "LOW — inferred from a photo caption")

Do NOT guess. If you are unsure, say so. Only report facts you can verify with a URL.
```

#### Confidence Scoring Rules

| Confidence | Criteria | Ingestion Action |
|---|---|---|
| **HIGH** | Fact stated explicitly on official corps website, verified social media account, or official press release | Store directly; `source_type='agent_high'` |
| **MEDIUM** | Fact from reputable secondary source (FloMarching, DCI.org, corps social media with verified badge, local news) | Store with `source_type='agent_medium'` and flag for human review |
| **LOW** | Fact inferred from photo captions, fan comments, unverified social media, or indirect evidence | Store in `show_announcement_scrapes` as raw notes only; do NOT write to `corps_shows` |

#### Agent Browser Stack (Three Tiers, Cost-Ordered)

The agent uses the **cheapest viable browser method** for each target. We escalate only when the cheaper method fails.

| Tier | Method | Cost | When to Use | Cookies/Login |
|---|---|---|---|---|
| **1** | **Direct fetch + cheerio** | Free | Corps websites (static HTML, no JS required) | None (anonymous) |
| **1b** | **browser-tools CLI** (`scripts/browser-tools.ts`) | Free | Google search + JS-rendered pages via puppeteer-core + Edge/Chrome | None (anonymous) or your Edge profile if launched |
| **1c** | **`browse` CLI** (Browserbase local driver) | Free | Structured page interaction: open → snapshot → get → eval | Fresh local Chromium session |
| **2** | **Playwright → User's Edge via CDP** | Free | Sites requiring login (Instagram, Facebook, TikTok) | **Full** — uses your Edge profile |
| **3** | **Browserbase cloud + `browse` CLI** | ~$0.03/page | Cloudflare-blocked pages (DCI.org, FloMarching paywall) where Tier 1+2 fail | None (fresh session) |
| **3b** | **Browserbase skills** | ~$0.03/page | Reusable pre-built automations for specific sites | Varies by skill |

##### Tier 1: Direct Fetch + browser-tools CLI (Default)

**1a. Direct `fetch()`** is the first attempt for every corps website. Most corps sites are static or lightly dynamic and work fine with plain HTTP + cheerio parsing. This is completely free and requires no browser setup.

**1b. `browser-tools.ts` CLI** (`scripts/browser-tools.ts`) wraps `puppeteer-core` and connects to a locally running Edge/Chrome instance via the DevTools Protocol (CDP) on `http://localhost:9222`. It provides commands we spawn from the Effect service:

| Command | Purpose | Used By Agent Scraper |
|---|---|---|
| `start` | Launch Edge/Chrome with `--remote-debugging-port=9222` | Manual setup step |
| `nav <url>` | Navigate active tab to URL | Not used directly (service spawns `search`/`content`) |
| `search <query>` | Google search via browser automation; returns title/link/snippet | **Yes** — `runBrowserToolsSearch()` |
| `content <url>` | Extract readable article text via Readability.js + Turndown.js | **Yes** — `runBrowserToolsContent()` |
| `eval <code>` | Evaluate JS in page context | Not used |
| `screenshot` | Capture viewport or full page | Not used |
| `console` | Capture console logs | Not used |
| `network` | Capture network requests | Not used |
| `inspect` | List DevTools browser processes + tabs | Diagnostic |
| `kill` | Terminate DevTools browser instances | Cleanup |

Usage:
```bash
# Step 1: Launch Edge with remote debugging (one-time per session)
npx tsx scripts/browser-tools.ts start --browser edge --port 9222

# Step 2: The Effect service spawns search/content commands automatically
# No manual interaction needed
```

**Key design decision:** The `ShowScraperAgent` service does NOT import puppeteer-core directly. Instead, it spawns `npx tsx scripts/browser-tools.ts <command>` as a subprocess. This keeps the service lightweight and reuses the existing, well-tested CLI. The trade-off is slightly higher latency (~200ms spawn overhead) and parsing text output instead of structured objects.

##### Tier 1c: `browse` CLI (Browserbase Local Driver)

The **`browse` CLI** (`browse` command, installed via `bun install -g browse`) is Browserbase's unified browser automation tool. It runs a local Chromium instance (via Playwright) and exposes a command-line interface for page interaction. Unlike `browser-tools.ts` which requires an existing Edge/Chrome process, `browse` manages its own browser lifecycle.

**Key commands for our use case:**

| Command | Purpose | Example |
|---|---|---|
| `browse open <url>` | Open URL in active session | `browse open https://bluestars.org` |
| `browse snapshot` | Print accessibility tree + cache element refs | `browse snapshot` |
| `browse get <selector>` | Extract text/content from element | `browse get h1` |
| `browse eval <code>` | Evaluate JS in page context | `browse eval "document.title"` |
| `browse screenshot` | Capture viewport screenshot | `browse screenshot` |
| `browse cdp` | Stream DevTools Protocol events | `browse cdp` |
| `browse skills list` | List available Browserbase skills | `browse skills list` |
| `browse skills run <skill>` | Execute a pre-built skill | `browse skills run example.com/skill-name` |

**Usage pattern for show scraping:**

```bash
# Start a browse session (implicit on first command, or explicit)
browse open https://bluestars.org/2026-show

# Get page structure
browse snapshot

# Extract title
browse get "h1, .page-title, [property='og:title']"

# Extract article content
browse eval "document.querySelector('article, .content')?.innerText?.slice(0, 2000)"

# Screenshot for audit trail
browse screenshot --output ./audit/bluestars-2026.png
```

**Pros vs. browser-tools.ts:**
- Self-managed browser lifecycle (no need to pre-launch Edge)
- Richer output format (JSON snapshots with element refs)
- Built-in session management (`browse status`, `browse stop`)
- Video recording support (`browse open --record`)

**Cons vs. browser-tools.ts:**
- No built-in Google search command (we use `browser-tools.ts search` for that)
- No Readability.js/Turndown.js content extraction (we use `browser-tools.ts content` for that)
- Separate tool to install (`bun install -g browse`)

**Current plan:** We use `browser-tools.ts` for search/content extraction (Tier 1b) and reserve `browse` CLI for direct page interaction when we need structured element access (Tier 1c). Both are free and local.

##### Tier 2: Playwright + Your Edge Browser via CDP (Login Required)

When Tier 1 hits a **login wall** (e.g., Instagram shows "Log in to see this post"), we connect to your **already-running Edge browser** using the Chrome DevTools Protocol (CDP). This gives the agent:
- Your **logged-in sessions** (Instagram, Facebook, TikTok, YouTube account)
- Your **cookies and saved passwords**
- Your **browser extensions** (if any)
- The **same IP address** as your regular browsing (less likely to trigger bot detection)

**Setup (one-time):**

```powershell
# Close all Edge windows first, then launch Edge with remote debugging
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# Or use a dedicated profile to avoid interfering with your main browsing:
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\Users\Patrick\corps-place\.edge-agent-profile"
```

**Playwright connection code:**

```typescript
import { chromium } from 'playwright';

// Connect to your running Edge browser
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0]; // Uses your default profile
const page = await context.newPage();

// Now navigate as "you" — logged into Instagram, Facebook, etc.
await page.goto('https://www.instagram.com/bluestarsdci/');
```

**Why this matters:**
- Instagram blocks anonymous browsing after ~5 posts. With your logged-in session, we can browse freely.
- Facebook groups and pages often require login.
- TikTok's web interface is heavily gated without a session.
- YouTube personalized recommendations help find corps-specific videos faster.

**Safety:**
- The agent only **reads** pages (screenshots, text extraction). It does NOT click "Post", "Like", "Share", or "Comment".
- We use a **dedicated agent profile** (`--user-data-dir`) so your main Edge browsing is unaffected.
- All navigation is logged and archived in `show_announcement_scrapes`.

##### Tier 3: Browserbase (Last Resort, Expensive)

Only for pages that are **actively blocking all local browsers** via Cloudflare or advanced bot detection:
- DCI.org (Cloudflare challenge)
- FloMarching (Cloudflare + possible paywall)
- Some corps websites with aggressive bot protection

Browserbase runs a real browser in the cloud with residential IP rotation. It bypasses Cloudflare but costs per page. We use it **sparingly**.

**When NOT to use Browserbase:**
- Corps websites (Tier 1 handles these)
- Social media (Tier 2 handles these via your login)
- DCX Museum (plain fetch, no browser needed)

##### Tier 3b: Browserbase Skills (Reusable Site Automations)

**Browserbase skills** are pre-built, verified automation recipes for specific websites. They are published in the Browserbase skills registry and can be discovered via `browse skills list`.

**How skills work:**
- Each skill is a TypeScript module that knows how to navigate a specific site
- Skills handle login, pagination, form filling, and data extraction
- They return structured JSON output
- Source code is available on GitHub for audit

**Example skills in the registry:**

| Skill | Site | What It Does | Relevant to Us? |
|---|---|---|---|
| `sam.gov/contract-opportunity-search` | SAM.gov | Search federal contract opportunities | ❌ No |
| `ticketmaster.com/find-ticket` | Ticketmaster | Search events and tickets | ⚠️ Maybe — for DCI event tickets |
| `amazon.com/search-products` | Amazon | Product search and details | ❌ No |
| `glassdoor.com/get-company-reviews` | Glassdoor | Company reviews | ❌ No |

**Why no DCI-specific skills exist yet:**
The Browserbase skill registry is focused on high-traffic consumer/government sites. DCI.org, FloMarching, and drum corps websites are niche targets with no pre-built skills. However, the **skill framework itself** is useful:

- If we build a reusable DCI.org scraper, we could publish it as a skill
- Skills provide a standardized output format (JSON schema)
- Skills are versioned and tested against live sites

**Usage:**
```bash
# List all available skills
browse skills list

# Run a skill (example)
browse skills run ticketmaster.com/find-ticket --query "DCI San Antonio"
```

**Note:** We do not currently use Browserbase skills in the pipeline because none exist for our target sites. This tier is documented for future extensibility.

---

#### Agent Output Format

```json
{
  "corps_name": "Blue Stars",
  "season": 2026,
  "browser_tier_used": 2,
  "tier_2_reason": "Instagram required login for show announcement post",
  "facts_found": [
    {
      "field": "title",
      "value": "Into the Light",
      "source_url": "https://www.instagram.com/p/ABC123/",
      "browser_tier": 2,
      "confidence": "HIGH",
      "reasoning": "Posted on official Blue Stars Instagram account, caption explicitly states 'Our 2026 show is Into the Light'"
    }
  ],
  "urls_checked": [
    { "url": "https://bluestars.org/2026-season", "tier": 1, "result": "found_title" },
    { "url": "https://www.instagram.com/bluestarsdci/", "tier": 2, "result": "found_title_and_photo" }
  ],
  "time_spent_seconds": 120
}
```

#### Ingestion Rules

- Only **HIGH** and **MEDIUM** confidence facts from **Tier 1 or Tier 2** are written to `corps_shows` / `corps_show_designers` / etc.
- **Tier 3 (Browserbase)** facts are treated as MEDIUM confidence max (cloud browser may have stale cache or session anomalies)
- **LOW** confidence facts are archived in `show_announcement_scrapes` with `source_type='agent_low'` but not promoted to canonical tables
- Every fact must have a `source_url` and `browser_tier` recorded for audit

#### Edge Cases

- **Hallucination risk** — agents can invent facts. Mitigation: every fact must have a source URL; we spot-check 10% of agent-discovered URLs manually
- **Social media login wall (Tier 1 fails)** — Escalate to Tier 2 (your Edge profile). If Tier 2 also fails (e.g., 2FA required), report "login blocked" and skip
- **Dead/inactive social accounts** — some corps don't maintain social media. Agent should detect this and report "no social media presence found"
- **Corps website redesign** — corps websites change frequently. Agent should handle 404s gracefully and search for cached versions (Wayback Machine)
- **Brand confusion** — some corps share names with non-corps entities (e.g. "Colts" could be Indianapolis Colts). Agent should verify DCI/drum corps context before reporting
- **Edge not running with debugging port** — If Tier 2 is requested but Edge isn't launched with `--remote-debugging-port=9222`, the script falls back to Tier 1 and logs a warning. No hard failure.

#### Social Media Data Model

What we extract from each platform and how we store it:

| Platform | Extracted Fields | Stored In | Notes |
|---|---|---|---|
| **Instagram** | Post caption text, image/video URLs, post date, hashtags | `corps_show_media` (`media_type='photo'` or `'video'`) + `show_announcement_scrapes` (raw caption) | Captions often contain show titles, designer shoutouts, movement teasers |
| **Twitter/X** | Tweet text, image URLs, tweet date, thread context | `corps_show_media` + `show_announcement_scrapes` | Announcement threads may reveal show concept piece by piece |
| **Facebook** | Post text, photo album URLs, event links | `corps_show_media` + `show_announcement_scrapes` | Less structured; often mirrors Instagram content |
| **YouTube** | Video title, description, thumbnail URL, video URL, publish date | `corps_show_media` (`media_type='video'`) | Descriptions often contain full repertoire lists and designer credits before they appear anywhere else |
| **TikTok** | Video caption, thumbnail URL, video URL | `corps_show_media` (`media_type='video'`) | Behind-the-scenes content; captions may mention designers or show themes |
| **Corps Website** | Show title, subtitle, description, design team roster, concept essay, PDF press release | `corps_shows` (title, subtitle, description) + `corps_show_designers` + `corps_show_movements` + `show_announcement_scrapes` | Most authoritative source when available |

> **Agent heuristic:** YouTube descriptions are often the richest source of repertoire + designer data. The agent should prioritize YouTube search results for corps-specific show reveal videos.

#### Video Handling Policy

Videos from YouTube, TikTok, Instagram Reels, and Facebook are treated differently from photos:

| Asset Type | Store URL? | Store Metadata? | Download Bytes? | Store Thumbnail? | Rationale |
|---|---|---|---|---|---|
| **Photos** (JPEG/PNG) | Yes | Yes (title, caption, attribution) | **Yes** — download into `media-cache.db` | N/A | Small, cacheable, no copyright redistribution |
| **Videos** (YouTube, TikTok, IG Reels, FB) | Yes | Yes (title, description, duration, publish date, platform) | **No** — never download video bytes | **Yes** — download thumbnail bytes if available | Video bytes are large (MB–GB), copyrighted, and change (platform compression, takedowns). Thumbnails are small and safe. |
| **PDFs** (press releases) | Yes | Yes (filename, page count) | **Yes** — download into `media-cache.db` | N/A | Small, static, cacheable |
| **Audio** (rare — SoundCloud, Bandcamp snippets) | Yes | Yes (title, artist, duration) | **No** | N/A | Copyright-sensitive, streaming-only typically |

**Thumbnail extraction:**
- **YouTube:** `https://img.youtube.com/vi/<VIDEO_ID>/maxresdefault.jpg` (or `/hqdefault.jpg` as fallback)
- **TikTok:** No public thumbnail API; agent may screenshot the video poster frame if available on the page
- **Instagram:** No public thumbnail API for Reels; use the `og:image` meta tag from the post URL
- **Facebook:** Use the `og:image` meta tag from the post URL

**Effect Service interaction:** `ShowIngestion.downloadMedia` checks `media_type`:
- If `'photo'` or `'pdf'` → calls `MediaService.getOrFetch(url)` (downloads bytes)
- If `'video'` → calls `MediaService.getOrFetch(thumbnail_url)` (downloads thumbnail bytes only); stores `video_url` in `corps_show_media.url` but never fetches it
- If thumbnail download fails → marks `thumbnail_status='failed'` but keeps the video URL reference

```typescript
const downloadMedia = Effect.fn("ShowIngestion.downloadMedia")(
  function* (mediaEntries: ShowMediaAsset[]) {
    const media = yield* MediaService
    for (const entry of mediaEntries) {
      if (entry.mediaType === "photo" || entry.mediaType === "pdf") {
        yield* media.getOrFetch(entry.url).pipe(
          Effect.tap(() => Effect.log("Downloaded media", { url: entry.url, type: entry.mediaType })),
          Effect.catchAll((err) => {
            yield* Effect.logError("Media download failed", { url: entry.url, error: err.message })
            return Effect.succeed(undefined)
          })
        )
      } else if (entry.mediaType === "video" && entry.thumbnailUrl) {
        yield* media.getOrFetch(entry.thumbnailUrl).pipe(
          Effect.tap(() => Effect.log("Downloaded video thumbnail", { url: entry.thumbnailUrl, videoUrl: entry.url })),
          Effect.catchAll((err) => {
            yield* Effect.logError("Thumbnail download failed", { url: entry.thumbnailUrl, error: err.message })
            return Effect.succeed(undefined)
          })
        )
      } else {
        yield* Effect.log("Skipping byte download for video (no thumbnail)", { url: entry.url })
      }
    }
    return mediaEntries.length
  }
)
```

---

## 5. Effect Architecture & DB Schema

### 5.1 Effect Service Layer Design

This pipeline is implemented as a family of Effect-TS services, not imperative scripts. Every service uses `Effect.Service` with `accessors: true`, `Effect.fn` for public methods, `Schema.TaggedError` for domain errors, and Layer composition for wiring.

#### Service Overview

| Service | Responsibility | Dependencies |
|---|---|---|
| `DcxScraper` | Fetch + parse DCX Museum repertoires | `HttpClient` (plain) |
| `FloMarchingScraper` | Search + parse FloMarching articles | `HttpClient` (Browserbase), `WebsiteApi` |
| `DciOrgScraper` | Probe + parse DCI.org news | `HttpClient` (Browserbase), `WebsiteApi` |
| `AgentScraper` | Browser-enabled agent exploration | `AgentBrowser` (Tier 1), `PlaywrightService` (Tier 2) |
| `ShowIngestion` | Coalescing upsert into `corps_shows` family | `SqlClient` (relational DB), `MediaService` |
| `ShowOrchestrator` | Pipeline sequencing + reporting | All scrapers + `ShowIngestion` |

#### Error Types (Schema.TaggedError)

```typescript
import { Schema } from "effect"

export class DcxParseError extends Schema.TaggedError<DcxParseError>()(
  "DcxParseError",
  {
    corpsKey: Schema.String,
    message: Schema.String,
    htmlSnippet: Schema.optional(Schema.String),
  }
) {}

export class FloMarchingPaywallError extends Schema.TaggedError<FloMarchingPaywallError>()(
  "FloMarchingPaywallError",
  {
    url: Schema.String,
    message: Schema.String,
  }
) {}

export class DciOrgCloudflareError extends Schema.TaggedError<DciOrgCloudflareError>()(
  "DciOrgCloudflareError",
  {
    url: Schema.String,
    message: Schema.String,
  }
) {}

export class AgentExplorationError extends Schema.TaggedError<AgentExplorationError>()(
  "AgentExplorationError",
  {
    corpsKey: Schema.String,
    message: Schema.String,
    urlsChecked: Schema.Array(Schema.String),
  }
) {}

export class CorpsNotFoundError extends Schema.TaggedError<CorpsNotFoundError>()(
  "CorpsNotFoundError",
  {
    corpsKey: Schema.String,
    message: Schema.String,
  }
) {}

export class ShowAlreadyExistsError extends Schema.TaggedError<ShowAlreadyExistsError>()(
  "ShowAlreadyExistsError",
  {
    showId: Schema.String,
    existingSource: Schema.String,
  }
) {}
```

#### Service Example: DcxScraper

```typescript
import { Effect } from "effect"

export class DcxScraper extends Effect.Service<DcxScraper>()("DcxScraper", {
  accessors: true,
  dependencies: [], // plain fetch, no deps
  effect: Effect.gen(function* () {
    // Private helpers — NOT exported
    const fetchRepertoirePage = Effect.fn("DcxScraper.fetchRepertoirePage")(
      function* () {
        yield* Effect.log("Fetching DCX Museum repertoire list")
        const response = yield* Effect.tryPromise({
          try: () => fetch("https://www.dcxmuseum.org/index.cfm?roomid=302&view=repertoires&option=current"),
          catch: (e) => new DcxParseError({ corpsKey: "", message: String(e) }),
        })
        const html = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) => new DcxParseError({ corpsKey: "", message: String(e) }),
        })
        return html
      }
    )

    const parseRepertoirePage = Effect.fn("DcxScraper.parseRepertoirePage")(
      function* (html: string) {
        yield* Effect.log("Parsing DCX Museum repertoire list")
        // cheerio parsing logic...
        const entries: Array<{ corpsName: string; title: string | null; songs: string[] }> = []
        // ... parse HTML with cheerio
        return entries
      }
    )

    // Public method — exported in the service return value
    const scrapeAll = Effect.fn("DcxScraper.scrapeAll")(
      function* () {
        const html = yield* fetchRepertoirePage()
        const entries = yield* parseRepertoirePage(html)
        yield* Effect.log("DCX scrape complete", { entryCount: entries.length })
        return entries
      }
    )

    const scrapeCorpsDetail = Effect.fn("DcxScraper.scrapeCorpsDetail")(
      function* (corpsId: string, year: number) {
        yield* Effect.log("Fetching DCX corps detail", { corpsId, year })
        // ... fetch and parse detail page
        return null // or enriched data
      }
    )

    return { scrapeAll, scrapeCorpsDetail }
  }),
}) {}
```

> **⚠️ Anti-pattern avoided:** No `Effect.runPromise` anywhere inside the service body. Effects are composed and returned. `runPromise` only appears at the script entry point (the "boundary").

#### Service Example: ShowIngestion

```typescript
export class ShowIngestion extends Effect.Service<ShowIngestion>()("ShowIngestion", {
  accessors: true,
  dependencies: [MediaService.Default], // depends on existing media service
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient
    const media = yield* MediaService

    const upsertShow = Effect.fn("ShowIngestion.upsertShow")(
      function* (show: CorpsShow) {
        yield* Effect.log("Upserting corps show", {
          corpsKey: show.corpsKey,
          season: show.season,
          title: show.title,
        })
        // ... INSERT OR REPLACE into corps_shows
        // ... track in show_announcement_scrapes
        return show.showId
      }
    )

    const upsertRepertoire = Effect.fn("ShowIngestion.upsertRepertoire")(
      function* (showId: string, entries: ShowRepertoireEntry[]) {
        yield* Effect.log("Upserting repertoire", { showId, count: entries.length })
        // ... batch INSERT into corps_show_repertoire
        return entries.length
      }
    )

    const upsertDesigners = Effect.fn("ShowIngestion.upsertDesigners")(
      function* (showId: string, designers: ShowDesigner[]) {
        yield* Effect.log("Upserting designers", { showId, count: designers.length })
        // ... batch INSERT into corps_show_designers
        return designers.length
      }
    )

    const downloadMedia = Effect.fn("ShowIngestion.downloadMedia")(
      function* (mediaEntries: ShowMediaAsset[]) {
        yield* Effect.log("Downloading media", { count: mediaEntries.length })
        // ... use MediaService to fetch bytes into media-cache.db
        // ... update corps_show_media with download_status
        return mediaEntries.length
      }
    )

    return { upsertShow, upsertRepertoire, upsertDesigners, downloadMedia }
  }),
}) {}
```

#### Pipeline Orchestrator (ShowOrchestrator)

```typescript
export class ShowOrchestrator extends Effect.Service<ShowOrchestrator>()("ShowOrchestrator", {
  accessors: true,
  dependencies: [
    DcxScraper.Default,
    FloMarchingScraper.Default,
    DciOrgScraper.Default,
    AgentScraper.Default,
    ShowIngestion.Default,
  ],
  effect: Effect.gen(function* () {
    const dcx = yield* DcxScraper
    const flomarching = yield* FloMarchingScraper
    const dciorg = yield* DciOrgScraper
    const agent = yield* AgentScraper
    const ingest = yield* ShowIngestion

    const processCorps = Effect.fn("ShowOrchestrator.processCorps")(
      function* (corpsKey: string, corpsName: string, season: number) {
        yield* Effect.log("Processing corps", { corpsKey, corpsName, season })

        // Step 1: DCX Museum (always free, always first)
        const dcxResult = yield* dcx.scrapeAll().pipe(
          Effect.map((entries) => entries.find((e) => e.corpsKey === corpsKey)),
          Effect.catchTag("DcxParseError", (err) => {
            yield* Effect.logError("DCX scrape failed for corps", { corpsKey, error: err.message })
            return Effect.succeed(undefined)
          })
        )

        let showId: string | undefined = undefined
        if (dcxResult && dcxResult.title) {
          showId = yield* ingest.upsertShow({
            corpsKey,
            season,
            title: dcxResult.title,
            repertoire: dcxResult.songs,
          })
        }

        // Step 2: FloMarching (enrichment)
        if (showId) {
          const fmResult = yield* flomarching.searchForCorps(corpsName).pipe(
            Effect.flatMap((articleUrl) =>
              articleUrl
                ? flomarching.scrapeArticle(articleUrl)
                : Effect.succeed(undefined)
            ),
            Effect.catchTags({
              FloMarchingPaywallError: (err) => {
                yield* Effect.log("FloMarching paywalled, skipping enrichment", { corpsKey, url: err.url })
                return Effect.succeed(undefined)
              },
              DciOrgCloudflareError: (err) => {
                yield* Effect.log("DCI.org blocked, skipping", { corpsKey })
                return Effect.succeed(undefined)
              },
            })
          )
          if (fmResult) {
            yield* ingest.upsertDesigners(showId, fmResult.designers)
            yield* ingest.upsertMovements(showId, fmResult.movements)
            // ... enrich show metadata
          }
        }

        // Step 3: DCI.org (gap-filler)
        // ... similar pattern

        // Step 4: Agent (smart gap-filler)
        const missingFields = computeMissingFields(showId)
        if (missingFields.length > 0) {
          const agentResult = yield* agent.explore(corpsKey, corpsName, season, missingFields).pipe(
            Effect.catchTag("AgentExplorationError", (err) => {
              yield* Effect.logError("Agent exploration failed", { corpsKey, error: err.message })
              return Effect.succeed({ highConfidenceFacts: [], mediumConfidenceFacts: [] })
            })
          )
          for (const fact of agentResult.highConfidenceFacts) {
            yield* enrichShowFromAgentFact(showId, fact, "agent_high")
          }
          for (const fact of agentResult.mediumConfidenceFacts) {
            yield* enrichShowFromAgentFact(showId, fact, "agent_medium")
          }
        }

        return showId
      }
    )

    const runForAllCorps = Effect.fn("ShowOrchestrator.runForAllCorps")(
      function* (corpsList: Array<{ corpsKey: string; corpsName: string }>, season: number) {
        yield* Effect.log("Starting show ingestion pipeline", {
          corpsCount: corpsList.length,
          season,
        })

        // DCX is free — run all corps in parallel (no rate limits)
        const dcxEntries = yield* dcx.scrapeAll()

        // FloMarching uses Browserbase — limit concurrency to avoid cost spikes
        const fmResults = yield* Effect.forEach(
          corpsList,
          (corps) =>
            flomarching.searchForCorps(corps.corpsName).pipe(
              Effect.tap((url) => Effect.log("FloMarching found article", { corps: corps.corpsName, url })),
              Effect.catchTags({
                FloMarchingPaywallError: () => Effect.succeed(undefined),
                DciOrgCloudflareError: () => Effect.succeed(undefined),
              })
            ),
          { concurrency: 2 } // Browserbase: max 2 concurrent
        )

        // Process each corps sequentially for DB writes (avoid SQLite contention)
        const results = yield* Effect.forEach(
          corpsList,
          (corps) => processCorps(corps.corpsKey, corps.corpsName, season),
          { concurrency: 1 } // Sequential DB writes
        )

        yield* Effect.log("Pipeline complete", {
          totalCorps: corpsList.length,
          showsCreated: results.filter(Boolean).length,
        })

        return results
      }
    )

    return { processCorps, runForAllCorps }
  }),
}) {}
```

#### Layer Composition (Entry Point)

```typescript
// sdk/scripts/ingestShowAnnouncements.ts
import { Effect, Layer } from "effect"

// Infrastructure layers
const DatabaseLive = SqlClientLive // existing
const BrowserbaseLive = BrowserbaseServiceLive // existing
const MediaLive = MediaServiceLive // existing

// Scraper layers (each depends on infrastructure)
const ScraperLayers = Layer.mergeAll(
  DcxScraper.Default,              // no deps
  FloMarchingScraper.Default,     // depends on BrowserbaseLive
  DciOrgScraper.Default,          // depends on BrowserbaseLive
  AgentScraper.Default,           // depends on PlaywrightServiceLive
  ShowIngestion.Default,          // depends on MediaLive
  ShowOrchestrator.Default,       // depends on all scrapers + ingestion
)

// Full app layer
const AppLive = Layer.mergeAll(
  DatabaseLive,
  BrowserbaseLive,
  MediaLive,
  ScraperLayers,
)

// Entry point — the ONE place Effect.runPromise is allowed
const program = Effect.gen(function* () {
  const orchestrator = yield* ShowOrchestrator
  const corpsList = yield* loadCorpsListFromDb({ season: 2026 }) // existing query helper
  const results = yield* orchestrator.runForAllCorps(corpsList, 2026)
  return results
})

Effect.runPromise(program.pipe(Effect.provide(AppLive)))
  .then((results) => {
    console.log(`Pipeline complete. Shows created: ${results.filter(Boolean).length}`)
    process.exit(0)
  })
  .catch((err) => {
    console.error("Pipeline failed:", err)
    process.exit(1)
  })
```

> **Key rule:** `Effect.runPromise` appears **exactly once** — at the script boundary. All business logic inside services is pure Effect composition.

#### Effect Layer Wiring for Media (Deep Dive)

The `ShowIngestion` service depends on `MediaService`. This is how the layers compose:

```
ShowIngestion.Default
  ├── dependencies: [MediaService.Default]
  │     └── MediaServiceLive (existing)
  │           ├── SqlClient (for media_assets metadata table in dci-relational.db)
  │           └── HttpClient (for fetching bytes into media-cache.db)
  └── ShowIngestion body
        ├── calls MediaService.getOrFetch(url) for photos
        ├── calls MediaService.getOrFetch(thumbnailUrl) for video thumbnails
        └── does NOT call MediaService for video bytes
```

**Why this matters:** `MediaService` is already a production service used by the web app (`app/lib/media-cache.ts` on the frontend, `sdk/src/mediaService.ts` on the backend). By depending on it rather than reimplementing download logic, we:
1. Reuse existing caching logic (cache hits avoid re-fetch)
2. Reuse existing host-allowlisting (SSRF guard)
3. Reuse existing byte storage (`media-cache.db`)
4. Keep `ShowIngestion` focused on business logic (what to download, not how)

**Layer composition rule:** `ShowIngestion.Default` declares `dependencies: [MediaService.Default]`. This means at the app root we don't need to manually `Layer.provide(MediaService.Default)` — it's automatically wired when `ShowIngestion.Default` is part of `Layer.mergeAll`.

**MediaService interface (existing):**
```typescript
// sdk/src/mediaService.ts (existing)
export class MediaService extends Effect.Service<MediaService>()("MediaService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient // for media_assets table
    
    const getOrFetch = Effect.fn("MediaService.getOrFetch")(
      function* (url: string) {
        // 1. Check media-cache.db for existing bytes
        // 2. If miss: fetch via HttpClient (host-allowlisted)
        // 3. Store bytes in media-cache.db
        // 4. Upsert media_assets metadata row
        return { mediaCacheKey, byteLength, contentType }
      }
    )
    
    return { getOrFetch }
  }),
}) {}
```

> **Note:** `MediaService` stores bytes in a **separate** SQLite file (`media-cache.db`), not in `dci-relational.db`. `corps_show_media` stores metadata (URLs, titles, thumbnail references) in `dci-relational.db`. The two tables are joined at read time via `media_cache_key`.

#### Parallelism Strategy

| Stage | Concurrency | Reason |
|---|---|---|
| DCX Museum fetch | `unbounded` (parallel) | Plain HTTP, no rate limits, no cost |
| DCX parsing | `unbounded` | CPU-bound, no I/O |
| FloMarching fetch | `2` | Browserbase costs per page; limit to control spend |
| DCI.org fetch | `2` | Browserbase costs per page |
| Agent Tier 1 | `5` | Built-in browser is free but we don't overwhelm the machine |
| Agent Tier 2 (Edge CDP) | `1` | Single Edge instance; sequential to avoid tab conflicts |
| DB writes (upserts) | `1` | SQLite WAL mode handles reads well, but writes are safest sequential |
| Media downloads | `5` | Network I/O to media-cache.db; moderate parallelism |

### 5.2 Existing Tables (0 rows, schema ready)

```sql
-- Already in relational.ts (lines ~593-655, ~4100-4275)
corps_shows (
  show_id TEXT PRIMARY KEY,
  corps_key TEXT,
  corps_name TEXT,
  season INTEGER,
  title TEXT,
  subtitle TEXT,
  description TEXT,
  premiere_date TEXT,
  venue TEXT,
  tagline TEXT,
  designer_notes TEXT,
  source_url TEXT,
  metadata_json TEXT
);

corps_show_tags (
  show_id TEXT,
  tag TEXT,
  PRIMARY KEY (show_id, tag)
);

corps_show_media (
  media_id TEXT PRIMARY KEY,
  show_id TEXT,
  media_type TEXT,
  title TEXT,
  description TEXT,
  url TEXT,
  thumbnail_url TEXT,
  attribution TEXT,
  published_at TEXT,
  duration_seconds INTEGER,
  metadata_json TEXT
);

corps_show_repertoire (
  entry_id TEXT PRIMARY KEY,
  show_id TEXT,
  work_title TEXT,
  composer TEXT,
  arranger TEXT,
  description TEXT,
  hyperlink TEXT,
  related_corps_key TEXT,
  notes TEXT,
  metadata_json TEXT
);

corps_show_reviews (
  review_id TEXT PRIMARY KEY,
  show_id TEXT,
  author_name TEXT,
  author_profile_url TEXT,
  publication TEXT,
  published_at TEXT,
  rating REAL,
  summary TEXT,
  content TEXT,
  source_url TEXT,
  metadata_json TEXT
);
```

### 5.2 New Tables

```sql
-- Design staff per show (1:many)
-- New: captures brass arranger, visual designer, percussion arranger, color guard designer, etc.
CREATE TABLE IF NOT EXISTS corps_show_designers (
  designer_id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  corps_key TEXT NOT NULL,
  role TEXT NOT NULL,        -- e.g. 'brass_arranger', 'visual_designer', 'percussion_arranger',
                              --      'color_guard_designer', 'show_designer', 'music_director',
                              --      'drill_writer', 'choreographer', 'artistic_director'
  name TEXT NOT NULL,
  source_url TEXT,
  scraped_at INTEGER
);

-- Ordered movements within a show (1:many)
-- New: captures movement 1, 2, 3, 4 with title + description
CREATE TABLE IF NOT EXISTS corps_show_movements (
  movement_id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  corps_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,   -- 1, 2, 3, 4...
  title TEXT,
  description TEXT,
  source_url TEXT,
  scraped_at INTEGER
);

-- Scrape archive — mirrors corps_page_scrapes / event_page_scrapes pattern
-- New: stores raw HTML + parsed JSON for every fetch, enabling re-parsing and time-travel
CREATE TABLE IF NOT EXISTS show_announcement_scrapes (
  corps_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,  -- 'dcx_museum_list', 'dcx_museum_detail', 'flomarching_article',
                              -- 'flomarching_running_list', 'dci_org', 'agent_exploration',
                              -- 'agent_high', 'agent_medium', 'agent_low'
  scraped_at INTEGER NOT NULL,
  raw_html TEXT,
  parsed_json TEXT,
  http_status INTEGER,
  PRIMARY KEY (corps_key, source_url, scraped_at)
);
```

### 5.3 Schema Enhancements to Existing Tables

```sql
-- Enhance corps_show_repertoire with fields we know we can get from DCX/FloMarching
-- These are added as ALTER TABLE statements (safe, non-destructive)
ALTER TABLE corps_show_repertoire ADD COLUMN artist TEXT;
ALTER TABLE corps_show_repertoire ADD COLUMN year INTEGER;       -- composition year if known
ALTER TABLE corps_show_repertoire ADD COLUMN genre TEXT;
ALTER TABLE corps_show_repertoire ADD COLUMN movement_ordinal INTEGER; -- if a song belongs to a specific movement
ALTER TABLE corps_show_repertoire ADD COLUMN source_type TEXT;   -- 'dcx_museum', 'flomarching', 'dci_org', 'agent_high', 'agent_medium'
```

> **⚠️ Safety Rule:** Use `ALTER TABLE ... ADD COLUMN` (not `DROP TABLE`) and only add columns that don't already exist. Check `.schema corps_show_repertoire` first. Never re-run `ensureRelationalSchema` with `DROP TABLE IF EXISTS` for these tables (learned from prior incident that wiped event tables).

### 5.4 Index Recommendations

```sql
-- Speed lookups by corps + season
CREATE INDEX IF NOT EXISTS idx_corps_shows_corps_season ON corps_shows(corps_key, season);

-- Speed repertoire lookups
CREATE INDEX IF NOT EXISTS idx_corps_show_repertoire_show ON corps_show_repertoire(show_id);

-- Speed designer lookups
CREATE INDEX IF NOT EXISTS idx_corps_show_designers_show ON corps_show_designers(show_id);
CREATE INDEX IF NOT EXISTS idx_corps_show_designers_role ON corps_show_designers(role);

-- Speed movement lookups
CREATE INDEX IF NOT EXISTS idx_corps_show_movements_show ON corps_show_movements(show_id);

-- Speed archive lookups
CREATE INDEX IF NOT EXISTS idx_show_scrapes_corps ON show_announcement_scrapes(corps_key);
CREATE INDEX IF NOT EXISTS idx_show_scrapes_type ON show_announcement_scrapes(source_type);
```

---

## 6. Pipeline Architecture

### 6.1 Data Flow

```
TIER 0: STRUCTURED SOURCES (deterministic, no browser)
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  DCX Museum     │────→│  parseHTML   │────→│ corps_shows     │
│  (plain fetch)  │     │  (cheerio)   │     │ corps_show_     │
└─────────────────┘     └──────────────┘     │ repertoire      │
                                             └─────────────────┘
┌─────────────────┐     ┌──────────────┐                    │
│  FloMarching    │────→│  parseHTML   │────→ Enrichment  │
│  (Browserbase)  │     │  (cheerio)   │     (designers,   │
└─────────────────┘     └──────────────┘      movements,    │
                                              description,   │
┌─────────────────┐     ┌──────────────┐      photos)        │
│  DCI.org        │────→│  parseHTML   │────→              │
│  (Browserbase)  │     │  (cheerio)   │                   │
└─────────────────┘     └──────────────┘                   │
                                                           │
TIER 1: AGENT BUILT-IN BROWSER (free, anonymous)          │
┌─────────────────┐     ┌──────────────┐                 │
│  Agent Browser  │────→│  agentOutput │────→ Gap-fill  │
│  (public sites) │     │  (JSON)      │     (confidence │
└─────────────────┘     └──────────────┘      scored)    │
                                                           │
TIER 2: YOUR EDGE BROWSER (free, your profile)            │
┌─────────────────┐     ┌──────────────┐                 │
│  Playwright +   │────→│  agentOutput │────→ Login-    │
│  Edge (CDP)     │     │  (JSON)      │     gated social │
│  (your cookies) │     │              │     media fills  │
└─────────────────┘     └──────────────┘                 │
                                                           ↓
                                               ┌─────────────────┐
                                               │ show_announcement│
                                               │ _scrapes (archive)│
                                               └─────────────────┘
                                                            │
                                                            ↓
                                               ┌─────────────────┐
                                               │ media-cache.db  │
                                               │ (photo bytes)   │
                                               └─────────────────┘
```

### 6.2 Per-Corps Algorithm

```
function ingestShowForCorps(corpsKey, season):
  # Step 1: DCX Museum (always try first — free, structured, no Cloudflare)
  dcxData = fetchDcxRepertoire(corpsKey, season)
  if dcxData.found:
    showId = upsertCorpsShow(corpsKey, season, {
      title: dcxData.title,
      repertoire: dcxData.songs,
      source_url: dcxData.sourceUrl
    })
    upsertRepertoire(showId, dcxData.songs)
    archiveScrape(corpsKey, dcxData.rawHtml, 'dcx_museum')

  # Step 2: FloMarching (enrichment — designers, movements, description, photos)
  fmData = searchFloMarchingForCorps(corpsKey)
  if fmData.articleFound:
    article = fetchFloMarchingArticle(fmData.articleUrl)
    enrichShow(showId, {
      subtitle: article.subtitle,
      description: article.description,
      designers: article.designers,
      movements: article.movements,
      photos: article.photos
    })
    upsertDesigners(showId, article.designers)
    upsertMovements(showId, article.movements)
    queueMediaDownloads(article.photos)
    archiveScrape(corpsKey, article.rawHtml, 'flomarching_article')

  # Step 3: DCI.org (gap-filler)
  dciData = searchDciOrgForCorps(corpsKey)
  if dciData.found:
    enrichShow(showId, dciData.fields)
    archiveScrape(corpsKey, dciData.rawHtml, 'dci_org')

  # Step 4: Codex Agent (smart gap-filler for missing fields)
  missingFields = computeMissingFields(showId)
  if missingFields.length > 0:
    agentResult = dispatchAgent(corpsKey, corpsName, season, missingFields)
    for fact in agentResult.highConfidenceFacts:
      enrichShow(showId, fact.field, fact.value, fact.sourceUrl, 'agent_high')
    for fact in agentResult.mediumConfidenceFacts:
      enrichShow(showId, fact.field, fact.value, fact.sourceUrl, 'agent_medium')
    # LOW confidence facts are archived but NOT promoted to canonical tables
    archiveScrape(corpsKey, JSON.stringify(agentResult.fullOutput), 'agent_exploration')

  # Step 5: Report
  report = buildReport(corpsKey, {
    foundFields: [...],
    missingFields: [...],
    sourcesUsed: [...],
    agentConfidence: agentResult?.confidenceSummary
  })
  return report
```

### 6.3 Corps Name Normalization (DCX → our corps_key)

DCX Museum uses display names like:
- `"Blue Devils"` → our `corps_key`: `001j000000i6i9saav`
- `"Cavaliers, The"` → our `corps_key`: `001j000000iwxafaa1`
- `"Zephyrus"` → our `corps_key`: `zephyrus-drum-bugle-corps`

**Approach:** Reuse the existing `matchExistingCorpsKey` / `resolveExistingCorpsKey` logic from `sdk/src/corpsParser.ts` (or `corpsDiscovery.ts`). It strips `the`/`corps`/`drum`/`bugle`/`&`/`.` and normalizes whitespace. If that fails, fall back to a manual mapping table for known DCX → corps_key mappings.

> **⚠️ Known issue:** `corps_aliases` table exists but is NOT wired into the matching code. Adding rows there will NOT help. We must either wire it into `matchExistingCorpsKey` OR maintain a local mapping for this pipeline. Recommended: maintain a `DCX_CORPS_NAME_MAP` constant in the scraper module for the 50 target corps.

---

## 7. Implementation Phases (Milestones)

### Milestone 1: Effect Services + Schema Foundation (Day 1)
**Goal:** All Effect services defined, schema extended, Layer composition working, single-corps dry-run returns an Effect program.

**Tasks:**
1. Run `ALTER TABLE` to add `artist`, `year`, `genre`, `movement_ordinal`, `source_type` to `corps_show_repertoire`
2. Create `corps_show_designers`, `corps_show_movements`, `show_announcement_scrapes` tables
3. Add indexes
4. Define `Schema.TaggedError` error types in `sdk/src/showErrors.ts`: `DcxParseError`, `FloMarchingPaywallError`, `DciOrgCloudflareError`, `AgentExplorationError`, `CorpsNotFoundError`, `ShowAlreadyExistsError`
5. Implement `DcxScraper` service in `sdk/src/showScraperDcx.ts` — `Effect.Service` with `Effect.fn` methods, no `runPromise`
6. Implement `ShowIngestion` service in `sdk/src/showIngestion.ts` — wraps DB writes in Effects, uses `SqlClient`
7. Implement `ShowOrchestrator` service in `sdk/src/showOrchestrator.ts` — composes all scrapers, handles parallelism strategy
8. Write Layer composition in `sdk/src/showLayers.ts` — `Layer.mergeAll` for infrastructure + scrapers + orchestrator
9. Write smoke test: `DcxScraper.scrapeAll` run against a fixture HTML file returns expected `Array<{ corpsName, title, songs }>`

**Acceptance Criteria:**
- `sqlite3 dci-relational.db ".tables"` shows new tables
- `npx tsc --noEmit -p tsconfig.json` shows zero errors (Effect Language Server enabled)
- `DcxScraper.scrapeAll` returns an `Effect<never, DcxParseError, Array<...>>` (type-check only)
- Single-corps dry-run: `ShowOrchestrator.processCorps(corpsKey, corpsName, 2026)` type-checks and produces an Effect (not executed)
- `Effect.runPromise` appears **only** in `sdk/scripts/ingestShowAnnouncements.ts` (the entry point)

### Milestone 2: DCX Museum Scraper (Day 2)
**Goal:** All 50 corps have DCX data parsed via `DcxScraper` service and ingested via `ShowIngestion`.

**Tasks:**
1. Implement `DcxScraper.scrapeAll` — Effect that fetches the master list, parses with cheerio, returns typed entries
2. Implement `DcxScraper.scrapeCorpsDetail` — Effect for individual corps pages
3. Implement `parseDcxCorpsName` — pure function (not Effect) that maps DCX display names to `corps_key`
4. Compose the DCX stage: `ShowOrchestrator.runForAllCorps` calls `DcxScraper.scrapeAll` first, then maps entries per-corps
5. Run full DCX stage with `--dry-run`, review output
6. Run with `--apply`, verify DB rows

**Effect Patterns Used:**
- `Effect.tryPromise` for `fetch()` calls (catches exceptions into `DcxParseError`)
- `Effect.map` for pure transformations (cheerio parsing)
- `Effect.forEach({ concurrency: 'unbounded' })` for parallel per-corps processing (DCX is free, no rate limits)
- `Effect.log` for structured logging (no `console.log`)

**Acceptance Criteria:**
- `SELECT COUNT(*) FROM corps_shows WHERE season = 2026` = count of corps with titles on DCX
- `SELECT COUNT(*) FROM corps_show_repertoire` = sum of all songs across those corps
- No `DcxParseError` unhandled (all caught and logged via `catchTag`)
- All raw HTML archived in `show_announcement_scrapes`

### Milestone 3: FloMarching Scraper (Day 3–4)
**Goal:** Enrich DCX data with designers, movements, descriptions, photos via `FloMarchingScraper` service.

**Tasks:**
1. Implement `FloMarchingScraper` service in `sdk/src/showScraperFloMarching.ts` — `Effect.Service` with:
   - `searchForCorps(corpsName): Effect<...>` — returns `Option<string>` (article URL or None)
   - `scrapeArticle(url): Effect<...>` — Browserbase fetch + cheerio parse
   - `scrapeRunningList(): Effect<...>` — parse aggregator article
2. Implement designer extraction as pure function (cheerio → `Array<{ role, name }>`)
3. Implement movement extraction as pure function (cheerio → `Array<{ ordinal, title, description }>`)
4. Implement photo URL extraction as pure function
5. Wire `FloMarchingScraper` into `ShowOrchestrator` — sequential calls with `concurrency: 2` for Browserbase fetches
6. Run with `--dry-run`, review enrichment quality
7. Run with `--apply`

**Effect Patterns Used:**
- `Effect.gen` + `Effect.fn` for all service methods
- `Schema.TaggedError` for `FloMarchingPaywallError` (detected when article body is missing)
- `Effect.catchTag("FloMarchingPaywallError", ...)` to gracefully skip paywalled articles
- `Effect.forEach({ concurrency: 2 })` to limit Browserbase spend
- `Effect.log` with structured data (corps name, article URL, field counts)

**Acceptance Criteria:**
- At least 10 corps have designer data added
- At least 5 corps have movement data added
- All referenced photo URLs stored in `corps_show_media` with `media_type='photo'`
- Raw HTML archived in `show_announcement_scrapes` with `source_type='flomarching_article'`
- Zero unhandled `FloMarchingPaywallError` (all caught and logged)

### Milestone 4: Agent Gap-Fill (Day 5)
**Goal:** Use `ShowScraperAgent` Effect service to fill remaining gaps from corps websites and Google search results.

**Pre-requisite:** Edge launched with `--remote-debugging-port=9222` (see Runbook) if using Tier 1b (browser-tools search/content). Tier 1a (direct fetch) requires no setup.

**Implementation:** `sdk/src/showScraperAgent.ts`

**Service API:**
- `scrapeCorps(corpsKey, corpsName, season, urls): Effect<AgentScrapedShow, AgentExplorationError>` — tries multiple strategies per corps
- `scrapeCorpsBatch(targets): Effect<{ results, errors }>` — sequential batch processing with 500ms delay between requests

**Three strategies per corps (in order):**
1. **Direct fetch to guessed URLs** — `guessAnnouncementUrls(baseUrl)` generates paths like `/2026-show`, `/announcements`, `/news`, `/program`. Each is fetched and checked for 2026 + show keywords in body text. First hit with good content is parsed.
2. **browser-tools search** — If direct fetch finds nothing, spawns `npx tsx scripts/browser-tools.ts search "{corpsName} drum corps 2026 show announcement title"` to get Google results. Top 2 results are then fetched via `browser-tools content <url>` which runs Readability.js + Turndown.js extraction inside the browser.
3. **Confidence scoring** — `extractShowFromHtml()` applies 7 heuristics (title patterns, meta tags, designer credits, movement names, repertoire lists, embedded media, page structure) and assigns `HIGH` / `MEDIUM` / `LOW` confidence.

**Heuristics in `extractShowFromHtml()`:**
| # | Heuristic | Pattern | Confidence Impact |
|---|---|---|---|
| 1 | Title regex | `announcing|presenting|introducing` → capture quoted text | Required for MEDIUM+ |
| 2 | Meta og:title | Use if contains corps name and looks like a show title | Supports MEDIUM |
| 3 | Meta description | `og:description` or `description` tag | Supports MEDIUM |
| 4 | Designer credits | Regex for show designer, arranger, visual designer names | Boosts to HIGH if title also found |
| 5 | Movement names | `Movement I/II/III` or `Act 1/2/3` followed by title | Boosts to HIGH |
| 6 | Repertoire lists | `li`/`p` elements matching `"Song Name" by Composer` | Boosts to HIGH |
| 7 | Embedded media | YouTube/Vimeo iframes found in HTML | Stored, no confidence impact |

**`buildShowFromAgent()`** — Pure function converting `AgentScrapedShow` → `CorpsShow` with `metadata.confidence` and `metadata.sourceType` preserved for audit.

**Effect Patterns Used:**
- `Effect.tryPromise` + `child_process.execFile` for spawning browser-tools CLI commands
- `Effect.catchTag("DciOrgCloudflareError", () => Effect.succeed(null))` — blocked sites don't crash the pipeline
- `Effect.catchTag("AgentExplorationError", ...)` — graceful skip when no data found
- `Effect.sleep("500 millis")` — polite sequential delay between corps requests
- `Effect.match` — collects both successes (`AgentScrapedShow[]`) and failures (`AgentExplorationError[]`) in batch mode

**Acceptance Criteria:**
- At least 5 corps have data added from agent exploration
- `ShowScraperAgent` never imports puppeteer-core directly (uses CLI spawning)
- `ShowScraperAgent` never calls `Effect.runPromise` inside service body
- All agent-discovered data has `sourceUrl` and `metadata.confidence` for audit

### Milestone 5: DCI.org Gap-Fill + Media Download (Day 6)
**Goal:** Any remaining gaps from DCI.org; all photos and videos downloaded.

**Tasks:**
1. Probe DCI.org news for any 2026 show announcement articles
2. Parse and ingest any found articles
3. Run `mediaService` batch download for all `corps_show_media` rows with `status='pending'`
4. Update `corps_show_media` with `download_status` and `media_cache_key` references
5. Download video thumbnails/photos from YouTube and social media URLs

**Acceptance Criteria:**
- 100% of referenced photo URLs either downloaded to `media-cache.db` or marked `failed` with reason
- Any DCI.org articles found are parsed and archived
- Social media videos referenced in `corps_show_media` with `media_type='video'`

### Milestone 6: Verification + Reporting (Day 7)
**Goal:** Confidence in data quality; user-visible report.

**Tasks:**
1. Run cross-source validation: compare DCX repertoire vs FloMarching repertoire for same corps → flag discrepancies
2. Build summary report table (see Section 9)
3. Identify corps with no show data found (for manual research)
4. Write `MIGRATION_PROGRESS.md` update noting show data availability

**Acceptance Criteria:**
- Report shows coverage % per class
- Report lists top 10 corps by data completeness score
- Report lists all corps with zero data (actionable list)
- All duplicate / conflicting data flagged for human review

---

## 8. Edge Cases & Handling

### 8.1 Data Quality

| Edge Case | Detection | Handling |
|---|---|---|
| **Duplicate song titles** in same show | Same `work_title` appears twice in one show's repertoire | Keep both entries with distinct `entry_id`s; mark `notes='duplicate_in_source'` |
| **"Original music"** as repertoire entry | Song title contains "Original" | Store as-is; set `composer=NULL`, `notes='original_composition'` |
| **"No title yet"** on DCX | `title` is null/empty/"No title yet" | Skip DCX title, wait for FloMarching/DCI.org. Do NOT create `corps_shows` row with empty title. |
| **"(Repertoire not available)"** | Zero songs after parsing | Create `corps_shows` row with title if available, but no repertoire rows. Flag `metadata_json='{"repertoire_missing": true}'` |
| **Inconsistent artist names** | "Beethoven" vs "Ludwig van Beethoven" vs "Ludwig Van Beethoven" | Store raw name from source; do NOT normalize artist names in this pass (normalization is future work) |
| **Accented characters** (Carnivàle, Göransson) | Unicode in song/person names | Ensure SQLite is in UTF-8 mode; store raw Unicode |
| **HTML entities in titles** | `&amp;`, `&quot;` in parsed text | Decode with `he` library or cheerio's `.text()` method |
| **Multi-part songs** | "Symphony #6" listed as single entry but has 4 movements | Store as single repertoire entry; movements go in `corps_show_movements` if source provides breakdown |

### 8.2 Scraping & Infrastructure

| Edge Case | Detection | Handling |
|---|---|---|
| **DCX page structure changes** | Parser returns zero corps | Log error, do NOT write empty data. Alert via `Effect.logError`. |
| **FloMarching paywall** | Article HTML contains subscription CTA, no article body | Archive what we have, mark `parsed_json='{"paywalled": true}'`, skip enrichment for this source |
| **Browserbase failure** | Non-200 status, timeout, or challenge page returned | Retry once with backoff. If still failing, skip and log. Try next source. |
| **Photo 404** | `fetch()` returns 404 for image URL | Mark `corps_show_media.download_status='failed_404'` |
| **Rate limiting** | HTTP 429 or repeated timeouts | Add `sleep(2000)` between Browserbase fetches; respect `Retry-After` header |
| **Corps name mismatch** | DCX name does not match any `corps_key` via normalization | Use manual `DCX_CORPS_NAME_MAP`. If still unmatched, log warning and skip that corps entry. |
| **DCI.org Cloudflare block** (even with Browserbase) | Challenge page returned | Log and skip. Document in report. |
| **Concurrent DB writes** | Multiple subagents writing to same DB | Use SQLite WAL mode (already enabled) and `BEGIN IMMEDIATE` transactions in upsert helpers. |

### 8.3 Agent Exploration Risks

| Edge Case | Detection | Handling |
|---|---|---|
| **Agent hallucination** | Fact cannot be verified by visiting the reported URL | Spot-check 10% of agent-discovered URLs. If URL doesn't contain claimed fact, downgrade confidence to LOW and do not ingest. |
| **Agent reports wrong corps** | "Colts" data is actually about Indianapolis Colts (NFL) | Require agent to verify DCI/drum corps context in prompt. Post-process: reject if source URL is not on a known drum corps domain or social account. |
| **Agent stale data** | Corps website shows 2025 show, not 2026 | Require agent to look for "2026" explicitly on the page. If ambiguous, mark confidence LOW. |
| **Social media login wall** | Instagram/Twitter requires login | Agent reports "login required"; we fall back to Google cache, public embeds, or skip. Do not prompt for credentials. |
| **Agent finds no relevant data** | After 5 minutes of browsing, no 2026 show info | Agent reports "no data found" with list of URLs checked. We archive this result to avoid re-querying. |
| **Agent misidentifies song** | "Symphony No. 6" could be Beethoven, Tchaikovsky, or Mahler | Agent must include composer when stating a symphony number. If composer unknown, confidence = LOW. |
| **Agent confuses designer roles** | "Visual Designer" vs "Drill Writer" vs "Choreographer" | Accept agent's role label as-is in `corps_show_designers.role` but add `notes='role_as_reported_by_agent'` for human review. |
| **Agent extracts from unverified fan account** | Data from a fan-run Twitter account, not official corps account | Agent should identify account as "official" or "fan-run". Only official accounts produce HIGH confidence. Fan-run = LOW. |

### 8.4 Schema & Safety

| Edge Case | Prevention |
|---|---|
| **Accidental table DROP** | Never add `DROP TABLE IF EXISTS` for show-related tables. Only use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS`. |
| **Duplicate show_id** | `show_id` = `<corps_key>_<season>` (e.g. `001j000000i6i9saav_2026`). UNIQUE constraint on `(corps_key, season)` in `corps_shows` (add if not present). |
| **Orphaned repertoire** | FK from `corps_show_repertoire.show_id` to `corps_shows.show_id` (SQLite enforces FKs if `PRAGMA foreign_keys = ON`). |
| **Orphaned media** | MediaService stores bytes by URL hash; `corps_show_media.url` is the source URL, not a FK to media-cache.db. |

---

## 9. Subagent Strategy

This work can be parallelized across sources but NOT across corps (to avoid DB contention). We use subagents for:

### 9.1 Research Subagents (Read-Only)

| Subagent | Task | Input | Output |
|---|---|---|---|
| `explore` | Probe DCI.org news section for 2026 show announcement articles | None | List of article URLs + titles |
| `explore` | Probe FloMarching running list for all linked individual articles | Running list URL | Map of `corps_name → article_url` |
| `general` | Verify DCX Museum detail pages have additional data beyond the master list | 3 sample corps detail URLs | Yes/No + sample parsed output |
| `agent-browser` | Explore a corps website + social media for 2026 show details | Corps name, known facts, missing fields | Agent report: facts + URLs + confidence |
| `agent-browser` | Search Google for corps-specific 2026 show announcement | Corps name + "2026 show" | Search result URLs + snippet summaries |

### 9.2 Codex Agent Dispatch Pattern

For each corps with missing fields after structured sources, we dispatch an `agent-browser` subagent with:

```
Task: Research <CORPS_NAME> 2026 DCI show announcement

Missing fields: <list of null/empty fields after DCX + FloMarching + DCI.org>
Known fields: <list of already-ingested facts>

Instructions:
1. Visit the corps' official website. Navigate to "2026 Season", "Show", or "About" pages.
2. Search Google for: "<corps name> 2026 show announcement DCI"
3. Check the corps' Instagram, Twitter/X, Facebook, YouTube, TikTok for 2026 posts.
4. For each fact found, report: the fact, source URL, confidence (HIGH/MEDIUM/LOW), and reasoning.
5. Do NOT guess. Only report what you can verify.
6. If no data found after reasonable exploration, report "no data found" with URLs checked.
```

**Agent output schema:**
```json
{
  "corps_name": "Blue Stars",
  "season": 2026,
  "facts_found": [
    {
      "field": "title",
      "value": "Into the Light",
      "source_url": "https://bluestars.org/2026-season",
      "confidence": "HIGH",
      "reasoning": "Explicitly stated as the 2026 show title on the official corps website"
    },
    {
      "field": "designers",
      "value": [{"role": "brass_arranger", "name": "John Doe"}],
      "source_url": "https://instagram.com/bluestarsdci/p/...",
      "confidence": "MEDIUM",
      "reasoning": "Posted on official Instagram account but not on main website yet"
    }
  ],
  "urls_checked": [...],
  "time_spent_seconds": 120
}
```

**Ingestion rule:** Only `HIGH` and `MEDIUM` confidence facts are written to `corps_shows` / `corps_show_designers` / etc. `LOW` confidence facts are archived in `show_announcement_scrapes` with `source_type='agent_low'` but not promoted.

### 9.3 Implementation Subagents (Write)

We do NOT delegate the DB-writing work to subagents because:
- DB schema changes must be consistent and reviewed
- The main agent holds the full context of what was learned
- SQLite writes from multiple processes can deadlock without careful coordination

Instead, subagents are used for:
- **Parsing logic drafting** — "Write a cheerio parser for this HTML snippet"
- **Regex pattern development** — "Extract designer names and roles from this text"
- **Test data generation** — "Create a fixture HTML file matching DCX's structure"

### 9.3 Validation Subagents (Read-Only)

| Subagent | Task | Input | Output |
|---|---|---|---|
| `explore` | Cross-reference ingested data against known public sources | `corps_shows` rows for 2026 | Discrepancy report |
| `explore` | Verify media-cache.db has all referenced photos | `corps_show_media` rows | Missing downloads list |

---

## 10. Browserbase Integration Details

### 10.1 When to Use Browserbase

| Source | Browser Method | Reason |
|---|---|---|
| DCX Museum | **Plain fetch** | Server-rendered HTML, no JS needed |
| FloMarching | **Tier 3 (Browserbase)** | Cloudflare + paywall; local browser blocked |
| DCI.org | **Tier 3 (Browserbase)** | Cloudflare challenge; local browser blocked |
| Corps websites | **Tier 1 (agent built-in)** | Most are static/lightly dynamic |
| Instagram public posts | **Tier 1 (agent built-in)** | No login required for public profiles |
| Instagram private/followed | **Tier 2 (your Edge)** | Requires your logged-in session |
| Facebook pages/groups | **Tier 2 (your Edge)** | Login-gated content |
| YouTube video pages | **Tier 1 (agent built-in)** | Public, but Tier 2 preferred for personalized recommendations |
| TikTok web | **Tier 2 (your Edge)** | Heavily gated without session |
| Google Search | **Tier 1 (agent built-in)** | No login needed |

### 10.2 How to Wire It

Per `sdk/src/browserbaseService.ts` and `sdk/src/websiteApi.ts`:

```typescript
import { BrowserbaseService } from "./browserbaseService";
import { makeWebsiteScraperWithBrowserbaseLayer } from "./websiteApi";

// Layer composition
const scraperLayer = makeWebsiteScraperWithBrowserbaseLayer();
// Provides BrowserbaseService to all website scraper fetches
```

Environment variable: `BROWSERBASE_API_KEY` must be set.

### 10.3 Cost Estimation

| Page Type | Estimated Count | Notes |
|---|---|---|
| DCX Museum master list | 1 | Free (plain fetch) |
| DCX Museum detail pages | 30 | Free (plain fetch) — only fetch if master list is insufficient |
| FloMarching running list | 1 | Tier 3 (Browserbase) |
| FloMarching individual articles | ~15 | Tier 3 (Browserbase) — only if paywall bypass needed |
| DCI.org news probe | ~5 | Tier 3 (Browserbase) |
| DCI.org individual articles | ~5 | Tier 3 (Browserbase) |
| **Total Browserbase pages** | **~26** | **~$0.78** at $0.03/page |
| Codex Agent (Tier 1) dispatches | ~50 corps | Free — built-in browser |
| Agent pages per dispatch (Tier 1) | ~3–5 | Corps site + public social + Google |
| Playwright + Edge (Tier 2) | ~10–15 corps | Free — uses your browser profile |
| Tier 2 pages per dispatch | ~5–8 | Login-required social media |
| **Total free pages** | **~300–400** | Zero cost |

### 10.4 Caching Strategy

All Browserbase fetches must be cached in `show_announcement_scrapes` (our new table) to:
1. Avoid re-fetching on re-runs
2. Enable re-parsing if parser logic changes
3. Provide audit trail

TTL: 7 days for FloMarching/DCI.org (same as `website_recaps`). DCX Museum has no TTL (plain fetch is free). Agent Tier 1 and Tier 2 fetches are also cached with 7-day TTL since they are cheap to re-run but we want audit trail.

---

## 11. Name Normalization & Corps Mapping

### 11.1 DCX Museum → corps_key Mapping

DCX uses display names. Our DB uses `corps_key` (Salesforce IDs or custom slugs). Examples:

| DCX Display Name | Our corps_key | Notes |
|---|---|---|
| `Blue Devils` | `001j000000i6i9saav` | Direct match after stripping |
| `Cavaliers, The` | `001j000000iwxafaa1` | "The" suffix → prefix normalization |
| `Blue Devils B` | `001j000000i6jmbaaf` | Quote marks in name |
| `Zephyrus` | `zephyrus-drum-bugle-corps` | Custom slug, no Salesforce ID |
| `Boise Gems (*Open Class Affiliate)` | `0015b00002bxwbjaap` | Need to strip parenthetical |
| `Eclipse (*Open Class Affiliate)` | `0015b000028qtqbaae` | Same |

**Algorithm:**
1. Strip parentheticals: `/\s*\([^)]*\)/g`
2. Strip quotes: `/"/g`
3. Normalize "Cavaliers, The" → "The Cavaliers" → "cavaliers"
4. Run through existing `matchExistingCorpsKey(normalizedName)`
5. If no match, consult hardcoded `DCX_CORPS_NAME_MAP` for the 50 known mappings
6. If still no match, log warning with DCX name and skip

### 11.2 FloMarching → corps_key Mapping

FloMarching article titles contain corps names (e.g. "Santa Clara Vanguard Announce DCI 2026 Show..."). Extract the corps name from the title, then apply the same normalization as DCX.

---

## 12. Testing & Verification

This section documents the testing strategy, existing test files, verification scripts, and robustness patterns used throughout the pipeline. All tests run with `npx tsx` (no Jest/Vitest dependency).

### 12.1 Test Files

| Test File | What It Tests | Run Command |
|---|---|---|
| `sdk/test/showScraperDcx.test.ts` | Pure DCX HTML parsing: corps names, titles, repertoire, division sections, edge cases | `npx tsx test/showScraperDcx.test.ts` |
| `sdk/test/showOrchestrator.test.ts` | Pure functions: `normalizeCorpsName`, `dcxNameToCorpsKey`, `makeShowId`, `buildShowFromDcx` | `npx tsx test/showOrchestrator.test.ts` |
| `sdk/scripts/verifyShowIngestion.ts` | DB integrity checks after ingestion: duplicates, orphans, data quality | `npx tsx scripts/verifyShowIngestion.ts --season 2026` |

### 12.2 Design Principle: Pure Functions Are Tested; Effect Services Are Composed

We follow a strict separation:

| Layer | Testable? | How |
|---|---|---|
| **Pure functions** (parsers, normalizers, builders) | ✅ Unit tests directly | `parseDcxRepertoireHtml(html)`, `normalizeCorpsName(name)`, `buildShowFromDcx(entry, key, season)` |
| **Effect services** (scrapers, ingestion, orchestrator) | ✅ Integration tests via DB + fixtures | Entry-point script in `--dry-run` mode; assert DB state after |
| **Effect layers** | ✅ Runtime only | Type-check via `npx tsc --noEmit`; runtime via `--dry-run` |

**Why:** Pure functions have no side effects, no network, no DB — they return the same output for the same input. We test them exhaustively. Effect services are integration-tested by running the entry point and verifying DB state.

### 12.3 Fixture Strategy

Saved HTML fixtures guarantee reproducible tests even when the live site changes:

| Fixture | Source | Size | Tests |
|---|---|---|---|
| `sdk/__fixtures__/dcx-repertoires-2026.html` | DCX Museum repertoires page | ~3KB | Corps name extraction, title parsing, song list extraction, division headers, edge cases |

**Fixture maintenance:** If the parser is updated to handle new DOM patterns, the fixture should be refreshed from the live site and committed. The test file documents the expected counts (e.g. "9 entries", "4 songs for 7th Regiment") so any drift is caught immediately.

### 12.4 Unit Test Coverage: `showScraperDcx.test.ts`

**Test categories:**

1. **Parsing fixture HTML** — verifies `parseDcxRepertoireHtml` returns expected entry count
2. **Corps name extraction** — checks corps name and `dcxCorpsId` from `<a href>`
3. **Show title extraction** — handles real titles, `.No title yet`, `.` placeholders, `(Repertoire not available)`
4. **Repertoire (songs) extraction** — counts songs, validates song text, preserves special characters, handles `Original music`
5. **Division section tracking** — verifies corps are grouped under correct class headers
6. **Edge cases** — empty table, no table, malformed HTML → 0 entries (no crash)

**Sample assertion pattern:**
```typescript
const seventhRegiment = entries.find((e) => e.dcxCorpsName === "7th Regiment");
assert(seventhRegiment?.showTitle === "In Spring", "Title matches");
assert(seventhRegiment?.songs.length === 4, "4 songs extracted");
assert(seventhRegiment?.songs[0] === "Appalachian Spring", "First song correct");
```

### 12.5 Unit Test Coverage: `showOrchestrator.test.ts`

**Test categories:**

1. **`normalizeCorpsName`** — 17 assertions covering:
   - Basic names (`Blue Devils` → `bluedevils`)
   - Leading/trailing "The" (`The Cavaliers`, `Cavaliers, The` → `cavaliers`)
   - Parentheticals (`Boise Gems (*Open Class Affiliate)` → `boisegems`)
   - Quotes (`Blue Devils "B"` → `bluedevilsb`)
   - Punctuation removal
2. **`dcxNameToCorpsKey`** — lookup map hit/miss, empty name
3. **`makeShowId`** — format `<corps_key>_<season>`
4. **`buildShowFromDcx`** — full `CorpsShow` object shape:
   - `showId`, `corpsKey`, `corpsName`, `season`, `title`
   - `repertoire[]` with `entryId` format, `workTitle`, null `composer`/`arranger`
   - Empty arrays for `designers`, `movements`, `media`, `tags`
   - Metadata object with `dcxCorpsId`, `divisionSection`, `parsedAt`

### 12.6 Verification Script: `verifyShowIngestion.ts`

A standalone script that runs after every `--apply` to verify DB integrity. It performs 10 automated checks:

| # | Check | Severity | What It Catches |
|---|---|---|---|
| 1 | `corps_shows` rows exist | **Error** | Ingestion silently produced no rows |
| 2 | Every show has a title | **Error** | Parser bug left null/empty titles |
| 3 | No duplicate `show_id` | **Error** | Upsert logic failure or duplicate source entries |
| 4 | Repertoire references valid shows | **Error** | Orphaned repertoire (FK violation not enforced) |
| 5 | No empty song titles | **Error** | Parser extracted empty strings as songs |
| 6 | Corps with shows exist in `corps` table | **Error** | Name mapping produced invalid `corps_key` |
| 7 | No HTML entities in titles | **Error** | Parser didn't decode `&amp;` / `&quot;` |
| 8 | Show stats | Info | Total shows, real titles vs placeholders, song count |
| 9 | New schema tables exist | **Error** | Migration not applied |
| 10 | Missing shows report | Warning | Corps in DB with no 2026 show data (expected for unannounced corps) |

**Usage:**
```bash
cd sdk
npx tsx scripts/verifyShowIngestion.ts --season 2026
# ✅ ALL CHECKS PASSED  (or ❌ VERIFICATION FAILED with details)
```

**Output example:**
```
=== Show Ingestion Verification (season 2026) ===
1. corps_shows rows exist
  ✅ 81 shows found for season 2026
2. Every show has a title
  ✅ Zero shows with null/empty title
3. No duplicate show_id
  ✅ Zero duplicate show_id values
...
8. Show stats
  ℹ️  Total shows: 81
  ℹ️  With real title: 32
  ℹ️  With placeholder title: 49
  ℹ️  Total repertoire entries: 139
9. New schema tables exist
  ✅ corps_show_designers table exists
  ✅ corps_show_movements table exists
  ✅ show_announcement_scrapes table exists
==================================================
Results: 10 passed, 0 failed, 0 warnings
==================================================
✅ ALL CHECKS PASSED
```

### 12.7 Dry-Run Checklist

Before every `--apply`, run `--dry-run` and verify:

- [ ] No `corps_shows` rows would be created with empty `title`
- [ ] No `corps_show_repertoire` rows would be created with empty `work_title`
- [ ] All `source_url` fields are populated
- [ ] `show_id` values are consistent (`<corps_key>_<season>`)
- [ ] No duplicate `show_id` would be created
- [ ] Run `npx tsx test/showScraperDcx.test.ts` → all pass
- [ ] Run `npx tsx test/showOrchestrator.test.ts` → all pass

### 12.8 Post-Ingestion Verification Queries

```sql
-- Coverage by class
SELECT 
  c.division_name,
  COUNT(DISTINCT c.corps_key) as total_corps,
  COUNT(DISTINCT cs.corps_key) as with_show_data,
  COUNT(DISTINCT CASE WHEN csr.entry_id IS NOT NULL THEN c.corps_key END) as with_repertoire,
  COUNT(DISTINCT CASE WHEN csd.designer_id IS NOT NULL THEN c.corps_key END) as with_designers
FROM corps c
LEFT JOIN corps_shows cs ON cs.corps_key = c.corps_key AND cs.season = 2026
LEFT JOIN corps_show_repertoire csr ON csr.show_id = cs.show_id
LEFT JOIN corps_show_designers csd ON csd.show_id = cs.show_id
WHERE c.corps_key IN (
  SELECT DISTINCT ep.corps_key 
  FROM event_participants ep 
  JOIN events e ON e.event_id = ep.event_slug 
  WHERE e.season = 2026 AND ep.corps_key IS NOT NULL
)
GROUP BY c.division_name;

-- Corps with zero data (actionable)
SELECT c.name, c.division_name
FROM corps c
LEFT JOIN corps_shows cs ON cs.corps_key = c.corps_key AND cs.season = 2026
WHERE c.corps_key IN (
  SELECT DISTINCT ep.corps_key FROM event_participants ep 
  JOIN events e ON e.event_id = ep.event_slug WHERE e.season = 2026
)
AND cs.show_id IS NULL;
```

### 12.9 Regression Prevention

| Change Type | Required Verification |
|---|---|
| **Parser logic change** | Update fixture HTML if DOM pattern changed; re-run `showScraperDcx.test.ts`; verify counts match |
| **Schema change** | Re-run `verifyShowIngestion.ts`; ensure new tables/indexes are created; check no data loss |
| **Name normalization change** | Re-run `showOrchestrator.test.ts`; verify unmatched count in dry-run doesn't increase |
| **Effect layer wiring change** | `--dry-run` must succeed; `npx tsc --noEmit -p tsconfig.json` must pass |
| **New source added** | Add fixture + test for that source's parser; update verification script with new checks |

---

## 13. Risks, Mitigations, and Open Questions

### 13.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **FloMarching paywall blocks all articles** | Medium | High | Fall back to DCX Museum data (titles + repertoire). DCI.org as secondary fallback. |
| **Top World Class corps haven't announced by early June** | High | Medium | DCX shows "No title yet" for ~10 World Class corps. Re-run pipeline in late June/July when announcements are complete. |
| **DCX Museum changes page structure** | Low | Medium | Parser validates expected DOM structure; if changed, archive raw HTML and raise error. Do not write partial data. |
| **Browserbase credit exhaustion / API failure** | Low | High | DCX Museum is free (no Browserbase). If Browserbase fails, pipeline still yields 70% of data from DCX alone. |
| **Corps name mapping errors** | Medium | Low | Manual verification of the 50 mappings; unmatched names are logged, not silently dropped. |
| **Agent hallucination / incorrect facts** | Medium | High | Confidence scoring + mandatory source URLs. Spot-check 10% of agent-discovered facts. LOW confidence never ingested into canonical tables. |
| **Agent discovers stale data (2025 instead of 2026)** | Medium | Medium | Agent prompt explicitly asks for "2026". Post-process: reject facts where source URL does not contain "2026" or show evidence of being current season. |
| **Social media content deletion** | Medium | Low | Agent archives URLs at discovery time. If content is later deleted, the URL reference remains in `show_announcement_scrapes` as evidence of prior existence. |
| **Photo copyright issues** | Low | Low | Photos are cached for personal/research use only. URLs are public. No redistribution. |

### 13.2 Open Questions

1. **Should we ingest non-competitive corps?** (SoundSport, Exhibition, etc.) — User said "only the ones with appearances in 2026" ordered by class. Current scope is 50 competitive corps. SoundSport corps (31 additional) are excluded. Decision: **Defer to user**.
2. **Should we populate `corps_show_reviews`?** — Critic reviews from blogs/sites like "Drum Corps Planet". Decision: **Out of scope for this pass**.
3. **How to handle shows with multiple titles?** (e.g. working title vs final title) — Decision: **Store the most recent title from the highest-priority source (DCI.org > FloMarching > DCX)**. Track history in `show_announcement_scrapes` if needed.
4. **Should we backfill historical seasons (2025, 2024, etc.)?** — Decision: **Defer to user**. The pipeline is season-agnostic (`season` is a parameter). Backfill is a future task.
5. **Should the agent explore non-competitive corps' social media too?** — SoundSport/Exhibition corps may have 2026 show announcements on Instagram. Decision: **Defer to user**. Current scope is 50 competitive corps.
6. **Should we attempt to extract video/audio files from social media?** — ✅ **Decided.** Store video URLs + metadata + thumbnail bytes in `corps_show_media`; never download video bytes. Photos and PDFs are downloaded as bytes. See Section 4.4.1 "Video Handling Policy".

---

## 14. Appendix A: Source URL Patterns

### DCX Museum
```
https://www.dcxmuseum.org/index.cfm?roomid=302&view=repertoires&option=current
https://www.dcxmuseum.org/index.cfm?view=corpslist&corpsid=<NUMERIC_ID>&corpsyear=2026
```

### FloMarching
```
https://www.floMarching.com/articles/14791418-a-running-list-of-drum-corps-international-2026-show-announcements
https://www.floMarching.com/articles/<ID>-<SLUGIFIED_TITLE>
https://www.floMarching.com/search?q=2026+show+announcement+DCI&page=<N>
```

### DCI.org
```
https://www.dci.org/news/
https://www.dci.org/news/<SLUG>/
```

### Corps Social Media (agent-discovered — examples)
```
https://www.instagram.com/<corps_handle>/
https://x.com/<corps_handle>
https://www.facebook.com/<corps_page_name>/
https://www.youtube.com/<corps_channel>/
https://www.tiktok.com/@<corps_handle>
```

> **Note:** Corps handles are not standardized. The agent discovers them via Google search (`"<corps name>" Instagram`) or by browsing the corps website for social media links. Common patterns: `@bluestarsdci`, `@thecavaliers`, `@troopersdbc`, `@scvanguard`, etc.

### Corps Websites (agent-discovered — examples)
```
https://bluestars.org/
https://www.cavaliers.org/
https://troopersdbc.org/
https://www.scvanguard.org/
https://bluedevils.org/
```

> **Note:** The agent finds these via Google search or by following links from DCI.org directory pages. Some corps use `.com`, `.org`, or subdomain variations (e.g. `2026.bluestars.org`).

---

## 15. Appendix B: Sample Parsed Data (Crossmen 2026)

Based on DCX Museum and FloMarching research:

```json
{
  "corps_key": "001j000000iwx9aaat",
  "corps_name": "Crossmen",
  "season": 2026,
  "title": "A Side/B Side",
  "subtitle": null,
  "description": "(from FloMarching article — rich narrative about the show concept)",
  "tagline": null,
  "source_url": "https://www.floMarching.com/articles/15906288-crossmen-announce-dci-2026-program-a-sideb-side",
  "repertoire": [
    { "work_title": "Earth Song", "artist": "Michael Jackson", "composer": null, "arranger": null, "ordinal": 1 },
    { "work_title": "Last Train Home", "artist": "Pat Metheny", "composer": null, "arranger": null, "ordinal": 2 },
    { "work_title": "Mr. Pinstripe Suit", "artist": "Big Bad Voodoo Daddy", "composer": null, "arranger": null, "ordinal": 3 },
    { "work_title": "Classical Gas", "artist": "Mason Williams", "composer": null, "arranger": null, "ordinal": 4 },
    { "work_title": "I'm Confident That I'm Insecure", "artist": null, "composer": null, "arranger": null, "ordinal": 5 },
    { "work_title": "Abstract Thought", "artist": null, "composer": null, "arranger": null, "ordinal": 6 },
    { "work_title": "Record Player", "artist": null, "composer": null, "arranger": null, "ordinal": 7 },
    { "work_title": "Original music", "artist": null, "composer": null, "arranger": null, "notes": "original_composition", "ordinal": 8 }
  ],
  "designers": [
    { "role": "brass_arranger", "name": "(to be extracted from article)" },
    { "role": "visual_designer", "name": "(to be extracted from article)" }
  ],
  "movements": [
    { "ordinal": 1, "title": "A Side", "description": "(from article)" },
    { "ordinal": 2, "title": "B Side", "description": "(from article)" }
  ],
  "media": [
    { "media_type": "photo", "url": "https://d2779tscntxxsw.cloudfront.net/6a05de6fbdfd4.png", "title": "Crossmen 2026 Show Announcement" }
  ]
}
```

---

## 16. Appendix C: Runbook (Quick Reference)

### Setup: Launch Edge with Remote Debugging (for Tier 2 Agent)

**One-time setup** — do this before running the agent if you want it to use your logged-in sessions:

```powershell
# Close all Edge windows first

# Option A: Use your main Edge profile (has all your cookies/logins)
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# Option B: Use a dedicated agent profile (recommended — won't interfere with your browsing)
# First, create the profile directory:
New-Item -ItemType Directory -Path "C:\Users\Patrick\corps-place\.edge-agent-profile" -Force

# Then launch Edge with that profile:
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\Users\Patrick\corps-place\.edge-agent-profile"

# Verify it's listening:
Invoke-RestMethod -Uri "http://localhost:9222/json/version"
```

> **Note:** If using Option B, you will need to log into Instagram, Facebook, etc. **once** in that Edge window. After that, the agent can reuse those sessions indefinitely.

> **Security:** The agent only reads pages (no posting, liking, or commenting). All navigation is logged.

### Single Corps Dry-Run (Structured Sources Only)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --corps 001j000000iwx9aaat --dry-run --source flomarching
```

### Single Corps with Agent Gap-Fill
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --corps 001j000000iwx9aaat --source agent --dry-run
```

### Full Pipeline (All 50 Corps, All Sources + Agent)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --class world --apply
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --class open --apply
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --class allage --apply
```

### Re-Parse from Archive (No Re-Scrape)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --from-archive --apply
```

### Agent-Only Mode (Skip Structured Sources, Use Agent for All)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --source agent --apply
```

> **Use case:** When structured sources have stale data and you suspect corps websites/social media have newer announcements. The agent explores each corps independently.

### Media Download Only
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --download-media --apply
```

### Verification Report (Includes Agent Confidence Summary)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --report-only
```

### Agent Spot-Check (Verify Agent-Reported Facts)
```bash
cd sdk
npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --spot-check-agent --sample-size 10
```

> **Use case:** Randomly sample 10 agent-discovered facts and verify their source URLs are still live and contain the claimed information.

---

## 17. Appendix D: Browser Automation Tools Reference

### What Exists

`scripts/browser-tools.ts` is a **standalone CLI** (not an MCP server) that wraps `puppeteer-core` to drive Chrome/Edge via the DevTools Protocol (CDP). It is already in the project and used via `npm run browser-tools`.

### Commands Available

| Command | Args | Purpose | Returns |
|---|---|---|---|
| `start` | `--port`, `--browser`, `--profile`, `--kill-existing`, `--headless` | Launch browser with remote debugging | (none, launches process) |
| `nav <url>` | `--port`, `--new`, `--wait-until` | Navigate current or new tab | Console confirmation |
| `search <query>` | `--port`, `--count`, `--content`, `--timeout` | **Google search via browser automation** | `--- Result N ---\nTitle: ...\nLink: ...\nSnippet: ...` |
| `content <url>` | `--port`, `--timeout` | **Extract readable article text** via Readability.js + Turndown.js | `URL: ...\nTitle: ...\n\n<markdown-like content>` |
| `eval <code>` | `--port`, `--pretty-print` | Evaluate JS in page context | Result of expression |
| `screenshot` | `--port`, `--output`, `--full-page` | Capture viewport or full page | File path to PNG |
| `console` | `--port`, `--types`, `--follow`, `--timeout` | Capture console logs | Live stream or dump |
| `network` | `--port`, `--types`, `--follow`, `--timeout` | Capture network requests | Live stream or dump |
| `inspect` | `--browser`, `--ports`, `--pids`, `--json` | List DevTools browser processes + tabs | Text table or JSON |
| `cookies` | `--port` | Dump cookies from active tab | JSON array |
| `pick <message>` | `--port` | Interactive DOM picker (click elements) | Element metadata |
| `kill` | `--browser`, `--ports`, `--pids`, `--all`, `--force` | Terminate DevTools browser instances | Console confirmation |

### Key Commands for the Agent Scraper

**`search`** and **`content`** are the two commands the `ShowScraperAgent` service spawns via `child_process.execFile`:

```typescript
// Spawning from Effect service
const result = yield* Effect.tryPromise({
  try: () => new Promise<string>((resolve, reject) => {
    execFile("npx", [
      "tsx", "scripts/browser-tools.ts",
      "search",
      "Bluecoats drum corps 2026 show announcement",
      "-n", "3"
    ], { cwd: "C:\\Users\\Patrick\\corps-place", timeout: 30000 },
    (err, stdout) => err ? reject(err) : resolve(stdout));
  }),
  catch: (e) => new AgentExplorationError({ ... }),
});
```

**`content`** runs Readability.js + Turndown.js inside the browser context, returning clean markdown-like text. This is ideal for extracting article content from JavaScript-rendered pages or paywall previews.

### How It Connects

1. `start` launches Edge/Chrome with `--remote-debugging-port=9222`
2. All other commands connect to `http://localhost:9222` via `puppeteer.connect({ browserURL })`
3. The CLI disconnects after each command (does not keep browser open between commands)
4. `inspect` can verify a browser is listening before running commands

### Design Decision: CLI Spawning vs. Direct puppeteer-core Import

The `ShowScraperAgent` service **spawns the CLI as a subprocess** rather than importing `puppeteer-core` directly. Reasons:

| Approach | Pros | Cons |
|---|---|---|
| **CLI spawning** (chosen) | Reuses tested CLI; no puppeteer-core import in service; easy to debug by running commands manually | ~200ms spawn overhead; text output requires parsing |
| **Direct puppeteer-core import** | Faster; structured objects from Puppeteer API | More code; harder to maintain; risk of browser process leaks |

### Launching Edge for Agent Use

```bash
# One-time per session
npx tsx scripts/browser-tools.ts start --browser edge --port 9222

# Verify it's running
npx tsx scripts/browser-tools.ts inspect --browser edge

# The Effect service will auto-spawn search/content commands
# No manual interaction needed after start
```

### Edge Cases Discovered

| Issue | Handling |
|---|---|
| **Edge not running on port 9222** | `search`/`content` commands fail with connection error; `ShowScraperAgent` catches this and falls back to direct fetch only |
| **Google search blocked (CAPTCHA)** | `search` returns zero results; agent falls back to direct corps website guessing |
| **Content extraction returns empty** | Readability.js fails on non-article pages (e.g., home page); agent treats as no data found |
| **CLI timeout (30s)** | Complex pages may exceed timeout; `Effect.tryPromise` catches timeout and retries with shorter content |

---

### What We Learned About `browse` CLI (Browserbase)

### What Exists

The **`browse` CLI** (`browse.exe`, installed at `C:\Users\Patrick\.bun\bin\browse.exe`) is Browserbase's unified browser automation tool. It is a separate product from `browser-tools.ts` and provides both **local browser automation** (free) and **cloud browser automation** (paid, via Browserbase API).

**Version:** `browse/0.8.3 win32-x64 node-v25.2.1`

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   browse CLI    │────→│  browse driver   │────→│  Local Chromium │
│  (commands)     │     │  (daemon)        │     │  (Playwright)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │
         │ (cloud mode)
         ↓
┌─────────────────┐
│ Browserbase API │
│ (cloud browser) │
└─────────────────┘
```

### Key Commands

| Command | Purpose | Returns |
|---|---|---|
| `browse open <url>` | Open URL in active session | Session info |
| `browse snapshot` | Print accessibility tree + element refs | JSON snapshot |
| `browse get <selector>` | Extract text from element | Element text |
| `browse eval <code>` | Evaluate JS | Evaluation result |
| `browse screenshot` | Capture screenshot | PNG file path |
| `browse click <ref>` | Click element by ref | Confirmation |
| `browse fill <ref> <text>` | Fill input | Confirmation |
| `browse cdp` | Stream DevTools Protocol | CDP events |
| `browse status` | Show session status | Session info |
| `browse stop` | Stop session | Confirmation |

### Topics (Sub-commands)

| Topic | Purpose |
|---|---|
| `browse cloud` | Manage Browserbase cloud resources |
| `browse functions` | Develop/publish Browserbase Functions |
| `browse mouse` | Raw mouse coordinate input |
| `browse network` | Capture network traffic |
| `browse skills` | Discover/install/run skills |
| `browse tab` | Manage browser tabs |
| `browse templates` | Browse/scaffold templates |

### Usage Example for Show Scraping

```bash
# Open a corps website
browse open https://bluestars.org

# Get page snapshot (accessibility tree with element refs)
browse snapshot

# Extract the title
browse get "h1"

# Extract page content
browse eval "document.body.innerText.slice(0, 3000)"

# Screenshot for audit
browse screenshot --output ./audit/bluestars.png
```

### Comparison: `browser-tools.ts` vs. `browse` CLI

| Feature | `browser-tools.ts` | `browse` CLI |
|---|---|---|
| **Installation** | Already in project (`scripts/browser-tools.ts`) | Global install (`bun install -g browse`) |
| **Browser management** | Requires pre-launched Edge/Chrome | Self-managed (starts Chromium automatically) |
| **Google search** | ✅ Built-in `search` command | ❌ Not available |
| **Content extraction** | ✅ Readability.js + Turndown.js | ❌ Not built-in |
| **Element interaction** | ⚠️ Limited (eval only) | ✅ Rich (snapshot refs, click, fill) |
| **Session management** | ❌ None (disconnects after each command) | ✅ Status, stop, resume |
| **Video recording** | ❌ No | ✅ Yes (`--record`) |
| **Cloud fallback** | ❌ No | ✅ Built-in (`--cloud` flag) |
| **Skills ecosystem** | ❌ No | ✅ `browse skills list/run` |

### Why We Use `browser-tools.ts` as Primary

1. **Google search** is essential for finding corps announcement articles — `browser-tools.ts` has this built-in; `browse` does not
2. **Content extraction** (Readability.js) is essential for parsing article text — `browser-tools.ts` has this; `browse` requires manual JS eval
3. **Already integrated** — `ShowScraperAgent` already spawns `browser-tools.ts` commands; switching would require rewriting the service

**When to use `browse` CLI instead:**
- Need to interact with page elements (click, fill forms)
- Need video recording of the scraping session
- Need to escalate to cloud browser (`browse open --cloud`)
- Want to use Browserbase skills (`browse skills run ...`)

### Browserbase Skills

**Skills** are pre-built automation recipes published by Browserbase and third parties. They are discovered via:

```bash
# List all available skills
browse skills list

# Run a skill
browse skills run <hostname>/<task-id>
```

**Skill metadata includes:**
- `name`, `title`, `description`
- `category` (government, shopping, travel, etc.)
- `verified` (officially tested by Browserbase)
- `proxies` (uses proxy rotation)
- `sourceUrl` (GitHub source for audit)
- `recommendedMethod` (`api` | `browser`)

**Current state:** No DCI/drum corps skills exist in the registry. The available skills cover sites like SAM.gov, Ticketmaster, Amazon, Glassdoor, etc. If we build a reusable DCI.org or FloMarching scraper, we could publish it as a skill.

---

## 18. Lessons Learned (as of 2026-06-08)

### What Worked
1. **DCX Museum is the most reliable source** for structured repertoire data. The pure parser (`parseDcxRepertoireHtml`) is fast, testable, and produces clean data.
2. **Effect-TS architecture** scales well — services, layers, and `Effect.fn` make the codebase composable and testable.
3. **Dry-run mode** is essential — the `--apply` flag prevented accidental DB writes during development.
4. **Verification script** (`verifyShowIngestion.ts`) catches issues early — 10 automated checks for schema integrity.

### What Didn't Work
1. **Agent scraper `extractShowFromHtml()`** produces garbage titles. The heuristics are too broad and extract page headings instead of show titles. Root cause: extracting show titles from arbitrary HTML with regex is inherently unreliable.
2. **Direct URL guessing** (`/2026-season`, `/news`, etc.) finds home pages, not announcement articles. Corps don't publish show announcements at predictable URLs.
3. **browser-tools search** works but the search results are tour schedules, not show announcements. The FloMarching running list is the best source but requires login.

### Key Insights
1. **Many corps haven't announced their 2026 shows yet.** It's early June — the FloMarching running list shows "TBA" for Blue Devils. The 47 placeholder titles are likely real "not yet announced" states.
2. **DCX Museum is the only source with structured 2026 data.** Other sources (FloMarching, DCI.org, corps websites) either require login, are Cloudflare-blocked, or don't have show titles yet.
3. **The `corps_aliases` table is not wired into matching.** The DCX name normalization (`normalizeCorpsName`) works well enough for most cases.
4. **`event_participants.event_slug` uses a different format from `events.event_id`** (e.g., `2026-dci-san-antonio` vs `web-2026-2026-dci-san-antonio`). This makes joining tricky.

### Next Steps (Priority Order)
1. **Wait for show announcements** — many corps will announce in June/July. Re-run DCX scraper periodically.
2. **Implement FloMarching running list parser** — the article at `https://www.flo Marching.com/articles/159204-a-running-list-of-drum-corps-international-2026-show-announcements` contains titles for all corps.
3. **Improve agent scraper** — use search results (not direct URL guessing) and parse article content for show titles.
4. **Add DCI.org scraper with Browserbase** — Cloudflare bypass needed for live scraping.
5. **Media download pass** — download photos for shows with real titles.

---

## 19. Related Files & References

### Existing Files (Reused)

| File | Purpose |
|---|---|
| `sdk/src/relational.ts` | Schema CREATEs, INSERT/UPSERT helpers, SqlClient Effect wrappers |
| `sdk/src/extraDomain.ts` | Domain types (`CorpsShowSchema`, `ShowRepertoireEntrySchema`) |
| `sdk/src/browserbaseService.ts` | Browserbase Effect-TS service (`BrowserbaseService`) |
| `sdk/src/websiteApi.ts` | Website scraper with caching (Effect-based) |
| `sdk/src/corpsParser.ts` | `parseCorpsDirectory`, `parseCorpsProfile`, name normalization |
| `sdk/src/corpsDiscovery.ts` | `matchExistingCorpsKey`, `resolveExistingCorpsKey` |
| `sdk/src/mediaService.ts` | Media caching into `media-cache.db` (Effect-based `MediaService`) |
| `sdk/scripts/scrapeCorps.ts` | Reference orchestrator pattern (archive → parse → coalesce → ingest) |
| `sdk/CORPS_SCRAPING_PLAN.md` | Corps scraping pipeline design |
| `sdk/docs/dci-website-scraping.md` | Website scraping scope, storage, edge cases |
| `AGENTS.md` | Project conventions, DB safety rules, Effect patterns, working style |
| `scripts/browser-tools.ts` | **browser-tools CLI** — puppeteer-core + Edge/Chrome CDP wrapper; commands: `start`, `nav`, `search`, `content`, `eval`, `screenshot`, `inspect`, `kill` |
| `browse` (global CLI) | **Browserbase `browse` CLI** — unified browser automation (`browse open`, `snapshot`, `get`, `eval`, `screenshot`, `skills`); local + cloud modes |
| `agent-browser` skill | **Agent browser skill** — headless Chromium for agent use; loaded via `/agent-browser` skill command |

### New Files (Created)

| File | Purpose | Effect Pattern |
|---|---|---|
| `sdk/src/showErrors.ts` | `Schema.TaggedError` definitions for all show-scraping domain errors | `Schema.TaggedError` per error type |
| `sdk/src/showScraperDcx.ts` | `DcxScraper` service — DCX Museum fetch + parse | `Effect.Service` + `Effect.fn` + `Effect.tryPromise` |
| `sdk/src/showScraperFlomarching.ts` | `FloMarchingScraper` service — FloMarching search + article parse | `Effect.Service` + `Effect.catchTag` for paywall |
| `sdk/src/showScraperDciOrg.ts` | `DciOrgScraper` service — DCI.org news probe + parse | `Effect.Service` + `Effect.catchTag` for Cloudflare |
| `sdk/src/showScraperAgent.ts` | `ShowScraperAgent` service — direct fetch + browser-tools CLI (Tier 1a + 1b) | `Effect.Service` + `Effect.tryPromise` (spawns CLI) + `Effect.catchTag` |
| `sdk/src/showIngestion.ts` | `ShowIngestion` service — DB writes + media downloads | `Effect.Service` + `dependencies: [MediaService.Default]` |
| `sdk/src/showOrchestrator.ts` | `ShowOrchestrator` service — pipeline composition + parallelism strategy | `Effect.Service` + `dependencies: [DcxScraper + ShowIngestion]` |
| `sdk/src/showLayers.ts` | Layer composition — `Layer.mergeAll` for all services + infrastructure | `Layer.mergeAll` + `Layer.provideMerge` |
| `sdk/src/showReport.ts` | Coverage reporting — class breakdown, missing titles, recently updated | Pure functions over DB queries |
| `sdk/scripts/ingestShowAnnouncements.ts` | Entry point — the **only** file with `Effect.runPromise` | `Effect.runPromise` at boundary only |
| `sdk/scripts/verifyShowIngestion.ts` | Post-ingestion DB integrity verification script | Standalone script, 10 automated checks |
| `sdk/__fixtures__/dcx-repertoires-2026.html` | Saved HTML fixture for DCX parser tests (9 corps entries) | Test data |
| `sdk/test/showScraperDcx.test.ts` | 30 unit tests for `parseDcxRepertoireHtml` pure function | Direct assertions, no test framework |
| `sdk/test/showOrchestrator.test.ts` | 41 unit tests for `normalizeCorpsName`, `dcxNameToCorpsKey`, `makeShowId`, `buildShowFromDcx` | Direct assertions, no test framework |

---

*End of plan.*
