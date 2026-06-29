# Staff & Judge Profile Ownership Plan

Let a real person **claim and manage their own profile** on drumcorps.app — both
`/staff/$personId` and `/judges/$judgeId`: claim button → sign in → name check → binding
attestation → owner-editable profile (including edit/remove of the photo), with all edits stored
as a durable, history-tracked overlay that the nightly read-model rebuild can never overwrite.

This is the **synthesis of two patterns the codebase already runs in production**:

- the **show-detail wiki overlay** (`displayed = override ?? scraped`, append-only revisions,
  durable `contributions.db`, divergence reconciliation) — see `SHOW_WIKI_*` plans and
  `app/lib/contrib/*`; and
- the **pageantryjobs person-claim flow** (`jobs_person_claim`, attestation, seed-from-read-model)
  — see `PAGEANTRY_JOBS_PLAN.md` and `app/lib/jobs/jobs-service.ts` `claimPerson` (~:811), which
  **already handles both `entity_type='staff'` and `entity_type='judge'`**.

Nothing here is novel infrastructure; it is those two systems pointed at `/staff` and `/judges`.

### One system, two entity types

`/staff` and `/judges` are structurally identical: `StaffDirectoryService`
(`app/lib/staff-directory.ts`) and `JudgeDirectoryService` (`app/lib/judge-directory.ts`) are the
same shape — read-model fast path (`readStaffProfile` / `readJudgeProfile`) with a builder
fallback, keyed by `person_id` / `judge_id`. So this plan models ownership generically by
**`(entity_type, entity_id)`** where `entity_type ∈ {'staff','judge'}` and `entity_id` is the
read-model id — exactly as `jobs_person_claim` already does (`UNIQUE(entity_type, entity_id)`).
Everywhere below "the person's id" means that pair.

---

## 1. The core constraint (why an overlay, not an edit)

Both staff and judge profiles are served **read-only from the read-model**
(`rm_staff`/`rm_staff_detail`, `rm_judges` + judge detail, built by
`sdk/src/readModel/builders/{staff,judges}.ts`). The read-model is **rebuilt nightly from
`dci-relational.db` and atomically hot-swapped** (`emitReadModel.ts`, A/B slot flip). Therefore:

> **You can never write a user edit into the profile itself — the next emit destroys it.**

The only durable surface is `contributions.db` (on the `/data` volume, untouched by the emit).
So owner edits live there as a **per-field overlay merged at read time** — invariant I-1/I-2/I-3
from the show-wiki plan, reused verbatim:

- **I-1** the app never writes scraped tables (read-model / `dci-relational.db`).
- **I-2** contributions survive the nightly emit (separate DB, durable volume).
- **I-3** displayed value = `override ?? scraped`, merged at request time.

---

## 2. Data model (all additive tables in `contributions.db`)

Migrations go in `scripts/contributions-migrations.mjs` (single source of truth), all
`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`. Schema defined in `app/lib/contributions-db.ts`.
Keyed by `(entity_type, entity_id)` so one set of tables serves staff and judges.

### 2.1 `profile_claims` — ownership + the binding attestation

Modeled on `jobs_person_claim` (`contributions-db.ts:559`) but standalone — drumcorps.app's unit
of ownership is the read-model entity directly, not a `jobs_profile`.

