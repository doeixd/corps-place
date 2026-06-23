# Show Detail Wiki (`contrib`) — Migrate to Effect Services + XState

Status: **DRAFT for review** · Created: 2026-06-23 · Owner: TBD

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
- **Delete the dead second editor:** `TiptapFreeForm` + the `'tiptap'`/`'editorjs'`
  branches of `FreeFormDoc.format` are only reachable from `routes/dev/
  free-form-spike.tsx`. Production uses `LexicalFreeForm` only. Drop them (or
  finish the abstraction) so the `format` union matches reality.
- **Build the Lexical editor out from a spike into a real editor (§8).** Today it
  is a barebones `RichTextPlugin` with **no toolbar**, keyboard-only marks, and
  only `Heading`/`Quote` nodes — still namespaced `'free-form-spike'`. Add a
  **toolbar**, **lists**, **links**, **markdown shortcuts**, a **code block**, and
  the project's **custom blocks** (callout / show-media embed), each extended in
  **lockstep** with the security allowlist renderer (`lexical-render.tsx`, I-14).
  This is its own workstream and can land in parallel with the Effect/XState work.

---

## 1. Current state (inventory — verified in-repo)

**Server (all raw `@libsql/client` via `getContributionsDb()`):**

| File | Surface | Notes |
|---|---|---|
| `app/lib/contributions-db.ts` | `getContributionsDb()`, `durableStorageStatus()` | Long-lived client + PRAGMA/DDL (mirrors `media-cache.ts`). Keep the bootstrap; wrap it in a `SqlClient` layer. |
| `app/lib/contrib/store.ts` | `readShowPageContributions`, `listRevisions`, `ensureShowPage`, `writeOverride`, `writeBlock` + `StaleWriteError`, `DurableStorageUnavailableError` | Plain `async` fns taking `Client`/`Transaction`; single-tx row+revision (I-6); optimistic concurrency via `expectedUpdatedAt`. **The core to wrap.** |
| `app/lib/server-fns/contrib.ts` | `getShowContributions`, `getShowHistory` (reads); `saveShowBlock`, `revertRevision` (writes) | 11 inline `db.execute` calls + auth + normalization **in the handlers** — the chief AGENTS.md violation. |
| `app/lib/server-fns/citations.ts` | `listCitations`, `createCitation` (+ a helper) | Inline SQL. |
| `app/lib/server-fns/media.ts` | `uploadShowMedia` | Inline SQL + R2 `putUpload`/`uploadKey`. |
| `app/routes/api/show-media/$id.ts` | GET serve by `media_id` | R2 `getUpload`; leave as a route, optionally back it with `MediaService`. |
| `app/lib/authz.ts` | `requireCapability` (I-12 chokepoint) | **Keep at the boundary**, unchanged. |

**Client (edit state in `useState` + `async`/`try-catch` — the XState targets):**

| Component | `useState` | async/try | Migrate to a section machine? |
|---|---:|---:|---|
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
  `staff`, `media`, `references`, `cover` to `useMachine(contribSectionMachine,
  { input: { initial, pinnedKey, save } })`. The **Formisch `useForm` stays** —
  it renders in the `editing` state; its `onSubmit(validated)` does
  `send({ type: 'SAVE', draft: validated })`. Delete the `editing`/`value`/`error`
  `useState`s. `image-drop` becomes an upload actor (`fromPromise`) or
  `useActionState` (its third return is the pending flag — AGENTS.md "load more"
  precedent); the uploaded URL is sent to the section machine.

- **M10 — `history-panel`.** Revert is an event → actor calling `revertRevision`;
  paging is machine context, not `useState`. On successful revert, the affected
  section machine refetches or the loader is invalidated
  (`router.invalidate()`), so the overlay reflects the revert without a manual
  mirror.

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

## 6. TanStack DB — evaluated, **deferred** ("if needed" → not yet)

TanStack DB earns its place when there's a **shared, queryable, live** client
dataset (the directory index shards; the Fantasy live draft). The wiki has
neither:

- The contributions overlay is **per-show and small**, already delivered by the
  route `loader` (SSR-first) and seeded as `initial` props — no index to preload,
  no `useLiveQuery` filtering.
- There is **no cross-client liveness** requirement (no two editors watching the
  same block in real time; saves are infrequent, last-writer-loses is guarded by
  `expectedUpdatedAt`).
- Optimistic update is handled locally by the section machine (§4) — a collection
  would add a `sync` bridge and a versioned shard for no read-side win.

**Decision:** skip TanStack DB for the core migration. Revisit **only if** one of
these lands: (a) a public, browseable *index of contributed shows* (then emit a
read-model shard + collection like the directories), or (b) real-time co-editing
(then a per-show collection fed by an SSE stream, mirroring the Fantasy draft).
Document this decision inline so a future reader doesn't "fix" the omission.

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

---

## 9. File checklist

New (server/state):
- `app/lib/contrib/contributions-sql.ts` — `ContributionsSql` SqlClient layer
- `app/lib/contrib/errors.ts` — tagged domain errors
- `app/lib/contrib/contributions-service.ts` — `ContributionsService` (+ `*Live`)
- `app/rpc/contrib-rpc.ts` — `ContribRpc` / `ContribRpcLive`
- `app/machines/contrib-section-machine.ts` — shared section machine
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

Changed:
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

---

## 10. Open questions

1. Split into `CitationsService`/`MediaService` or one `ContributionsService`?
   (Lean: split if any service exceeds ~6 methods.)
2. Should `revertRevision` invalidate the route loader (`router.invalidate()`) or
   return the new overlay for the machine to apply? (Lean: invalidate — simpler,
   one source of truth.)
3. Keep `routes/api/show-media/$id.ts` raw, or route it through `MediaService`?
   (Low value; default keep raw.)
