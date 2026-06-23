# `/shows/$slug/$season` page improvements — implementation plan

Status: planned (2026-06-22). Not started. Verified against the codebase.

Target page: `app/routes/shows/$slug.$season.tsx` (the corps-season show detail / wiki page).
Supporting components: `app/components/contrib/{block-sections,uniform-section,image-drop}.tsx`,
`app/components/corps-logo.tsx`. Upload path: `app/lib/server-fns/media.ts` → R2 → `show_media`
→ `app/routes/api/show-media/$id.ts`. Authored block schemas: `app/lib/contrib/schemas.ts`
(Valibot, shared client+server via Formisch + `saveShowBlock`).

The work splits into six independent units (one commit each). Items 1–3 are pure
front-end polish (no data/schema changes). Items 4–6 add new authored data.

---

## 0. Prior art — this page IS the "Show Detail Wiki" (read first)

`sdk/docs/show-detail-wiki-plan.md` is the original (large, rev-2) design that this page
implements: a scraped/contributions **overlay model** (`displayed = override ?? scraped`),
auth-gated wiki editing, per-row repertoire overrides, citations/provenance, yearbook ingestion,
and a free-form concept essay. Our six asks are *polish + completing-the-spec* on top of it, not a
greenfield. Concrete consequences for this plan, pulled from that doc + the post-merge incident
memory:

- **⚠️ Client-bundle `node:fs` leak — the one real landmine (applies to items 3, 5, 6).** Merging
  this feature once **broke the entire site client-side**: a server-only module (`effect`'s
  node-platform code, via `app/lib/contrib/free-form.ts` `import { Schema } from 'effect'`) leaked
  into the **main client chunk**, so every page SSR'd then went blank. **SSR, `curl`, and the
  Coolify `GET /` healthcheck all passed — only a real browser caught it.** Note `free-form.ts`
  *still* runtime-imports `effect` and is pulled by `block-sections.tsx` via the **value** import
  `emptyFreeFormDoc` — so the client graph is already sensitive here. **Rules when touching the
  contrib client components:** (a) import any server-only module **type-only**; (b) keep new schema
  work in `schemas.ts` (Valibot — client-safe), never add `effect` Schema imports to client paths;
  (c) **before any deploy, verify the bundle:** `vite build` then
  `grep -rl "node:fs\|node:path" .output/public/assets/ | grep -i main` must be EMPTY, and headless-
  load a page to confirm cards render with no `pageerror`. Typecheck + unit tests do NOT catch this.

- **Items 5 & 6 are *completing the original spec*, not inventing.** The wiki plan §7.1 already
  defines `uniform` as `{colors[], description, announcementUrl, images[]}` and a `media` pinned
  block carrying `cover/clip/photo`; `show_media.kind` already includes `'cover'` (§8). The shipped
  `UniformInputSchema` simply dropped `images`, and no cover block was built. So: use the original
  field name **`images`** for uniform photos, and `kind="cover"` for the hero upload — staying
  consistent with the design and the existing `show_media` schema.

- **`saveShowBlock` is fully generic over `BLOCK_SCHEMAS`** (`contrib.ts:161-205`; only `uniform`
  has extra hex-normalization). So a new `cover` block needs **only** a `CoverInputSchema` added to
  the `BLOCK_SCHEMAS` registry in `schemas.ts` — the server re-parse (`v.parse`), auth chokepoint,
  lazy page-create, revision write, and optimistic-concurrency token all come for free. Extending
  `UniformInputSchema` likewise auto-validates server-side. No `contrib.ts` handler change needed.

- **Concept duplication (item 2) is partly by-design but still redundant.** The plan distinguishes
  `symbolism` (a short *structured* note block) from the free-form `about`/"concept" *essay*. They
  ended up looking like the same thing to users. Collapsing to the richer free-form "The concept"
  is the right call; just keep the `symbolism` key in the registry so existing rows aren't orphaned
  (as already stated in item 2).

- **Repertoire is a seedable per-row overlay with citations + provenance badges** (per-title natural
  key, divergence banners, yearbook authority). Item 4 is **render-only** (derived search/DCX URLs)
  — it must sit *alongside* the existing override/citation/badge rendering and not disturb it.
  (Note: the plan even anticipated per-row `listenLinks[]` as authored data — our auto-generated
  search links are the zero-effort complement to that, not a conflict.)

- **Citations already exist on the page** (`ReferencesSection`, `listCitations`), so DCX/streaming
  links in item 4 are *navigation aids*, not citations — don't conflate them with the references system.