```sql
CREATE TABLE IF NOT EXISTS profile_claims (
  claim_id            TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL,          -- 'staff' | 'judge'
  entity_id           TEXT NOT NULL,          -- read-model person_id / judge_id
  user_id             TEXT NOT NULL,          -- better-auth user.id
  status              TEXT NOT NULL DEFAULT 'active',  -- active | pending | revoked

  -- name-match record ("for our records"; see §4):
  google_name         TEXT,                   -- session.user.name at claim time
  matched_name        TEXT,                   -- profile display_name at claim time
  name_match          TEXT,                   -- 'exact' | 'close' | 'weak'
  name_score          REAL,                   -- 0..1 similarity

  -- the attestation (see §5):
  attested_at         TEXT NOT NULL,
  attestation_version TEXT NOT NULL,          -- bump when legal copy changes
  attest_ip           TEXT,
  attest_user_agent   TEXT,

  claimed_at          TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_by          TEXT,                    -- moderator user_id
  revoke_reason       TEXT
);
-- one ACTIVE owner per entity (partial unique; revoked rows don't block re-claim):
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_claims_active
  ON profile_claims (entity_type, entity_id) WHERE status != 'revoked';
CREATE INDEX IF NOT EXISTS idx_profile_claims_user ON profile_claims (user_id);
```

### 2.2 `profile_overrides` — the editable overlay

Modeled on `show_block_overrides`. Per **field/block**, with the divergence guard
(`source_hash` / `scrape_diverged`) copied from the wiki reconciler.

```sql
CREATE TABLE IF NOT EXISTS profile_overrides (
  entity_type     TEXT NOT NULL,        -- 'staff' | 'judge'
  entity_id       TEXT NOT NULL,
  field_key       TEXT NOT NULL,        -- see editable surface, §6
  content_json    TEXT NOT NULL,        -- Lexical envelope for prose; structured JSON for blocks; photo ref
  source_hash     TEXT,                 -- hash of the scraped value at edit time
  scrape_diverged INTEGER NOT NULL DEFAULT 0,  -- nightly reconcile sets/clears
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, field_key)
);
```

### 2.3 `profile_revisions` — append-only history

Identical shape to `show_revisions` / `jobs_revision`. Written **in the same transaction** as
every override or claim mutation (invariant I-6).

```sql
CREATE TABLE IF NOT EXISTS profile_revisions (
  revision_id   TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  target_kind   TEXT NOT NULL,          -- 'claim' | 'override'
  field_key     TEXT,                   -- null for claim ops
  actor_user_id TEXT NOT NULL,
  actor_role    TEXT NOT NULL,          -- frozen at write time
  op            TEXT NOT NULL,          -- 'claim' | 'revoke' | 'edit' | 'revert' | 'remove'
  before_json   TEXT,
  after_json    TEXT,
  summary       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_revisions_entity
  ON profile_revisions (entity_type, entity_id, created_at);
```

---

## 3. The claim flow (end to end — identical for staff & judges)

1. **Claim button** on `/staff/$personId` and `/judges/$judgeId`.
   - Unclaimed → "Is this you? Claim this profile".
   - Already owned → "Claimed" badge + a "this isn't right?" link → dispute flag (reuse the
     `jobs_flag` pattern, `contributions-db.ts:573`).
2. **Sign in** — existing better-auth (Google OAuth / passkey / magic link, `app/lib/auth.ts`),
   through the consent gate. The claim CTA routes through sign-in then returns to the profile.
3. **Name check** (server-fn, §4) — classify match `exact | close | weak`, recorded on the claim.
4. **Binding attestation dialog** (§5) — explicit, serious confirmation.
5. **Persist** — one transaction: insert `profile_claims` + a `profile_revisions` `op='claim'` row.
   Optionally seed `profile_overrides` from read-model values (so the editor opens pre-filled),
   exactly as `claimPerson` seeds jobs blocks from `readStaffProfile`/`readJudgeProfile`
   (`jobs-service.ts:832-896` — note it already branches on `entity_type`).
6. **Edit** — owner sees pageantryjobs-style forms (Formisch + Valibot, Lexical for prose) plus the
   photo editor (§6). Writes go through a new `ProfileOwnerService` (§7) gated on ownership.

---

## 4. Name matching ("check if the Google name matches our records")

A server-fn compares `session.user.name` (from Google) to the profile `display_name`:

- normalize both (lowercase, strip punctuation/diacritics/honorifics — reuse the SDK
  name-normalization used in corps identity resolution);
