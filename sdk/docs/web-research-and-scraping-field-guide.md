# Web Research, Search & Scraping — Field Guide

A practical, general-purpose playbook for any task that involves **finding
information and media on the open web, extracting it reliably, and ingesting it**
into this project. Written from hard-won experience (the judge bio/photo
enrichment effort, the corps/event scraping pipelines, and the 2026
show-announcement research). Read this before doing research/scraping work — it
will save you the tool-thrashing and dead-ends that produced these lessons.

This is **not** about one dataset. The tools, tactics, and gotchas below apply
to enriching any entity (corps, events, judges, staff, venues), recovering
images, or harvesting facts from messy pages.

---

## 1. The tool ladder (cheapest → most capable)

Always start at the top and escalate **only when the cheaper tool fails**. Each
rung costs more (time, money, or fragility).

| Rung | Tool | Use for | Cost | Notes |
|---|---|---|---|---|
| 1 | **WebSearch** | Discover who/what exists, find candidate source URLs, disambiguate names | free | US-only. Returns titles+URLs + a model summary. The summary is a *lead*, not a citation — open the source. |
| 2 | **WebFetch** | Pull a **static** page's content/answer a question about it | free | Converts to markdown, answers via a small model. **Cannot run JS.** Caches 15 min/URL. **Lies with false 404s** — see §4. |
| 3 | **`scripts/renderPage.ts` / `renderImgs.ts` / `renderHtml.ts`** (puppeteer) | **JS-rendered** pages, Cloudflare-protected pages, extracting all `<img>`/text/HTML after hydration | free | Local headless Chrome. The workhorse when WebFetch can't see content. See §3. |
| 4 | **`BrowserbaseService.fetchHtml`** (`sdk/src/browserbaseService.ts`) | Cloud browser to bypass Cloudflare **and hydrate SPAs** | ~$/page | **As of 2026-06 this drives a Browserbase *session* over CDP (puppeteer-core `connect`), so it now DOES execute client-side JS / hydrate SPAs.** (It previously used the hosted `fetchAPI`, which only returned initial HTML *and* is plan-gated — see §9.) |
| 5 | **`scripts/browser-tools.ts`** (`agent-browser` skill, Browserbase cloud) | Interactive automation: click, snapshot, login-walled pages, Google `search`, Readability `content` extraction | free–$/page | Heavier. The repo-root `scripts/browser-tools.ts` wraps puppeteer + Readability/Turndown. See `sdk/docs/2026-show-announcements-plan.md` §"Agent Browser Stack". |
| 6 | **`curl`** | HEAD/redirect/content-type probes, downloading a known asset URL, hitting JSON/REST endpoints, **and as a free Cloudflare-bypass fetch tier** | free | Best for *verifying* a URL cheaply — see §6. Also passes most Cloudflare checks that Node `fetch` fails. ⚠️ Pass a **generic** `-A "Mozilla/5.0"`, NOT a detailed Chrome UA — Cloudflare flags a UA/TLS-fingerprint mismatch (curl claiming Chrome → 403); bare/generic UA → 200. See §9. |

**Rule of thumb:** discovery = WebSearch; reading a normal page = WebFetch;
reading a Cloudflare page = curl (generic UA) → render; reading a JS/SPA page =
puppeteer render or Browserbase session; verifying a URL = curl HEAD.

---

## 2. The research loop (how to actually find a fact/photo)

1. **WebSearch** with the entity name + 2–4 disambiguating terms (domain, role,
   location, organization). The search-result *link list* is often more useful
   than the prose summary — scan it for high-signal hosts (official sites, MFA,
   SCPA, university faculty, HOF pages, news).
2. **Pick the highest-trust source** that likely has what you need (see §7 source
   tiering). Prefer official/primary over aggregators.
3. **Fetch/render it** (WebFetch if static; puppeteer if JS). Extract the fact +
   the **source URL** + a **confidence** (HIGH/MEDIUM/LOW).
4. **Cross-check** against a second independent source when identity is at stake
   (common names!). For judges, DCI adjudication-panel announcements were a
   reliable "is this the same person" check.
5. **Record provenance.** Every fact carries `{fact, source, confidence}`. Never
   write an unsourced claim as HIGH. Don't guess — omit instead.

### Confidence calibration
- **HIGH** — stated on an official/primary site (the person's employer, an HOF
  page, their own bio, a verified org).
- **MEDIUM** — reputable secondary (MFA/BOA, SCPA, a news article) **or** a
  primary fact whose *identity match* isn't fully nailed (common name).
- **LOW** — inferred, aggregator-only, or unverifiable. Store as a note, don't
  promote to a displayed field.

---

## 3. Puppeteer rendering — the workhorse (and how to get it working)

Local headless Chrome via `puppeteer-core` is the single most valuable tool for
this codebase's research work. It executes JS, passes most Cloudflare bot
checks, and sees what WebFetch/Browserbase can't.

### Getting a browser (per platform)
- **Linux box (the deploy/ingest host) — `/usr/bin/chromium` is already installed.**
  Just point `puppeteer-core` at it: `puppeteer.launch({ executablePath:
  "/usr/bin/chromium", headless: true, args: ["--no-sandbox",
  "--disable-setuid-sandbox", "--disable-dev-shm-usage"] })`. This is the path the
  merch pipeline uses (see §3c). `--no-sandbox` is required (non-root container);
  `--disable-dev-shm-usage` avoids `/dev/shm` OOM on big pages. No download needed.
