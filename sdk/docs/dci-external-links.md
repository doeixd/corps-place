# DCI External Links (event / recap / final-scores)

How the prediction & score pages link back to dci.org, why the old links 404'd,
and the verified rules we now follow. Companion to
`data-integrity-slugs-lineups-aliases.md` (slug namespaces & the
`event_to_competition` bridge).

---

## TL;DR

- DCI publishes **three distinct pages** per competition, all keyed by the same
  **season-prefixed** slug:
  - `/events/{slug}` — the show/event page
  - `/scores/recap/{slug}` — judge caption breakdown ("Full Recap")
  - `/scores/final-scores/{slug}` — placement totals ("Final Scores")
- The recap and final-scores pages are **separate live pages** (not a redirect
  pair) and **persist indefinitely**.
- The `/events/` page is **removed by DCI for older events.** Same slug, score
  pages live, event page 404s.
- Therefore: recap/final-scores links can be inferred from *having score data*;
  the **event link cannot be inferred from the slug at all** — it needs positive,
  live verification (an allowlist).
- The link slug is **`competition_slug ?? routeSlug`** — `competition_slug` is the
  authoritative season-prefixed slug bridged via `event_to_competition`; it routes
  around bare/legacy and multi-day (`-N`) event slugs.

---

## Live verification (Browserbase, 2026-06-12)

Probed via the `browse` skill in `--remote` mode (dci.org is Cloudflare-protected;
plain `fetch` returns a challenge — see the slug doc §3). Example event
`2016-dci-tour-premiere-presented-by-french-lick-resort`:

| URL | Result | Title |
|---|---|---|
| `/scores/recap/{slug}` | **200** | "DCI Tour Premiere … Full Recap" |
| `/scores/final-scores/{slug}` | **200** | "Official DCI Tour Premiere … Final Scores" |
| `/events/{slug}` | **404** | "Page not found" |

Cross-checked against the slug doc §3 (different probe, 2026-06-11):
`/events/2022-drums-along-the-rockies` → **200**; bare `/events/drums-along-the-rockies`
→ **404**. So recent seasons keep their `/events/` page; older ones lose it. There
is a retention window, not a clean cutoff — treat event-page existence as
**per-slug, time-varying, verify-only**.

Key consequences:
1. **A well-formed prefixed slug does not imply the `/events/` page exists.** 2016
   is a real, correctly-slugged event whose event page is simply gone.
2. **`event_page_scrapes` membership is NOT proof the page still exists** — a page
   we scraped years ago may since have been removed. Verification must re-check
   even previously-scraped slugs.
3. recap ≠ final-scores: both exist and are distinct, so three separate links are
   warranted (not redundant).

---

## The rules we implement

`app/lib/dci-links.ts` → `dciLinks(event, routeSlug, opts?)` returns
`{ event, recap, scores }` (each `string | null`).

- **Link slug** = `event.competition_slug ?? routeSlug`.
- **event** link: rendered **only if** the slug is in the verified allowlist
  `app/lib/dci-verified-event-slugs.json` (live 2xx/3xx). Absent ⇒ hidden (could be
  "removed by DCI" or "not yet verified" — both must not link).
- **recap** link: rendered when we have recap/score data in hand
  (`opts.hasRecap`) **or** `event.recap_released`.
- **scores** link: rendered when we have score data (`opts.hasScores`) **or**
  `event.scores_released`.

### Why the `opts` data-presence override exists

The `recap_released` / `scores_released` flags come from the `competitions` row and
are **stale or unset for many historical events** even when the recap page is live
(this was the 2016 bug — the recap link was wrongly suppressed). The authoritative
signal is "did we load recap/score data for this event," which both pages already
have. We OR it with the released flags so **future** events (no data, flags off)
still don't get dead links.

Callers:
- `past-season-scores.tsx`: `hasRecap = seededFullRecap != null || hasScoreData`,
  `hasScores = hasScoreData` (`hasScoreData = recap.scores.length > 0`).
- `prediction.tsx` (current page): `hasRecap = hasScores = recap.scores.length > 0`.

### UI

`event-season-title.tsx` renders up to three tooltipped icon links next to the H1
(event / judge recap / final scores), each wrapped in `<Show when={dci.x}>` so a
`null` is simply omitted. Note: in this codebase `Show` (from `jotai-solid-api`)
passes the **value** to its child function, not an accessor — matches existing
usage in the same file.

---

## The verifier & the allowlist

`sdk/scripts/verifyEventLinks.ts`:
- Resolves every event's link slug (`COALESCE(m.competition_slug, e.slug)` via
  `event_to_competition`) — mirrors the app.
- Fetches `dci.org/events/{slug}` for each via Browserbase
  (`BROWSERBASE_API_KEY` from `../.env`; note `.env` is CRLF on this machine).
- Caches results in `sdk/event-slug-verification-cache.json`
  (`{ slug: { status, checkedAt } }`); reruns skip cached slugs unless `--recheck`.
- **Does not skip scraped slugs** (they can have been removed since).
- Writes slugs with status `2xx/3xx` to `app/lib/dci-verified-event-slugs.json`
  (the allowlist the UI gates on).

Run (from `sdk/`, needs the 3.5 GB `dci-relational.db` + Browserbase):

```bash
npx tsx scripts/verifyEventLinks.ts            # first run: ~1,100 live fetches
npx tsx scripts/verifyEventLinks.ts --recheck  # re-verify all (catch removed pages)
```

> ⚠️ The big DB would not open under `@libsql/client` in the agent sandbox (hung,
> likely WAL lock), so the full run must happen on a real dev machine. The seed
> allowlist (44 slugs, mostly 2025) was extracted from the pre-existing 55-entry
> cache.

(`scripts/verifyEventSlugs.ts` is the older, narrower verifier — it only checked
the slug-migration candidates and assumed scraped = real. `verifyEventLinks.ts`
supersedes it for link purposes.)

---

## Interim state (as shipped 2026-06-12)

- Allowlist = 44 verified slugs (mostly 2025) ⇒ **event links show only for those**;
  recap + final-scores show for any event with score data, all seasons.
- This is the safe default: no dead `/events/` links. Running `verifyEventLinks.ts`
  expands the allowlist to all current/recent events.

## Open follow-up

- **Read-model home for the allowlist.** Bundling a growing JSON allowlist in the
  client works but isn't ideal. Cleaner long-term: a `dci_event_verified` boolean
  (and/or the verified link slug) as a column in `rm_events`, populated at emit time
  from the verification cache. Needs a `SCHEMA_VERSION` bump + re-emit.
- Consider periodic re-verification (`--recheck`) since `/events/` pages disappear
  over time; the score links don't need it.

---

## Files

- `app/lib/dci-links.ts` — link builder + allowlist gate.
- `app/lib/dci-verified-event-slugs.json` — verified `/events/` allowlist (generated).
- `app/components/prediction/event-season-title.tsx` — renders the three links.
- `app/routes/events/$yearSlug/$slug/prediction.tsx`,
  `app/components/prediction/past-season-scores.tsx` — call sites.
- `sdk/scripts/verifyEventLinks.ts` — verifier + allowlist generator.
- `sdk/event-slug-verification-cache.json` — Browserbase status cache (gitignored
  artifacts live in sdk/; confirm this one's tracking status before relying on it).