- compute a **token-set match** ("Bob Smith" vs "Robert Smith Jr.") plus a Levenshtein ratio;
  take the max as `name_score ∈ [0,1]`;
- classify: `exact` (≈1.0), `close` (≥ threshold, e.g. 0.8), `weak` (below).

The result is **always recorded** on the claim ("for our records"), and gates per the decision below.

### DECISION — claim gating (default: **Tiered**)

- **`exact`/`close`** → claim is `status='active'` immediately; owner can edit right away.
- **`weak`** → claim is `status='pending'`; **edits do not go live** until a moderator approves it
  from the admin console. The claim + name-match evidence is queued for review.

> Rationale: a name match plus a binding attestation suffices for the high-confidence case; the
> long tail (nicknames, stage names, married names, mismatches) gets a human gate without blocking
> everyone. Flip to "always moderator review" (every claim `pending`) for max safety, or
> "record-only" (attestation is the sole gate) for least friction. One-line policy constant.

---

## 5. The attestation (legally accurate wording)

A contractual representation gated as a condition of access — **not** a sworn legal declaration,
so it must **not** invoke "penalty of perjury" (that applies only to sworn/affidavit contexts).
Assertable consequences: breach of Terms of Service, permanent loss of access, and potential
civil/criminal exposure for fraud or impersonation (stated as possibility — the law's call).

Dialog copy (versioned via `attestation_version`):

> **Confirm this is you.**
> By continuing, you represent and affirm that you are **{display_name}**, the individual
> represented on this profile, and that you are authorized to manage it. This is a legally
> binding agreement under our Terms of Service. Knowingly claiming a profile that is not yours,
> or providing false information, is a serious violation that may result in permanent loss of
> access and can expose you to civil or criminal liability for fraud or impersonation.
>
> ☐ I understand and affirm the above.   [ Cancel ]   [ Claim this profile ]

Require an active confirmation (checkbox + button, or typed name). On confirm the server stamps
`attested_at`, `attestation_version`, `attest_ip`, `attest_user_agent`, and the name-match record.
Bumping the legal copy bumps `attestation_version`; old claims keep the version they agreed to.

---

## 6. Editable surface (incl. the photo)

Mirror the pageantryjobs block forms (`app/lib/jobs/schemas.ts`, Lexical envelope
`{format, version, doc, plain}`), keyed by `field_key`.

### DECISION — edit scope (default: **bio + facts + photo only**)

Owner may override:

- `biography` (Lexical free-form, allowlist-rendered like the wiki — `lexical-render.tsx`),
- `photo` (upload / replace / **remove** — see §6.1),
- `hometown`, `current_position`, pronouns / preferred display name, external links/socials,
- `experience` extras (additive context the scrape lacks).

Owner may **not** override the **scraped competitive record** — staff `assignments`, judge
`assignments`/`caption` history, scores, corps groupings stay read-model-authoritative (an owner
shouldn't be able to contradict the judged history). Flip to "everything overlayable" if desired.

All prose renders through the **read-only allowlist Lexical renderer** (XSS defense, I-14).

### 6.1 Photo: reuse the fantasy/pageantryjobs profile-photo upload

**Yes — reuse the existing component + service; do not build a new uploader.**

- **Upload service** — `MediaService.uploadProfilePhoto` already exists
  (`app/lib/fantasy/services/media-service.ts:105`): any authenticated actor (no league gate),
  16 MB cap, `sharp` → WebP re-encode, `.rotate()` bakes EXIF orientation (metadata/GPS stripped),
  downscale ≤512px, R2 `putUpload`, row in `fantasy_media` (sentinel empty `league_id`), returns
  `{ mediaId, url: '/api/fantasy-media/:id', width, height }`. This is exactly a profile photo —
  reuse it as-is for staff/judge photos.
- **UI** — reuse `app/components/contrib/image-drop.tsx` (the wiki drop-zone) for drag/drop + the
  client-side JPEG re-encode it already does, wired to call `uploadProfilePhoto`. (The fantasy
  league logo / jobs profile photo flows already drive this same service from the client.)
- **Store the reference** — the photo isn't a scraped column we can null; it's an overlay. On
  upload, write a `profile_overrides` row with `field_key='photo'`,
  `content_json = { mediaId, url, width, height }`, + a `profile_revisions` `op='edit'` entry.
- **Remove** — set/replace the `photo` override with a `{ removed: true }` (or empty) payload,
  `op='remove'`, in one transaction. The read merge (§7) then treats the photo as intentionally
  blank: `displayed_photo = override.removed ? null : (override.url ?? scraped.photo_url)`. We
  keep the override row (not delete it) so history + the "owner cleared the photo" intent survive
  a re-scrape that would otherwise re-surface the old scraped `photo_url`.
- The uploaded R2 object stays (cheap, immutable); only the profile's *displayed* photo changes.

---

## 7. Read-path integration (the merge — both services)

`StaffDirectoryService.getStaffProfile` (`staff-directory.ts:58`) and
`JudgeDirectoryService.getJudgeProfile` (`judge-directory.ts:65`) currently return the read-model
profile directly. Add an **overlay merge** to each (a shared helper keyed by `(entity_type,
entity_id)`):

1. read-model read → scraped profile (unchanged).
2. New `ProfileOwnerService` reads `profile_overrides` for that `(entity_type, entity_id)` from
   `contributions.db` (one indexed lookup; nothing for ~99% of unclaimed pages).
3. Apply `displayed = override ?? scraped` per field — including the photo rule in §6.1; attach an
   `ownership` block from `profile_claims` (owned/verified badge, claimed-by, `scrape_diverged`).

Keep the `StaffProfile` / `JudgeProfile` contract shape stable so SSR/loaders and the
`loadDetailOrServer` detail-shard path (`app/routes/staff/$personId.tsx`,
`app/routes/judges/$judgeId.tsx`) are unaffected. The merge is cheap and short-circuits when there's
no claim/override.

> Do **not** push overrides into the read-model emit (that couples mutable user data to the nightly
> rebuild and defeats I-2). The overlay is request-time only.

---

## 8. Authorization

Extend `app/lib/authz.ts`:

- Add capabilities `claimProfile` (min role `user`) and `manageProfileClaims` (min role
  `moderator` — approve-pending / revoke / dispute resolution).
- Add `requireProfileOwner(db, entityType, entityId)` — mirror `requireJobsProfileOwner`
  (`authz.ts:114`): throws unless the session user holds the **active** claim on that entity, with
  moderators allowed to override. Every owner-edit server-fn (incl. photo upload/remove) calls it
  first. UI gating is cosmetic; the server is the gate (I-9/I-12).

Banned users are already rejected in `getActor` (`authz.ts:98`).

---

## 9. Moderation & admin

In `/admin` (`ADMIN_PAGE_PLAN.md`, capability `manageProfileClaims`):

- **Pending-claims queue** (when gating yields `weak` → `pending`): name-match evidence,
  attestation record, approve / reject.
- **Revoke** a claim (`status='revoked'`, writes a `revoke` revision; overrides can be hidden but
  not destroyed — append-only history).
- **Dispute flags** from the public "this isn't right?" link (reuse `jobs_flag` shape).
- Full claim/override history visible (transparent, like the wiki history panel).

---

## 10. Two structural risks to handle

1. **`entity_id` stability.** Claims/overrides key on the read-model id, but the admin **identity
   merge/split** tools (`/admin/identity`) re-group staff (and could re-key judges). A merge could
   orphan a claim/override.
   - The identity-merge path must **carry `profile_claims` / `profile_overrides` along** (re-point
     `entity_id` to the surviving canonical id), and
   - the reconciler (§11) must detect + flag orphaned rows (an `entity_id` that no longer resolves).
2. **Editing facts about a real, named person.** Controls: name match + binding attestation + full
   append-only revision history + moderator revoke + public dispute flag + scraped competitive
   record kept authoritative (default edit scope).

---

## 11. Divergence reconciliation

Reuse the wiki reconciler idea (`app/lib/contrib/reconcile.ts`): nightly (after `emitReadModel`),
for each `profile_overrides` row recompute the scraped field's `source_hash`; if it changed, set
`scrape_diverged=1` so the profile shows a "the source record changed since you edited this" notice
and the owner can re-confirm. Per-field precision. Server-authoritative (client hash never trusted,
I-3/I-11). Also flag orphaned claims/overrides (risk §10.1) in this pass.

---

## 12. Build order (incremental, commit per step)

1. **Migrations** — add the three `profile_*` tables to `scripts/contributions-migrations.mjs` +
   define in `app/lib/contributions-db.ts`. (No behavior change; safe to ship.)
2. **`ProfileOwnerService`** (Effect service, `app/lib/profile-owner.ts`) — read overrides + claim,
   write override + revision atomically, `claimProfile` (name-check + attestation persist),
   `revokeClaim`. Branches on `entity_type`. Thin `createServerFn` boundaries `runPromise` it.
3. **Read merge** — wire the overlay into both `getStaffProfile` and `getJudgeProfile` via a shared
   helper; add the `ownership` block to both contracts.
4. **Authz** — capabilities + `requireProfileOwner`.
5. **Claim UI** — claim button on `/staff` + `/judges` + sign-in round-trip + name-check call +
   attestation dialog (XState machine for the claim flow; components dumb, render from `snapshot`).
6. **Editor UI** — pageantryjobs-style block/Lexical forms behind the owner gate; **photo** via the
   reused `image-drop.tsx` + `MediaService.uploadProfilePhoto` (upload / replace / remove, §6.1).
7. **Admin** — pending queue / revoke / dispute review under `manageProfileClaims`.
8. **Reconciler** — nightly divergence + orphan flagging; hook the identity-merge path to carry
   claims/overrides.

---

## 13. Terms of Service

The Terms of Service (`app/routes/terms-of-service.tsx`) were updated alongside this plan
(2026-06-29) to cover user contributions and profile ownership and to disclaim liability for
user-contributed content:

- §3 **User Content and Contributions** — replaces the stale "no user content" clause; license
  grant, user responsibility, no-pre-screening, our right to moderate/remove, and **explicit
  non-liability for User Content**.
- §4 **Accounts, Profile Claims, and Verified Profiles** — the binding-representation framing of a
  claim (matches the §5 attestation copy here), our right to verify/decline/revoke, no transfer of
  ownership, and that claimed-profile edits are User Content.
- §6 Accuracy, §8 Limitation of Liability, §9 Indemnification — extended to user-contributed
  content and profile claims.

`CURRENT_TERMS_VERSION` in `app/lib/consent.ts` was bumped to `'2026-06-29'`, so every signed-in
user is re-gated through the consent flow and must re-accept before contributing. **When the claim
attestation copy (§5) ships, keep `attestation_version` aligned with the live ToS wording**, and
bump `CURRENT_TERMS_VERSION` again if the ToS changes materially at that point.

---

## 14. Open decisions (flip in one place)

- **Claim gating** — default **Tiered** (close→instant, weak→moderator). Alternatives:
  always-review, or record-only. (§4)
- **Edit scope** — default **bio + facts + photo only** (scraped competitive record stays
  authoritative). Alternative: everything overlayable. (§6)
- **Photo storage bucket** — reuse `fantasy_media` + `/api/fantasy-media/:id` (zero new infra, the
  PageantryJobs profile-photo path) vs. a dedicated `profile_media` table/route. Default: reuse
  `fantasy_media` (it's already the generic "user-uploaded profile photo" store). (§6.1)