---

## 1. Header: shrink the mobile logo + reorder eyebrow under the title

**Problem.** `CorpsLogo` is rendered at a fixed `width={72}` (`$slug.$season.tsx:116`), which
is too large on mobile. The eyebrow (`{corps.name} · {season}`) sits **above** the `<h1>`
(`:117-126`); product wants the title first, eyebrow beneath it.

**Fix (presentational only, lines 115–127):**
- Make the logo responsive: render smaller on mobile, current size on ≥sm. `CorpsLogo`'s
  `width` prop drives the resized image variant + 2x srcset, so pass a smaller width AND cap
  the tile with classes. Simplest: keep `width={72}` (so the 2x asset is still crisp) but
  constrain the rendered tile via `className="size-12 sm:size-[72px]"` — the inner
  `ProgressiveImage` is `h-full w-full object-contain`, so the box size wins. (Confirm
  `CorpsLogo` forwards `className` to the outer tile — it does, `corps-logo.tsx:81-85`.)
- Reorder the identity block so the `<h1>` is first and the eyebrow follows the
  title/subtitle/tagline. New order inside the `min-w-0` column:
  1. `<h1>` (`show.title`)
  2. subtitle (`<Show when={show.subtitle}>`)
  3. tagline (`<Show when={show.tagline}>`)
  4. eyebrow `<p class="text-xs uppercase tracking-wide text-text-secondary">{corps.name} · {show.season}</p>`
- Keep the `flex-col sm:flex-row sm:items-center` wrapper; on mobile the smaller logo sits
  above the stacked text, which reads cleanly. Consider `sm:items-start` so a tall text block
  top-aligns with the logo.

No new deps, no data change. Verify on mobile width (≤375px) that the logo is ~48px and the
title leads.

---

## 2. Concept appears twice — collapse to one section

**Problem.** Two sections cover the same ground:
- `AboutSection` — title **"The concept"**, a rich free-form (Lexical) essay, pinned key `about`
  (`block-sections.tsx:478`).
- `SymbolismSection` — title **"Concept & symbolism"**, a plain `<textarea>`, pinned key
  `symbolism` (`block-sections.tsx:327`).

These are redundant. Keep the richer free-form **"The concept"** (`AboutSection`) and **remove
the `SymbolismSection`** from the page.

**Fix:**
- In `$slug.$season.tsx`, delete the `<SymbolismSection .../>` render (`:296-300`) and its import
  (`:11`). Drop `symbolism` from the `authored` map (`:68`) and the `SymbolismInput` import (`:22`).
- Leave `SymbolismInputSchema`/`symbolism` in `schemas.ts` `BLOCK_SCHEMAS` and the
  `SymbolismSection`/`SymbolismEditor` code in place but unexported-from-page (or delete them) —
  **do not** delete the `symbolism` row from the DB / `saveShowBlock` registry, so any already-
  authored symbolism content isn't orphaned at the data layer.
- **Migration nicety (optional):** if a page has `symbolism` content but no `about` content, the
  loader could fold the symbolism text into the concept view as a fallback paragraph so existing
  contributions still surface. Decide at build time; low priority (few/no rows in prod).
- Rename consideration: "The concept" is the right single label. If product prefers
  "Concept & symbolism" as the surviving title, just rename `AboutSection`'s `title` prop.

---

## 3. Restyle all forms/inputs to match the site theme

**Problem.** Every editor uses a bare recipe
`const inputCls = 'w-full rounded border border-border bg-transparent px-2 py-1 text-sm'`
(duplicated in `block-sections.tsx:29` and `uniform-section.tsx:10`) plus hand-rolled
`<button>`s and `✕` glyphs. They look unfinished and don't match the ReUI/shadcn `base-nova`
chrome used elsewhere (e.g. the prediction page).

**Fix — adopt the shared UI primitives** (already installed: `app/components/ui/{input,label,
button,button-group}.tsx`; add `textarea` via the shadcn registry — see AGENTS.md install note):
- Add `Textarea` to `app/components/ui/` (`npx shadcn@latest add textarea --yes`, then move into
  `app/components/ui/` per the install-path gotcha).
- Replace raw `<input className={inputCls}>` with `<Input>`, `<textarea>` with `<Textarea>`,
  and the save/add/remove `<button>`s with `<Button variant=…>` (`default` for Save, `outline`/
  `ghost` for "+ Add", `ghost` icon button for remove — note ReUI `Button` has no `primary`
  variant; `default` is the filled one).
