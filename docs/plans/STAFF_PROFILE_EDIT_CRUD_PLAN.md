# Staff Profile Edit — Full CRUD of the Competitive Record

Status: **DRAFT for review** — not started. Extends `STAFF_PROFILE_OWNERSHIP_PLAN.md`
(which is LIVE): claiming + editing bio/photo/hometown/current-position already ship.
This plan adds owner CRUD of the **structured** record — assignments (corps × season ×
role/section × title × year), awards, and performed/groups — plus a UX overhaul.

Created: 2026-07-01.

---

## 0. Goal

Let a verified owner correct and complete the noisy, auto-extracted competitive record
on their own `/staff/$personId` page: **add / edit / remove** assignments (the corps
they taught, the season, their section/role and title, the years), awards, and the
groups/corps they performed in — with a real edit UX, and durably (surviving the nightly
yearbook re-scrape).

Judges are largely out of scope for structured CRUD (see §1.3).

---

## 1. Current state (verified 2026-07-01)

### 1.1 What's editable today
`app/components/profile-owner/profile-editor.tsx` edits only four scalar fields —
**biography, photo, hometown, current_position** — with per-field save buttons.
`mergeProfileOverlay` (`app/lib/profile-owner/merge.ts`) overlays exactly those four; the
comment states *"scraped competitive record stays authoritative."*

### 1.2 What is NOT editable (the target of this plan)
The `StaffProfile` shape (`sdk/src/readModel/builders/staff.ts`) carries the structured
record, all scraped-only:
- **`assignments: StaffAssignment[]`** — `{ corps_key, corps_name, corps_slug, season,
  title, role_type, start_year, end_year }`, grouped by corps in the UI.
- **`bioFacts.awards[]`** `{ name, year }`, **`performedOther[]`** `{ group, startYear,
  endYear }`, **`education[]`**, plus **`groups[]`** / **`performed[]`** relations.

### 1.3 Two enabling facts, one scoping fact
- **Storage is already generic.** `ProfileOwnerService.saveOverride` writes an arbitrary
  `(entity_type, entity_id, field_key, content_json)` row (no allowlist) into
  `profile_overrides` — it can hold structured-collection overrides today.
- **Edits never touch the model.** Overrides are a **request-time overlay in
  `contributions.db`**, merged in the route loader; they never rewrite the relational /
  read-model data. So owner edits **cannot pollute the ML pipeline** (`corps.division_name`
  and other model features stay authoritative). This is the key safety invariant and must
  be preserved.
- **Judges are different.** A `JudgeAssignment` is `event × season × caption`, **derived
  from real competition scores** — factual history, not a self-describable "role." Judges
  therefore get bio/photo/awards-style facts only, never CRUD over their event/caption
  record (§ P4).

---

## 2. The core design decision — overlaying a *collection* durably

