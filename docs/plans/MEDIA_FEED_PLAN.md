# Media feed (`/media`) — plan

A community media feed that automatically surfaces new media about the corps and
surrounding community, as **link-out previews** (never reposts): thumbnail +
title + AI summary + source badge + "View on <source> →". AI summarizes,
categorizes by corps/type, and gates relevance.

Reuses the existing `scrape → archive → pure parser → coalesce/ingest →
read-model → route` pipeline. The **staff feature** is the end-to-end template
(`staffScraper.ts` → `corps_staff` → `builders/staff.ts` → `readers.ts` →
`app/routes/staff/`).

## Scope decisions (2026-06-16)

- **v1 sources:** **YouTube** (automated backbone). Instagram/TikTok scraping
  attempted via `yt-dlp` (see caveat). Reddit / DCI news / generic RSS are
  architected-for but deferred to v2.
- **Automation:** auto-publish once the AI **relevance gate** passes, plus an
  **admin hide/unhide** control (`status` column + one RPC + admin route).
- **Social caveat:** IG/TikTok are login-walled, ToS-hostile, with expiring CDN
  URLs (per `web-research-and-scraping-field-guide.md`). Engine = `yt-dlp` off a
  **handle allowlist**; thumbnails cached to `media-cache.db` immediately
  (source URLs expire). Expect maintenance churn; YouTube is the stable core.
  Fallback if IP-blocked: Browserbase-rendered profile pages.

## Sources (yield-per-effort)

| Source | Method | Tier |
|---|---|---|
| YouTube | per-channel RSS `youtube.com/feeds/videos.xml?channel_id=…` (no key); Data API v3 optional | v1 — easy, stable |
| Instagram / TikTok | `yt-dlp` public-post metadata off a handle allowlist; cache thumbnails | v1 — attempted, brittle |
| Reddit | official JSON `/r/drumcorps/new.json` | v2 — easy |
| DCI.org news | Browserbase + cheerio (Cloudflare) | v2 |
| Generic RSS | corps blogs/news where published | v2 |
| Discord | bot invited per public server | v3 — optional |

## Data model — `dci-relational.db` (durable archive)

```sql
media_items(
  media_id PK,            -- hash of canonical source_url (dedup key)
  source,                 -- 'youtube'|'instagram'|'tiktok'|'reddit'|'dci'|'rss'|'curated'
  source_url, permalink,  -- link OUT, never rehost
  title, author,
  thumbnail_url,          -- bytes cached in media-cache.db (CDN URLs expire)
  published_at,
  media_type,             -- 'video'|'article'|'discussion'|'photo'
  raw_json,               -- full source payload, re-parseable
  -- AI-derived (re-runnable; never authoritative source data):
  ai_summary, ai_corps_keys_json, ai_tags_json, ai_relevance, ai_model, ai_at,
  status                  -- 'published'|'hidden'|'pending'
)
```
AI fields are derived/re-runnable (like staff AI confidence); `raw_json` is the
durable source. Identity: corps tagging resolves mentions via the existing
`resolveExistingCorpsKey` name-normalization so `/media?corps=blue-devils` works.

## Pipeline (`sdk/`)

```
sdk/src/media/sources/{youtube,social}.ts   // fetch+parse → RawMediaItem[]
sdk/src/media/sourceRegistry.ts             // YT channels + IG/TikTok handles
sdk/src/media/aiEnrich.ts                   // summarize + categorize + relevance gate
sdk/scripts/scrapeMedia.ts                  // orchestrator: --dry-run/--apply, scraper_progress
sdk/scripts/mediaUpdateWorkflow.ts          // scrape → enrich → emit → push → redeploy
```

**AI enrich** — one Anthropic API call per new item (`claude-haiku-4-5`; cheap,
fast, classification-shaped). NOT the `claude -p` CLI (`scraperClaude.ts`) — that
won't be authenticated in non-interactive cron. Needs `ANTHROPIC_API_KEY`.
Returns: 1–2 sentence neutral summary, corps keys, type tags
(`performance|news|analysis|community|announcement`), and a relevance score that
drops spam/off-topic/NSFW. The relevance gate is the quality moat (fan channels
are noisy).

## Read-model + route

- `sdk/src/readModel/builders/media.ts` → `buildMediaFeed()` (published only).
- Emit `rm_media_feed` in `emitReadModel.ts`; **bump `SCHEMA_VERSION`**.
- Reader in `readers.ts`; `mediaCollection` in `app/db/collections.ts`; manifest shard.
- `app/routes/media/index.tsx` — copy `/merch`: `HybridCollection` +
  `useActionState` load-more + `useSearchSync` filters (corps / source / type).
  Card links out; **no rehosting**.
- `app/routes/admin/media.tsx` — hide/unhide; one Effect RPC mutation flips `status`.

## Hard parts
- **Dedup** across sources (same video on YT + Reddit): canonical-URL hash + fuzzy title.
- **Thumbnail durability**: cache bytes; never store expiring `fbcdn`/`cdninstagram` URLs.
- **Relevance filtering**: the AI gate keeps the feed good.
- **Registry curation**: seed YT channels from corps table + a hand-picked fan list; IG/TikTok handle allowlist is manual.

## Scheduling
Box already runs scheduled tasks (restic backup). Add a cron entry running
`mediaUpdateWorkflow` every few hours:
`scrapeMedia --apply → aiEnrich → emitReadModel → push:data read-model → redeploy/pull`.