- Replace the `✕` text removers with a proper icon button: `<Button variant="ghost" size="icon">`
  + a delete/close Hugeicon (e.g. `restore-bin` already generated, or add a `cancel-01`/`multiplication-sign`).
- Use `<Label>` for field labels instead of relying solely on placeholders — improves a11y and
  looks intentional. Keep placeholders as hints.
- **Centralize:** delete both copies of `inputCls`; the styling now lives in the `ui/*` components.
  Field-level error text (`text-red-500`) should move to the destructive token
  (`text-destructive`) for theme consistency.
- The Formisch wiring (`useForm`/`Field`/`FieldArray`/`insert`/`remove`) stays exactly the same —
  only the rendered element swaps. `<Input value=… onChange=…>` is a drop-in for `<input>`.
- Touch points: `PropsEditor`, `LinksEditor`, `SymbolismEditor` (if kept), `GalleryEditor`,
  `AboutEditor` save button, and `UniformEditor` — plus the color `<input type="color">` which can
  keep its native control but get a nicer wrapper/`Label`.

This is mechanical but broad; do it as one focused commit and eyeball each editor.

---

## 4. Repertoire: streaming + DCX museum icon links per song

**Goal.** For each repertoire row, show small icon links to search the work on Spotify, Apple
Music, and YouTube, plus a link into the DCX Museum.

**Streaming services — there is no per-track deep link without an API lookup, so use the public
search URLs** (the standard, no-auth approach; opens a pre-filled search):
- Spotify:    `https://open.spotify.com/search/<encoded query>`
- Apple Music: `https://music.apple.com/us/search?term=<encoded query>`
- YouTube:    `https://www.youtube.com/results?search_query=<encoded query>`