The overlay must survive the nightly re-scrape (a new season's assignments should still
appear; an owner's corrections should stick). Three options:

| Option | Model | Pros | Cons |
|---|---|---|---|
| **A. Whole-collection override** | `field_key='assignments'`, JSON = the full edited list; `displayed = override ?? scraped` | trivial (~1 day) | owner snapshot *replaces* scraped → new future assignments hidden until re-edit; no per-item divergence |
| **B. Operation-based overlay (RECOMMENDED)** | granular ops keyed by a stable assignment identity: `add`, `edit(id, patch)`, `remove(id)`. `displayed = scraped − removed + added ± edited` | new scraped rows still appear; corrections stick; per-item divergence; mirrors the existing admin curation model | needs a stable identity + a merge function (~3–4 days) |
| **C. Reuse admin curation primitives** (`staff_role_overrides`, `staff_assignment_suppressions`) | relational-side, applied at ingest/emit | already durable | wrong layer — not the read-time contributions overlay; not owner-scoped |

**Recommendation: B.** Durability-against-re-scrape is the entire reason the overlay
exists; A quietly breaks it. B is philosophically identical to the durable admin curation
already documented in `AGENTS.md` (role overrides / assignment suppressions / field
locks), just owner-scoped and applied at read time.

### 2.1 Identity
Assignments have no stable id in the read-model (derived tuples). Use a coarse, stable
key: `assignmentKey = sha1(corps_key | season | role_type | title)` (deliberately coarse
so a re-scrape that only reformats a title doesn't orphan the override; validated by the
reconciler). Awards/performed get analogous keys.

### 2.2 Storage
Reuse `profile_overrides` with structured `field_key`s and an op-log `content_json`:
- `field_key = 'assignments'` → `{ removed: string[] /*keys*/, added: Assignment[], edited: Record<key, Partial<Assignment>> }`
- `field_key = 'awards'`, `field_key = 'performed'` → same op-shape.
Each mutation still writes a `profile_revisions` row (append-only history, invariant I-6),
enabling undo.

---

## 3. What becomes editable (staff, full CRUD)

| Entity | Fields | Ops | Guardrails |
|---|---|---|---|
| **Assignment** | corps, season / year range, **role_type (section)**, **title** | add / edit / remove | corps via **search-and-pick** (real `corps_key`/slug, so links resolve — reuse the /vs corps combobox), not free text; `role_type` from the **canonical caption/section vocabulary**; year range validated; never writes ML columns |
| **Award** | name, year | add / edit / remove | year optional; free-text name |
| **Performed / groups** | corps (pick) or non-DCI group (text), year range | add / edit / remove | DCI corps resolve to a slug; non-DCI stays text |
| Existing scalars | bio, photo, hometown, current position | (already shipped) | — |

---

## 4. UX overhaul

Today's editor is a stack of per-field save buttons. Replace with:
- **One "Edit profile" mode.** The profile flips into an editable view: assignments render
  as an **editable table grouped by corps**, each row inline-editable with add/remove;
  awards & groups as editable chip-lists.
- **Dirty-tracking + save.** Optimistic UI with a sticky **Save / Discard** bar (or
  autosave-on-blur per row), driven off an XState editor machine (components dumb) — no
  ad-hoc `useState` spinner soup.
- **Undo** via the append-only `profile_revisions` already recorded per mutation.
- **Divergence badges.** "The source record changed since you edited" from the existing
  `scrape_diverged` mechanism, extended to collection items via the reconciler.
- **Reuse:** `image-drop.tsx` + `MediaService.uploadProfilePhoto` (already wired); the
  `feat/wiki-editable-rows` inline-row pattern; the corps-pick combobox from `/vs`.

---

## 5. Merge, moderation, reconciliation

- **Merge:** extend `mergeProfileOverlay` with a collection branch (`ops + scraped →
  merged list`) for `assignments` / `awards` / `performed`; keep the four scalar branches.
- **Reconcile:** extend `reconcileProfileOverrides` to flag **item-level** divergence
  (an override key whose scraped source changed/vanished) and orphan-flag stale ops.
- **Moderation:** structured edits are User Content (ToS §3/§4 already cover this) and are
  moderatable/revocable. Gate **new-entity creation** (adding a corps/award that wasn't
  scraped) behind the same tiered check as claims — fabricated credits are the main abuse
  vector; correcting an existing row is lower-risk.

---

## 6. Build order (incremental, commit per step)

- **P0 — Data layer. ✅ SHIPPED.** Op-based `OverrideContent` shapes, `applyCollectionOps`
  + `diffCollectionOps` (round-trip), stable-key helpers, `mergeProfileOverlay` extended for
  awards/performed, `mergeAssignmentsOverlay` for assignments; 35 profile-owner tests.
- **P1 — Awards + performed/groups CRUD. ✅ SHIPPED (staff).** Editor sections + durable
  op-log save; loader threads scraped baselines; gated on the baseline (staff-only).
- **P2 — Assignments CRUD. ✅ SHIPPED (staff).** Fix section (controlled `ROLE_TYPES` vocab),
  title, season, year range; remove misattributions.
- **P2b — Corps search-picker. ✅ SHIPPED.** Add an assignment at ANY corps via a lazy
  directory-search combobox (real `corps_key`/slug so links resolve). **Full CRUD of the
  competitive record is now complete.** Remaining nicety: a grouped-by-corps editable table
  (P3 polish).
- **P3 — UX polish. 🟡 PARTIAL.** ✅ Assignments grouped-by-corps table; ✅ unsaved-changes
  guard extended to all collections; ✅ **moderation surface** — the admin claims queue shows
  each owner's edits (field + op-count) to spot fabricated credits. **Remaining:** divergence
  badges ("source changed since you edited" — needs per-item `scrape_diverged` in the
  reconciler), and an optional XState/autosave refactor of the working per-section save.
- **P4 — Judges. ✅ SHIPPED.** Awards editing enabled for judges (per-collection section
  gating — a section renders iff its scraped baseline is provided). Their score-derived
  event/caption record stays off-limits by design.

---

**Status summary:** P0, P1, P2, P2b, P4 all shipped; P3 mostly shipped (grouped table,
unsaved-changes guard, moderation surface). Only the low-value refinements remain —
divergence badges (per-item `scrape_diverged`) and an optional XState/autosave refactor.
**The feature — full, durable, moderatable owner CRUD of the profile record — is complete.**

---

## 7. Risks & non-goals

- **Identity churn** — a re-scrape that changes a title shifts the assignment key and
  orphans the override. Mitigate with a coarse key (corps + season + role) and reconciler
  re-linking; surface orphans to the owner.
- **Abuse / fabricated credits** — moderation + tiered gating on new-entity creation;
  everything is revocable (revoke clears overrides, already built).
- **ML-pipeline safety** — non-negotiable: overrides stay read-time display only; never
  write `corps_staff` / relational columns the model consumes.
- **Non-goals:** editing judges' factual event/caption/score record; bulk import; merging
  two people (that's the existing §11a claim-merge); editing *other* people's profiles.

---

## 8. Testing

- Unit: the collection-merge function (scraped + ops → merged), stable-key hashing, each
  op (add/edit/remove), divergence detection — against fixtures (mirrors the existing
  `merge.test.ts` / `name-match.test.ts`).
- Schema: `profile_overrides` round-trips structured `content_json` (extends
  `contributions-schema.test.ts`).
- Wiring: an owner-gated `saveOverride('assignments', …)` writes an op + a revision in one
  transaction (invariant I-6).