- **Windows laptop** (the gotchas below): no system Chrome on PATH, so —
- `agent-browser` (the global CLI) **fails to start its daemon** on this
  Windows/git-bash setup (unix-socket + it shells out to `npx`, which isn't on
  the daemon's PATH). Don't fight it.
- The fix that works: run **`agent-browser install`** once (downloads a
  Playwright `chrome-headless-shell`), then drive that binary directly with
  **`puppeteer-core`** — *not* the agent-browser daemon. Its path is:
  `C:\Users\Patrick\AppData\Local\ms-playwright\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe`
- `agent-browser install` itself needs `node`/`npx` on PATH; export it first:
  `node_dir=$(dirname "$(which node)"); export PATH="$node_dir:$PATH"`. (Node is
  under `C:\Program Files\Volta`.)
- `puppeteer-core` is already in the **repo-root** `node_modules` (resolves from
  `sdk/scripts/*` via node's upward module resolution).

### The helper scripts (in `sdk/scripts/`)
- **`renderImgs.ts <url> [substringFilter]`** — dumps every `<img>` src + alt
  after hydration. The go-to for **finding headshots/logos**. Grep the output
  for `uploads`, `scpauploads`, the person's surname, etc.
- **`renderPage.ts <url>`** — prints filtered candidate images + the main visible
  text (first ~2500 chars). Use to read a JS page's content + confirm a stub.
- **`renderHtml.ts <url> <out>`** — saves the full post-hydration HTML to a file
  so you can `grep` the raw markup (find JSON-LD, data endpoints, exact image
  filenames, og: tags).
- All hard-code the chrome-shell path via a `CHROME_SHELL` env override.

### Writing these scripts — quoting gotchas (cost real time)
- **Do not create them with a bash here-doc.** A `<<'EOF'` heredoc *collapsed
  the `\\` path separators* in the Windows EXE path, producing
  `C:UsersPatrick...` → "browser not found". **Use the Write tool** to create
  TS files so escaping is preserved.
- When passing a **URL with `&`** to a script, **single-quote the whole URL**
  (`'https://site/x?a=1&b=2'`). An unquoted `&` backgrounds the command and the
  shell tries to run `b=2` as a program (you'll see random `vim`/`id` errors).
- Run renders **in the background** (`run_in_background: true`) when sweeping
  many URLs — each spawn is ~10–15 s. Don't launch a second browser job that
  competes with a running one.

---

## 3c. The rendering pipeline today (local Chromium → parser / AI) — 2026-06

This is how rendering actually works in the merch pipeline now, and the reusable
shape for any "JS page → structured data" task. **Render once, then choose an
extractor: a deterministic parser (cheap, preferred) or an AI loop (for messy,
unstructured pages).**

### The render layer: local-first, cloud-fallback
`sdk/src/browserbaseService.ts` (`BrowserbaseServiceLive`) exposes `fetchHtml(url)`
and escalates **cheapest → costliest**:
1. **Local headless Chromium** (`/usr/bin/chromium` via puppeteer-core) — free,
   unlimited, parallel. The primary path. One shared `Browser` is launched lazily
   and reused; each `fetchHtml` opens/closes a `Page`.
2. **Browserbase cloud session** — fallback only (the free plan caps concurrency
   at 3 and burns limited minutes, so avoid it when local Chromium exists).

It needs **no API key** for the local path; callers always provide the layer.
`findLocalChrome()` honours `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` then probes
the usual `/usr/bin/...` paths. *(History: we first drove Browserbase's hosted
`fetchAPI` — but that endpoint is plan-gated (402) AND never hydrated SPAs; then
Browserbase sessions, which hydrate but saturate the free plan; local Chromium is
the resolution. See §9.)*

### Render-readiness: wait for the SIGNAL, never `networkidle`
**The single biggest gotcha.** `waitUntil: "networkidle2"` *hangs the full nav
timeout* on real stores — recaptcha / Sentry / analytics keep connections open so
the page never reaches network-idle (this made every render take ~45 s and timed
out batch jobs). Instead:
```ts
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector('script[type="application/ld+json"]', { timeout: 8000 })
          .catch(() => {});           // the data we want, capped — not "the network"
return await page.content();
```
Wait for the *specific element that carries your data* (a JSON-LD script, an `h1`,
a price node), with a short cap. A render then takes **~1–3 s**, not 45.

### Pattern A — render → deterministic parser (preferred)
Pipe the rendered HTML into cheerio + a structured-data extractor. Cheap, exact,
no tokens. This is what `merchCatalog.ts` does — `fetchHtmlWithFallback(url, …,
hasProductJsonLd)` renders only when the plain fetch lacks the signal, then
`productFromHtml()` extracts in priority order:
1. **schema.org JSON-LD** `Product` — walk arrays, `@graph`, **and `mainEntity`**
   (Weebly/Square wrap the Product in a `WebPage.mainEntity`); tolerate casing
   variants (`Offers`, `Availability`, image `contentUrl` vs `url`).
2. **OpenGraph** `og:type=product` + `product:price:*`.
3. **Rendered-DOM heuristic** (last resort, e.g. Shopify Hydrogen / `store.dci.org`
   which emit neither): `<h1>` title, the cdn product `<img>`, and a price via a
   **cents-required** regex (`/\$\s?([0-9]+\.[0-9]{2})\b/`) so a "$75 free shipping"
   banner or a bare quantity isn't mistaken for the price.
Detect *client-rendered* stores by fetching one PDP directly: a non-empty HTML
**shell with no Product signal** = client-rendered → render the rest. (The fallback
only escalates to a render when the cheap fetch's HTML fails the signal check, so
server-rendered stores like Wix/BigCommerce never pay the render cost.)

### Pattern B — render → AI extraction loop (for messy/unstructured pages)
When a page has **no** structured data and the layout is irregular (no stable
selectors), hand the rendered, **stripped-down** HTML (or the visible text) to a
model with a strict output schema, and validate. Two routes in this repo:
- **In-process**: render with puppeteer → reduce the HTML (drop `<script>/<style>`,
  keep the main content / visible text — full pages are 2–3 MB and blow the context
  window) → call the model with a JSON schema → `Schema.decode` the result, retry on
  mismatch. Keep a per-field `{value, confidence, source}` and a dry-run report
  before writing (see §10).
- **Subprocess `claude -p`**: `sdk/src/scraperClaude.ts` already wraps
  `execFile("claude", ["-p", prompt])` → `Schema.decode` → upsert, with progress
  tracking (§3b). Reuse that prompt-builder → decode → upsert shape. **Validate on
  ONE entity before a bulk run** — a headless `claude -p` may not have web tools and
  can hallucinate.
**Prefer Pattern A**; reach for B only when no parser can be written reliably. AI
extraction costs tokens, varies run-to-run, and *must* be schema-validated +
confidence-gated. A good hybrid: parser first, and only the rows it can't fill go
to the AI loop.

### Cost & batching
- Per-PDP rendering is the expensive step (network + hydrate per page). A 274-product
  store ≈ 3–6 min locally at concurrency 4. Fine for a nightly job; **cap discovery
  and `log()` truncation** so a huge store can't run unbounded.
- **Cheapest of all: skip rendering — find the store's JSON.** Before rendering N
  PDPs, check for a feed: Shopify `/products.json`, Squarespace `?format=json`, a
  WebInspector-visible XHR (bkmarketplace is Weebly/Square → `cdn*.editmysite.com/
  app/store/api/v*/…/products`), or a React-Router `<route>.data` endpoint (Shopify
  Hydrogen). One API call beats 200 renders. Render only when there's no feed.
- The slim ingest Docker image does **not** ship Chromium; the nightly job runs **on
  the box** (which has `/usr/bin/chromium`). If you ever run rendering inside that
  image, install chromium there or it falls back to Browserbase.
- **⚠️ This box has only ~4 GB RAM, and the render path LEAKS one chromium per run.**
  The shared local browser (`browserbaseService`) is never closed on exit, so node's
  `process.exit` (or a `kill -9`) **orphans its chromium child to init** — it keeps
  running (~10 procs, ~300 MB each). Restarting a batch job a few times accumulates
  dozens of orphans (seen: **105 chromium = ~3 GB**) → the kernel **OOM-kills** the next
  run silently (no V8 trace; it crashes at a *different* corps each time = memory
  exhaustion, not a bad page). Before a render-heavy batch: reap orphans
  (`for pid in $(ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /chrom/{print $1}'); do kill -9 $pid; done`,
  verify `ps -eo comm|grep -ci chrom` = 0), run at **`--concurrency 1`** with
  **`--max-old-space-size=2048`** (NOT >RAM), and **don't `kill -9` a live job** — let
  it finish, then clean up the one leaked browser. Proper fix: a `Layer.scoped`
  finalizer that calls `browser.close()` so each run self-cleans.

### Driving the browser by hand (debugging an extractor)
Render to a file and iterate the parser offline — don't re-render on every tweak:
```bash
# render once → save hydrated HTML, then parse with node+cheerio repeatedly
npx tsx sdk/scripts/renderHtml.ts '<url>' /tmp/page.html      # or a 10-line puppeteer script
node -e 'const $=require("cheerio").load(require("fs").readFileSync("/tmp/page.html","utf8")); …'
```
**`page.evaluate(fn)` gotcha under tsx/esbuild:** passing a JS *function* into
`page.evaluate` throws `ReferenceError: __name is not defined` (esbuild injects a
`__name` helper the page can't see). Workarounds: pass the body as a **string**
(`page.evaluate("(() => …)()")`), or skip `evaluate` entirely — `page.content()`
→ cheerio in Node is simpler and what the pipeline uses.

---

## 3b. Other automation mechanisms in this repo (know they exist)

Beyond the render scripts, the codebase ships several heavier mechanisms. Most
were **not** needed for routine bio/photo research, but you should know what they
are, whether they actually work, and when to reach for them.

### `claude -p` — the headless-Claude research runner (`sdk/src/scraperClaude.ts`)
There is a **built-in pipeline that spawns a headless Claude to do the research
for you** and return structured JSON. `makeClaudeRunner()` →
`runClaudeCommand(command, prompt)` literally does
`execFile("claude", ["-p", prompt])` (overridable via `CLAUDE_CLI`/`CLAUDE_BIN`).
It's wired into:
- `runClaudeJudgeScraper`, `runClaudeScraper`, `runClaudeMediaScraper` — build a
  per-entity research prompt (`buildJudgePrompt`, etc.), shell out to `claude -p`,
  `Schema`-decode the JSON, and `upsert…`. Supports `dryRun`, `maxTasks`,
  `targetJudgeIds`, `concurrency`, `targetSeasons`, `resume`.
- `compareJudgesWithClaude` / `compareStaffMembersWithClaude` — dedupe helpers
  that return `{samePerson, confidence, rationale, recommendedAction:
  merge|keep-separate|needs-review}` (the prompt tells the agent to compare
  headshots across Google Images/social/Wayback and only conclude "same person"
  on multiple independent signals).

| function | researches → | output schema | tables | resume? |
|---|---|---|---|---|
| `runClaudeScraper` | corps×season shows/staff/participation/media | `ClaudePayloadSchema` | `corps_shows`, `corps_staff`, `corps_season_participation`, `media_assets` | ✅ |
| `runClaudeJudgeScraper` | judges across seasons | `JudgeProfileSchema` | `judge_profiles`, `media_assets` | ✅ |
| `runClaudeMediaScraper` | media for a corps×season | `{media: MediaAssetSchema[]}` | `media_assets` | ❌ (no `scraper_progress`) |

**Exact spawn:** `execFile(command, ["-p", prompt], {maxBuffer: 10*1024*1024,
windowsHide: true})` — **no flags select model, web tools, or permissions**; every
constraint (which sites to consult, JSON-only output, confidence rules) lives in
the prompt text. Output path: stdout → `JSON.parse` (→`DciDecodeError`) → field
normalization (fills `showId`/`staffId`/`mediaId` defaults) → `Schema.decode`.
A malformed response marks that task `failed` in `scraper_progress` and the batch
**continues** rather than crashing.

**Status / gotchas:**
- It is the *automated* alternative to doing research yourself. We deliberately
  used the **manual** path (own WebSearch/WebFetch/render + hand-built JSON
  report) because quality/identity control was better and `claude -p`'s
  **web-tool access in the subprocess is unverified** — a headless `claude -p`
  may not have WebSearch/WebFetch enabled, so it can hallucinate. If you use it,
  pass/enable web tools and **validate on one entity** before a bulk run.
- `finalizeJudgeTasks` originally sorted **alphabetically**; it was changed to
  rank by **assignment volume** so `maxTasks` picks the most-active entities.
  `targetJudgeIds` was added to target specific ids.
- Entry point added: `sdk/scripts/researchJudges.ts` (`--top N`, `--judge <id>`,
  `--apply`, `--concurrency`, `--seasons`). `--dry-run` builds prompts but the
  empty runner response means it won't write — use it to sanity-check ordering.
- Reuse the *pattern* (prompt-builder → `claude -p` → Schema-decode → upsert) for
  any entity, but treat the manual path as the quality benchmark.

### `scripts/browser-tools.ts` (repo root) — interactive puppeteer CLI
A 1900-line commander CLI (the `agent-browser` skill's Tier-1b tool) that drives
a **locally-launched Edge/Chrome over CDP (port 9222)**. Commands:
`start`, `nav <url>`, `eval <code>`, `screenshot`, `pick`, `console`, `network`,
**`search <query>`** (Google search → title/link/snippet, with `--content` to
also pull readable text), **`content <url>`** (Readability.js + Turndown → clean
article markdown), `wait-for`, `click`, `type`, `scroll`, `pdf <url>`, cookies,
`inspect`, `kill`, tab management.
- **When to use:** clean article extraction (`content` is nicer than raw
  innerText) and Google `search --content` in one shot; login-walled sites via
  your own Edge profile (Tier 2). For *finding an image/headshot*, the simple
  `renderImgs.ts` was faster and sufficient.
- **Gotcha:** needs a browser launched on `--remote-debugging-port=9222` first
  (`browser-tools.ts start`). The user declined launching it interactively in
  this environment, so it was not exercised here — `renderImgs/renderPage`
  covered the same needs without a persistent CDP browser.
- **Mechanics worth knowing:** `start` spawns the browser detached, polls CDP up
  to 30×/500ms, then persists `{lastPort,lastBrowser}` to
  `~/.cache/browser-tools/state.json` (so later commands auto-find the port; also
  `BROWSER_TOOLS_PORT`/`BROWSER_TOOLS_BROWSER`). `--profile` copies your real
  profile (minus cache dirs) to inherit logins. `content`/`search --content`
  inject Readability + Turndown (+GFM) **from unpkg** and **cap output at 8000
  chars** — long articles are truncated. `search` scrapes Google `div.MjjYud`
  (title=`h3`, snippet=`div.VwiC3b`), `-n` up to 50. Full verb set also includes
  `wait-for/click/type/scroll/pdf/set-cookie/clear-cookies/close-tab/list-tabs`.

#### Driving a home browser over Tailscale (`scripts/browser-tunnel.sh`)
To scrape from a **residential IP** instead of this datacenter box (which gets
auto-blocked), forward the CDP port to a home machine on the tailnet:
`scripts/browser-tunnel.sh` runs `ssh -N -L 9222:localhost:9222
<user>@<tailnet-host>`. `browser-tools.ts` needs **no changes** — the forward
makes the home machine's `localhost:9222` appear as `localhost:9222` here, so
every command works unchanged, and Chrome's debug port stays bound to localhost
on both ends (never exposed on the tailnet; also dodges Chrome's "Host header
must be IP/localhost" rejection).
- **Default target:** `mini-pc` (`100.98.92.103`). Override with
  `BROWSER_TUNNEL_HOST` / `--host`, `--user`, `--local-port`, `--remote-port`.
- **Home machine prereqs (one-time):** Tailscale online; OpenSSH **Server**
  enabled (on Windows: `Add-WindowsCapability -Online -Name
  OpenSSH.Server~~~~0.0.1.0` then `Start-Service sshd`); Chrome launched with
  `--remote-debugging-port=9222` (or run `browser-tools.ts start` there).
- **Gotcha:** `tailscale ssh` does **not** work to a Windows target (its SSH
  *server* is Linux/macOS-only) — we use plain `ssh` to the tailnet IP against
  Windows' built-in OpenSSH server. Verify with `scripts/browser-tunnel.sh
  --check` (hits `/json/version` through the tunnel).
- **Asymmetric reachability (corporate NAT) — use a REVERSE tunnel.** On the
  real mini-pc, `vultr -> mini-pc` TCP was dropped on *every* port (22/3389/445)
  even with the Windows firewall fully off, ShieldsUp false, interface Private,
  and an allow-all tailnet ACL — while `mini-pc -> vultr` worked fine and
  `tailscale ping` (disco, ACL-exempt) succeeded both ways. The home machine's
  network only carries *outbound* TCP. Fix: don't tunnel from vultr; have the
  home machine dial out and remote-forward its Chrome port:
  `ssh -N -R 9222:127.0.0.1:9222 patrick@100.97.144.34` (run on mini-pc). That
  lands Chrome on vultr's `localhost:9222`; `browser-tools.ts` is unchanged.
  One-shot on the home box: `scripts/home-browser-host.ps1` launches Chrome +
  the auto-reconnecting reverse tunnel (register at logon via Task Scheduler;
  see its header for the SSH-key + schtasks one-liners). **Pin 127.0.0.1 on both
  ends** — `localhost` can resolve to IPv6 `::1` where Chrome (IPv4-only debug
  port) isn't listening, giving "Empty reply from server".
  Don't waste time debugging the inbound block — port-switching can't help, the
  corporate firewall never sees the inner port (it's inside the WireGuard/DERP
  TLS stream). **Full write-up:** `sdk/docs/home-browser-over-tailscale.md`
  (architecture, the two gotchas, startup task, and the diagnostic playbook of
  everything we ruled out). See also `scripts/browser-tunnel.sh` header.

### Stagehand (`@browserbasehq/stagehand`) — installed, NOT wired in
`@browserbasehq/stagehand@^3.5.0` is a **dependency in `package.json`** (AI-driven
browser automation: natural-language `act`/`extract`/`observe` over Playwright/
Browserbase). **No code uses it** — grep finds it only in `package.json`/lockfile.
It's available if you want NL-driven extraction on a hard page, but it's
unproven in this repo and would need wiring (and likely a Browserbase session /
LLM key). Don't assume it "just works."

### `browse` CLI — referenced in docs, NOT installed
The `browse` CLI (Browserbase's local driver: `open`/`snapshot`/`get`/`eval`/
`screenshot`/`skills`) is described as "Tier 1c" in
`sdk/docs/2026-show-announcements-plan.md`, but it is **not installed** here
(no `browse` bin in `node_modules/.bin`, would need `bun install -g browse`).
Treat that doc section as aspirational for this machine; use puppeteer instead.

### The show-scraper agent (`sdk/src/showScraperAgent.ts`) — agent finds URLs, code extracts
A second "agentic" pattern, distinct from `claude -p`: the agent **discovers
sources** but extraction is **deterministic heuristics, not an LLM**. Flow
(`scrapeCorps`): (1) guess standard paths on the corps site (`/2026-show`,
`/announcements`, `/news`, `/program`…) and direct-fetch; (2) on failure,
**spawn the browser CLI as a subprocess** — `exec("npx tsx
scripts/browser-tools.ts search …")` then `… content <url>`, parse the
`Title:/Link:/Snippet:` text; (3) run `extractShowFromHtml` — 7 regex/DOM
heuristics (title, og:meta, designer credits, movements, `"Song" by Composer`
repertoire, YT/Vimeo iframes) → confidence HIGH/MEDIUM/LOW by field presence.
- **Status (honest):** the plan marks this *"⚠️ Partial — browser-tools CLI works,
  but `extractShowFromHtml()` produces garbage titles; reverted."* The
  agent-discovery half works; the heuristic extractor is unreliable on real HTML.
  **Don't lean on it for titles** — prefer the structured scrapers below.
- **Ingestion safety:** confidence-gated — HIGH writes directly, MEDIUM flags for
  review, **LOW only lands in `show_announcement_scrapes` (raw archive), never
  `corps_shows`**. The `exec` `cwd` is hard-coded to a Windows path.
- **Companion structured scrapers:** `showScraperDcx.ts` →
  **`dcxmuseum.org`** (a ColdFusion site, **no Cloudflare** — the best 2026
  repertoire source; Cheerio table parsing, ~81 shows) and `showScraperDciOrg.ts`
  → `dci.org/news` (Cloudflare-blocked → returns empty; needs Browserbase, not
  wired). When you need DCI repertoire/show titles, **start at dcxmuseum.org**.

### Two divergent fetch paths — know which retries what
The core scraper has **two** `fetchHtmlWithRetry` implementations with different
behavior (both spoof Chrome 120 / Windows UA, both 6 retries, no explicit
timeout):
- `websiteScraper.ts` (recap scraper): base **1000ms**, **retries 429 only**.
- `websiteApi.ts` (`DciApi` service): base **250ms**, **retries 429 + 5xx + network
  errors**. Caches via 7-day TTL into `website_recaps` (key `recap_slug`, latest
  `scraped_at`) and `api_responses` (key exact `endpoint_url`, `#parsed` suffix
  for parsed variants).
Neither path auto-falls-back to Browserbase — Browserbase is opt-in
(`--source browserbase`, `bbFetch.ts`/`bbDump.ts`); its only built-in self-heal
is retrying a direct fetch when it returns empty content for a `www.dci.org` URL.

### Naming note
The render helpers are **`renderPage.ts` / `renderImgs.ts` / `renderHtml.ts`**
(plus `bbDump.ts` / `bbFetch.ts`). There is **no `renderFile`** — if you see it
referenced, it means `renderHtml.ts` (render → save full HTML to a file).

---

## 4. WebFetch's false 404 (the single most expensive gotcha)

**WebFetch returns "HTTP 404 Not Found" for pages that actually exist.** This
burned hours: dozens of Music-for-All clinician pages, university profiles, etc.
were declared 404 by WebFetch but rendered perfectly with puppeteer.

- **Never trust a WebFetch 404 as "the page doesn't exist."** Re-check with
  `renderImgs.ts`/`renderPage.ts` (or `curl -sI`) before concluding a source is
  missing.
- WebFetch also 403s on some hosts (Tapspace, Pearl) and returns only a data-URI
  placeholder for lazy-loaded images — again, render instead.
- WebFetch **upgrades HTTP→HTTPS** and returns cross-host redirects to you
  instead of following them (re-call with the redirect URL). `dci.org` →
  `www.dci.org` is a 301 you must follow manually.

---

## 5. High-yield bulk tactic: guess the URL pattern, then sweep

Many directories use **predictable per-entity URL slugs**. Far faster than
searching each entity:

- Music for All clinicians: `education.musicforall.org/clinician/<first>-<last>/`
  (kebab). Image lives at `…/wp-content/uploads/sites/4/<...>.{jpg,png}` with
  `alt="Lastname, First"`.
- SCPA judges: `scpa.live/judge/profile/<id>` → photo at
  `scpauploads.s3.amazonaws.com/judges/<...>.jpg` (the S3 URL renders even when
  the profile page is JS).
- DCI Hall of Fame: `dci.org/static/<slug>` or `dci.org/hall-of-fame/<slug>`;
  portraits at `images.dci.org/wp-content/uploads/<...>.webp`.
- WGI judge pages (`wgi.org/judge/<slug>`, `wgi.org/judges_winds/<slug>`) are
  **caption-only stubs** — name + caption, *no bio/photo*. Don't waste a render
  confirming each; they're empty by design.

**Sweep pattern:** build the candidate slug list, loop `renderImgs.ts` over each
in a **background** job, grep for a real `uploads/` hit, collect winners. One
slug-sweep across ~50 names recovered ~13 photos that individual searches had
missed. Run sweeps of ~20–25 URLs per background job.

### Reverse-engineering a directory's image path
When a list page renders but per-entity pages don't (e.g. MCBA, a Joomla site):
the photos often follow `…/images/Adjudicators/Lastname_First.jpeg`. **Probe the
pattern directly with curl and check `Content-Type`** (§6) — many CMSes return
`200 text/html` (an error page) for a missing image, so a 200 status alone is a
**false positive**. Only `Content-Type: image/*` means the file is real.

---

## 6. Verify URLs cheaply with curl before trusting/ingesting them

A bare HEAD/`-D -` probe is the cheapest way to confirm an asset is real and
ingestible. Do this **before** caching bytes or writing a `photo_url`:

```bash
curl -s -A "Mozilla/5.0" -D - -o /dev/null "<url>" | grep -iE "content-type|content-length"
```

- `Content-Type: image/jpeg` + a real `Content-Length` → genuine image.
- `Content-Type: text/html` → it's a 404/redirect/challenge page masquerading as
  a 200. **Reject it.** (This is how the Pearl `CharleyPoole-header.jpg` and
  several MCBA `Lastname_First.jpeg` guesses were caught.)
- Always pass `-A "Mozilla/5.0"`; many hosts 403 the default curl UA.
- Watch for **placeholder images**: MFA serves `generic.jpg` / a `file.jpg`
  user-icon for clinicians without a real headshot, and DCI HOF serves
  `user-icon-placeholder-1.webp`. A 200 image that is a generic avatar is **not
  a usable headshot** — eyeball the filename/alt.

---

## 7. Source tiering — where the good data actually lives

Learned ranking of sources by yield + trust for marching-arts people/entities
(generalize the *idea* to any domain: official > directory > aggregator):

1. **Official / primary** — the person's employer (university faculty page,
   school staff), their own site, an HOF profile (DCI/WGI/World Drum Corps), an
   org appointment news post. HIGH confidence, usually a real photo.
2. **Adjudicator directories** — Music for All clinicians (best single source:
   bio + headshot for a huge fraction), SCPA (`scpa.live`, photos on S3),
   ContestDynamics (`printjudgebio.php?JudgeID=`), e-adjudicate. Good photos,
   MEDIUM-HIGH.
3. **Manufacturer artist pages** — Innovative Percussion, Tapspace, Pearl,
   Dynasty, Yamaha, Vic Firth. Often have a clean headshot for percussionists.
4. **News / features / podcasts** — university news (UKNow), local papers,
   "Discussions in Percussion"/marching-arts blogs. Their **header/cover image**
   is frequently the person's photo (check the `alt`).
5. **DCI/WGI/BOA event PDFs** ("Judge Bios" for Grand Nationals, etc.) — contain
   bios + embedded headshots, but **image extraction from PDFs is hard** and
   WebFetch can't parse binary PDFs; treat as a last resort / text-only.
6. **Aggregators / social** (LinkedIn, Facebook, Instagram) — LOW for scraping
   (login walls, expiring CDN URLs). Don't scrape login-walled social; if a
   user hands you an FB `fbcdn` URL, note it **expires** — re-host the bytes.

**Domain-specific cross-checks that proved reliable:** DCI adjudication-panel
announcements (`dci.org/news/<year>-...-adjudication-panels`) to confirm a
person is the right judge and which captions/years; the entity's own
caption/role "fingerprint" already in the DB to disambiguate same-named people.

---

## 8. Identity disambiguation (don't attach the wrong photo/bio)

Common names are a trap. Two concrete misses to learn from:
- A St-Louis "Michael Davis" (Freedom Percussion) vs. the DCI percussion judge —
  initially conflated; corrected only when the user confirmed the sources.
- "Andrea Brown" (UMD bands) vs. a separate male "Michael Brown" brass judge.

Tactics:
- Ground every search in the DB **fingerprint** you already have (caption mix,
  seasons, corps relations). If the candidate's specialty doesn't match the
  fingerprint, it's probably a different person.
- For a photo especially, require a **named match** (filename/alt contains the
  surname, or the page is unambiguously that person). When unsure, **leave it
  null and flag MEDIUM/LOW** — a missing photo is recoverable; a wrong one is a
  visible error.
- When the user supplies a source, trust it over your guess and **reconcile**
  (the Mike Davis bio was rewritten once the user confirmed identity).

---

## 9. Cloudflare & blocked-fetch reality (this project's web targets)

- **DCI.org, FloMarching, regiment.org, cadets.org, and many corps/Wix/Squarespace
  sites sit behind Cloudflare.** A Node `fetch()` / bare WebFetch gets an
  "Attention Required" challenge (often a 403 with a ~75 KB challenge body), not
  the real HTML.
- **`curl` is the cheapest bypass — but the UA matters (2026-06 lesson).** Node's
  `fetch` (undici) gets a 403 from Cloudflare on regiment.org where `curl` gets
  200, because Cloudflare fingerprints the TLS/HTTP2 stack. **The catch: curl must
  send a *generic* UA.** Verified on regiment.org:
  - `-A "Mozilla/5.0"` → **200**, full 168 KB page.
  - `-A "Mozilla/5.0 (Windows…) Chrome/120…"` (detailed) → **403** challenge.
  - `-A "curl/8.5.0"` (honest) → **200**.
  Cloudflare flags the *liar* case (claims Chrome, but the TLS fingerprint is
  curl's). So a curl fetch tier should use a plain `Mozilla/5.0`, not spoof a
  specific browser. The merch scanner (`merchScan.ts`) wires curl as a fetch tier
  between Node `fetch` and Browserbase for exactly this.
- **Cloudflare rate-limits by IP under concurrency.** A bulk scan at concurrency 6
  produced false "none" results for Cloudflare sites (regiment.org) that resolved
  perfectly at concurrency 1–2. If a site works standalone but fails in a batch,
  drop the concurrency and re-run; don't trust a single batch's negatives. (Guard
  bulk re-runs with a before/after diff so a transient block can't overwrite good
  data with a "none".)
- **What bypasses it:** curl (generic UA, free) → puppeteer with real Chrome →
  Browserbase **session** (cloud browser, residential IPs) for the stubborn ones.
- **Browserbase: `fetchAPI` vs sessions (2026-06).** Browserbase has two products.
  The hosted **`fetchAPI`** (one-shot `bb.fetchAPI.create({url})`) is **plan-gated —
  it 402s on our account even with a valid key** (the key authenticates; rate-limit
  headers come back fine; only that endpoint is gated), AND it only ever returned
  *initial* HTML (no SPA hydration). The core **sessions** product (`bb.sessions.create`
  → connect puppeteer-core over CDP) **works on the same key and DOES hydrate SPAs**.
  `BrowserbaseService.fetchHtml` was rewired to sessions: regiment.org went from a
  75 KB challenge to a fully-rendered 200 KB page with the JS mega-menu intact.
  Notes: `bb.sessions.create` needs a `projectId` (resolve from `bb.projects.list()[0].id`
  if `BROWSERBASE_PROJECT_ID` is unset); puppeteer-core only `connect`s to the cloud
  browser, so **no local Chromium is downloaded** (the slim ingest image stays slim);
  the project's **concurrency cap (3 here)** bounds parallel sessions.
- **A parked domain renders as a GoDaddy/"domainparking" lander.** cadets.org is a
  114-byte static stub that hydrates to a `…/lander` page linking `www.godaddy.com`
  / `search-domainparking.com` — i.e. the org let the domain lapse. A "site with no
  detectable content/store" is often a **parked domain**, not a scraping failure;
  render it once and check for godaddy/domainparking hosts before chasing it.
- WordPress sites: try the **REST API** (`/wp-json/wp/v2/<type>?slug=<slug>`)
  and **og:/JSON-LD** meta in the rendered HTML before giving up — but custom
  post types are often *not* exposed (WGI's `judges_winds` REST = 404), and
  Yoast `og:description` is frequently just nav boilerplate, not a bio.

---

## 10. Ingestion discipline (turning findings into DB rows)

Mirror the project's established conventions (see CLAUDE.md "Working style" and
the corps/read-model docs):

- **Build a reviewable JSON report first, dry-run, then `--apply`.** The judge
  work used `results/judge-bios-*.json` + `scripts/applyJudgeBios.ts --dry-run`.
  Never write the live 2.5 GB DB blind.
- **Coalescing upserts** — scraped non-null wins, a missing field never nulls
  out existing data; guardrails reject placeholder garbage. (`upsertJudgeProfile`
  / the corps ingest's `decideWrite` are the models.) **Caveat:** some writers
  assign directly rather than coalesce — e.g. `judges.biography=excluded.biography`
  overwrites. Know which is which before re-running with partial data.
- **Validate against the domain Schema** (`Schema.decodeUnknown(...)`) in the
  apply step so malformed report rows fail loudly, not silently.
- **Skip data artifacts.** `unknown-unknown-1` ("Unknown Judge", 72 assignments)
  and `j-missing-1` ("Judge Missing") are unresolved-attribution placeholders,
  not people. Filter them at the read layer (`buildJudgeDirectory` WHERE +
  `readJudgeDirectory` filter) rather than deleting (their assignments are still
  referenced).

### Media/image caching (so photos survive the source going offline)
- `photo_url` is served through `/api/media?u=<url>` from `media-cache.db`. The
  app's `proxiedImage(..., {assumeCached:true})` always routes through the proxy.
- **A cache hit is served regardless of host** (SSRF guard only applies to
  fetch-on-miss, which is allow-listed to DCI hosts). Two ways to populate it:
  - **Remote URL:** `MediaService.cache({ownerType, ownerId, role, sourceUrl})`
    downloads + stores bytes + writes a `media_assets` row. (This is what
    `applyJudgeBios` does per `photoUrl`.)
  - **Local file / un-fetchable URL:** insert bytes directly under a **canonical
    key**, then point `photo_url` at that key:
    ```bash
    sqlite3 sdk/media-cache.db "INSERT OR REPLACE INTO media_cache
      (url, content_type, bytes, byte_length, fetched_at)
      VALUES ('https://drumcorps.app/judges/michael-lentz.jpg','image/jpeg',
              readfile('public/judges/michael-lentz.jpg'), 53008, datetime('now'));"
    ```
    The host in the key is irrelevant (cache-hit serves it); pick a stable one.
    This is how a user-supplied `public/` file got wired in.
- **FB/social CDN URLs expire** — never store an `fbcdn`/`instagram` URL as a
  durable `photo_url`; download and re-host/cache the bytes.

---

## 11. Read-model awareness (where the app actually reads from)

Changing a builder/SQL isn't enough if prod reads the precomputed tables:
- App read services go through the **read-model** (`rm_*` tables) when
  `READ_MODEL_DB_URL` is set (production); with it unset (local `vite`) they
  **fall back to building from `dci-relational.db`**.
- So a fix in a `builders/*.ts` query helps **dev only**; production reads
  `rm_*` via `readers.ts`. Patch **both** (builder + reader) for an immediate
  effect, or re-emit (`scripts/emitReadModel.ts --only <section>`) — re-emit is
  zero-downtime/safe anytime. The deployed `.output` server needs a redeploy to
  pick up compiled reader changes.

---

## 12. Efficiency & process notes

- **Batch the work.** Research N entities per "batch", build one report, dry-run,
  apply once. Track batches with the Task tools so progress is visible.
- **Parallelize independent calls** — fire multiple WebSearch/WebFetch in one
  turn; run multi-URL renders as background jobs and poll the output file.
- **Know when to stop.** Photo/bio yield drops sharply for low-activity entities
  (single-panel judges had ~1/13 photo hit-rate). At the long tail, prefer a
  *targeted* pass (user pastes a URL for the few high-value holdouts) over
  grinding every name.
- **Let the user feed you sources.** When something is login-walled or behind an
  unguessable slug (e.g. a Squarespace `new-page-1-1-1-…` judge page), the
  fastest path is to ask for the URL and patch it — don't burn 10 renders
  guessing.
- **Clean up** temp render dumps (`rm -f *.html bb-*.json`) and don't commit
  binary scratch.

---

## 12b. Building a parser? READ THE PAGE YOURSELF FIRST (don't infer from counts)

The single most effective tactic when writing or debugging a deterministic extractor:
**dump the actual page and read it with your own eyes** before theorizing about why
the parser under-performs. Inferring structure from node counts, selectors, or the
extractor's own output will mislead you.

**The lesson that earned this section (Boston Crusaders staff):** the deterministic
parser found 14 people; the AI fallback found ~125. I *assumed* the AI was
hallucinating because a quick scan showed only ~26 `<h2>` and a loose name-regex over
text nodes matched mostly junk ("Tour Schedule", "Fantastic Festivals"). I nearly
shipped an anti-"hallucination" filter to suppress the AI. Then I dumped the rendered
page's **visible text** and read it: Boston genuinely lists **~123 staff** — its
EDUCATION TEAM is ~90 instructional staff in `<ul><li>` rosters under caption headers
("Brass Staff", "Battery Staff", …), each `<li>` being either `Name – Title`
(en-dash) or a **bare name**. The AI was *right*; my parser was blind to a whole
layout. Reading the page turned a wrong conclusion into the highest-recall fix of the
project (14 → 123, and the same pattern lifted many other corps).

How to do it (fast loop):
1. **Render once to a file**, then read the *visible text*, not just the markup:
   ```bash
   npx tsx sdk/scripts/renderHtml.ts '<url>' /tmp/p.html
   node -e 'const $=require("cheerio").load(require("fs").readFileSync("/tmp/p.html","utf8"));
            $("script,style,nav,header,footer").remove(); $("br").replaceWith(" / ");
            console.log($("body").text().replace(/[ \t]+/g," ").replace(/\n\s*\n+/g,"\n").trim())'
   ```
   The flattened text shows the *real* roster and how name/title are delimited
   (comma? en-dash? bare lines under a header? name only in `<img alt>`?).
2. **Inspect the exact markup of ONE representative record** (and one the parser
   missed) — `$.html($(el).closest('.card, li, .team-member'))` — to see the true
   container/leaf shape. (This is how the `<br>`-in-title and `<li>` roster patterns
   were found.)
3. Only *then* write/adjust the pass, and re-run against the saved fixture.

Corollaries:
- **Don't trust the AI's count as truth OR as noise** — verify against the page. The
  AI both *over-extracts* (event names/nav as "people") **and** finds real structure
  the parser misses. Grounding AI output in the source text (`nameInSource` — keep
  only names that actually appear on the page) separates the two.
- **Node counts lie.** "Only 26 `<h2>`" said nothing about the 90 `<li>` names.
- A handful of saved fixtures (one per *layout family*: card-grid, lazy-img
  Squarespace, sectioned `<ul>` roster, comma list, name-in-alt) is the regression
  suite — re-run the parser over all of them after every change to catch precision
  regressions while chasing recall.

---

## 13. Quick reference — scripts created for this work (reusable)

In `sdk/scripts/` (general-purpose, not judge-specific):
- `renderPage.ts` — JS-render a URL → candidate images + visible text.
- `renderImgs.ts` — JS-render → dump all `<img>` src+alt (optional filter). Best
  image-finder.
- `renderHtml.ts` — JS-render → save full hydrated HTML to a file for grepping.
- `bbDump.ts` — Browserbase static-HTML dump to a file (Cloudflare bypass,
  no JS).
- `bbFetch.ts` — Browserbase fetch + cheerio image/text extract.

Pattern to reuse for any entity: research (WebSearch→render/fetch) → JSON report
with per-fact sources/confidence → `--dry-run` validate → coalescing upsert →
cache media bytes → verify in DB. Filter artifacts at the read layer.
