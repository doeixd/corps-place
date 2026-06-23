# Show Detail Wiki (`contrib`) — Migrate to Effect Services + XState

Status: **DRAFT for review** · Created: 2026-06-23 · Owner: TBD
**Revisions:**
- 2026-06-23: v2 — added multi-uniform sections (brass/percussion/guard with carousel), props image uploads, optimistic real-time edit history via TanStack DB + XState + React 19
- 2026-06-23: v3 — added "Concept" section (short, before repertoire), "About the Show" section with guided questions template, and user-friendly structured diffs in the history panel
- 2026-06-23: v4 — added expandable lineup rows with mini show preview (uniform image + concept excerpt), and SEO sitemap + dynamic tags for all show pages

Migrates the Show Detail Wiki (the `contrib` subsystem) from its current
`createServerFn` + raw `@libsql/client` + `useState`/`try-catch` shape to the
codebase's blessed architecture (AGENTS.md):

- **Server:** Effect Services/Layers over an `effect/unstable/sql` `SqlClient`,
  exposed via an Effect **RPC** group, with `Schema.TaggedErrorClass` domain
  errors. `createServerFn` is **retained** as the thin SSR/action boundary that
  `Effect.runPromise`s the service — never deleted (see AGENTS.md "createServerFn
  is a RETAINED boundary").
- **Client:** edit/save/error/optimistic state moves into **XState v5 machines**
  whose actors call the server-fns/RPC. Components become dumb (render from
  `snapshot`, `send` events).
- **Forms stay as-is:** **Valibot + Formisch** remain the form layer (the user's
  explicit decision) — they sit *inside* the XState actors and the server-fn
  `.validator`, not replaced by Effect Schema.
- **TanStack DB:** evaluated and **deferred** (see §6) — the wiki has no
  cross-client liveness or large shared index that would justify a collection.
  The SSR loader + optimistic XState update covers every current need. This is
  the "(if needed)" branch resolving to *not needed yet*.

This is a re-architecture of **working code**, so it is a **strangler migration,
one server-fn / one section at a time**, each step behavior-preserving. Unlike
Fantasy there is **no feature flag** to hide behind, so correctness is gated on
keeping each migrated handler byte-compatible with its predecessor (same inputs,
same outputs, same thrown→surfaced errors) and on the existing route rendering
unchanged.

> This plan is the sibling of
> [`FANTASY_EFFECT_TANSTACKDB_MIGRATION_PLAN.md`](./FANTASY_EFFECT_TANSTACKDB_MIGRATION_PLAN.md).
> Where a pattern is identical (Service shape, RPC wiring, v4 deltas, the
> `createServerFn`-retention rationale) this plan points there instead of
> repeating it. Read §0.5 of that plan first.

---

## 0. TL;DR

- Wrap `contributions.db` in a **`ContributionsSql` `SqlClient` layer**
  (`effect/unstable/sql`), mirroring the SDK's Effect+SQL convention and the
  Fantasy plan's `SqlClient` over the same file.
- Move the data core (`app/lib/contrib/store.ts`) into a **`ContributionsService`**
  (`app/lib/contrib/contributions-service.ts`): `ensureShowPage`, `writeBlock`,
  `writeOverride`, `readShowPageContributions`, `listRevisions`, plus the
  citations/media writes folded in (or split into `CitationsService` /
  `MediaService` — see §3). Keep the pure helpers (id, hashing, the
  override-vs-scrape merge) as framework-agnostic functions the service calls.
- Replace the hand-rolled `StaleWriteError` / `DurableStorageUnavailableError`
  `Error` subclasses (which fake a `_tag`) with real **`Schema.TaggedErrorClass`**
  domain errors + `catchTag`. This is the single biggest correctness win — the
  optimistic-concurrency 409 (`StaleWriteError`) becomes a typed channel instead
  of a string-matched `Error`.
- Express the writes as an **Effect RPC group** (`app/rpc/contrib-rpc.ts`) merged
  into `AppLive` (`app/rpc/index.ts`); the existing `createServerFn`s
  (`saveShowBlock`, `revertRevision`, `createCitation`, `uploadShowMedia`) become
  thin `Effect.runPromise(provideAppLive(...))` shims. The `authorize()`/
  `requireCapability` chokepoint (I-12) stays at the boundary, in front of the
  Effect program.
- Give each editable section a **machine** (`app/machines/contrib-section-machine.ts`,
  parameterized per block) modelling `viewing → editing → saving → (saved|error)`
  with optimistic apply + rollback, seeded from the loader's `initial` prop. The
  9 editor components stop owning `editing`/`value`/`error`/`saving` `useState`.
- **Valibot + Formisch stay.** The Formisch form lives inside the machine's
  `editing` state; on submit the validated Valibot output is sent as a `SAVE`
  event; the actor calls the server-fn. No Effect Schema in the form layer.
- **Add a "Concept" section (§3.7):** a short, sweet authored block placed before repertoire. Uses a constrained Lexical editor (inline marks only, 5 KB limit) so contributors can write a quick show summary.
- **Revamp the "About the Show" section (§3.8):** the existing `about` block gets a guided template with prompting questions (movement count, movement names, things to look out for, symbolism, etc.) shown above the Lexical editor. No schema change — the template lives in the editor UI only.
- **User-friendly history diffs (§3.9):** replace the raw JSON `before`/`after` display with structured, per-block-type diff renderers. Store `pinned_key` on each revision so the panel can show semantic changes ("Colors changed from #AABBCC to #DDEEFF", "Added 2 prop items", etc.) instead of truncated JSON.
- **Expandable lineup rows with mini show preview (§3.10):** each row in `LineupSchedule` and similar lineup tables becomes expandable. When expanded, a lazy-fetched mini preview shows the uniform image (first from the uniform block), concept text excerpt, corps name + show title, and a link to the full show page. A batch server function `getShowPreviews` fetches authored preview data for all visible rows in one round-trip.
- **SEO sitemap + dynamic tags for shows (§3.11):** add all `/shows/$slug/$season` URLs to the sitemap via a new `getAllShows` read-model reader. Update the show page's `head()` to prefer authored content (concept text for meta description, uniform image for og:image) over scraped fallbacks.
- **Delete the dead second editor:** `TiptapFreeForm` + the `'tiptap'`/`'editorjs'`
  branches of `FreeFormDoc.format` are only reachable from `routes/dev/
  free-form-spike.tsx`. Production uses `LexicalFreeForm` only. Drop them (or
  finish the abstraction) so the `format` union matches reality.
- **Build the Lexical editor out from a spike into a real editor (§4.5).** Today it
  is a barebones `RichTextPlugin` with **no toolbar**, keyboard-only marks, and
  only `Heading`/`Quote` nodes — still namespaced `'free-form-spike'`. Add a
  **toolbar**, **lists**, **links**, **markdown shortcuts**, a **code block**, and
  the project's **custom blocks** (callout / show-media embed), each extended in
  **lockstep** with the security allowlist renderer (`lexical-render.tsx`, I-14).
  This is its own workstream and can land in parallel with the Effect/XState work.
- **Multi-uniform sections:** Replace the single flat uniform block with
  per-section (brass/percussion/guard) uniforms, each with its own colors,
  description, announcement URL, and an image carousel. Preserved as one
  `pinnedKey: 'uniform'` block with a `sections[]` array in the schema.
- **Props image uploads:** Extend each prop item with an `images: MediaItem[]`
  field, leveraging the existing `ImageDrop` + `uploadShowMedia` pipeline.
- **Optimistic real-time edit history (§6):** Retract the "TanStack DB deferred"
  decision for the history panel. History becomes a **TanStack DB collection**
  fed from the SSR initial payload, with new revisions appended optimistically
  (React 19 `useOptimistic`) on every save/revert and periodically reconciled
  with the server. The history-panel XState machine owns paging/loading/error.
- **UX polish and design integration (§4.6):** eliminate prototype-isms across
  the entire wiki — unified section shell, animated view/edit transitions,
  save confirmation badges, redesigned empty states, mobile form layouts,
  authored-content badges, and a history panel visual refresh. 10 milestones
  (M21–M30) that make the wiki feel native to the site.

---

## 1. Current state (inventory — verified in-repo)

**Server (all raw `@libsql/client` via `getContributionsDb()`):**

| File | Surface | Notes |
|---|---|---|
| `app/lib/contributions-db.ts` | `getContributionsDb()`, `durableStorageStatus()` | Long-lived client + PRAGMA/DDL (mirrors `media-cache.ts`). Keep the bootstrap; wrap it in a `SqlClient` layer. |
| `app/lib/contrib/store.ts` | `readShowPageContributions`, `listRevisions`, `ensureShowPage`, `writeOverride`, `writeBlock` + `StaleWriteError`, `DurableStorageUnavailableError` | Plain `async` fns taking `Client`/`Transaction`; single-tx row+revision (I-6); optimistic concurrency via `expectedUpdatedAt`. **The core to wrap.** |
| `app/lib/contrib/schemas.ts` | `UniformInputSchema`, `PropsInputSchema`, `BLOCK_SCHEMAS` registry | **Schema changes ahead (§3.5–3.6):** `UniformInputSchema` gains per-section brass/percussion/guard; `PropsInputSchema` gains image attachments per item. |
| `app/lib/server-fns/contrib.ts` | `getShowContributions`, `getShowHistory` (reads); `saveShowBlock`, `revertRevision` (writes) | 11 inline `db.execute` calls + auth + normalization **in the handlers** — the chief AGENTS.md violation. `normalizeHex` will need updating for multi-uniform. |
| `app/lib/server-fns/citations.ts` | `listCitations`, `createCitation` (+ a helper) | Inline SQL. |
| `app/lib/server-fns/media.ts` | `uploadShowMedia` | Inline SQL + R2 `putUpload`/`uploadKey`. |
| `app/routes/api/show-media/$id.ts` | GET serve by `media_id` | R2 `getUpload`; leave as a route, optionally back it with `MediaService`. |
| `app/lib/authz.ts` | `requireCapability` (I-12 chokepoint) | **Keep at the boundary**, unchanged. |

**⚠️ Dead code — `symbolism` pinned key is registered but unwired.** The `SymbolismSection` component and `SymbolismInputSchema` exist in `block-sections.tsx` and `schemas.ts`, and `BLOCK_SCHEMAS` accepts `'symbolism'`, but the show page route (`$slug.$season.tsx`) does **not** extract a `symbolism` authored block and does **not** render the component. It is reachable via direct server-fn call but invisible to visitors. This plan repurposes it as the new `concept` section (§3.7).

**⚠️ History diffs are raw JSON.** The history panel shows `before_json` / `after_json` as truncated, color-coded JSON strings. Users cannot meaningfully read these — a structured diff per block type is needed (§3.9).

**⚠️ About section has no editorial guidance.** The `about` Lexical editor opens a blank composer — contributors receive no prompts or template to guide their writing. The empty hint ("Tell the story of this show — the concept, the journey, what it all means.") is the only guidance. A structured question template above the editor (§3.8) will reduce blank/one-sentence saves.

**Client (edit state in `useState` + `async`/`try-catch` — the XState targets):**

| Component | `useState` | async/try | Migrate to a section machine? |
|---|---|---|---:|---:|---|
| `block-sections.tsx` (Props/Links/Gallery/About) | 16 | 10 | **Yes** — 4 sections, the bulk |
| `staff-section.tsx` | 7 | 4 | Yes |
| `cover-section.tsx` | 6 | 2 | Yes |
| `uniform-section.tsx` | 5 | 3 | Yes |
| `media-section.tsx` | 5 | 3 | Yes |
| `references-section.tsx` | 5 | 3 | Yes |
| `history-panel.tsx` | 4 | 4 | Yes (revert action + paging) |
| `image-drop.tsx` | 3 | 2 | Upload sub-machine or `useActionState` |
| `lexical-free-form.tsx` / `tiptap-free-form.tsx` | 0 | 0 | No (controlled inputs); tiptap is **dead — delete** |

**Read path (already idiomatic — do NOT change):** `routes/shows/$slug.$season.tsx`
loads everything in its `loader` (SSR), seeds `initial` props, renders with
`<Show>`/`<For>`. Keep it; only swap the server-fns it calls for the thin Effect
shims (same signatures, so the route is untouched).

---

## 2. Target architecture

```
routes/shows/$slug.$season.tsx        (unchanged: loader → initial props)
  │  loader calls ↓ (same names/signatures)
app/lib/server-fns/contrib.ts         createServerFn shim → runPromise(provideAppLive(program))
  │                                     + requireCapability() chokepoint stays here
app/rpc/contrib-rpc.ts                ContribRpc group (writes) → ContribRpcLive
  │
app/lib/contrib/contributions-service.ts   ContributionsService (Context.Service)
  ├─ pure helpers (merge, ids, hashing) — unchanged, called by the service
  └─ uses ↓
app/lib/contrib/contributions-sql.ts  ContributionsSql (SqlClient layer over contributions.db)

Client:
section components (dumb) ── send/snapshot ──▶ contrib-section-machine (XState)
                                                  └─ actor (fromPromise) → server-fn → RPC
  Formisch+Valibot form lives in the machine's `editing` state (kept)
```

Registration: append `ContributionsServiceLive` (+ `CitationsServiceLive`,
`MediaServiceLive` if split) and `ContribRpcLive` into `AppLive` in
`app/rpc/index.ts`, exactly as the Fantasy services were appended.

---

## 3. Server milestones (strangler, behavior-preserving)

Each milestone migrates one slice and keeps its server-fn signature identical.
After each, `npm run check` is clean and the show page renders unchanged.

- **M1 — `ContributionsSql` layer.** New `app/lib/contrib/contributions-sql.ts`:
  a `SqlClient` over `contributions.db`, reusing `getContributionsDb`'s URL +
  PRAGMA/DDL bootstrap (don't duplicate the DDL — call the existing init, or move
  it behind the layer's acquire). Self-contained `Layer` (provides its own client)
  like the Fantasy SQL layer. No behavior change yet.

- **M2 — Domain errors.** New `app/lib/contrib/errors.ts` with
  `Schema.TaggedErrorClass`: `StaleWriteError` (carries `current: string | null`),
  `DurableStorageUnavailableError` (carries `reason`), `ContributionsDataError`
  (generic read/write failure), `RevisionNotFoundError`, `BlockNotFoundError`,
  `UnknownPinnedKeyError`. Delete the two `Error` subclasses in `store.ts`. Map
  them to HTTP at the boundary (`StaleWriteError` → 409, `Durable…` → 503,
  `Unknown…`/`…NotFound` → 400/404) via `catchTags` in the shim.

- **M3 — `ContributionsService`.** Port `store.ts` into
  `app/lib/contrib/contributions-service.ts` as a `Context.Service` whose methods
  (`ensureShowPage`, `writeBlock`, `writeOverride`, `readShowPageContributions`,
  `listRevisions`, `revertRevision`) are `Effect.fn("ContributionsService.…")`.
  The single-transaction row+revision (I-6) becomes one `sql.withTransaction`
  Effect; `expectedUpdatedAt` precondition fails with `StaleWriteError`. Keep the
  pure merge/id helpers as plain functions. `durableStorageStatus()` becomes a
  pre-write `Effect` that fails `DurableStorageUnavailableError` (I-7, fail-closed).

- **M4 — Reads through the service.** Repoint `getShowContributions` /
  `getShowHistory` handlers to `runPromise(provideAppLive(service.read…))`. Reads
  are public (no auth). Verify the loader payload is identical
  (`PageContributions`, `HistoryEntry[]` shapes unchanged).

- **M5 — Writes through RPC.** New `app/rpc/contrib-rpc.ts`: `RpcGroup.make` with
  `saveBlock`, `revertRevision` (+ `createCitation`, `uploadMedia` if not split),
  each `{ success, error: <tagged union> }`. `ContribRpc.toLayer(...)` =
  `ContribRpcLive`. The `saveShowBlock`/`revertRevision` server-fns keep their
  `.validator` (Valibot `decodeInput` / the block `BLOCK_SCHEMAS` re-parse —
  **never trust the client**, §6.6 unchanged) and `requireCapability` call, then
  delegate to the RPC handler. Move the inline `normalizeHex`/uniform
  normalization into the service.

- **M6 — Citations + Media.** Fold `citations.ts` and `media.ts` SQL into
  `ContributionsService` (or `CitationsService` / `MediaService` — prefer split if
  it keeps services small; Fantasy split per concern). `uploadShowMedia` keeps R2
  `putUpload`/`uploadKey` at the boundary (I/O), records the row through the
  service. `routes/api/show-media/$id.ts` may stay raw or read via the service —
  low value, decide during M6.

- **M7 — Register + delete dead code.** Wire all `*Live` into `AppLive`; remove
  `store.ts` once nothing imports it; delete `TiptapFreeForm`,
  `routes/dev/free-form-spike.tsx`, and narrow `FreeFormDoc.format` to `'lexical'`
  (keep the envelope's `format` tag for forward-compat, but only the reachable
  literal). Update AGENTS.md's "show wiki" note if one exists.

**v4 deltas to honor** (see Fantasy plan §0.5): `effect/unstable/sql`,
`effect/unstable/rpc`, `Schema.TaggedErrorClass`, `SchemaParser.decodeUnknownEffect`,
`Effect.catch`/`catchTag(s)`, `Effect.log` (not `console.log`), `Context.Service`
(no `.Default`/`dependencies:`), `Layer.provide([…Live])`, `sql<Row>` returns
`Row[]`. `runPromise` only at the boundary.

---

## 3.5 Multi-uniform schema — sections for brass/percussion/guard with carousel

The current `UniformInputSchema` is a flat block: one set of colors, one
description, one announcement URL, one image grid. Show uniforms vary by
section (brass vs percussion vs guard) and each section may have its own
colors, photos, and design details. The data model must represent this without
breaking existing persisted blocks (strangler-friendly).

**Design decision — single block with nested sections, not multiple pinned keys.**
Using `pinnedKey: 'uniform-brass' | 'uniform-percussion' | 'uniform-guard'`
would require 3× the blocks, 3× the revision events, and 3× the editor
components for what is one conceptual "uniform block." A single `pinnedKey:
'uniform'` with a `sections[]` array keeps the block-count flat, preserves
the existing route loader's `blockContent<UniformInput>('uniform')` call
(only the type widens), and lets the editor manage section tabs inside one
Formisch form. Sections are ordered; brass first by convention.

**New schema (in `app/lib/contrib/schemas.ts`):**

```typescript
const UniformSectionSchema = v.object({
  label: v.picklist(['brass', 'percussion', 'guard']),  // strict union
  colors: v.array(UniformColor),
  description: v.optional(v.string(), ''),
  announcementUrl: v.optional(v.string(), ''),
  images: v.optional(v.array(MediaItem), []),
});

// Replace the existing UniformInputSchema:
const UniformInputSchema = v.object({
  sections: v.array(UniformSectionSchema),
});
```

**Backward compatibility — cold-start migration.** Already-persisted blocks
have `content_json` shaped as the old `{ colors, description, announcementUrl,
images }`. On read, the service checks whether the JSON has a `sections` key.
If it doesn't, it wraps the legacy shape into a single section
`{ label: 'brass', ...legacy }` before handing it to the component — the
view/edit path always deals with the new shape. On the next write, the new
sections structure is persisted. This is a one-time adapter, deleted after the
migration window closes (M7).

**Carousel component (shared, `app/components/contrib/uniform-carousel.tsx`).**
Each section's `images[]` render in a lightweight carousel using
`motion/react` `AnimatePresence` + `layout` for slide/fade transitions.
The carousel:
- Shows one image at a time with prev/next arrows (Hugeicons `chevron-left`/`-right`).
- Displays dot indicators for total count + current position.
- Swipe gesture on mobile (`onPan` or a lightweight gesture wrapper).
- Falls back to a static 2-col grid when `images.length <= 2` (no carousel
  needed for 1–2 images — simpler UX).
- Accepts `images: MediaItem[]` and an optional `onReorder` for drag-to-reorder
  in edit mode (via `@dnd-kit/sortable`).

**Edit mode — section tabs.** The uniform editor becomes a tabbed form:
one `UniformSectionEditor` per section (brass / percussion / guard), each with
its own colors array, description, announcement URL, and an `ImageDrop` grid.
Tabs use the existing UI pattern from the score-table toggles (ghost buttons
with active underline). A `+ Add Section` button adds a new section (defaults
to `label: 'brass'` with the other fields empty; the user changes the label
after creation). Remove is allowed only when >1 section exists (trashed with
confirmation — sections have no separate DB persistence, so removal is a
block-level edit).

**View mode — section tabs + carousel.** The read-only view renders section
tabs (same UI) and beneath them the carousel for that section's images, plus
the color swatches and description. Tab state is local (no URL sync — the
viewer is unlikely to share a tab selection).

**No new pinned keys, no new DB tables.** Everything flows through the existing
`show_blocks` row with `pinnedKey: 'uniform'`. The revision `after_json`
contains the new `{ sections: [...] }` shape. The migration adapter on read is
the only bridge.

**Milestones:**

- **M3b — Schema types + backward-compat adapter.** Update `schemas.ts` with
  the new `UniformSectionSchema` and `UniformInputSchema`. Add the read-path
  adapter in `store.ts` (or the new service in M3) that wraps legacy flat
  `content.json` into `{ sections: [{ label: 'brass', ... }] }`. No behavior
  change to the editor yet.
- **M9b — Tabbed uniform editor.** Rewrite `uniform-section.tsx`: replace the
  single-section editor with the tabbed sections + carousel. The `ContribBlock`
  wrapper stays; the internal form is new. The section machine (M8) drives
  save/error/revert as before.
- **M9c — Uniform carousel component.** Implement `uniform-carousel.tsx`
  (emit in parallel with M9b). Wire into the uniform view mode.
- **M9d — Migrate persisted data.** After M7 (dead code removed), delete the
  backward-compat adapter. All persisted blocks should now be in the new shape.
  Any block still in the legacy shape is treated as a single-section block.

---

## 3.6 Props image uploads — per-item media attachments

The current `PropsInputSchema` stores items as `{ name, description }` with
no image support. Props are physical staging elements (platforms, props, set
pieces) — contributors need to illustrate them with photos, just like the
uniform section does.

**Schema change (in `app/lib/contrib/schemas.ts`):**

```typescript
const PropsItemInput = v.object({
  name: v.string([v.minLength(1)]),
  description: v.optional(v.string(), ''),
  images: v.optional(v.array(MediaItem), []),   // ADDED
});

// PropsInputSchema stays the same shape at the top level:
const PropsInputSchema = v.object({
  items: v.array(PropsItemInput),   // ← widened Item type
});
```

**Upload pipeline — reused, not rebuilt.** The existing `ImageDrop` +
`uploadShowMedia` flow (sharp re-encode → R2 → `show_media` record) handles
prop images without changes. Each prop item's `images[]` references upload
results (`{ url, alt, width, height }`), just like the uniform section does.
The server-fn re-parse (Valibot `BLOCK_SCHEMAS` re-validation) already catches
malformed `MediaItem` entries — no new attack surface.

**Editor changes.** Each prop row in `PropsEditor` gains a small `ImageDrop`
inline zone below the name/description fields (collapsed by default, expand
with a "Add photo" button). Images display as a horizontal thumbnail strip
next to the prop item, with an `×` remove button per image. The strip uses
the existing thumbnail styling from `uniform-section.tsx`.

**View changes.** Each prop item renders its images as a compact thumbnail
strip (or static grid for >3 images). Clicking a thumbnail opens the
`ImageLightbox` (reuse or compose a simple modal from Motion's `AnimatePresence`
+ the existing `Dialog` component). No carousel needed for 1–5 prop images
per item — thumbnails + lightbox is sufficient.

**Milestones:**

- **M3c — Schema update.** Widen `PropsItemInput` with `images: optional(MediaItem[])`.
  Since the new field defaults to `[]`, persisted items without images decode
  cleanly on read — no backward-compat adapter needed.
- **M9e — Props editor with inline image upload.** Extend `PropsEditor` in
  `block-sections.tsx`: add `ImageDrop` per row, thumbnail strip, remove button.
  The `saveShowBlock` server-fn already re-validates against the new schema —
  no server change.
- **M9f — Props view with lightbox.** Extend the props view in `block-sections.tsx`:
  thumbnail strip + click-to-lightbox. Reuse or co-locate a `Lightbox` component.

---

## 3.7 "Concept" section — short authored summary before repertoire

A brief concept write-up placed before the repertoire section. This is distinct
from the full "About the Show" essay (which comes later, after reviews) — it
catches the eye early with a short, scannable summary of the show's idea.

**Design decision — reuse the `symbolism` pinned key, rename to `concept`.**
The existing `symbolism` key in `BLOCK_SCHEMAS` and `schemas.ts` is dead code:
registered, component exists, but never wired into the show page route. Renaming
it to `concept` eliminates dead code and gives us the section in one move. The
component already saves with `pinnedKey: 'symbolism'` — the change is a rename.

**Schema (no change needed from `SymbolismInputSchema`, just rename):**

```typescript
// Before: dead 'symbolism' with SymbolismInputSchema
// After: live 'concept' with ConceptInputSchema (same shape)
const ConceptInputSchema = v.object({ text: v.optional(v.string(), '') });
```

**But — use a constrained Lexical editor, not a textarea.** The existing
`SymbolismSection` uses a plain `<Textarea>`. Replace it with a lightweight
Lexical composer that supports only paragraphs + inline marks (bold, italic,
underline, strikethrough). This keeps the experience consistent with the rest
of the wiki and gives contributors basic formatting without the complexity of
the full editor (no lists, links, headings, code, or custom blocks).

The `FreeFormDoc` envelope is reused but with a **strict 5 KB limit** on both
`doc` and `plain` (vs 200 KB / 50 KB for the full about section). The editor
toolbar is a subset of M11: only the inline formatting buttons (bold, italic,
underline, strikethrough), no block dropdown, no undo/redo, no link insert.

```typescript
const MAX_CONCEPT_DOC_BYTES = 5_000;
const MAX_CONCEPT_PLAIN_BYTES = 2_000;
```

**Renderer:** the existing `renderLexicalDoc` handles paragraphs + inline marks
already — no allowlist change. The concept renderer is the same function.

**Placement in the route:** Insert `<ConceptSection>` between the scraped
description (section #3) and the repertoire (section #4) in
`$slug.$season.tsx`. Update the `authored` object to extract `concept`.

**Milestones:**

- **M3d — Schema rename.** Rename `SymbolismInputSchema` → `ConceptInputSchema`
  in `schemas.ts`. Update `BLOCK_SCHEMAS` key from `'symbolism'` → `'concept'`.
  Add `MAX_CONCEPT_DOC_BYTES` / `MAX_CONCEPT_PLAIN_BYTES` to `free-form.ts`.
- **M3e — Migration for existing `symbolism` blocks.** If any persisted blocks
  have `pinned_key = 'symbolism'`, the read path re-maps them to `'concept'`.
  On next write, they are saved with the new key. This is a one-line adapter
  in the service (or the `blockContent` helper).
- **M9g — Concept editor.** Rewrite `ConceptSection` (formerly `SymbolismSection`)
  to use a constrained Lexical editor instead of a textarea. Wrap in
  `ContribBlock` (existing pattern). The editor shell is the same `LexicalFreeForm`
  but with a reduced toolbar (M11 subset), 5 KB max, and placeholder "A short
  summary of the show's concept…".
- **M9h — Wire into route.** Add `authored.concept = blockContent<ConceptInput>('concept')`
  to the loader and render `<ConceptSection>` in the component tree — between
  the scraped description and repertoire. Delete the unrendered `SymbolismSection`
  import and type.

---

## 3.8 "About the Show" section — guided questions template with Lexical editor

The existing `about` pinned key holds the full show essay (FreeFormDoc with the
Lexical editor). Contributors face a blank composer, which leads to one-sentence
saves or empty blocks. The improvement adds a **guided questions template**
displayed above the editor — prompting contributors to cover specific topics
without constraining their writing.

**What changes:**

- **Schema — unchanged.** The block remains `FreeFormDoc` with `format, version,
  doc, plain`. No new fields. The template is purely an editor-UI concern.
- **Data — unchanged.** The `about` pinned key, the `AboutInputSchema` Valibot
  validation, the `saveShowBlock` server-fn — none of these change. The revision
  system already records `before_json`/`after_json` and the structured diff
  (§3.9) knows how to render FreeFormDoc diffs.
- **Route placement — unchanged.** The rendered position (after reviews, before
  uniform) stays. The section title stays "The concept" (or changes to "About
  the show" — decision below).

**Guided template UI.** When the editor opens, a collapsible "Starting points"
panel appears above the Lexical composer:

```
┌─ Starting points ─────────────────────────────────┐
│  • How many movements does this show have?         │
│  • What are the names of the movements?            │
│  • What should the audience look out for?          │
│  • What is the symbolism or story?                 │
│  • Are there any notable design elements?          │
│  • How does this show compare to the corps'        │
│    previous shows?                                 │
│  • Anything else worth mentioning?                 │
└────────────────────────────────────────────────────┘
```

The panel is collapsed by default on re-opens (user preference stored in
machine context, `showTemplate: boolean`). Each question is a `<p>` with a
Hugeicons icon + text — not a form field. The contributor writes free-form in
the Lexical editor below; the template is guidance only.

**Empty-state affordance.** When no `about` content exists, the empty hint (in
`ContribBlock`) changes from "Tell the story of this show…" to:
"Write a full guide to this show — its movements, story, symbolism, and what to
watch for. Use the Starting points template above to get started."

**Editor integration with the build-out (§4.5).** The About editor is the
flagship consumer of the full Lexical build-out (M11–M17): toolbar, lists,
links, markdown shortcuts, code blocks, callouts, show-media embeds, and entity
links. Every custom block added to the editor (M15) is immediately authorable
in the About section. The template panel sits above, collapsible, independent.

**Title decision.** Rename the section from "The concept" to "About the show"
to distinguish it from the new concept section (which is the short one-sentence
summary). The component title is a prop to `ContribBlock` — one-line change.

**Milestones:**

- **M3f — No schema change** (informational — `about` stays `FreeFormDoc` with
  existing limits).
- **M9i — Guided template component.** Build `app/components/contrib/about-template.tsx`:
  a collapsible card with the question list. Renders above the `AboutEditor`
  `LexicalFreeForm` composer. Toggle visibility stored in the section machine
  context (`showTemplate: boolean`). Default open on first edit, collapsed on
  subsequent edits.
- **M9j — Update empty hint and title.** Change the `AboutSection` `ContribBlock`
  title from "The concept" to "About the show" and the empty hint to the
  expanded guidance text.
- **M17 (existing) — Editor state via the section machine.** Fold the about
  editor's `draft`/`saving`/`error` `useState`s into `contrib-section-machine`
  (as already planned). The template visibility becomes part of machine context.

---

## 3.9 User-friendly structured diffs — replace raw JSON in history panel

The history panel currently parses `before_json` / `after_json` and displays
them as truncated, color-coded JSON strings ("− {summarized JSON}" /
"+ {summarized JSON}"). Users cannot meaningfully read these. Each block type
stores different-shaped data, so the diff must be **type-aware**.

**Schema addition — `pinned_key` on revisions.** To know which block type a
revision belongs to, the `show_revisions` table needs a nullable `pinned_key`
column. When a block write or revert creates a revision, it sets
`pinned_key = block.pinned_key`. For overrides and page-level ops, it stays
null. This is a one-column migration (add column, backfill for existing block
revisions via `show_blocks` join).

```sql
ALTER TABLE show_revisions ADD COLUMN pinned_key TEXT;
```

**`<StructuredDiff>` component.** A new component at
`app/components/contrib/structured-diff.tsx` that receives `before`, `after`,
and `pinnedKey`, then dispatches to a type-specific renderer:

```typescript
function StructuredDiff({ before, after, pinnedKey }: {
  before: string | null;   // parsed JSON or null
  after: string | null;
  pinnedKey: string | null;
}) {
  if (!before && !after) return null;
  if (!before) return <AddedDiff after={after} />;       // "Block created"
  if (!after)  return <RemovedDiff before={before} />;   // "Block deleted"
  return match(pinnedKey).pipe(
    Match.when('about', () => <FreeFormDiff before={before} after={after} />),
    Match.when('concept', () => <FreeFormDiff before={before} after={after} />),
    Match.when('uniform', () => <UniformDiff before={before} after={after} />),
    Match.when('props', () => <PropsDiff before={before} after={after} />),
    Match.when('staff', () => <ArrayDiff before={before} after={after} itemLabel="staff" />),
    Match.when('media', () => <MediaLinksDiff before={before} after={after} />),
    Match.when('gallery', () => <GalleryDiff before={before} after={after} />),
    Match.when('cover', () => <CoverDiff before={before} after={after} />),
    Match.when('links', () => <LinksDiff before={before} after={after} />),
    Match.orElse(() => <JsonDiff before={before} after={after} />),  // fallback
  );
}
```

**Per-type diff renderers (all return a `ReactNode`):**

| pinnedKey | Renderer | What it shows |
|---|---|---|
| `about`, `concept` | `FreeFormDiff` | Before/after of the `plain` text (full text, word-level diff via a simple LCS/ Myers diff on the `plain` field). Falls back to "Content updated" if `plain` is missing or unchanged. |
| `uniform` | `UniformDiff` | "Sections added/removed", "Colors changed: `#AABBCC → #DDEEFF` per section", "Images added/removed per section", "Description updated" (truncated). |
| `props` | `PropsDiff` | "Added N items: [names]", "Removed N items: [names]", "Images added/removed on: [names]". |
| `staff` | `ArrayDiff` | "Added N staff: [roles + names]", "Removed N staff: [roles + names]" with label `"staff member"`. |
| `media` | `MediaLinksDiff` | "Added N links, removed N links", URLs truncated to domain+path. |
| `gallery` | `GalleryDiff` | "Added N images, removed N images" (count only — URLs are not human-readable). |
| `cover` | `CoverDiff` | "Cover image changed" or "Cover image removed" / "Cover image added". |
| `links` | `LinksDiff` | "Added N links: [labels or domains]", "Removed N links: [labels or domains]". |
| `*` (null/unknown) | `JsonDiff` | Original summarized JSON fallback for override/page-level revisions. |

**Plain-text diff algorithm.** For `FreeFormDiff`, use a word-level diff on
`before.plain` vs `after.plain`. Keep it lightweight — no library dependency.
A 50-line LCS-based word diff (split on whitespace) with `<span>` wrappers for
insertions (green) and deletions (red) is sufficient for revision review. The
`plain` field is guaranteed to match the `doc` content (validated on save), so
it is a faithful preview.

**Implementation notes:**
- No new dependencies. The word diff is a standalone utility.
- All diff renderers parse `before`/`after` from JSON strings (the `HistoryEntry`
  fields are `string | null`). Parsing errors fall back to `JsonDiff`.
- The diffs are **read-only views** — no edit-in-place. They are shown in the
  history panel's existing diff expandable (`<details>` / `<summary>` pattern).
- The `StructuredDiff` component replaces the existing `Diff` component in
  `history-panel.tsx`. The `HistoryEntry` type gains `pinnedKey?: string | null`
  (from the new DB column).

**Milestones:**

- **M3g — Add `pinned_key` column to `show_revisions`.** Migration SQL in
  `contributions-db.ts`. Backfill existing block revisions via
  `UPDATE show_revisions SET pinned_key = (SELECT pinned_key FROM show_blocks WHERE show_blocks.block_id = show_revisions.target_id) WHERE target_kind = 'block'`.
- **M3h — `StructuredDiff` component + per-type renderers.** New file
  `app/lib/contrib/structured-diff.tsx` with the dispatcher and all per-type
  renderers. Pure components, no data fetching — they receive parsed inputs.
- **M3i — Plain-text word diff utility.** New file `app/lib/contrib/text-diff.ts`
  with a word-level LCS diff function returning `Array<{ text: string, type: 'same' | 'insert' | 'delete' }>`.
- **M10 (existing) — History panel integration.** During the M10 rewrite,
  replace the `Diff` component with `StructuredDiff` and pass the new
  `pinnedKey` field from the TanStack DB collection entries.

---

## 3.10 Expandable lineup rows — mini show previews

Lineup tables (`LineupSchedule`, `WeekendShowsCarousel`) currently show corps
name, show title, class, and time — one row per corps. The user wants each row
expandable to reveal a mini preview of that corps' show page: uniform image,
concept excerpt, and a link to the full show page for repertoire/staff/props.

**Data flow — lazy batch fetch, not read-model bloat.** The authored preview
data (uniform first image, concept `plain` text) lives in the contributions DB,
not in the read-model. Including it in every `ShowInfoSummary` would require the
read-model emitter to depend on `contributions.db` — a new cross-DB coupling in
the emit pipeline. Instead, a lightweight server function fetches preview data
on demand, batched for all rows in the visible viewport.

**New server function — `getShowPreviews`:**

```typescript
const getShowPreviews = createServerFn({ method: 'GET' })
  .validator((data: { corpsSeasons: { corpsKey: string; season: string }[] }) => data)
  .handler(async ({ corpsSeasons }) => {
    // Batch-read unit images + concept excerpts from contributions.db
    // Returns a map keyed by `${corpsKey}:${season}`.
    // Data is tiny — one image URL + 200 chars of text per show.
  });
```

```typescript
type ShowPreview = {
  uniformImageUrl: string | null;   // first image from uniform block's first section
  conceptExcerpt: string | null;    // first 200 chars of concept.plain
  corpsName: string;
  showTitle: string;
  showSubtitle: string | null;
  slug: string;
};
```

The function reads the `show_blocks` table for `pinned_key IN ('uniform',
'concept')` for the given corps+season pairs. Returns only what is needed for
the mini preview — no full `FreeFormDoc` JSON, just the extracted image URL
(from the first section's first image) and the concept's `plain` text clipped
to 200 characters.

**Lazy loading strategy.**
- The `LineupSchedule` component (and other lineup tables) tracks a `Set<string>`
  of expanded `corpsKey:season` keys in local state (or in a machine context).
- On first expand for a corps+season pair, the component calls `getShowPreviews`
  with **all currently visible** corps+season keys (batched). The results are
  cached in a `Map<string, ShowPreview>` so subsequent expands of the same show
  are instant.
- On scroll (virtualized rows), new rows entering the viewport are included in
  the next batch when first expanded.
- A loading skeleton (two pulsing lines + a square placeholder) is shown in the
  expanded area while the batch fetch is in flight.

**Expanded area layout — `<LineupRowExpanded>` component:**

```
┌──────────────────────────────────────────────┐
│ [Uniform Image]  │ Corps Name                 │
│  (first section  │ Show Title: subtitle       │
│   first image,   │                            │
│   160×120 thumb) │ "Concept text excerpt…"    │
│                   │                            │
│                   │ → View full show           │
│                   │   (repertoire, staff,      │
│                    │    props, media gallery)  │
└──────────────────────────────────────────────┘
```

- Uniform image: a 160×120 WebP thumbnail from the first section's first image
  or the section with the most images, served via `/api/show-media/$id`.
  Falls back to a corps logo placeholder if no uniform image exists.
- Concept excerpt: first 200 characters of `concept.plain`, rendered as a
  dimmed paragraph. Falls back to the scraped `show.description` if no
  authored concept exists.
- "View full show" link: TanStack `<Link>` to `/shows/$slug/$season` with
  an explanatory label listing what's on the full page.

**Expand/collapse affordance.**
- A chevron icon (Hugeicons `chevron-down` / `chevron-up`) on the left side of
  each row — same pattern as the prediction table's per-judge score expand.
- The expandable area uses `motion/react` `AnimatePresence` with a `layout`
  height animation (same as other expandable sections in the app).
- Only one row expanded at a time (accordion behavior) or independent per-row
  — user preference. (Lean: independent, since lineup rows reference distinct
  shows and a user may want to compare two side-by-side.)

**Where the component slot is added.** The expandable area is a new child
component called from within the existing `LineupSchedule` row renderer. The
`LineupSchedule` component already has per-row rendering via a map over
`schedule` — the expand toggle and `AnimatePresence` wrapper are added there.
`WeekendShowsCarousel` / `ShowCard` is a separate integration (see M9m).

**Milestones:**

- **M9k — `getShowPreviews` server function.** New server function in
  `app/lib/server-fns/contrib.ts` (or a new `app/lib/server-fns/show-previews.ts`).
  Reads from contributions DB, returns `Map<string, ShowPreview>`.
- **M9l — `LineupRowExpanded` component.** New component at
  `app/components/contrib/lineup-row-expanded.tsx`. Renders the mini preview
  layout with motion expand/collapse.
- **M9m — Integrate into lineup tables.** Wire the expandable row into
  `LineupSchedule` and `WeekendShowsCarousel`/`ShowCard`. Track expanded state
  and batch-fetch previews via `getShowPreviews`.
- **M9n — Loading and empty states.** Skeleton placeholder for the expanded
  area while fetching. Fallback rendering when no uniform image or concept
  text exists (show logo + scraped description).

---

## 3.11 SEO sitemap and dynamic tags for show pages

The sitemap (`app/routes/sitemap[.]xml.ts`) currently includes corps, judges,
merch, and static pages — but **no show pages**. The show page's `head()` SEO
tags use scraped data but do not prefer authored content (concept text, uniform
image) when available. Two fixes needed.

### 3.11.1 Sitemap — add all show URLs

**Gap:** No `getAllShows()` reader or server function exists to enumerate shows.
The sitemap builder needs to know every `(slug, season, updatedAt)` tuple.

**New read-model reader — `readAllShows()`:**
Add to `sdk/src/readModel/readers.ts`:

```typescript
export const readAllShows = Effect.fn("readAllShows")(function* () {
  const sql = yield* SqlClient;
  return yield* sql<ShowForSitemap>`
    SELECT cs.slug, cs.season, cs.updated_at
    FROM corps_shows cs
    JOIN corps c ON c.corps_key = cs.corps_key
    WHERE cs.slug IS NOT NULL AND cs.deleted_at IS NULL
    ORDER BY cs.season DESC, cs.slug ASC
  `;
});
```

```typescript
type ShowForSitemap = { slug: string; season: string; updated_at: string | null };
```

**New server function — `getAllShows`:**
Thin `createServerFn` wrapper over `Effect.runPromise(readAllShows)`. Returns
the full list of show slugs, seasons, and their last-modified timestamps.

**Sitemap update.** In the sitemap route handler, add a parallel fetch to
`getAllShows` and emit `<url>` entries:

```xml
<url>
  <loc>https://drumcorps.app/shows/{slug}/{season}</loc>
  {updated_at ? `<lastmod>${updated_at}</lastmod>` : ''}
  <changefreq>monthly</changefreq>
</url>
```

All show pages use the same priority and change frequency as corps pages
(`<priority>0.6</priority>`, `<changefreq>monthly</changefreq>`).

**Sitemap cache and size.** The sitemap is currently a single monolithic XML
response. If show pages push it past 50,000 entries (unlikely — drum corps has
~100 active corps × ~15 seasons = ~1,500 shows), implement a sitemap index
with paginated children. Not needed for the foreseeable future.

### 3.11.2 Dynamic SEO tags — prefer authored content

The show page's `head()` function currently builds meta from scraped
`ShowDetail` fields. When authored content exists (concept block, uniform
block), it should be preferred for SEO purposes:

**Current `head()` logic** (simplified):
```typescript
description: show.description ?? show.tagline ?? show.subtitle ?? show.designerNotes ?? fallback,
image: show.media[0]?.thumbnailUrl ?? show.media[0]?.url,
```

**Updated `head()` logic:**
```typescript
// Prefer authored content over scraped data
const conceptPlain = authored?.concept?.plain;    // from concept block
const uniformImage = authored?.uniform?.sections?.[0]?.images?.[0]?.url;
description: conceptPlain?.slice(0, 160) ?? show.description ?? show.tagline ?? ...,
image: uniformImage ?? show.media[0]?.thumbnailUrl ?? show.media[0]?.url,
// Title stays unchanged (corps + season + show title — no authored override needed)
title: `${corpsName} ${season} — ${show.title} (Drum Corps Show)`,
```

The `authored` object is already available in the loader data passed to
`head()` — it is extracted from `contributions.blocks` in the loader. The
`head()` callback receives `loaderData` which includes `authored`. This is a
pure data-preference change in the `head()` function — no new data fetching.

**JSON-LD update.** The existing `schema.org/CreativeWork` JSON-LD includes
`description` and `image`. Update these to use the same authored-first logic.
Additionally, if the uniform image is available, add it as
`schema.org/image` (letting search engines pick the most representative image).

**Open Graph / Twitter:** Already inherit from the `seoHead()` helper. The
`og:image` and `twitter:image` tags automatically reflect the `image` value.

**Milestones:**

- **M11a — `readAllShows` reader + `getAllShows` server function.** Add the
  read-model reader in `sdk/src/readModel/readers.ts` and the server function
  in `app/lib/server-fns/hybrid.ts` (or a dedicated `app/lib/server-fns/shows.ts`).
- **M11b — Sitemap update.** In `app/routes/sitemap[.]xml.ts`, add a
  `getAllShows()` fetch and emit `<url>` entries for each show.
- **M11c — Authored-first SEO tags.** Update the `head()` function in
  `app/routes/shows/$slug.$season.tsx` to prefer authored concept text and
  uniform image over scraped fallbacks. Update the JSON-LD to match.
- **M11d — Sitemap cache revalidation.** Verify the sitemap's
  `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` is
  appropriate for the added volume (1,500+ URLs). Add `lastmod` from
  `corps_shows.updated_at` so crawlers can delta-fetch.

---

## 4. Client milestones — XState

- **M8 — `contrib-section-machine`.** One reusable machine
  (`app/machines/contrib-section-machine.ts`) via `setup({ types, actions })`:
  - context: `{ value: T | null; draft: T | null; error: string | null }`, seeded
    from `input: { initial }`.
  - states: `viewing` → (`EDIT`) `editing` → (`SAVE`) `saving` → `saved`|`error`;
    `CANCEL` returns to `viewing`. `saving` invokes a `fromPromise` actor that
    calls the section's `save` server-fn.
  - **optimistic:** on `SAVE`, assign `value = draft` immediately (use
    `useOptimistic`-style apply); on actor error, roll back to the prior `value`
    and set `error` (typed from the tagged `StaleWriteError` → "refresh & retry").
  - affordances (`disabled`, "Saving…", error text) come from `snapshot.matches`,
    never a separate `useState`.
  Provide the per-section `save`/`pinnedKey`/schema via machine `input` so all
  sections share one machine (data-driven config, not 9 copies).

- **M9 — Port sections.** Convert `uniform`, then `block-sections` (4),
  `staff`, `media`, `references`, `cover`, `about` to
  `useMachine(contribSectionMachine, { input: { initial, pinnedKey, save } })`.
  The **Formisch `useForm` stays** — it renders in the `editing` state; its
  `onSubmit(validated)` does `send({ type: 'SAVE', draft: validated })`. Delete
  the `editing`/`value`/`error` `useState`s. `image-drop` becomes an upload
  actor (`fromPromise`) or `useActionState` (its third return is the pending
  flag — AGENTS.md "load more" precedent); the uploaded URL is sent to the
  section machine. Also port `concept` (the section machine handles it the same
  way as every other block — no special treatment).

- **M10 — `history-panel` with optimistic real-time updates.** The history panel
  is no longer static — it becomes a live, optimistically-updated view of the
  revision log:
  - **TanStack DB collection** (`app/db/revision-collection.ts`): a
    `createCollection` keyed by `revisionId`, seeded from the SSR loader
    payload (`initial: HistoryEntry[]`). Provides `useLiveQuery` for the
    client.
  - **XState machine** (`app/machines/contrib-history-machine.ts`): owns
    pagination (page token / offset from context, not `useState`), loading
    state, and the revert action. On revert, invokes a `fromPromise` actor
    calling `revertRevision` via the RPC/shim.
  - **Optimistic append via React 19 `useOptimistic`:** When any section
    machine completes a `SAVE` (or the history machine dispatches a revert),
    the new revision is immediately optimistically prepended to the collection
    with a pending indicator. On server confirmation, the pending entry is
    replaced with the real revision; on error it is removed.
  - **Cross-actor wiring:** The section machine (M8) publishes a `REVISION_ADDED`
    event on successful save via a shared XState actor bus or a lightweight
    callback registered at the route level. The history machine subscribes
    and calls `mutate(...)` to prepend the new revision.
  - **Periodic reconciliation:** A `useInterval`-driven refetch (every 60 s)
    or a visibility-change listener (`useSyncExternalStore` on
    `document.visibilityState`) pulls fresh revisions from the server,
    reconciling any that arrived from other editors. Cross-tab real-time
    (SSE/EventSource) is deferred until co-editing lands (see §6).
  - **Pagination:** The collection holds the current page; "Load older" sends
    a `LOAD_MORE` event, the machine calls `listRevisions` with an offset
    cursor, and inserts the result into the collection.
  - **View:** The `<HistoryPanel>` component reads from
    `useLiveQuery(revisionCollection, { ...query })` and renders entries
    sorted by `createdAt DESC`. Each entry shows author, timestamp, op badge,
    and target label, plus revert button when `beforeJson` is present.
    The diff display uses the `<StructuredDiff>` component (§3.9) instead of
    raw JSON — the `pinnedKey` field from the revision collection drives a
    type-aware renderer per block.

- **M10b — History-panel cross-actor integration.** Wire the section machine's
  `fromPromise` actor on-success path to emit a `REVISION_ADDED` event
  consumed by the history machine. This is a 5-line change in the route shell
  that connects the two machines — the section machine doesn't import the
  history machine.

Components after this own **zero** business `useState` — only `useForm` (Formisch)
and `useMachine`.

---

## 4.5 Rich-text editor build-out (Lexical: toolbar, blocks, links)

Independent of the Effect/XState work — the `FreeFormDoc` envelope is the seam, so
this can land in parallel and ship incrementally. The goal: turn the
`'free-form-spike'` `RichTextPlugin` into a **discoverable, fully-featured,
beautiful** concept editor without ever rendering raw HTML.

**The cardinal rule — editor and renderer move in lockstep (I-14).** Every node
type the editor can produce MUST be (a) registered in `LexicalComposer.nodes`,
**and** (b) added to the allowlist in `app/lib/contrib/lexical-render.tsx`, **and**
(c) covered by a sanitization rule for any URL/attribute it carries. A node added
to the editor but missing from the renderer is **silently dropped on display**;
an attribute let through without sanitization is an **XSS hole**. No editor PR
merges without its matching renderer + sanitizer change and a render test.

**Architecture.** Split the monolithic spike component into:
`app/components/contrib/editor/` — `LexicalFreeForm.tsx` (composer shell),
`Toolbar.tsx`, `plugins/*` (one per concern), `nodes/*` (custom block nodes),
`theme.ts` (the Lexical `EditorThemeClasses` → Tailwind map). Rename the namespace
off `free-form-spike` to `show-wiki`. Keep `onChange → FreeFormDoc` serialization
and the client-only mount guard.

### Milestones

- **M11 — Toolbar + core marks (discoverability fix).** Add a sticky `Toolbar`
  wired to `FORMAT_TEXT_COMMAND` (bold/italic/underline/strike/inline-code) with
  active-state highlight from `$getSelection` + `editor.registerUpdateListener`.
  Add a block-type dropdown (paragraph / H1–H3 / quote) using
  `$setBlocksType`. Add undo/redo buttons reading `CAN_UNDO_COMMAND`/
  `CAN_REDO_COMMAND`. **Renderer already supports all of these** — no allowlist
  change, pure UX win. Buttons are Hugeicons via `<Icon>`; group with the same
  `ui/button` ghost/active styling as the score-table toggles.

- **M12 — Lists.** `npm i @lexical/list`; register `ListNode` + `ListItemNode`;
  add `ListPlugin`; toolbar buttons dispatch `INSERT_UNORDERED_LIST_COMMAND` /
  `INSERT_ORDERED_LIST_COMMAND` / `REMOVE_LIST_COMMAND`. **Extend the renderer:**
  `list` (→ `<ul>`/`<ol>` by `listType`) + `listitem` (→ `<li>`), with nested-list
  support (listitem can hold a list). Table-stakes for a wiki.

- **M13 — Links (highest XSS surface).** `npm i @lexical/link`; register
  `LinkNode` + `AutoLinkNode`; add `LinkPlugin` + `AutoLinkPlugin` + a small
  link-edit popover (insert/edit/remove URL on the current selection).
  **Renderer + sanitizer:** render `link` as `<a>` with `target="_blank"` and a
  forced `rel="nofollow noopener noreferrer ugc"`; **href passes a URL allowlist**
  (http/https/mailto only — reject `javascript:`/`data:`; reuse/mirror the
  citation-URL normalization already in `citations.ts`). Contributor links are
  untrusted — this is the node most likely to be abused.

- **M14 — Markdown shortcuts + code block.** `npm i @lexical/markdown
  @lexical/code`; add `MarkdownShortcutPlugin` (so `# `, `- `, `> `, `` ` ``,
  `**` auto-format as you type — big ease-of-use win) constrained to the
  TRANSFORMERS we actually support (no tables/images yet). Register `CodeNode` +
  `CodeHighlightNode`; renderer emits `<pre><code>` (escaped text only, never
  highlighted HTML from the client). Update the `format` envelope note.

- **M15 — Custom blocks (the project-specific value).** Add decorator/element
  nodes for things the wiki actually needs, each a `DecoratorNode`/`ElementNode`
  subclass with an `exportJSON`/`importJSON` and a matching renderer case:
  - **Callout** (`type: 'callout'`, `variant: 'note'|'tip'|'warning'`) — a tinted
    `Card`-style box for "designer's note" / "editor's note"; toolbar inserts it;
    renderer maps variant → the existing alert tokens (`--info`/`--warning`).
  - **Show-media embed** (`type: 'show-media'`, `mediaId`) — inline reference to an
    already-uploaded `show_media` row (served via `/api/show-media/$id`), so the
    free-form prose can place an image/video the contributor already uploaded.
    Renderer resolves `mediaId` → `<ProgressiveImage>`; the editor inserts via a
    picker over the section's media. **No external/raw embeds** — only our own
    `media_id`s, keeping the SSRF/XSS surface closed.
  - (Optional, later) **Corps/show cross-link** (`type: 'entity-link'`,
    `kind: 'corps'|'show'`, `slug`) — a typed internal link rendered as a
    TanStack `<Link>`, so concept text can reference other pages safely without a
    raw URL.
  Each custom block needs: node class + `nodes:[]` registration + toolbar
  affordance + `lexical-render.tsx` case + a `decodeFreeFormDoc`/size-bound check
  (the `MAX_DOC_BYTES` guard already bounds the serialized doc).

- **M16 — Polish & typography (beauty).** A `theme.ts` mapping Lexical node classes
  to Tailwind, `prose`-grade typography on both the editor surface and the read
  view (headings/lists/quote/code spacing, link underline-offset, focus ring on
  the composer), placeholder polish, and a max-width measure for readability.
  Mobile: toolbar collapses to an overflow menu. Verify the read view
  (`renderLexicalDoc`) and the editor render **visually identically** (WYSIWYG).

- **M17 — Editor state via the section machine.** Fold `AboutEditor`'s
  `draft`/`saving`/`error` `useState`s into the `contrib-section-machine` (§4) like
  every other section — the rich editor is just another section whose `draft` is a
  `FreeFormDoc`. Closes the loop with the XState milestone.

### M18 — Uniform image carousel component (independent of Lexical)

A lightweight carousel for the uniform section's per-section images. This is a
**read+edit component**, not a Lexical node, so it lives at
`app/components/contrib/uniform-carousel.tsx`.

- Built with `motion/react` `AnimatePresence` + variants for slide-left/
  slide-right transitions (not a third-party carousel library).
- Accepts `images: MediaItem[]` and optional `onReorder` for edit-mode
  drag-to-reorder (`@dnd-kit/sortable` vertical reorder of the thumbnail list).
- Drop-in replacement for the current static image grid in `UniformView`.
- When `images.length <= 2` displays a static 2-col grid (no transition chrome).
- Edit mode: thumbnails are sortable, each has an `×` remove, and an
  `ImageDrop` zone at the end appends new images.
- No new dependencies beyond `motion` (already in the project) and
  `@dnd-kit/sortable` (already used by DataGrid cascading).

### M19 — About the Show guided template panel (editor UI)

A collapsible "Starting points" panel rendered above the Lexical composer in
the About section. This is an **editor-UI component** with no schema changes.

- Component: `app/components/contrib/about-template.tsx` — renders a list of
  prompting questions inside a `Card` with a collapse toggle (Hugeicons
  `chevron-up`/`-down`). Questions are static text, not form fields.
- Visibility state stored in the section machine context (`showTemplate`,
  default `true` on first edit, persisted per-editor in machine local state).
- Styled identically to the editor surface — background, border radius, font
  size match the Lexical composer so the two feel like one panel.
- The empty-state hint in `ContribBlock` is updated to reference the template
  (see §3.8 M9j).
- No new dependencies — uses existing `Card`, `Icon`, `Button`.

### M20 — Constrained Lexical editor for the Concept section

A reduced-surface Lexical composer for the short concept block (§3.7). Built
by composing the same `LexicalFreeForm` shell with a restricted configuration:

- **Nodes:** only `ParagraphNode`, `TextNode`, `LineBreakNode` (no headings,
  lists, quotes, code, links, or custom blocks). The `nodes` array is a subset
  of the full editor's.
- **Toolbar:** only bold, italic, underline, strikethrough buttons from the
  M11 toolbar — no block dropdown, no undo/redo, no link/code/list buttons.
  The toolbar component accepts a `variant: 'full' | 'minimal'` prop (shared
  `Toolbar.tsx`).
- **Limits:** `MAX_CONCEPT_DOC_BYTES = 5_000`, `MAX_CONCEPT_PLAIN_BYTES = 2_000`
  enforced at serialization time (same `onChange → FreeFormDoc` path with
  tighter constraints).
- **Placeholder:** "A short summary of the show's concept…" — distinct from
  the about section's placeholder.
- **Renderer:** unchanged — `renderLexicalDoc` already handles the subset.

### Acceptance per node type (the lockstep checklist)

For each new node (list, link, code, callout, show-media, entity-link):

1. Node registered in `nodes:[]`; `exportJSON`/`importJSON` round-trips.
2. Toolbar affordance inserts/toggles it; active-state reflects selection.
3. `lexical-render.tsx` allowlist case emits safe React (no `dangerouslySetInnerHTML`).
4. Any URL/attribute it carries is sanitized (allowlist scheme, forced `rel`).
5. Render test: a doc containing the node renders; a doc with a **forged/unknown**
   variant of it is dropped (I-14 regression guard).
6. `decodeFreeFormDoc` still accepts the produced envelope within `MAX_DOC_BYTES`.

### Dependencies to add

`@lexical/list`, `@lexical/link`, `@lexical/markdown`, `@lexical/code` (all pinned
to the installed `^0.45.0` line — keep lexical packages version-locked together;
note the existing `scripts/patch-lexical-node.mjs` postbuild patch and re-verify it
still applies). No editor renders to HTML; nothing new ships to the client beyond
these Lexical plugins.

---

## 4.6 UX polish and design integration

The show wiki was built incrementally — the UI reflects an engineer's "make it
work" mindset, not a polished product. Sections use cramped uppercase headings,
empty states all look the same (dashed border), edit affordances are easy to
miss (tiny ghost button), and view/edit transitions snap abruptly. This section
defines UX principles and specific improvements to make the wiki feel native
to the site.

### 4.6.1 UX principles

1. **Belongs, doesn't float** — Every wiki element (cards, typography, spacing,
   animation) must be indistinguishable from the rest of drumcorps.app. A user
   should not be able to tell where "the site" ends and "the wiki" begins.
2. **Editing is a mode, not a page** — Entering and exiting edit mode is a
   fluid transition, not a page change. The card smoothly rearranges; the form
   fades in; the user stays in context.
3. **Empty states invite, don't apologize** — Dashed borders signal "this can
   be filled," but empty areas should feel like opportunities, not gaps. Use
   the section's own icon as a hero graphic, add a subtle background tint, and
   write copy that makes the first contribution feel low-stakes.
4. **Preview is the default** — View mode must look publication-ready. Lexical
   content, uniform images, color swatches, and prop thumbnails should all
   render at the same typographic and spacing quality as the scraped sections.
5. **Feedback is instant** — Save success should flash a subtle
   checkmark/"Saved" indicator below the section heading and auto-dismiss in
   2 s. Errors appear inline, not in a toast. Optimistic updates apply
   immediately; rollback is silent.
6. **Mobile-first editing** — Form fields, image uploads, and the Lexical
   toolbar must work at 360 px width. Array items stack vertically. The edit
   button is always visible (not hidden behind hover).
7. **Contrast edit/view at a glance** — A visitor scanning the page should
   instantly see which sections have been enriched by contributors (authored
   content) vs which still show only scraped data. A subtle "authored" badge
   or a tinted top border on authored cards provides this signal without
   distracting.

### 4.6.2 Audit: prototype-ish patterns to eliminate

| Current pattern | Problem | Fix |
|---|---|---|
| Section heading `text-sm font-semibold uppercase tracking-wide` | Cramped, low-contrast, inconsistent with prediction page's `text-lg font-medium` | Change to `text-base font-semibold text-text-primary` or match the prediction page pattern |
| `<Card>` nested inside `<Card>` (scraped `Section` wrapper + `ContribBlock`) | Double ring border, visual clutter | Unify: scraped sections and authored sections use the same shell (either both `<Card>` or `ContribBlock` uses a non-card container when inside a scraped section's card) |
| `border-2 border-dashed border-foreground/15` on every empty state | All empty sections look identical, no differentiation | Per-section empty state with the section's icon as a hero, a tinted background, and contextual copy |
| Ghost `size="xs"` Edit/Add button in heading | Easy to miss, especially on mobile where ghost buttons have no hover state | Use `variant="outline" size="sm"` with a pencil icon for "Edit", plus-button for "Add". Always visible, never hover-dependent |
| View → edit transition snaps abruptly | Disorienting — content vanishes and a form appears | Wrap view and edit in `<AnimatePresence mode="wait">` with a brief cross-fade (0.15 s). The card body height animates via `layout` |
| No save confirmation beyond content appearing | User isn't sure the save succeeded | Show a subtle `<Badge variant="success-light">Saved ✓</Badge>` below the section heading for 2 s, then fade out. Driven by the machine's `saved` state |
| Formisch fields use `flex items-start gap-2` for array rows | Breaks below 480 px (label and field squish) | Switch to `flex-col sm:flex-row` at narrow widths. Each array item gets a visible fieldset border or alternating background |
| Has-content vs empty uses same dashed border (just hidden) | The card never looks "complete" — authored content sits in the same container as empty state | When content exists, remove the dashed border and add a subtle top-accent bar (3 px, `bg-primary/20`) to signal "this section has been enriched" |
| Uniform color swatches show raw hex | Hex codes are meaningless to most users; the swatch card looks unfinished | Show the color name from the schema's `label` field prominently. If no label, show a tooltip with the hex. Add a subtle shadow on the swatch circle |
| History diff in `<details>` with raw JSON | Feels like a dev tool, not a product | Replace with `<StructuredDiff>` (§3.9). Add an "Edited by X, Y changes" summary line outside the expandable area |
| Image drop zone has no drag highlight | User doesn't know if drag is working | Add a `border-primary` + `bg-primary/5` highlight on `dragenter`. Show a brief "Drop to upload" overlay |
| Lexical composer is a bare ring with no inner shadow | Doesn't look like an active text area | Add a subtle `shadow-inner` on focus, a bottom-border accent, and a smoother placeholder fade |
| No visual difference between authored and scraped content in view mode | Contributor effort is invisible | Authored sections get a 3 px `border-t-primary/20` accent. Seedable sections (staff, media) show a small "Authored" / "Scraped" badge per item |

### 4.6.3 Per-component improvement list

**Section shell unification (M21).** Create a single `<WikiSection>` component
that replaces both the scraped `Section` helper and the `ContribBlock` wrapper.
It handles:
- Consistent heading with `h2` (use prediction-page style: `text-base font-semibold`)
- Icon + title in a row with optional "Authored" badge
- Edit/Add button (outline, always visible)
- Empty state with hero icon + tinted background
- AnimatePresence transition between view and edit
- `scroll-margin-top` for anchor linking
- Top-accent bar when content exists

The unified component eliminates the card-in-card double-border problem:
scraped and authored sections render identically.

**Edit affordance redesign (M22).** Replace the ghost `size="xs"` button with:
- **Has content:** `variant="outline" size="sm"` with a Hugeicons `EditPencil01Icon`
  and "Edit" label. Right-aligned in the heading row.
- **Empty:** `variant="outline" size="sm"` with `AddCircleIcon` and "Add".
  Also shown below the empty-state hero for discoverability.
- On mobile, the button is always full opacity (no hover-reveal).
- While saving, the button becomes a disabled "Saving…" spinner.

**View/edit animated transition (M23).** Every section machine's component
wraps the view/edit toggle in:

```tsx
<AnimatePresence mode="wait">
  {editing ? (
    <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <Editor ... />
    </motion.div>
  ) : (
    <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <View ... />
    </motion.div>
  )}
</AnimatePresence>
```

Duration: 0.15 s, ease: easeOut. No layout shift — the card's height is
driven by content, not animated (avoids the height-animation jank common
with `mode="wait"`).

**Save confirmation affordance (M24).** After a successful save, the section
machine enters a `saved` state for 2 s before returning to `viewing`. During
this window, a small badge appears below the heading:

```tsx
<AnimatePresence>
  {snapshot.matches('saved') && (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}>
      <Badge variant="success-light" size="sm">
        <Icon icon={CheckmarkCircleIcon} size="xs" /> Saved
      </Badge>
    </motion.div>
  )}
</AnimatePresence>
```

On error, the existing destructive-text error message stays in place until
the user dismisses or re-submits. No toast — errors belong inline.

**Mobile form layout (M25).** Audit every Formisch editor form for mobile
breakage:
- Array item rows: `flex-col sm:flex-row` — stacked on narrow screens.
- Field labels: `text-sm` above the input, not beside it (avoids wrapping).
- Buttons (Save, Cancel, Add item): full-width `w-full sm:w-auto` below sm.
- ImageDrop zone: full-width on mobile, with `min-h-[100px]` touch target.
- Color picker: native `<input type="color">` is already mobile-friendly —
  ensure its touch target is at least 44×44 px.
- Lexical toolbar: collapse to an overflow scroll on mobile (`overflow-x-auto
  flex-nowrap`), with the block-type dropdown becoming a bottom sheet
  (deferred — the toolbar build-out M11 covers this).

**Empty state redesign (M26).** Replace the uniform dashed border with
per-section empty illustrations:

```tsx
{/* Before: dashed border + hint text */}
<Card className="border-2 border-dashed border-foreground/15 p-4 text-center">

{/* After: hero icon + tinted circle + contextual copy */}
<Card className="relative overflow-hidden">
  <div className="flex flex-col items-center gap-3 py-8">
    <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
      <Icon icon={section.icon} size="xl" className="text-primary/40" />
    </div>
    <p className="text-sm font-medium text-text-primary">{section.title}</p>
    <p className="max-w-xs text-center text-sm text-text-secondary">{section.emptyHint}</p>
    <Button variant="outline" size="sm">
      <Icon icon={AddCircleIcon} size="sm" /> Add {section.title}
    </Button>
  </div>
</Card>
```

Each section's hero icon is the same icon used in the heading — consistent,
recognizable. The `bg-primary/10` circle gives it a subtle tint without
adding a color.

**Authored content badge (M27).** When a section has authored content (not
empty, not scraped-only), add a 3 px top border accent:

```css
border-t-3 border-t-primary/20
```

For seedable sections (staff, media), individual items that have been authored
or overridden show a small inline badge:

```tsx
<Badge variant="secondary-light" size="sm">Authored</Badge>
```

vs scraped items (no badge). This gives immediate feedback on what the
community has contributed.

**Scraped description integration (M28).** The current scraped description
section ("About this show" with `show.description` + `show.designerNotes`)
sits right before the concept section. When an authored concept or about
block exists, the scraped description should de-emphasize (collapsed by
default with a "Show scraped description" toggle) or be removed entirely
from the main flow and moved to a "Source data" collapsible at the bottom.
Rationale: once a human has written a concept or about essay, the raw
scraped blurb is redundant and clutters the page.

**Card content spacing audit (M29).** Ensure every wiki card uses consistent
vertical rhythm:
- `CardContent` padding: `py-5` (current) is slightly off from the prediction
  page's card padding pattern. Unify to `py-4 sm:py-5`.
- Between sections: `space-y-6` (current) is correct — matches the page's
  existing gap.
- Between items inside a card: `space-y-3` between logical groups, `gap-2`
  between grid items.
- Heading to content gap: `mb-3` (current) is correct.

**History panel visual refresh (M30).** After M10 (TanStack DB + structured
diffs) lands:
- Session group headers get a small dot in the timeline (`size-2 rounded-full
  bg-border` on the left side, connected by a vertical line).
- Each revision entry gets an icon corresponding to its `op` (edit= pencil,
  create= plus-circle, revert= restore-bin, hide= eye-off).
- The "view changes" summary line outside the diff shows a human-readable
  summary: "Uniform colors changed (3 edits)" instead of just "view changes".
- The diff section itself uses `<StructuredDiff>` (§3.9).

### 4.6.4 Milestones

- **M21 — Unified `WikiSection` component.** Merge `Section` helper and
  `ContribBlock` into a single shell. Consistent heading, edit affordance,
  empty state, animated transitions. Eliminates card-in-card double border.
- **M22 — Edit affordance redesign.** Outline button + icon, always visible.
- **M23 — View/edit animated transitions.** Wire `AnimatePresence mode="wait"`
  into the section machine's render output.
- **M24 — Save confirmation affordance.** `saved` machine state shows a
  checkmark badge for 2 s, then auto-returns to `viewing`.
- **M25 — Mobile form layout audit.** Fix every Formisch editor to stack
  vertically below 480 px. Full-width buttons, touch-target color picker.
- **M26 — Empty state redesign.** Hero icon in tinted circle, contextual
  copy, visible "Add" button.
- **M27 — Authored content badge.** Top-accent bar on populated sections;
  "Authored" badge on seedable items.
- **M28 — Scraped description de-emphasis.** Collapse or move the scraped
  "About this show" blurb when authored content exists.
- **M29 — Card spacing audit.** Unify padding, gaps, and vertical rhythm
  across all wiki cards to match the prediction page's card patterns.
- **M30 — History panel visual refresh.** Timeline dots, op icons, friendly
  diff summary, structured diffs.

---

## 5. Error & concurrency model (the correctness payoff)

- `StaleWriteError` is today a string-ish `Error` with a fake `_tag`; the client
  only sees `e.message`. After M2/M5 it's a `Schema.TaggedErrorClass` flowing
  through the RPC error channel, mapped to a 409 at the boundary and matched by
  `_tag` in the machine — so the editor can show a precise "someone edited this;
  refresh" affordance and offer reload, instead of guessing from a message.
- `DurableStorageUnavailableError` (I-7 fail-closed) becomes a typed 503 the UI
  can render as "editing is temporarily unavailable" rather than a generic throw.
- The single-transaction invariant (I-6, row + append-only revision) is preserved
  by wrapping it in one `sql.withTransaction` — the service can't accidentally
  split it.

---

## 6. TanStack DB — used for the history panel, **deferred** for block content

TanStack DB now has a role in the wiki, but only for the **revision history
panel**. The block content itself remains SSR-first, seeded via the route
loader and managed by the XState section machine — TanStack DB adds no value
there (no cross-client liveness, no shared index, no client-side query
filtering on blocks).

### 6.1 What TanStack DB owns: the revision collection

The history panel displays a temporal list of revisions per show page that
should update optimistically and stay in sync across in-page edits. This is
a natural fit for a **TanStack DB collection**:

- **`app/db/revision-collection.ts`**: a `createCollection` with `getKey: (r) => r.revisionId`, seeded from the SSR loader's `initial: HistoryEntry[]`, populated on first subscribe via `useLiveQuery`. The collection has no versioned shards — the data is small (hundreds of rows max) and fits in memory. Write-mode only: mutations come from the XState machine appending new revisions or loading more pages.
- **SSR seeding, no double-fetch.** The route loader passes `initial` as the SSR payload. The collection's `sync` bridge writes these on first subscribe (client-only, after hydration). TanStack DB doesn't re-fetch on mount — the initial data is already there. Subsequent fetches (pagination, reconciliation) go through the existing `getShowHistory` server-fn.
- **No `manifest.json`, no versioned shards.** This is not a read-model concern. The history is an ephemeral client-side document that syncs on save and periodically. Immutable versioning isn't needed.

### 6.2 What stays TanStack DB-free

- **Block content (each `pinnedKey` section):** still SSR-loaded, seeded as
  `initial` props, and mutated through the XState section machine with
  optimistic apply + rollback (M8). A TanStack DB collection here would mean
  a `sync` bridge that serializes the block content into a versioned shard and
  re-reads it via `useLiveQuery` — zero read-side value (the content is
  already in the component's XState context) and a write-path indirection. The
  section machine is the source of truth; the TanStack DB call in M10 is
  specifically for the history *list*, not the block *values*.
- **Cross-tab real-time co-editing:** still deferred. The history panel gets
  periodic reconciliation (visibility-change + 60 s interval) but no SSE
  stream. Full real-time sync (multiple editors watching the same block) would
  require a per-show collection fed by an EventSource, mirroring the Fantasy
  draft architecture. That's a future concern and is **out of scope** for this
  migration.

### 6.3 Why history merits a collection when blocks don't

| Property | Block content | Revision history |
|---|---|---|
| Read pattern | One value per pinnedKey per page | Ordered list, paginated |
| Mutation | Occasional, one-block-at-a-time | Appended on every save/revert |
| Cross-section visibility | Not needed (each section is independent) | **Needed** — sections emit events the history panel consumes |
| Optimistic update value | Low (block updates locally is instant) | **High** — saves from unrelated sections disappear without a visible history entry |
| Client-side querying | None | **Pagination**, sorting by date, filtering by author/op (future) |

### 6.4 Decision summary

**Use TanStack DB for `revision-collection`** (history panel, M10). Skip it
for block content. Cross-tab real-time sync remains future work.

---

## 7. Testing & rollout

- **Per-milestone parity:** each migrated server-fn keeps its signature; add a
  unit test asserting the Effect service returns the same shape the old `store.ts`
  fn did (port any existing store tests onto the service). `npm run check` clean
  after every milestone.
- **Transaction/concurrency tests:** a test that two concurrent `saveBlock`s with
  a stale `expectedUpdatedAt` yield exactly one `StaleWriteError` (not a clobber)
  — this is the invariant most at risk in the port.
- **No flag, so verify by rendering:** after M4/M5 load a real show page locally
  (`npm run dev`, not `vp dev`) and confirm read + a round-trip save/revert work.
  The user confirms UI results themselves (AGENTS.md working-style) — don't
  auto-launch a browser.
- **Multi-uniform adapter test:** unit test that a legacy flat uniform block
  read through the adapter yields the correct `{ sections: [{ label: 'brass',
  ... }] }` shape, and that saving through the adapter writes the new shape.
- **Props image round-trip:** upload an image via `ImageDrop`, attach it to a
  prop item, save, reload, confirm the image URL survives re-parse and renders
  in the view. No image payload on the server-fn (the URL is already hosted in
  R2 — the test is schema fidelity, not upload).
- **History optimistic append test:** simulate a save from a section machine,
  assert the history machine's collection prepends a pending entry, then assert
  the pending entry is replaced by the real revision (or removed on error).
- **Strangler order is safe:** SQL layer → errors → service → reads → writes →
  citations/media → delete. Each step is independently revertable; commit per
  milestone (AGENTS.md "commit frequently").

---

## 8. Risks

- **Transaction semantics drift** porting raw `tx.execute` to `sql.withTransaction`
  — mitigate with the concurrency test above before deleting `store.ts`.
- **`runPromise` leaking into a client chunk** — keep every Effect import behind
  the `createServerFn` server-only split (AGENTS.md); the machines import only the
  thin server-fn reference, never the service/`effect`.
- **Auth ordering** — `requireCapability` must run *before* the Effect program
  (it's the I-12 chokepoint); keep it in the shim, not inside a service method.
- **Scope creep** — Valibot/Formisch and the SSR read path are explicitly **out of
  scope**; resist rewriting forms to Effect Schema.
- **Multi-uniform backward-compat drift** — the legacy-flat-to-sections adapter
  on read must persist until M7. If a save happens on legacy-shaped data before
  the adapter is in place, the block will be re-saved as legacy and the migration
  window extends. Mitigate: land the adapter in M3b (before M4 reads go live)
  and never remove it until M7 confirms all blocks are migrated.
- **History collection memory** — the revision collection holds all entries in
  memory. For heavily-edited show pages, this could grow large. Mitigate: cap
  the collection at 500 entries; older entries are fetched on "Load older" and
  evicted from the hot set.
- **Cross-actor coupling** — the section machine publishing `REVISION_ADDED`
  to the history machine introduces a coupling between otherwise independent
  machines. Mitigate: the event is a single opaque string payload passed through
  a route-level bridge function, not a direct machine import. If the bridge
  grows, extract a shared event bus.

---

## 9. File checklist

New (server/state):
- `app/lib/contrib/contributions-sql.ts` — `ContributionsSql` SqlClient layer
- `app/lib/contrib/errors.ts` — tagged domain errors
- `app/lib/contrib/contributions-service.ts` — `ContributionsService` (+ `*Live`)
- `app/rpc/contrib-rpc.ts` — `ContribRpc` / `ContribRpcLive`
- `app/machines/contrib-section-machine.ts` — shared section machine
- `app/machines/contrib-history-machine.ts` — history panel machine (pagination, revert, optimistic append)
- `app/db/revision-collection.ts` — TanStack DB collection for revision history
- (optional) `app/lib/contrib/citations-service.ts`, `media-service.ts`

New (editor build-out, §4.5):
- `app/components/contrib/editor/LexicalFreeForm.tsx` — composer shell (replaces
  the spike file)
- `app/components/contrib/editor/Toolbar.tsx` — formatting/block/insert toolbar
- `app/components/contrib/editor/plugins/*` — list / link / markdown / code /
  custom-block insert plugins
- `app/components/contrib/editor/nodes/*` — `CalloutNode`, `ShowMediaNode`,
  (optional) `EntityLinkNode`
- `app/components/contrib/editor/theme.ts` — Lexical `EditorThemeClasses` → Tailwind

New (multi-uniform + carousel, §3.5):
- `app/components/contrib/uniform-carousel.tsx` — Motion-based image carousel with
  prev/next, dot indicators, swipe gesture, drag-to-reorder in edit mode
- `app/components/contrib/uniform-section-editor.tsx` — Tabbed editor (brass / percussion / guard)
- `app/components/contrib/uniform-section-view.tsx` — Tabbed view with carousel per section

New (props images, §3.6):
- `app/components/contrib/props-lightbox.tsx` — Image lightbox for props (motion/framer-based)

New (concept section, §3.7):
- `app/components/contrib/concept-section.tsx` — Concept block with constrained Lexical editor
  (inline marks only, 5 KB limit)

New (about section guided template, §3.8):
- `app/components/contrib/about-template.tsx` — Collapsible "Starting points" panel with
  prompting questions rendered above the Lexical composer

New (structured diffs, §3.9):
- `app/components/contrib/structured-diff.tsx` — Type-aware diff dispatcher + per-block
  renderers (FreeFormDiff, UniformDiff, PropsDiff, etc.)
- `app/lib/contrib/text-diff.ts` — Word-level LCS diff utility (before/after plain text)

New (editor build-out, M20):
- `app/components/contrib/editor/Toolbar.tsx` — now accepts `variant: 'full' | 'minimal'`
  prop for the constrained concept editor (M11 toolbar is the full variant)

New (expandable lineup rows, §3.10):
- `app/components/contrib/lineup-row-expanded.tsx` — Mini show preview with uniform image,
  concept excerpt, and "View full show" link
- `app/lib/server-fns/show-previews.ts` — `getShowPreviews` batch fetcher (or inline in contrib.ts)

New (SEO sitemap + tags, §3.11):
- `app/lib/server-fns/shows.ts` — `getAllShows` server function (wraps `readAllShows`)
- `sdk/src/readModel/builders/shows.ts` — add `ShowsForSitemap` builder (if readFrom doesn't exist)

Changed:
- `app/lib/contrib/schemas.ts` — widen `UniformInputSchema` to `{ sections: UniformSectionSchema[] }`;
  widen `PropsItemInput` with `images: optional(MediaItem[])`; rename
  `SymbolismInputSchema` → `ConceptInputSchema`, update `BLOCK_SCHEMAS` key
- `app/lib/contrib/store.ts` (or the new service) — add backward-compat adapter that wraps
  legacy flat uniform `content_json` into `{ sections: [{ label: 'brass', ... }] }`;
  add `symbolism → concept` pinned-key re-map on read
- `app/lib/contributions-db.ts` — add migration: `ALTER TABLE show_revisions ADD COLUMN pinned_key TEXT`
- `app/routes/shows/$slug.$season.tsx` — add `authored.concept` extraction; insert
  `<ConceptSection>` between scraped description and repertoire; update `ContribBlock`
  title for about from "The concept" to "About the show"; update `head()` SEO logic
  to prefer authored concept text for description and uniform image for og:image
- `app/routes/sitemap[.]xml.ts` — add `getAllShows()` fetch and emit show `<url>` entries
- `sdk/src/readModel/readers.ts` — add `readAllShows` Effect reader for sitemap enumeration
- `app/components/contrib/wiki-section.tsx` — Unified `WikiSection` component replacing both
  `Section` helper and `ContribBlock` (M21). Consistent heading, edit affordance,
  empty state, animated transitions, authored badge.
- `app/lib/server-fns/contrib.ts`, `citations.ts`, `media.ts` — handlers become
  `runPromise(provideAppLive(...))` shims (signatures unchanged)
- `app/rpc/index.ts` — merge the new `*Live` into `AppLive`
- The 8 editor components — `useMachine` instead of edit `useState`/`try-catch`
- `app/lib/contrib/lexical-render.tsx` — **extend the allowlist + URL sanitizer in
  lockstep** with each new node (list, link, code, callout, show-media) — I-14
- `app/lib/contrib/free-form.ts` — narrow `format` to `'lexical'`; keep the
  envelope/`MAX_DOC_BYTES` bound as custom blocks land
- `package.json` — add `@lexical/list`, `@lexical/link`, `@lexical/markdown`,
  `@lexical/code` (pinned to the `^0.45.0` line); re-verify `patch-lexical-node.mjs`

Deleted:
- `app/lib/contrib/store.ts` (once unimported)
- `app/components/contrib/tiptap-free-form.tsx`, `app/routes/dev/free-form-spike.tsx`
- the old single-file `app/components/contrib/lexical-free-form.tsx` (superseded by
  the `editor/` dir)
- backward-compat uniform adapter in the service (after M7 migration window closes)

---

## 10. Open questions

1. Split into `CitationsService`/`MediaService` or one `ContributionsService`?
   (Lean: split if any service exceeds ~6 methods.)
2. Should `revertRevision` invalidate the route loader (`router.invalidate()`) or
   return the new overlay for the machine to apply? (Lean: invalidate — simpler,
   one source of truth.)
3. Keep `routes/api/show-media/$id.ts` raw, or route it through `MediaService`?
   (Low value; default keep raw.)
4. **Multi-uniform section labels — strict picklist or free-form string?**
   A `v.picklist(['brass', 'percussion', 'guard'])` is type-safe but rigid
   (a show might have "front ensemble" instead of "percussion", or a split
   "brass low"/"brass high"). A free-form `v.string()` with conventional
   defaults is more flexible but opens up display inconsistency. (Lean:
   start with the picklist — it covers 95%+ of shows and makes the UI
   deterministic. Revisit if a show genuinely needs a nonstandard label.)
5. **Uniform carousel — gesture library or raw Motion?**
   `motion/react` `onPan` handlers work for swipe but need manual threshold/
   velocity logic. A 2 kB wrapper like `@emilkovac/react-swipeable` adds
   tested gesture detection. (Lean: start with raw `onPan` + a small
   `useSwipe` hook — zero new deps. Graduate to a lib only if gesture bugs
   surface.)
6. **History panel periodic reconciliation — interval or visibility change?**
   A fixed 60 s interval polls even when the tab is backgrounded. A
   `visibilitychange` listener + a 60 s debounce-on-foreground is more
   battery-friendly. (Lean: `visibilitychange` + a 5-minute stale-while-visible
   supersedes interval — no unnecessary fetches.)
7. **Prop image lightbox — dedicated component or reuse `Dialog`?**
   The existing `Dialog` from shadcn can wrap a Motion `AnimatePresence` zoom.
   (Lean: reuse `Dialog` + a full-bleed image; no separate lightbox component
   needed unless the UX demands swipe-to-dismiss or gallery navigation.)
8. **Concept section editor — Lexical subset or plain textarea?**
   A constrained Lexical editor (inline marks only) gives formatting consistency
   with the rest of the wiki. A plain `<Textarea>` is simpler and zero-cost.
   (Lean: use the Lexical subset — the editor build-out (§4.5) is already
   underway and the minimal toolbar is a `variant='minimal'` prop on a shared
   component. The 5 KB limit prevents abuse.)
9. **About section title — "About the show" or keep "The concept"?**
   With the new short concept section, the full essay should have a distinct
   name. (Lean: rename to "About the show" — clearer, avoids confusion with
   the concept section.)
10. **Structured diff — client-side word diff or server-rendered HTML diff?**
    Computing word diffs on the client (LCS on `plain` field) is instant for
    the small plain-text sizes (max 50 KB, typically <5 KB). A server-rendered
    HTML diff would need a new API response field. (Lean: client-side word diff
    in `text-diff.ts` — zero round-trips, no new API surface.)
11. **About template questions — static list or editor-configurable?**
    A static list is simpler and sufficient for v1. If contributors consistently
    ask for different prompts, make them a machine-context value that could
    later become page-level config. (Lean: static list — 6–7 evergreen questions
    that cover 95%+ of shows.)
12. **Expandable lineup preview — which uniform image to show?**
    With multi-section uniforms (brass/percussion/guard), the mini preview needs
    to pick one representative image. (Lean: show the first image from the first
    non-empty section, or the section with the most images. A label like "Brass
    uniform" can be added if ambiguous.)
13. **Lineup expand accordion vs independent?**
    Independent expand (multiple rows open simultaneously) lets users compare
    shows. Accordion (only one open) is simpler and avoids scroll overflow on
    mobile. (Lean: start with independent — the preview is compact enough that
    two open side-by-side fit on desktop. Fall back to accordion if mobile
    feedback is negative.)
14. **Sitemap — monolithic XML or paginated sitemap index?**
    With ~1,500 shows + existing entries, the total is well under 50,000 URLs
    (the sitemap protocol limit). (Lean: keep it monolithic. Add a sitemap index
    with `<sitemapindex>` only if the count exceeds 10,000.)
15. **Authored SEO tags — stale or real-time?**
    If the `head()` function runs during SSR and the authored content has been
    updated but the read-model hasn't been re-emitted, the SEO tags may be stale.
    (Lean: use the authored data from the contributions DB loader (fetched live
    every request), not the read-model — so tags are always current. The
    `authored` object is already in `loaderData` and passed to `head()`.)