Query = `\`${piece.workTitle} ${piece.composer ?? ''}\`.trim()` (composer improves hit quality;
arranger usually hurts it for streaming). Add a tiny pure helper `app/lib/music-search.ts`:
```ts
export const musicSearchLinks = (workTitle: string, composer?: string | null) => {
  const q = encodeURIComponent([workTitle, composer].filter(Boolean).join(' '));
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    appleMusic: `https://music.apple.com/us/search?term=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
};
```
Render a row of icon links under each piece (after the credit/notes), each
`<a target="_blank" rel="noreferrer">` wrapping `<Icon icon={…} size="sm">`. Icons: `YoutubeIcon`
is already generated. **VERIFIED icon path:** the icon set is **self-syncing** — just
`import { SpotifyIcon, AppleMusicIcon, YoutubeIcon } from '@/components/icons/generated'` in the
component, then run `npm run gen:icons` (`scripts/preload-icons.mjs`). The script scans `app/` for
generated-barrel imports, resolves `SpotifyIcon`→`spotify` and `AppleMusicIcon`→`apple-music`
(both confirmed present in `@iconify-json/hugeicons`), writes the `.tsx` + barrel, and prunes
unused. **Do NOT** hand-edit `generated/` or use `~icons/hugeicons/*` (that runtime path was
removed). Keep the existing `piece.hyperlink` link on the title as-is.

**DCX Museum link.** The corps record already carries `corps.dcx_museum_url`
(`readModel/builders/corps.ts:56`; used on the corps page at `$slug.{-$season}.tsx:190`). The DCX
corps-detail URL embeds the numeric corps id (`...corpsid=<N>`), and per the DCX scraper doc
(`sdk/docs/dcx-scraper.md` §2) the richest per-season view is
`Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=<N>&CorpsYear=<season>` (show title + composers +
placement). Plan:
- Pass `corps.dcx_museum_url` into the page (already in the loader's `corps`).
- Parse the corps id out of it (`/corpsid=(\d+)/i`; **verified** real values look like
  `https://www.dcxmuseum.org/index.cfm?view=corpslist&CorpsID=1790`); if present, build a **single per-section
  "View this corps' <season> repertoire in the DCX Museum"** link to the `RepYear` page (one link
  for the whole Repertoire card is cleaner than one per song, since DCX song search is fuzzy).
  Helper `dcxRepYearUrl(dcxMuseumUrl, season)` returning `null` when no id is found.
- Per-song DCX search (`index.cfm?view=search&song=<title>`) is possible but noisy; prefer the
  per-section RepYear link. Mention both; ship the section-level one.
- Gate all of this on the id being parseable — many corps have a null `dcx_museum_url`.

No schema/data change — all derived from existing fields at render time.

---

## 5. Cover image upload (hero for the show)

**Goal.** Let signed-in contributors upload a cover image shown as a hero/banner at the top of
the page.

**Approach — a new single-image authored block** (mirrors the gallery pattern, reuses the whole
upload pipeline):
- Schema: add `CoverInputSchema = v.object({ image: v.optional(MediaItem) })` (or `{ url, alt,
  width, height }`) to `app/lib/contrib/schemas.ts` and register `cover` in `BLOCK_SCHEMAS`.
- Upload: reuse `ImageDrop` with `kind="cover"` → `uploadShowMedia` (already generic over `kind`,
  `media.ts:32`) → R2 → `show_media` → served at `/api/show-media/$id`. No server changes needed.
- Component: a `CoverSection` (new, in `block-sections.tsx` or its own file) — but rendered at the
  **top** of the page, not in the section stack. The editor is a single `ImageDrop` + Save;
  the view is a full-width `ProgressiveImage` (e.g. `aspect-[16/9]` or `aspect-[21/9]`,
  `fit="cover"`, rounded) sitting above/behind the identity header.
- Loader: add `cover: blockContent<CoverInput>('cover')` to the `authored` map and thread it into
  the page. When present, render the hero; when absent + signed-in, show the dashed
  "Add a cover image" affordance (reuse `ContribBlock` chrome or a slim variant); when absent +
  signed-out, render nothing (don't show an empty hero).
- Nice touch: overlay the identity header (logo + title) on a subtle gradient scrim over the cover
  when one exists, falling back to the current plain header when it doesn't. Keep this optional/
  second-pass to avoid over-scoping.

**Decision to confirm with product:** standalone `cover` block (recommended, clean) vs. reusing
`gallery.items[0]`. Recommend the dedicated block — clearer intent, independent edit.

---

## 6. Uniform photos

**Goal.** Add a photo-upload area to the Uniform section (currently colors + description +
announcement URL only).

**Fix:**
- Schema: extend `UniformInputSchema` with **`images: v.optional(v.array(MediaItem), [])`**
  (`schemas.ts:17`) — use the original-spec field name `images` (wiki plan §7.1), not `images`.
  Backward compatible — existing rows decode with `images: []`, and the server re-parse via
  `BLOCK_SCHEMAS['uniform']` picks it up automatically (no `contrib.ts` change).
- `UniformEditor` (`uniform-section.tsx:121`): add an uploads area below the description, modeled
  exactly on `GalleryEditor` (`block-sections.tsx:418`): a grid of current photos each with a
  remove button + an `ImageDrop kind="uniform"` that appends `{url,alt,width,height}`. Since
  Formisch drives this form, either (a) manage `images` as a `FieldArray` and push uploaded refs
  via `insert`, or (b) lift images to local `useState` like `GalleryEditor` does and merge into the
  submitted `content`. Option (b) matches the existing gallery code and is simpler — follow it.
- `UniformView` (`:88`): render the photos as a thumbnail grid (reuse the gallery view markup —
  `grid grid-cols-2 sm:grid-cols-3`, `ProgressiveImage` `fit="cover"`, ring) above or below the
  colors/description.
- `hasContent` (`:31`) gains `|| value.images?.length`.

Reuses the existing upload pipeline end-to-end; only the schema + Uniform component change.

---

## Cross-cutting notes
- **Auth/upload already works** — `uploadShowMedia` is capability-gated and EXIF-stripped; cover &
  uniform photos ride the same path as the gallery, so no new server-fns or R2 wiring.
- **Read-model:** items 1–3 are app-only. Items 4 is render-derived (no emit). Items 5–6 store data
  in the **contributions DB** (`show_media` + authored blocks via `saveShowBlock`), NOT the
  read-model/relational DB — so no `emitReadModel`/`SCHEMA_VERSION` bump is involved.
- **Commit per unit.** Suggested order: 2 (delete dup) → 1 (header) → 3 (form restyle) → 4
  (rep links) → 6 (uniform photos) → 5 (cover hero). 3 and 5 are the largest.
- **Verify** each on `dev.drumcorps.app` (push to `dev`) — the user confirms UI themselves; don't
  auto-launch a browser.

## Open questions for product
- Cover image: dedicated `cover` block (recommended) or first gallery image?
- Keep the surviving concept section titled "The concept" or "Concept & symbolism"?
- Streaming links: search-URL approach is the only no-API option — acceptable? (A real
  Spotify/Apple deep link would need a backend track-resolution step + API keys; out of scope.)
- DCX per-section RepYear link (recommended) vs. per-song search links?
