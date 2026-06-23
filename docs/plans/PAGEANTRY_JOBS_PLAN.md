# PageantryJobs.com — industry job board & talent profiles — plan

A niche, industry-specific job board + professional-profile site for the pageantry
world (drum corps, marching band, winter guard, indoor percussion), branded
**PageantryJobs.com**. It behaves like a focused LinkedIn:

- **Employees** keep a profile that doubles as a public résumé / industry home page —
  structured sections + a freeform Notion-like editor, optional contact info, and are
  **searchable by criteria** (location, instrument/caption, experience, availability).
- **Employers** create an org profile, then **post jobs** (same editor) with apply /
  contact links. Employees apply via link, mailto, or on-platform.
- Later: **paid listings / boosting** and **AI résumé-parser prefill**.

Built as a **thin second brand on the existing corps.place app**, not a separate
codebase. Reuses better-auth, the contributions DB + inline-schema pattern, the
Lexical FreeForm editor + `ContribBlock` system, Formisch/Valibot structured forms,
the XState + SearchCodec filtering pattern, shadcn UI, and Resend email.

## Scope decisions (2026-06-17)

Locked with the user:

- **Same app, second domain.** One codebase, one deploy, one DB. `proxy.mjs` is
  domain-agnostic and forwards all hosts to the same backend, so PageantryJobs.com just
  points its tunnel/DNS at it. Brand is resolved per-request from the `Host` header.
- **Shared accounts.** Reuse the existing better-auth `user` table. A `jobs_profile`
  record carries the employee/employer type. One login spans both sites.
- **Ship the basics first.** v1 = profiles + jobs + apply + employer talent search.
  Payments/boosting and AI résumé parsing are fully specified here but built in later
  phases, in order.
- **Apply is a link first.** v1 "apply" is an outbound `apply_url` / mailto. On-platform
  application tracking is optional and additive.
- **Passkey stays on corps.place for v1.** WebAuthn `rpID` is domain-bound; the jobs
  domain uses magic-link + Google. Full multi-domain passkey is a v2 polish.
- **Pricing model — boost-only for v1.** Posting a job is free. Employers pay to
  "boost" a listing, which pins it to the top of search results and the landing
  page hero for a fixed period (14 / 30 / 60 days). One `jobs_order` per boost,
  processed via Stripe Checkout. Monthly subscriptions / per-posting fees are
  deferred — boost-only keeps the payment surface minimal and lets us validate
  demand before committing to a pricing model. Revisit after 100 free listings.
- **Salary fields structured.** `comp_text` (freeform) stays, but add
  `salary_min INTEGER`, `salary_max INTEGER`, `salary_currency TEXT DEFAULT 'USD'`
  to `jobs_posting`. Several US states require salary ranges in job postings;
  structured fields make compliance possible. Both are nullable — employers
  who don't want to disclose salary leave them null. The UI shows the range if
  present, else the freeform text.
- **Moderation surface is M2.5 (not deferred).** Before any public listing goes
  live, a basic moderation queue exists. A `/jobs/admin` route lists flagged
  postings, pending claims, and reported profiles. Moderators can hide/approve
  with one click. This is lightweight (a filtered query + action buttons) —
  no dashboard framework needed.

## Reuse map (what we lean on, where it lives)

**Everything is shared.** PageantryJobs is not a separate app — it's a brand
layer on the same codebase. Every component, hook, utility, and design token
from corps.place is available. Only add net-new files when the jobs domain
genuinely needs different behavior.

| Need | Reuse | Path |
|---|---|---|
| Auth (passwordless, roles) | better-auth + `authz.ts` matrix | `app/lib/auth.ts`, `app/lib/authz.ts` |
| User-writable DB + revisions | contributions DB, inline `CREATE TABLE`, append-only `*_revision` | `app/lib/contributions-db.ts` |
| Freeform editor | Lexical FreeForm + `FreeFormDoc` envelope | `app/components/contrib/lexical-free-form.tsx`, `app/lib/contrib/free-form.ts` |
| Structured sections | `block-sections.tsx` + Formisch + Valibot | `app/components/contrib/block-sections.tsx`, `app/lib/contrib/schemas.ts` |
| View/edit/sign-in gate | `ContribBlock` wrapper | `app/components/contrib/` |
| Render stored content | Lexical allowlist renderer | `app/lib/contrib/lexical-render.tsx` |
| Image upload | `ImageDrop` + R2 + `show_media` | `app/components/`, `app/lib/server-fns/contrib.ts` |
| Server fns + auth gate | `createServerFn` + Valibot + `requireCapability` | `app/lib/server-fns/contrib.ts` |
| List filtering + URL sync | XState filter machine + SearchCodec | `app/machines/event-filter-machine.ts`, `app/lib/use-search-sync.ts` |
| Substring text search | `selectJudges`-style filter | `app/lib/judge-filtering.ts` |
| Email | Resend `sendMagicLink` hook | `app/lib/auth.ts` |
| Card grid / data grid | `CorpsCard`, ReUI DataGrid | `app/components/`, `app/components/reui/data-grid/` |
| UI primitives (button, card, input, badge, dialog, sheet, etc.) | shadcn/ui + ReUI via `@/components/ui/*` and `@/components/reui/*` | `app/components/ui/`, `app/components/reui/` |
| Icons | Hugeicons via unplugin-icons (`~icons/hugeicons/<kebab>`) + `<Icon>` wrapper | `app/components/icon.tsx` |
| Animations & transitions | `motion/react` (`AnimatePresence`, `layout`, `fadeIn` variants) | `app/lib/motion-variants.ts` |
| Page layout shell | `PageShell` (`max-w-[1300px]` container + responsive padding) | `app/components/page-shell.tsx` |
| Responsive nav tokens | `pb-bottom-nav` / `pl-side-nav` / `w-side-nav` CSS vars (self-stepping at md/xl) | `app/app.css` |
| Card hover effects | `.card-hover` / `.card-hover-flat` / `.icon-shift` component classes | `app/app.css` `@layer components` |
| Design tokens | oklch `--surface-*`, `--text-*`, `--border-*`, `--primary` CSS variables + Tailwind 4 `@theme` | `app/app.css` |
| Font | `Instrument Sans Variable` (body + headings, loaded via `@fontsource-variable`) | `app/app.css` |
| Multi-step flows | XState v5 machines (`setup` + `createMachine` + `fromPromise` actors) | `app/machines/` |
| Status / empty states | `StatusCard` with tone variants (empty, info, error) | `app/components/status-card.tsx` |
| Progressive image loading | `ProgressiveImage` (blur-up placeholder → full res) | `app/components/progressive-image.tsx` |
| Staggered card grids | `StaggeredGrid` (entrance animation, responsive columns) | `app/components/staggered-grid.tsx` |
| Safe area / not-found | `useDelayedFlag`, `defaultNotFoundComponent` patterns | `app/hooks/`, `app/components/not-found.tsx` |
| Markdown-like rendering | `renderLexicalDoc` (allowlist-based, never raw HTML) | `app/lib/contrib/lexical-render.tsx` |
| Search param codecs | `SearchCodec` + `useSearchSync` (two-way machine ↔ URL bridge) | `app/lib/use-search-sync.ts` |
| Tailwind 4 configuration | `@theme` block with custom colors, spacing, radius, shadow tokens | `app/app.css` |
| Dark mode | `.dark` variant via `@custom-variant dark` — toggled by existing theme switch | `app/app.css` |

---

## Conventions & ground rules (READ FIRST — do not deviate)

These are verified facts about this repo. Guessing differently will break the build.

- **Import aliases** (from `tsconfig.json`): `@/*` → `./app/*`, `@sdk/*` → `./sdk/*`. Always
  use `@/lib/...`, never relative `../../lib`.
- **Commands** (from `package.json` — there is **no `tsc`/`eslint`/`jest`**):
  - Typecheck: `npm run check`  (alias for `vp check`)
  - Lint: `npm run lint`  ·  Format: `npm run fmt`  ·  Tests: `npm run test`
  - Dev server: `npm run dev`  (runs `gen:icons` first via `predev`)
  - Run **`npm run check` and `npm run lint` after every milestone**; both must pass.
- **Server functions** live in `app/lib/server-fns/*.ts`:
  - `import { createServerFn } from '@tanstack/react-start/client'`
  - `import { getWebRequest } from '@tanstack/react-start/server'`
  - Reads → `createServerFn({ method: 'GET' })`; writes → `{ method: 'POST' }`.
  - `.validator(fn)` then `.handler(async ({ data }) => ...)`. The validator may be a plain
    `(data: T) => data` (see `getShowContributions`) or an Effect decoder (see `saveShowBlock`).
    **For jobs, use Valibot: `.validator((d: unknown) => v.parse(SomeSchema, d))`** so the
    same schema validates client + server.
- **DB access:** `const db = await getContributionsDb()` from `@/lib/contributions-db`.
  Query with `await db.execute({ sql, args })`. Multi-write = `await db.transaction('write')`
  with `try { … await tx.commit() } catch (e) { await tx.rollback(); throw e }`. Rows come
  back as `unknown`; cast like the existing code (`as unknown as RowType`).
- **IDs & time:** `crypto.randomUUID()` for every `*_id`; `new Date().toISOString()` for every
  timestamp. Compute `now` once per write and reuse it across the row + its revision.
- **AUTH — the trap to avoid:** `requireCapability(request, action, ctx)` from `@/lib/authz`
  checks **role only**, NOT ownership. A normal `'user'` passes `'edit'`. So for jobs you MUST
  add an **ownership guard** (skeleton below) that loads the row and compares `user_id` to the
  session actor. Use `getActor(request)` / `ForbiddenError` from `@/lib/authz`. Moderators
  (role rank ≥ moderator, i.e. `can(actor, 'hideRevision')`) may override ownership for
  moderation/revoke.
- **Every write appends a `jobs_revision` row in the same transaction** (copy the
  `insertRevision` helper shape from `app/lib/contrib/store.ts`). No exceptions.
- **Fail closed on storage:** call `durableStorageStatus()` (exported from
  `@/lib/contributions-db`) at the top of each write and throw if `!ready` — mirror
  `assertWritable()` in `store.ts`.
- **Lexical content is never rendered as HTML.** Store the `FreeFormDoc` envelope
  (`{format, version, doc, plain}` — see `AboutInputSchema` in `app/lib/contrib/schemas.ts`)
  and render via `app/lib/contrib/lexical-render.tsx` (allowlist). Reuse `lexical-free-form.tsx`
  to edit and `AboutInputSchema` to validate.
- **Routes** are file-based (`app/routes/`); `routeTree.gen.ts` is **auto-generated** by the
  dev server / build — never hand-edit it. Define routes with
  `createFileRoute('/jobs/...')({ ... })`. Search params use `validateSearch` (see
  `app/routes/judges/$judgeId.tsx`).
- **Build a thin vertical slice first**, then iterate. Don't scaffold all seven routes before
  one profile saves and renders.

---

## Code skeletons (copy these shapes)

> These are deliberately concrete. Fill in fields per the schema above; keep the structure.

**1. New ownership guard — add to `app/lib/authz.ts`:**
```ts
import { getWebRequest } from '@tanstack/react-start/server';
import type { Client } from '@libsql/client';

/** Throws unless the session user owns `profileId` (moderators may override). */
export const requireJobsProfileOwner = async (db: Client, profileId: string): Promise<Actor> => {
  const actor = await getActor(getWebRequest());
  if (!actor) throw new ForbiddenError('edit');
  const row = (
    await db.execute({ sql: 'SELECT user_id FROM jobs_profile WHERE profile_id = ? LIMIT 1', args: [profileId] })
  ).rows[0] as { user_id: string } | undefined;
  if (!row) throw new Error('Profile not found');
  const isModerator = can(actor, 'hideRevision'); // rank >= moderator
  if (row.user_id !== actor.userId && !isModerator) throw new ForbiddenError('edit');
  return actor;
};
```

**2. Jobs store — new file `app/lib/jobs/store.ts`** (mirror `app/lib/contrib/store.ts`):
- `newId = () => crypto.randomUUID()`, `assertWritable()` via `durableStorageStatus()`.
- `ensureMyProfile(db, userId, kind, ctx)` → lazy-create the single profile row + revision.
- `writeProfileBlock(db, { profileId, kind, contentJson }, ctx)` → upsert by
  `(profile_id, kind)` + revision (copy `writeBlock`'s upsert/insertRevision shape exactly).
- `insertJobsRevision(tx, { targetKind, targetId, op, before, after, ctx })` → copy
  `insertRevision` from `contrib/store.ts`, writing to `jobs_revision`.
- `readPublicProfile(db, slug)` → profile + blocks (mirror `readShowPageContributions`).
- `uniqueSlug(db, base)` → slugify `display_name` with `value.toLowerCase().replace(/[^a-z0-9]+/g, '-')`
  (same normalize used in `app/components/corps-registry.tsx`), then suffix `-2`, `-3`… until
  `SELECT 1 FROM jobs_profile WHERE slug = ?` returns nothing.

**3. Server fn — in `app/lib/server-fns/jobs.ts`** (mirror `saveShowBlock`):
```ts
import { createServerFn } from '@tanstack/react-start/client';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireJobsProfileOwner } from '@/lib/authz';
import { JOBS_BLOCK_SCHEMAS, isJobsBlockKind } from '@/lib/jobs/schemas';
import { writeProfileBlock } from '@/lib/jobs/store';

const SaveBlockInput = v.object({ profileId: v.string(), kind: v.string(), content: v.unknown() });

export const saveJobsProfileBlock = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SaveBlockInput, d))
  .handler(async ({ data }) => {
    if (!isJobsBlockKind(data.kind)) throw new Error(`Unknown block: ${data.kind}`);
    const content = v.parse(JOBS_BLOCK_SCHEMAS[data.kind], data.content); // re-validate server-side
    const db = await getContributionsDb();
    const actor = await requireJobsProfileOwner(db, data.profileId);      // ownership gate
    const now = new Date().toISOString();
    const blockId = await writeProfileBlock(
      db,
      { profileId: data.profileId, kind: data.kind, contentJson: JSON.stringify(content) },
      { authorId: actor.userId, actorRole: actor.role, now }
    );
    return { ok: true as const, blockId, updatedAt: now };
  });
```

**4. Jobs block schemas — new file `app/lib/jobs/schemas.ts`** (mirror `app/lib/contrib/schemas.ts`):
- Reuse `AboutInputSchema`'s envelope shape for freeform kinds (`summary`, `about`).
- `experience`: `v.object({ items: v.array(v.object({ org: v.string(), role: v.optional(v.string(),''), startYear: v.optional(v.string(),''), endYear: v.optional(v.string(),''), description: v.optional(v.string(),'') })) })`.
- `education`, `skills` (`v.array(v.string())`), `availability` (struct), `org_details` (struct).
- Export `JOBS_BLOCK_SCHEMAS` registry + `isJobsBlockKind(k): k is keyof typeof JOBS_BLOCK_SCHEMAS`.

**5. `claimPerson` — handle the unique-constraint race explicitly:**
```ts
try {
  await db.execute({ sql: `INSERT INTO jobs_person_claim
    (claim_id, user_id, profile_id, entity_type, entity_id, status, claimed_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`, args: [newId(), userId, profileId, type, id, now] });
} catch (e) {
  if (String(e).includes('UNIQUE')) throw new Error('This page is already claimed');
  throw e;
}
```
Then read `buildStaffProfile`/`buildJudgeProfile` and seed blocks via `writeProfileBlock`
(prefill map below). Wrap insert + seed + revision in one transaction.

**6. Brand helper — new file `app/lib/brand.ts`:**
```ts
export type Brand = 'corps' | 'jobs';
export const BRAND_CONFIG = {
  corps: { name: 'Corps Place', themeClass: '', /* logo, nav, seo, magicFrom */ },
  jobs:  { name: 'PageantryJobs', themeClass: 'brand-jobs', /* … */ },
} as const;
export const getBrand = (request: Request): Brand => {
  const url = new URL(request.url);
  if (url.searchParams.get('brand') === 'jobs') return 'jobs';      // dev override
  const host = (request.headers.get('host') ?? '').toLowerCase();
  const jobsHost = (process.env.JOBS_HOST ?? 'pageantryjobs.com').toLowerCase();
  return host.includes(jobsHost) ? 'jobs' : 'corps';
};
```
Surface brand to components via a root-route `loader`/`context` (see `__root.tsx`); read it
in `index.tsx` to pick the home page. Keep the switch shallow.

---

## Architecture: one app, two brands

### Brand & visual identity

#### Domain routing
- `proxy.mjs` already sits on the Cloudflare tunnel and forwards all hosts to the same
  backend target — **no proxy code change for routing**. Add the jobs domain to the
  tunnel and to Vite's `allowedHosts` (`vite.config.ts`).
- New helper `app/lib/brand.ts` → `getBrand(request): 'corps' | 'jobs'`. Resolution
  order: explicit `?brand=` (dev) → `JOBS_HOST` env match on `Host` → default `'corps'`.

#### Brand identity tokens (`BRAND_CONFIG`)
The current skeleton expands to a full identity:

```typescript
export type Brand = 'corps' | 'jobs';

export interface BrandIdentity {
  name: string;              // "PageantryJobs"
  tagline: string;           // "The pageantry industry job board"
  themeClass: string;        // "brand-jobs"
  primaryColor: string;      // oklch value for --primary override
  logo: React.ComponentType; // SVG icon component for nav
  favicon: string;           // path to favicon asset
  navItems: Array<{ label: string; path: string; icon: IconComponent }>;
  seo: { title: string; description: string; ogImage: string };
  email: { fromName: string; fromEmail: string; magicLinkSubject: string };
}

export const BRAND_CONFIG: Record<Brand, BrandIdentity> = { ... };
```

**Visual identity for PageantryJobs:**
- **Primary color:** A professional teal/blue (`oklch(0.55 0.12 220)`) — distinct from
  corps.place's warm gold, conveys employment/professionalism.
- **Logo:** A stylized "PJ" mark (can be a simple SVG wordmark in the nav; defer a
  full logo to a designer).
- **Theme class:** `.brand-jobs` overrides `--primary`, `--primary-fg`, `--primary-muted`
  in `app/app.css`. All shadcn components automatically re-theme since they consume
  these CSS variables.
- **Nav items:** Home | Board | Talent (employer) | Post a Job (employer) | My Profile
  — different from corps.place's Events/Corps/Predictions nav.
- **Footer:** Simplified — logo, tagline, links to Terms (placeholder), Privacy
  (placeholder), and "Powered by DrumCorps.app".
- **Mobile bottom nav:** 4 items max (Home, Search/Board, Post, Profile).

#### Layout switching in `__root.tsx`
- `<html>` gets `className={brand === 'jobs' ? 'brand-jobs' : ''}` — the class toggles
  all CSS variable overrides.
- `<title>` and `<meta>` tags use `brand.seo` defaults.
- `<SiteNav>` renders `brand.navItems` instead of the corps.place nav.
- `<Footer>` renders a jobs-specific footer.
- The PageShell component keeps the same `max-w-[1300px]` container — layout and
  responsive breakpoints are shared.

#### How the switch propagates
- `getBrand()` is called once in the root `beforeLoad` and stored in the router context.
- Every route accesses `Route.useRouteContext().brand` (or a `useBrand()` hook).
- Pages under `app/routes/jobs/` are only reachable when `brand === 'jobs'` (the router
  returns 404 for `/jobs/*` under the corps brand — prevent cross-brand URL confusion).
- The `index.tsx` home route reads the brand and renders the appropriate landing. The
  switch is a single conditional — no route duplication.

### Auth (shared, multi-domain)
- In `app/lib/auth.ts`, add a `trustedOrigins` array to the `betterAuth({ … })` config
  (sibling of `baseURL`), exactly:
  ```ts
  trustedOrigins: [
    'https://corps.place', 'https://www.corps.place',
    'https://pageantryjobs.com', 'https://www.pageantryjobs.com',
    'http://localhost:5173',
  ],
  ```
  Without this, cross-domain sign-in / CSRF checks reject the jobs origin.
- `sendMagicLink({ email, url })` currently has no request in scope. Leave the corps copy as
  the default; branding the email by host is **optional polish**, not required for M1 (the
  link still works). If done later, thread the host through and switch subject/`from`/body
  via `BRAND_CONFIG`.
- **Do not touch** `rpID` / passkey config. Passkey is domain-bound and stays corps.place-only
  for v1; the jobs domain uses magic-link + Google (both work via `trustedOrigins`).
- Sessions are per-origin cookies backed by the same `user` row — signing in on each domain
  is expected and fine. No SSO work in v1.

---

## Data model — contributions DB (`app/lib/contributions-db.ts`)

All jobs tables are user-writable → contributions DB, not the read-model. Follow the
existing inline `CREATE TABLE IF NOT EXISTS` + idempotent-init pattern, the append-only
revision pattern (`show_revisions`), and `show_media` conventions for images.

> **v1 simplification (decided, removes ambiguity):** **one `jobs_profile` row per user.**
> `kind` is chosen at creation. A user is either an employee or an employer in v1 (variance:
> add a second profile later). This makes every ownership check a simple `user_id` compare
> and removes the "switch role" branch.

**EXACT steps to add the schema** (in `app/lib/contributions-db.ts`):
1. Add every DDL string below to the **existing `SCHEMA` array** (lines ~77–170) — do NOT
   create a second array or a second `getContributionsDb`. They run in `db.batch(SCHEMA,
   'write')` already, so they auto-apply on next boot. Each is `CREATE ... IF NOT EXISTS`
   so re-running is safe.
2. SQLite column types here are TEXT unless noted; booleans are `INTEGER NOT NULL DEFAULT 0`
   (SQLite has no bool). Timestamps are ISO strings (`new Date().toISOString()`), TEXT.
3. There are **no real FK constraints** in the existing schema (the app enforces relations
   in code) — match that; do not add `REFERENCES`.

```sql
-- one profile per user (v1). slug is the public URL: /jobs/profile/<slug>
CREATE TABLE IF NOT EXISTS jobs_profile (
  profile_id         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  kind               TEXT NOT NULL,                 -- 'employee' | 'employer'
  slug               TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  headline           TEXT,
  location           TEXT,
  location_lat       REAL,                          -- optional; radius search later
  location_lng       REAL,
  status             TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'published'|'hidden'
  contact_email      TEXT,
  contact_visibility TEXT NOT NULL DEFAULT 'signed_in', -- 'public'|'signed_in'|'hidden'
  links_json         TEXT,                          -- JSON: [{label,url}]
  notify_on_apply     INTEGER NOT NULL DEFAULT 1,   -- email employer on applications
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id),
  UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS idx_jobs_profile_kind_status ON jobs_profile (kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_profile_location ON jobs_profile (location);

-- structured + freeform sections; mirrors show_blocks. content_json is per-kind (see schemas).
CREATE TABLE IF NOT EXISTS jobs_profile_block (
  block_id     TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- summary|experience|education|skills|availability|gallery|about|org_details
  content_json TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  UNIQUE (profile_id, kind)              -- one block per kind per profile (v1)
);
CREATE INDEX IF NOT EXISTS idx_jobs_profile_block_profile ON jobs_profile_block (profile_id);

CREATE TABLE IF NOT EXISTS jobs_posting (
  posting_id          TEXT PRIMARY KEY,
  employer_profile_id TEXT NOT NULL,
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  location            TEXT,
  remote_ok           INTEGER NOT NULL DEFAULT 0,
  comp_text           TEXT,                          -- freeform pay string
  salary_min          INTEGER,                       -- structured salary range (nullable)
  salary_max          INTEGER,
  salary_currency     TEXT DEFAULT 'USD',
  apply_url           TEXT,
  apply_email         TEXT,
  content_json        TEXT NOT NULL,                 -- Lexical FreeFormDoc envelope (see schemas)
  status              TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'published'|'closed'|'expired'
  published_at        TEXT,
  expires_at          TEXT,
  is_boosted          INTEGER NOT NULL DEFAULT 0,    -- phase 5
  boosted_until       TEXT,                          -- phase 5
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS idx_jobs_posting_status_pub ON jobs_posting (status, published_at);
CREATE INDEX IF NOT EXISTS idx_jobs_posting_employer ON jobs_posting (employer_profile_id);

-- optional in first cut; records apply intent so employers see interest
CREATE TABLE IF NOT EXISTS jobs_application (
  application_id    TEXT PRIMARY KEY,
  posting_id        TEXT NOT NULL,
  applicant_user_id TEXT NOT NULL,
  message           TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_application_posting ON jobs_application (posting_id);

-- append-only audit; same shape as show_revisions
CREATE TABLE IF NOT EXISTS jobs_revision (
  revision_id   TEXT PRIMARY KEY,
  target_kind   TEXT NOT NULL,           -- 'profile'|'block'|'posting'|'claim'
  target_id     TEXT,
  actor_user_id TEXT NOT NULL,
  actor_role    TEXT NOT NULL,           -- role frozen at write time
  op            TEXT NOT NULL,           -- create|edit|publish|close|claim|revoke
  before_json   TEXT,
  after_json    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_revision_target ON jobs_revision (target_kind, target_id);

-- links a user to a read-model staff/judge identity (see Integration)
CREATE TABLE IF NOT EXISTS jobs_person_claim (
  claim_id    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  profile_id  TEXT NOT NULL,            -- the jobs_profile this claim feeds/links to
  entity_type TEXT NOT NULL,            -- 'staff' | 'judge'
  entity_id   TEXT NOT NULL,            -- staff person_id OR judge_id (read-model key)
  status      TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  claimed_at  TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT,
  UNIQUE (entity_type, entity_id)       -- one live claim per canonical person
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim_user ON jobs_person_claim (user_id);

-- moderation: flags on postings, profiles, and claims
CREATE TABLE IF NOT EXISTS jobs_flag (
  flag_id        TEXT PRIMARY KEY,
  flagger_id     TEXT NOT NULL,            -- user who submitted the flag
  target_kind    TEXT NOT NULL,            -- 'posting' | 'profile' | 'claim'
  target_id      TEXT NOT NULL,
  reason         TEXT,                     -- freeform text from the reporter
  status         TEXT NOT NULL DEFAULT 'open', -- 'open'|'dismissed'|'actioned'
  reviewed_by    TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_flag_status ON jobs_flag (status);
CREATE INDEX IF NOT EXISTS idx_jobs_flag_target ON jobs_flag (target_kind, target_id);

-- completed stripe orders (M5)
CREATE TABLE IF NOT EXISTS jobs_order (
  order_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,         -- 'boost'
  posting_id        TEXT,
  stripe_session_id TEXT,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'usd',
  status            TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'completed'|'refunded'
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_order_user ON jobs_order (user_id);

-- saved search alerts (M4.5)
CREATE TABLE IF NOT EXISTS jobs_alert (
  alert_id    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- 'employee' | 'employer'
  filters_json TEXT NOT NULL,             -- serialized filter state (same shape as URL params)
  frequency   TEXT NOT NULL DEFAULT 'daily', -- 'instant'|'daily'|'weekly'
  active      INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_alert_user ON jobs_alert (user_id);
```

- **Media:** reuse `show_media` (keyed by `r2_key`, not show-specific). Do NOT add a parallel
  table in v1; if scoping is ever needed, add a nullable `scope` column. (Image upload is not
  on the v1 critical path — skip galleries until a profile/posting works end-to-end.)
- **Text search:** substring matching over queried rows (low volume early), using
  `searchString` from `@/lib/utils` (already used in route loaders) or the `selectJudges`
  approach in `app/lib/judge-filtering.ts`. Add SQLite FTS5 only when volume demands it.
- **`UNIQUE (entity_type, entity_id)`** is the impersonation guard: a second `claimPerson`
  for a taken page throws on the unique-constraint violation — catch it and return a
  "already claimed" error (see skeleton).

---

## RPC / server functions — `app/lib/server-fns/jobs.ts`

Reuse the `createServerFn` + Valibot `.validator()` + auth-gate pattern from
`contrib.ts`. Ownership rule: a user may write only their own `jobs_profile` /
`jobs_posting` (check `user_id` via `getWebRequest()` session). `searchTalent` requires an
employer profile. Admin/moderator (existing `authz.ts` matrix) can hide/moderate.

- **Profiles:** `getJobsProfile(slug)`, `getMyJobsProfile()`, `upsertJobsProfile()`,
  `saveJobsProfileBlock()`, `publishJobsProfile()`.
- **Postings:** `listJobs(filters)`, `getJob(slug)`, `createJob()`, `updateJob()`,
  `closeJob()`.
- **Search:** `searchTalent(filters)` — employer-only; location/radius, captions/skills,
  kind, availability, keyword.
- **Apply:** v1 returns outbound link; optional `applyToJob()` records intent + emails the
  employer via Resend.

Every write appends a `jobs_revision` row (before/after JSON) inside the same transaction,
exactly like `saveShowBlock`.

Claim fns (see Integration): `suggestClaimMatches()`, `claimPerson(entity_type, entity_id)`,
`revokeClaim(claim_id)` (moderator), `getClaimForUser()`.

---

## Integration with staff & judge pages ("claim your page")

The site already has rich, scraped **staff** and **judge** profiles. New jobs accounts
should bootstrap from these: a user finds the page that is *them*, **claims it**, and their
jobs profile is **pre-filled** from the scraped data. This makes a brand-new profile
immediately valuable and gives PageantryJobs real reach into existing SEO pages.

### What the data looks like (from exploration)
- **Staff** identity = `person_id` (read-model, immutable; multiple `staff_id` rows merge
  into one `person_id`). Built by `sdk/src/readModel/builders/staff.ts` →
  `buildStaffProfile(db, personId)`. Fields: `display_name`, `biography`, `photo_url`,
  `assignments[]` (corps/season/title/role_type), `groups[]`, `seasons[]`, `performed[]`,
  `bioFacts` (education, award, hometown, position). Route loader:
  `app/routes/staff/$personId.tsx` → `getStaffProfile(personId)`.
- **Judge** identity = `judge_id` (read-model, immutable; **no** merge logic). Built by
  `sdk/src/readModel/builders/judges.ts` → `buildJudgeProfile(db, judgeId)`. Fields:
  `display_name`, `biography`, `photo_url`, `assignments[]` (competition/caption),
  `corpsScores[]`, `seasons[]`. Route loader: `app/routes/judges/$judgeId.tsx`.
- **They are separate entities**, and **one real human is often both** a staff member and a
  judge. A user can therefore claim **multiple** entities (≥1 staff `person_id` and/or a
  judge `judge_id`) that all feed the **same** `jobs_profile`.
- Both staff and judge pages are **read-only** today — there is no override/contribution
  layer for them (unlike the shows wiki's `show_block_overrides`).

### Trust model — auto-claim, admin reversal (decided)
- Claiming is **instant and live**: `jobs_person_claim.status = 'active'` on request, no
  approval gate. Reuse the existing role matrix (`app/lib/authz.ts`) to let moderators
  **revoke** a claim (`status='revoked'`, recorded with `revoked_by`). Every claim/revoke
  appends a `jobs_revision` row for audit.
- `UNIQUE(entity_type, entity_id)` enforces **one live claim per canonical person** — a
  second user attempting to claim a taken page is refused and pointed at a dispute path
  (moderator revoke). This is the main impersonation guard given there's no email proof.

### Discovery / matching
- On account creation (or from a "this is me?" prompt), `suggestClaimMatches()` proposes
  candidate staff/judge pages by **name-normalizing** the user's name and matching against
  read-model `display_name`. Reuse the existing despace/normalize approach
  (lowercase + strip spaces/hyphens/&/.) already used for staff identity — see
  `[[staff-bios-and-name-merge]]`. Show candidates with photo + corps + seasons so the user
  picks the right one; never auto-bind without a click.

### Prefill mapping (read-model → jobs block schema)
`claimPerson()` reads the read-model profile and seeds `jobs_profile` + `jobs_profile_block`
rows the user can then edit (it's a **copy**, not a live mirror):

| Source (staff/judge) | → Jobs profile target |
|---|---|
| `display_name`, `photo_url` | profile `display_name` + avatar/gallery |
| `biography` | `summary` freeform block (Lexical) |
| staff `assignments[]` (corps/season/title) | `experience` block entries |
| staff `bioFacts.education` | `education` block |
| staff `bioFacts.hometown` | profile `location` (seed for search) |
| staff caption/role / judge `assignments[].caption` | `skills` tag block |
| judge `assignments[]` / `corpsScores[]` seasons | `experience` (adjudication history) |
| read-model key | stored on `jobs_person_claim.entity_id` for cross-linking |

Prefill happens **once** at claim time; later re-scrapes don't overwrite user edits. Offer a
manual "re-import latest" action that previews a diff rather than clobbering.

### Cross-linking (verified badge)
- A claimed `jobs_profile` shows a **"Verified — claimed from corps.place"** badge linking
  to the source staff/judge page.
- The staff/judge route loaders (`app/routes/staff/$personId.tsx`,
  `app/routes/judges/$judgeId.tsx`) get a lightweight lookup: if an `active`
  `jobs_person_claim` exists for that `entity_id`, render a **"View this person's
  PageantryJobs profile / Hire me"** link. This is a read-only join into the contributions
  DB — no change to the read-model pipeline.

### Editing the canonical pages — later phase (decided: defer)
v1 grants **no edit rights** to the scraped staff/judge pages; claiming only seeds the
editable jobs profile and cross-links. Letting claimers edit the canonical pages requires
building a **staff/judge override + revision layer** mirroring the shows wiki
(`show_block_overrides` / `show_blocks` / `show_revisions` →
`staff_block_overrides` / `judge_block_overrides` + a render-time merge over the read-model).
That is a separate, larger effort (M7 below) and is explicitly out of v1 scope.

---

## UI / routes — `app/routes/jobs/`

| Route | Purpose | Reuses |
|---|---|---|
| `index.tsx` (+ `components/jobs/landing.tsx`) | jobs brand home: hero, search bar, featured/boosted | `PageShell`, `PageHeader` |
| `board.tsx` | job listings + filters | `job-filter-machine` + SearchCodec, `JobCard` |
| `$jobSlug.tsx` | job detail + apply | `lexical-render.tsx` |
| `talent.tsx` | employer-only talent search | filter machine + `TalentCard`/DataGrid |
| `profile/$slug.tsx` | public résumé/home page | `ContribBlock` render path |
| `me.tsx` | authed dashboard: my profile, my postings, applications | contrib editors |
| `post.tsx` | create/edit posting | Lexical + Formisch structured fields |

- **Editors:** profile & posting editors reuse `app/components/contrib/`
  (`lexical-free-form.tsx`, `block-sections.tsx`, `ContribBlock`, `ImageDrop`). Jobs block
  registry + Valibot schemas in a new `app/lib/jobs/schemas.ts` mirroring
  `app/lib/contrib/schemas.ts`.
- **Filtering:** clone `event-filter-machine.ts` → `app/machines/job-filter-machine.ts`;
  codec + selector in `app/lib/job-filtering.ts`. Filter state lives in URL search params
  via the existing `use-search-sync.ts` codec contract.
- **Branding:** jobs theme tokens in `app/app.css`; brand switch in `__root.tsx`. Reuse
  shadcn primitives; new `JobCard` / `TalentCard` modeled on `CorpsCard`.

---

## UX & design — making it feel like a real job board

### Design system — 100% shared with corps.place

PageantryJobs uses the **exact same design system** as drumcorps.app — no
separate component library, no forked CSS, no custom primitives. Everything
listed in the reuse map above is available and should be the first choice:

- **Cards, buttons, badges, inputs, dialogs, sheets, toggles** — all from
  `@/components/ui/` (shadcn) or `@/components/reui/` (ReUI). A `JobCard`
  is a `<Card className="card-hover">` with `<CardContent>` inside — exactly
  like `CorpsCard` and `EventCard`.
- **Icons** — Hugeicons via `<Icon icon={X} size="sm" />`. Every interactive
  element gets an icon. Use the same icon families as the existing site
  (e.g., `BriefcaseIcon` for jobs, `Search01Icon` for search).
- **Typography** — `Instrument Sans`, the same `text-sm font-semibold` section
  headings, the same `text-text-primary` / `text-text-secondary` color tokens.
- **Responsive layout** — `PageShell` (`max-w-[1300px] p-3 sm:p-6 md:p-8`),
  the same `flex-col lg:flex-row` sidebar pattern, the same `pb-bottom-nav`
  / `pl-side-nav` spacing tokens for mobile nav / desktop sidebar avoidance.
- **Animations** — `motion/react` with the existing `fadeIn` variant for page
  sections, `AnimatePresence` for view/edit transitions, `.card-hover` for
  card lift effects, `.icon-shift` for arrow nudges.
- **Dark mode** — already handled by the `.dark` variant on `<html>`. The
  `.brand-jobs` theme class works in both light and dark modes automatically.
- **Empty states** — use the same redesigned pattern from the show wiki plan
  (§4.6 M26): hero icon in tinted circle, contextual copy, visible action
  button. Don't invent a new empty state pattern.
- **New jobs-specific cards** (`JobCard`, `TalentCard`) should be modeled
  directly on `CorpsCard` (`app/components/corps-card.tsx`) — same structure,
  same hover effect, same icon-shift arrow.

**When to NOT reuse:** Only build a new component if the jobs domain genuinely
needs different behavior (e.g., the employer dashboard stat cards are a new
layout pattern not found on corps.place). For everything else, import and
compose.

The show wiki plan (§4.6 of the main plan) identified that "make it work" UI
feels prototype-ish. These same principles apply here — apply them from day one
rather than retrofitting.

### Profile page layout (employee — the portfolio)

The public profile at `/jobs/profile/<slug>` is the core employee asset — it is
their industry home page. Layout:

```
┌──────────────────────────────────────────────────┐
│ [Photo]   Display Name           ┌────────────┐ │
│            Headline              │ Contact btn │ │
│            Location · Badge      └────────────┘ │
│            "Verified — from corps.place" badge   │
├──────────────────────────────────────────────────┤
│ Summary (Lexical freeform)                       │
│  ┌────────────────────────────────────────────┐  │
│  │                                            │  │
│  │ Lexical-rendered prose (full width)        │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│ Experience                            [+ Edit]   │
│  ┌────────────────────────────────────────────┐  │
│  │ Org · Role · Years                         │  │
│  │ Description                                │  │
│  ├────────────────────────────────────────────┤  │
│  │ Org · Role · Years                         │  │
│  │ Description                                │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│ Skills                               [+ Edit]   │
│  [Brass] [Visual] [Percussion] [Marching]        │
├──────────────────────────────────────────────────┤
│ Availability                         [+ Edit]   │
│  Full-time · Seasonal (Summer) · Willing to      │
│  relocate                                         │
├──────────────────────────────────────────────────┤
│ Education                            [+ Edit]   │
│  School · Degree · Year                          │
├──────────────────────────────────────────────────┤
│ Gallery (photos/video)               [+ Edit]   │
│  [img] [img] [img]                               │
└──────────────────────────────────────────────────┘
```

- Each section is a `<Card>` with the consistent heading pattern from the main
  site (`text-base font-semibold`). The "Edit" button in the heading row is
  always visible when the profile owner is signed in (`variant="outline" size="sm"`).
- Empty sections show the redesigned empty state (hero icon + tinted circle,
  "Add experience" button) — same pattern from §4.6 M26 of the show wiki plan.
- Contact button at the top is a primary CTA. Its visibility is gated by
  `contact_visibility` (server-enforced, never client-only).
- The "Verified — from corps.place" cross-link badge (M2.5) appears below the
  headline.
- Mobile: sections stack, the photo/header goes full-width, contact button
  becomes full-width below the name.

### Employer org profile

Similar to employee but with different blocks:

```
┌──────────────────────────────────────────────────┐
│ [Logo]   Org Name                                │
│          Tagline · Location                       │
├──────────────────────────────────────────────────┤
│ About (Lexical freeform)                         │
├──────────────────────────────────────────────────┤
│ Open Positions (live feed of postings)           │
│  ┌────────────────────────────────────────────┐  │
│  │ Brass Tech — [City, State] — Remote OK     │  │
│  │ Posted 3d ago                              │  │
│  ├────────────────────────────────────────────┤  │
│  │ Percussion Caption Head — [City]           │  │
│  │ Posted 1w ago                              │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│ Past seasons / history (from scraped data)       │
└──────────────────────────────────────────────────┘
```

- "Open Positions" is a live query of `jobs_posting WHERE employer_profile_id
  = ? AND status = 'published'`. Can use TanStack DB collection if needed.
- The org profile can optionally attach to an existing corps entity to reuse
  its logo/identity (open question — see §10).

### Claim UX flow (M2.5) — full design

The claim process has five states. Each should feel deliberate, not surprising:

**State 1 — Suggestion prompt.** When a user visits `me.tsx` and has no claims
yet, the page shows a card above the profile editor:

```
┌──────────────────────────────────────────────────────┐
│ 📋 Claim your page                                   │
│                                                      │
│ We found staff/judge pages that might match you.     │
│ Claim one to pre-fill your profile from existing     │
│ data and show a verified badge on your profile.       │
│                                                      │
│ ┌─────────────────┐  ┌─────────────────┐            │
│ │ [photo]         │  │ [photo]         │            │
│ │ Jane Smith      │  │ Jane Smith      │            │
│ │ Judge, DCI      │  │ Visual Caption  │            │
│ │ 2019–2025       │  │ Head, Bluecoats │            │
│ │                 │  │ 2022–2024       │            │
│ │ ┌───────────┐   │  │ ┌───────────┐   │            │
│ │ │ This is me │   │  │ │ This is me │   │            │
│ │ └───────────┘   │  │ └───────────┘   │            │
│ └─────────────────┘  └─────────────────┘            │
│ ─── or ───                                         │
│ [Search for your name] [Skip]                       │
└──────────────────────────────────────────────────────┘
```

- Candidates are shown in a horizontal scroll (or vertical list on mobile).
- Each card shows photo, name, role description, and a "This is me" button.
- "Skip" dismisses the prompt permanently (sets a flag in machine context).
- "Search for your name" opens a text search against the read-model.

**State 2 — Claiming.** User clicks "This is me" → button shows a spinner →
server validates + prefill runs:

- If another user already claimed this entity: show an error with a "Report"
  link (moderator dispute path).
- On success: transition to State 3.

**State 3 — Prefill review.** Show a diff-like summary of what was imported:

```
┌──────────────────────────────────────────────────────┐
│ ✅ Claimed as Jane Smith — Judge                     │
│                                                      │
│ We've pre-filled your profile from corps.place data: │
│                                                      │
│ ✓ Summary — imported from biography                   │
│ ✓ Experience — 12 assignments imported                │
│ ✓ Skills — Brass, Visual, Percussion                  │
│ ✓ Location — set to "Indianapolis, IN"               │
│ ✓ Education — not found, add manually                 │
│                                                      │
│ ┌──────────────────┐   ┌──────────────────┐         │
│ │ Edit my profile  │   │ View my profile  │         │
│ └──────────────────┘   └──────────────────┘         │
└──────────────────────────────────────────────────────┘
```

**State 4 — Claimed (subsequent visits).** The prompt card is replaced by a
small "You have claimed N pages" badge with a "Manage claims" link to a claim
management interface.

**State 5 — Multiple claims.** A user can claim multiple entities (e.g. judge
+ staff for different corps). Each claim seeds a separate prefill, but they all
feed the same `jobs_profile`. Blocks imported later merge with (don't replace)
existing ones — new `experience` entries are appended, not clobbered.

### Application notifications (move from backlog to M3)

When a candidate applies to a job (via `applyToJob` or outbound link tracking),
the employer must be notified. This is core to the board working — not backlog:

- **On apply (in-platform):** `applyToJob` → insert `jobs_application` row →
  send email via Resend to the employer's `contact_email` on their profile:
  - Subject: "New application: {Job Title} from {Applicant Name}"
  - Body includes applicant name, a link to their public profile, and their
    message (if any).
- **On outbound link click (tracked):** Not a blocking feature — skip for v1.
  The apply URL is just a link. If tracking is added later, wrap the URL in a
  redirect endpoint.
- **Notification preferences:** A simple opt-out on the employer profile
  (`notify_on_apply INTEGER NOT NULL DEFAULT 1`). Add the column to
  `jobs_profile`.

### Mobile UX principles

Job boards are heavily used on phones. These constraints apply from M1:

- **Filter drawer on mobile:** The job board filter panel becomes a slide-over
  drawer (not a sidebar). Use the existing `Sheet` component from shadcn.
  Trigger: a "Filters" button with a funnel icon in the header bar.
- **Single-column layouts everywhere:** Profile, board, posting editor — all
  stack to one column below `md` breakpoint. No horizontal scrolling.
- **Job card tap target:** Minimum 48 px for the whole card (tap navigates to
  detail). The apply button is always visible, not hidden behind hover.
- **Posting editor on mobile:** Lexical toolbar collapses to overflow scroll
  (same pattern as the show wiki M11). Formisch array items stack vertically.
- **Profile editing:** Form sections collapse into an accordion on mobile so
  the user isn't faced with every block at once.
- **Bottom-sheet for claim suggestions:** On mobile, the claim suggestion cards
  render in a scrollable bottom sheet (`Sheet` from `side=bottom`) instead of
  an inline card grid.

### Empty / no-results states

Every list view needs a deliberate empty state:

- **Board (no jobs match filters):** A search illustration (magnifying glass
  icon in tinted circle) + "No jobs match your filters" + "Try broadening your
  search" + quick-action buttons for common filter resets (clear location,
  show remote only).
- **Board (no jobs exist at all):** "No jobs posted yet — be the first!" +
  "Post a job" CTA (visible to employers).
- **Talent search (no matches):** Similar to board — "No talent matches your
  search" + broadening suggestions.
- **My postings (none yet):** "You haven't posted any jobs" + "Post your first
  job" CTA.
- **My applications (none):** "You haven't applied to any jobs yet" + link to
  the board.
- **Profile empty sections:** Use the redesigned empty state from show wiki §4.6
  (hero icon + tinted circle + contextual copy + "Add" button).

### Pagination for listings

Job board and talent search use offset-based pagination (not cursor — sorting
by `published_at DESC` means new entries appear at the top, and offset is
simpler for the initial v1):

- Server fns accept `{ offset: number; limit: number }` (default limit = 20).
- Client uses a `useActionState`-based "Load more" button (same pattern as the
  merch page `app/routes/merch/index.tsx` — the third return is the pending flag).
- Infinite scroll is deferred (the "Load more" button is simpler and avoids
  scroll-position jank).
- Boosted jobs sort first, then by `published_at DESC`.

### SEO for jobs (move from risk to committed M3 deliverable)

Jobs pages need their own SEO strategy — they compete in search against other
job boards:

**Sitemap:**
- After M3, add a brand branch in `app/routes/sitemap[.]xml.ts`: if
  `brand === 'jobs'`, emit `/jobs/profile/<slug>` and `/jobs/<jobSlug>` URLs.
  The sitemap already supports per-request dynamic generation — add a
  `getAllJobsProfiles()` and `getAllPublishedPostings()` server fn.
- Robots.txt stays the same (it already delegates to the sitemap).

**Structured data (JSON-LD):**
- Job posting detail page (`$jobSlug.tsx`) emits `schema.org/JobPosting`:
  ```json
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "Brass Caption Head",
    "description": "…",
    "datePosted": "2026-06-01",
    "validThrough": "2026-08-01",
    "hiringOrganization": { "@type": "Organization", "name": "Blue Devils" },
    "jobLocation": { "@type": "Place", "address": { "addressLocality": "Concord, CA" } },
    "employmentType": "SEASONAL",
    "remote": true,
    "baseSalary": { "@type": "MonetaryAmount", "description": "Competitive" }
  }
  ```
- Profile pages emit `schema.org/Person` (employee) or `schema.org/Organization`
  (employer).

**Meta tags:**
- Board page: branded og tags ("PageantryJobs — Find pageantry industry jobs").
- Job detail: title includes job title + org ("Brass Tech at Blue Devils —
  PageantryJobs"), description is a 160-character excerpt from the Lexical body.
- Profile: title includes "Jane Smith — PageantryJobs profile", description
  from the summary block or headline.

### Onboarding wizard — guided profile creation

A new user landing on an empty profile won't know where to start. A wizard
mode (`/jobs/onboard`) walks through each block in sequence with a progress bar:

```
Step 1/5: About you ───────────────────── ●●●○○○
┌──────────────────────────────────────────────┐
│ Name: [________]                              │
│ Headline: [Brass Caption Head | Instructor]   │
│ Location: [________]                          │
│                                              │
│ [Skip this step]  [Continue →]               │
└──────────────────────────────────────────────┘
```

- Steps: About You → Experience → Skills → Availability → Review & Publish.
- Each step corresponds to one `jobs_profile_block` kind.
- "Skip" leaves the block empty (the profile still publishes with missing
  sections — better a published profile with gaps than a draft that never
  ships).
- After the last step, the profile is set to `status='published'` and the user
  lands on their public profile with a "Profile is live!" banner.
- Users can exit the wizard at any step (their progress is saved because each
  step autosaves on "Continue"). A dashboard card on `me.tsx` prompts them to
  resume.
- The wizard is optional — users can still edit blocks individually on `me.tsx`.
- **Mobile:** steps are full-screen with a sticky progress bar. Form fields
  stack vertically. "Continue" is a sticky bottom button.

### Employer dashboard layout

`me.tsx` for employers is not "my profile" — it's their operations center:

```
┌──────────────────────────────────────────────────┐
│ [Org Logo]  Org Name                [View Profile]│
│             Tagline                                │
├──────────────────────────────────────────────────┤
│  ◆ Dashboard  |  Postings  |  Applications       │  ← tabs
├──────────────────────────────────────────────────┤
│                                                    │
│  Welcome back, Org Name                            │
│                                                    │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐         │
│  │  3   │  │  12  │  │   2  │  │  89  │         │
│  │ Open │  │ Total│  │ New  │  │Views │         │
│  │Jobs  │  │Apply │  │Apps  │  │ this │         │
│  └──────┘  └──────┘  └──────┘  └──────┘         │
│                                                    │
│  ┌ Recent applications ────────────────────────┐  │
│  │ Jane Smith — Brass Tech        2h ago   [View]│  │
│  │ John Doe — Percussion Asst.    1d ago   [View]│  │
│  └───────────────────────────────────────────────┘  │
│                                                    │
│  ┌ Your postings ─────────────────────────────┐   │
│  │ Brass Caption Head — Concord, CA  [12 apps] │   │
│  │  Posted 3d ago · Boosted · Expires 8/1     │   │
│  │                                            │   │
│  │ Visual Designer — Remote          [3 apps]  │   │
│  │  Posted 1w ago · Expires 8/15              │   │
│  └────────────────────────────────────────────┘   │
│                                                    │
│  [+ Post a new job]                                │
└────────────────────────────────────────────────────┘
```

- Three tabs: Dashboard (overview), Postings (manage all listings), Applications
  (inbox). Tab state is a URL search param — shareable, back-button-safe.
- Stat cards show live counts from the DB (open jobs, total applications,
  unread applications, profile views — views start as 0, populated later).
- Recent applications is the most recent 5, with applicant name, job title,
  and time. No read receipts in v1 — just timestamp.
- "Post a new job" is a persistent primary button.
- **Mobile:** tabs become a horizontal scroll; stat cards stack 2×2; recent
  apps and postings are full-width list items.

This dashboard replaces the current plan's vague "my profile, my postings,
applications" description. The employee `me.tsx` keeps the dashboard concept
but shows profile completeness stats, recent activity, and quick-edit links.

### Landing page — the conversion surface

The current plan says "hero, search bar, featured/boosted" — not enough to
convert a visitor into a signed-up user. The landing page should tell a
story in three scroll sections:

1. **Hero:** Value prop headline ("Find your next gig in the pageantry world"),
   search bar (keyword + location), and a CTA ("Post a job" / "Create profile").
   Background: a subtle pattern or gradient — no heavy imagery (we don't have
   license for stock photos of marching arts).

2. **Social proof:** "Join X professionals and Y employers" (live counts from
   DB). A logo grid of featured employers (corps that have posted jobs). If
   no employers yet, show a "Be the first employer" CTA instead.

3. **How it works:** Three steps — Create profile (icon: user-plus) → Get
   discovered (icon: search) → Apply or hire (icon: handshake). Short text
   per step, no more than one line.

4. **CTA footer:** "Ready to find your next opportunity?" with two buttons:
   "Create your profile" (employee) and "Post a job" (employer).

- **Mobile:** Each section collapses to a single column, the search bar is
  full-width, stat counters stack vertically.
- **Empty states for the landing:** Pre-launch, when there are 0 jobs and 0
  profiles, hide the stats row entirely and show "Coming soon — be the first"
  messaging instead. The "How it works" section stays visible.

### Application confirmation flow

When a candidate applies to a job, the current plan only sends the employer
an email. The candidate gets nothing. For trust and clarity:

- **In-app confirmation:** After `applyToJob` succeeds, show a success panel
  on the job detail page:
  ```
  ┌────────────────────────────────────────────┐
  │ ✅ Application sent                        │
  │                                            │
  │ Your application for "Brass Caption Head"  │
  │ at Blue Devils has been sent.              │
  │                                            │
  │ The employer will reach out directly.      │
  │                                            │
  │ [View my applications] [Back to board]     │
  └────────────────────────────────────────────┘
  ```
- **Confirmation email:** Send the candidate a confirmation via Resend:
  Subject: "Application sent: {Job Title} at {Org Name}".
  Body: "Hi {Name}, your application for {Job Title} at {Org Name} was sent
  on {date}. The employer has your contact info and will follow up. You can
  track your applications on your dashboard."
- **Application history:** The "View my applications" link goes to a list on
  `me.tsx` showing every job the user has applied to, with status (sent /
  viewed — no read receipts in v1, just sent). This is a simple SELECT over
  `jobs_application` joined to `jobs_posting`.

### Saved search alerts (M4.5 — between search and payments)

A user shouldn't have to check the board daily. After M4 (talent search),
add alert subscriptions:

- **Trigger:** On the board and talent search pages, after executing a search,
  show a "Save this search" button: "Get notified when new jobs match your
  search."
- **Schema:** `jobs_alert` table (already defined above). Stores the serialized
  filter state as JSON (same shape as the URL search params — round-trips
  through the existing `SearchCodec`).
- **Frequency:** 'instant' (email on every new match), 'daily' (digest once
  per day), 'weekly' (digest once per week). Default 'daily'.
- **Cron / sweep:** No cron infrastructure exists. For v1, send alerts
  on-the-fly when a new job is published: `createJob` / `publishJob` checks
  for matching alerts and fires emails. This handles the core use case (new
  job alert) without needing a background worker. Daily/weekly digests can be
  a simple `setInterval` in the Node process or a periodic server fn call.
- **Unsubscribe:** One-click link in the email footer: "Unsubscribe from this
  alert" → sets `active = 0`.

### Success metrics — how we know the board is working

Without planned metrics, future priorities are guesses. Track from day one:

| Metric | Where captured | When to review |
|---|---|---|
| Profiles created (employee) | `jobs_profile` count | After M2 |
| Profiles published | `jobs_profile WHERE status='published'` | After M2 |
| Jobs posted | `jobs_posting` count | After M3 |
| Applications sent | `jobs_application` count | After M3 |
| Claims made | `jobs_person_claim` count | After M2.5 |
| Search-to-apply rate | applications / profile views | After M4 |
| Repeat employer rate | employers with >1 posting | After M3 |
| Profile views | server fn call count (start simple) | After M4 |
| Alert subscriptions | `jobs_alert` count | After M4.5 |

These are read from the DB directly (no analytics SDK). Surface the employer
stats on their dashboard ("X applications this week") and use the aggregate
counts on the landing page ("Join X professionals").

---

> Each step is atomic. After each milestone run `npm run check && npm run lint` — both must
> pass before moving on. Build the M2 vertical slice (one block saving + rendering) before
> adding more block kinds.

### M0 — Legal & policy scaffolding (before any public user data)

Before any real user creates a profile or posts a job, the legal surface must
exist. These are placeholder pages — they don't need polished copy, but they
must exist so the site isn't operating without terms:

1. Create placeholder routes: `/jobs/terms`, `/jobs/privacy`, `/jobs/guidelines`
   (content policy for job postings). Each is a static page rendered from
   markdown or hardcoded text with a note: "These terms are a work in progress
   and will be finalized before public launch."
2. Add a `accepted_terms_version TEXT` column to `jobs_profile` — users accept
   on signup. Set to `'2026-06-placeholder'` for now.
3. Document the GDPR/CCPA deletion path: a moderator "purge user" action that
   nulls PII columns on `jobs_profile`, removes `jobs_application` rows, and
   writes a final `jobs_revision` noting the purge (the revision row itself is
   retained for audit but with PII stripped).
4. **Acceptance:** `/jobs/terms`, `/jobs/privacy`, `/jobs/guidelines` render; the
   `accepted_terms_version` column exists; the purge procedure is documented.
   No lawyer review required for v1 — these are placeholders that prevent
   operating without any terms at all.

### M1 — Foundations (domain renders, no jobs features yet)
1. Add all jobs DDL strings to the `SCHEMA` array in `app/lib/contributions-db.ts` (see
   Data model). **Acceptance:** `npm run dev`, then in another shell
   `sqlite3 sdk/contributions.db ".tables"` lists all jobs tables including
   `jobs_flag`, `jobs_order`, `jobs_alert`.
2. Create `app/lib/brand.ts` with `getBrand` + `BRAND_CONFIG` (skeleton above).
3. Add `trustedOrigins` to `app/lib/auth.ts` (exact array above).
4. Add the jobs host to `allowedHosts` in `vite.config.ts` (find the existing `allowedHosts`
   list with `drumcorps.app`; add `'pageantryjobs.com'`, `'*.pageantryjobs.com'`).
5. Expose brand from the root route: add a `loader`/`beforeLoad` in `app/routes/__root.tsx`
   that calls `getBrand(getWebRequest())` and returns `{ brand }`; branch `<title>` + favicon
   on it. **Acceptance:** corps.place renders unchanged.
6. Add a `.brand-jobs` theme block to `app/app.css` (copy the `:root` token block; override
   `--primary` etc.). Create `app/components/jobs/landing.tsx` (a plain component, NOT under
   `routes/` — anything in `routes/` becomes a URL). Import it from `index.tsx`.
7. Make `app/routes/index.tsx` brand-aware: if `brand === 'jobs'` render `<JobsLanding/>`,
   else the existing home. **Acceptance:** `npm run dev`, open
   `http://localhost:5173/?brand=jobs` → jobs landing; `http://localhost:5173/` → corps home.

### M2 — Profiles (the LinkedIn résumé core) — DO THIS AS A VERTICAL SLICE
1. Create `app/lib/jobs/schemas.ts` — start with ONLY the `summary` (freeform) and
   `experience` kinds + `JOBS_BLOCK_SCHEMAS`/`isJobsBlockKind`. Add the rest after the slice
   works.
2. Add `requireJobsProfileOwner` to `app/lib/authz.ts` (skeleton above).
3. Create `app/lib/jobs/store.ts` — `newId`, `assertWritable`, `insertJobsRevision`,
   `ensureMyProfile`, `writeProfileBlock`, `readPublicProfile`, `uniqueSlug` (skeletons above).
4. Create `app/lib/server-fns/jobs.ts` — `getMyJobsProfile`, `upsertJobsProfile`
   (creates the single profile via `ensureMyProfile`, sets `kind`/`display_name`/`slug`),
   `saveJobsProfileBlock` (skeleton above), `publishJobsProfile` (set `status='published'`),
   `getJobsProfile(slug)` (public read). Each write appends a `jobs_revision` row.
5. Create `app/routes/jobs/me.tsx` — gated by `useSession()` (`@/lib/auth-client`); create
   profile if none, then edit the `summary` block with `lexical-free-form.tsx` and the
   `experience` block with a Formisch form bound to the Valibot schema. Wrap each in
   `ContribBlock`. **Acceptance:** signed-in user saves a summary; a `jobs_revision` row
   appears (`sqlite3 … "SELECT op,target_kind FROM jobs_revision"`).
6. Create `app/routes/jobs/profile/$slug.tsx` — public read via `getJobsProfile`, render the
   freeform block with `lexical-render.tsx` and structured blocks plainly. **Acceptance:**
   the published profile renders all saved sections at `/jobs/profile/<slug>`; a second
   signed-in user gets `ForbiddenError` trying `saveJobsProfileBlock` on someone else's
   `profileId`.
7. Add remaining block kinds (`education`, `skills`, `availability`, `gallery`,
   `org_details`) to `schemas.ts` + `me.tsx` once 5–6 pass.

### M2.5 — Claim your page (staff/judge → jobs profile) — depends on M2
1. Add claim fns to `app/lib/server-fns/jobs.ts`:
   - `suggestClaimMatches()` — normalize the session user's `name`
     (`value.toLowerCase().replace(/[^a-z0-9]+/g, '')`) and match against read-model staff/judge
     `display_name`; return candidates `{entity_type, entity_id, display_name, photo_url, corps, seasons}`.
   - `claimPerson({ entity_type, entity_id })` — insert into `jobs_person_claim` with the
     UNIQUE-race handling (skeleton 5), then read `buildStaffProfile`/`buildJudgeProfile`
     (`@sdk/src/readModel/builders/{staff,judges}`) and seed blocks via `writeProfileBlock`
     per the Prefill mapping. One transaction. Append a `claim` revision.
   - `getClaimForUser()` — return the user's active claim(s).
   - `revokeClaim({ claimId })` — moderator-only (`requireCapability(getWebRequest(),
     'hideRevision')`); set `status='revoked'`, `revoked_by`, append a `revoke` revision.
2. **XState claim flow machine** (`app/machines/jobs-claim-machine.ts`): a machine with
   states `idle → suggesting → claiming → claiming (error: already_claimed / success:
   prefill_review → claimed`. The React component renders different UI per state
   (suggestion cards, loading spinner, prefill summary, claimed badge). Actions call the
   server fns. This prevents the "flash of wrong state" that manual `useState` + `async`
   would produce.
3. In `app/routes/jobs/me.tsx`, integrate the claim machine. Show the full claim UX flow
   (suggestion cards → "This is me" → loading → prefill review → success/edit).
   Implement ALL five states described in the UX & design section above.
4. In `app/routes/staff/$personId.tsx` and `app/routes/judges/$judgeId.tsx` loaders, add a
   read-only lookup: `SELECT profile_id … FROM jobs_person_claim c JOIN jobs_profile p …
   WHERE entity_type=? AND entity_id=? AND status='active'`; if found, render a "View
   PageantryJobs profile" link to `/jobs/profile/<slug>`. **Acceptance:** claiming prefills
   the profile; the staff/judge page shows the link; a second claim of the same page returns
    "already claimed"; moderator revoke removes the link + writes a `revoke` revision.
5. **Moderation surface (`/jobs/admin`):** a simple route listing three queues:
   - **Flagged postings:** `SELECT * FROM jobs_flag WHERE target_kind='posting'
     AND status='open'` joined to `jobs_posting`. Each row shows the posting
     title, reason, and "Dismiss" / "Hide posting" buttons.
   - **Flagged profiles:** same pattern for `target_kind='profile'`.
   - **Pending claims:** claims where the entity has >X assignments (configurable
     threshold, default 5) — these get a "Review" button that routes to a
     manual approval flow. Claims under the threshold are auto-approved.
   - Action buttons call server fns that update `jobs_flag.status` and (for
     hides) set `jobs_profile.status='hidden'` or `jobs_posting.status='closed'`.
     All actions append a `jobs_revision` row for audit.
   - Gated by `requireCapability(getWebRequest(), 'hideRevision')` (existing
     moderator role). **Acceptance:** a moderator can see the queue, dismiss a
     flag, hide a posting, review and revoke a claim — each action is audited.

### M2.6 — Onboarding wizard (`/jobs/onboard`)

A step-by-step wizard that replaces the blank profile editor for first-time users.
1. Create `app/machines/jobs-onboard-machine.ts` — XState machine with states
   for each step (`about` → `experience` → `skills` → `availability` → `review`),
   context holding the accumulated block data, and an `onComplete` action that
   publishes the profile.
2. `app/routes/jobs/onboard.tsx` — renders the wizard UI per the UX & design
   section. Each step is an `AnimatePresence`-wrapped form section.
3. Each step autosaves on "Continue" via `saveJobsProfileBlock`, so exiting
   mid-wizard preserves progress. A "Resume onboarding" prompt shows on `me.tsx`
   if the profile is still `status='draft'` and the wizard wasn't completed.
4. After the final step, set `status='published'` and redirect to the public
   profile page with a success banner.
5. **Mobile:** steps are full-screen with sticky progress bar and sticky
   "Continue" button. **Acceptance:** a new user can complete all five steps,
   see their published profile, and edit individual blocks on `me.tsx` afterward.
   Exiting mid-wizard and returning resumes from the incomplete step.

### M3 — Postings + apply
1. Posting server fns in `jobs.ts`: `createJob`, `updateJob`, `closeJob` (gate with
   `requireJobsProfileOwner` on the employer profile that owns the posting — load
   `employer_profile_id` → its `user_id`), `getJob(slug)`, `listJobs(filters)` with
   `{ offset, limit }` pagination. Body is a `FreeFormDoc` envelope validated by the reused
   `AboutInputSchema`. Revisions on every write.
2. `app/routes/jobs/post.tsx` — employer-only editor (Lexical body + Formisch fields:
   title, location, remote_ok, comp_text, apply_url/apply_email).
3. `app/machines/job-filter-machine.ts` + `app/lib/job-filtering.ts` — **copy
   `event-filter-machine.ts` verbatim** and adapt fields (keyword `q`, location, remote,
   caption). Wire URL sync with `useSearchSync` + a `SearchCodec` exactly like
   `eventFilterSearchCodec`.
4. `app/routes/jobs/board.tsx` — list with filters, "Load more" button using `useActionState`
   (same pattern as merch page `app/routes/merch/index.tsx`). `validateSearch` like
   `judges/$judgeId.tsx`. Empty/no-results states per UX & design section.
5. `app/routes/jobs/$jobSlug.tsx` — detail via `lexical-render.tsx` + apply button →
   `apply_url`/`mailto:apply_email`. Emit `schema.org/JobPosting` JSON-LD in `head()`.
   **Acceptance:** posting appears on the board; changing a filter updates the URL and
   survives reload; detail renders with structured data; "Load more" pagination works.
6. **Application notifications (not optional — core to the board working):**
   - Add `notify_on_apply INTEGER NOT NULL DEFAULT 1` column to `jobs_profile` (employers
     can opt out).
   - `applyToJob({ postingId, message? })` server fn: records a `jobs_application` row,
     then sends email via Resend to `jobs_profile.contact_email` of the posting's employer.
     Email subject: "New application: {Job Title} from {Applicant Name}".
     Email body includes applicant name, link to `/jobs/profile/<slug>`, and the message.
    - The apply button on the job detail calls `applyToJob` if the user is signed in and
      the posting has `apply_url` (defer on-platform apply only — outbound links are still
      the v1 primary path). For outbound-only postings, skip the server fn.
   - **Candidate confirmation (not optional):** After `applyToJob` succeeds, show an
     in-app success panel with "Application sent" + "View my applications" link.
     Send a confirmation email to the candidate via Resend:
     Subject: "Application sent: {Job Title} at {Org Name}".
     Track applications on `me.tsx` with a simple list over `jobs_application`.
7. **Jobs sitemap + SEO (committed, not backlog):**
   - New server fns: `getAllJobsProfiles()` and `getAllPublishedPostings()` for sitemap
     enumeration.
   - Add brand branch to `app/routes/sitemap[.]xml.ts`: if `brand === 'jobs'`, emit
     jobs profile and posting URLs.
   - `$jobSlug.tsx` `head()`: emit `schema.org/JobPosting` JSON-LD + branded og tags.
   - `profile/$slug.tsx` `head()`: emit `schema.org/Person` or `schema.org/Organization`
     JSON-LD. Meta description from summary block or headline.
   - Board `head()`: branded og tags ("PageantryJobs — Find pageantry industry jobs").

### M4 — Employer talent search
1. `searchTalent(filters)` server fn — **employer-only** (load the caller's profile; if
   `kind !== 'employer'` throw). Filter published employee profiles by location substring,
   skills, availability, keyword (substring over queried rows; use indexes already added).
2. `app/routes/jobs/talent.tsx` — filter machine + `TalentCard` grid (model on `CorpsCard`).
3. **Contact-visibility enforcement (server-side, every read path):** in `getJobsProfile`
   and `searchTalent`, blank `contact_email` unless `contact_visibility==='public'`, or
   `'signed_in'` with a session present. Never rely on the UI to hide it.
   **Acceptance:** an employer search returns matches; a `hidden`/`signed_in` profile never
   leaks `contact_email` to the wrong viewer (verify by calling the fn signed-out).

### M4.5 — Saved search alerts (between search and payments)
1. Alert server fns in `jobs.ts`: `createAlert({ kind, filtersJson, frequency })`,
   `listMyAlerts()`, `deleteAlert(alertId)`, `unsubscribeAlert(alertId)`.
2. On the board and talent search pages, add a "Save this search" button after
   a search is executed. Opens a small dialog with frequency picker (Instant /
   Daily / Weekly) and a "Save" button.
3. **Fire alerts on publish:** In `publishJob` / `createJob`, after the posting
   is live, query `jobs_alert WHERE kind='employee' AND active=1` and check
   each alert's `filters_json` against the new posting via the same filter
   logic used in `listJobs`. For matching alerts, send an email via Resend:
   Subject: "New job: {Job Title} at {Org Name} — matches your search".
   Body includes the job title, org, location, comp, and a link to the posting.
   For non-matching alerts, skip (no "no new jobs" emails — silence means
   nothing matched).
4. **Unsubscribe:** One-click link in every alert email:
   `{origin}/jobs/alerts/unsubscribe?alertId={id}` → sets `active=0`.
5. **Acceptance:** an employee saves a search; an employer posts a matching job;
   the employee receives an email within minutes. Unsubscribing from the email
   link works and no further emails are sent.

### M5 — Payments / boosting (later)
- Stripe Checkout: server fns + `@stripe/stripe-js` + webhook route under
  `app/routes/api/`. New `jobs_order(user_id, kind 'listing'|'boost', amount,
  stripe_session_id, status)`. Webhook (idempotent, signature-verified) flips
  `jobs_posting.is_boosted` / `boosted_until`. Gate publish/boost/email-talent behind a
  paid order. Boosted jobs sort first on the board + eligible for landing hero.

### M6 — AI résumé-parser prefill (later)
- Employee uploads résumé (PDF/img) → extract text (`unpdf` for PDF; OCR lib for images)
  → LLM structured extraction (latest Claude model via the API) into the jobs block schema
  → **user reviews/edits before publish**. **Ground extraction against the extracted text**
  to avoid hallucinated experience entries (same lesson as the staff yearbook ingest —
  see `[[dci-yearbooks-authoritative-staff]]`). Optional prefill step, never a hard
  dependency.

### M7 — Editable canonical staff/judge pages (later, large)
- Build a staff/judge override + revision layer mirroring the shows wiki
  (`staff_block_overrides` / `judge_block_overrides` + render-time merge over the
  read-model). Claimers (and the role matrix) get edit rights on their own page; the jobs
  profile can reflect curated edits. Separate, larger effort — explicitly out of v1.

---

## Success criteria

- **M1:** hitting the jobs host (or `?brand=jobs`) renders PageantryJobs branding + landing;
  corps.place is visually unchanged; new tables exist after a clean boot with no errors.
- **M2:** a signed-in user creates an employee profile, edits structured + freeform blocks,
  publishes, and the public `/jobs/profile/<slug>` page renders all sections; edits append
  `jobs_revision` rows; a user cannot edit another user's profile.
- **M2.5:** a user with a matching name sees their staff/judge page suggested, claims it,
  and their jobs profile is pre-filled (bio→summary, assignments→experience,
  hometown→location, captions→skills); the staff/judge page shows a reciprocal link; a
  second user cannot claim the same page; a moderator can revoke a claim and the audit row
  is written.
- **M3:** an employer creates a posting; it appears on the board; filters are reflected in
  the URL (shareable) and survive reload; the detail page renders the Lexical body; apply
  opens the employer's link/mailto; the board has no-results states, "Load more" pagination,
  and mobile filter drawer; applying sends a notification email to the employer AND a
  confirmation to the candidate; the job detail page emits `schema.org/JobPosting` JSON-LD;
  jobs URLs appear in the sitemap.
- **M4:** an employer searches talent by location + skill and gets correct results;
  profiles with `contact_visibility != public` never leak contact info to the wrong viewer.
- **M5:** Stripe test-mode checkout → webhook flips `is_boosted` exactly once (idempotent)
  → boosted job sorts first.
- **M6:** uploading a résumé prefills ≥ the obvious fields (name, location, roles) with no
  fabricated entries; user can correct before publish.
- **Cross-cutting:** typecheck/lint pass; `routeTree.gen.ts` regenerates cleanly; corps.place
  auth/flows unaffected.

---

## Assumptions & variance

- **Proxy is truly host-agnostic.** Assumed from exploration. *Variance:* if `proxy.mjs`
  or the tunnel pins a single hostname, add host-aware forwarding / a second tunnel
  ingress. Low effort, isolated.
- **better-auth cross-domain via `trustedOrigins` is sufficient.** *Variance:* if cookie
  scoping fights us across two root domains, fall back to per-domain sessions (already the
  default) or a shared-parent-domain cookie. No shared-cookie SSO assumed in v1.
- **One profile per (user, kind).** A user could be both employee and employer. v1 keeps
  separate rows; UI surfaces "switch role." *Variance:* if that's confusing, restrict to
  one active kind per user and add a toggle.
- **Volume is low early**, so substring search over queried rows is fine. *Variance:* adopt
  FTS5 (and a geocoding step for real radius search) when listings/profiles grow.
- **Comp is freeform text + structured salary range.** `comp_text` + `salary_min` /
  `salary_max` / `salary_currency` are all nullable — employers who don't want to disclose
  leave them null. *Variance:* if most employers leave salary blank, drop the structured
  fields and keep only freeform. If a state mandates salary ranges, the structured fields
  become required.
- **Moderation reuses the existing role matrix with its own queue.** The `/jobs/admin`
  surface is separate from the corps moderation UI but uses the same capability check
  (`requireCapability(..., 'hideRevision')`). *Variance:* jobs may need its own capability
  (e.g. `moderateJobs`) if corps moderators shouldn't auto-moderate jobs.
- **Auto-claim is acceptable risk early** (low, trusted volume). *Variance:* if
  impersonation appears, tighten to moderator-approval (the `status` column already supports
  a `pending` state) or add email/proof verification — no schema change needed.
- **Name-normalized matching is good enough to suggest claims.** *Variance:* common names
  collide; always require a human pick from candidates (with photo/corps/seasons), never
  auto-bind. Ambiguous cases can fall to moderator.
- **Prefill is a one-time copy, not a live mirror.** Re-scrapes won't overwrite edits;
  a manual "re-import" shows a diff. *Variance:* if users expect auto-sync, add an opt-in
  mirror per block.
- **Stripe** is the assumed processor (test mode first). *Variance:* swap for another
  processor; the order table + webhook contract stay the same shape.

---

## Risks & notes

- **Passkey is domain-bound** — accept magic-link/Google-only on the jobs domain for v1;
  don't let a passkey-only corps.place user get stranded on PageantryJobs.
- **Lexical renderer is allowlist-based** (drops unknown nodes) — keep jobs content within
  the allowed node set or extend the allowlist deliberately; never render raw HTML.
- **Contact-info leakage is the top privacy risk.** Enforce `contact_visibility` on the
  server in every read path (`getJobsProfile`, `searchTalent`), not just in the UI.
- **PII + audit:** profiles hold personal data. The append-only `jobs_revision` is good for
  audit but means a true "delete my data" needs a real purge path (GDPR/CCPA) — note for
  whenever we go public.
- **Spam:** open job posting invites spam once it's free. Even pre-payments, gate posting
  behind a published employer profile + light rate limiting.
- **SEO/sitemap:** jobs profiles/postings should be in a jobs-specific `sitemap.xml`
  (reuse `app/routes/sitemap[.]xml.ts` with a brand branch) for the "industry home page"
  value to land. Structured data (`JobPosting`, `Person`, `Organization`) is critical for
  search visibility — treat as a first-class M3 requirement, not backlog.
- **Application email deliverability:** Resend already sends magic links, but
  application-notification emails from `pageantryjobs.com` may need SPF/DKIM setup.
  Verify before M3 ships.
- **Mobile UX is not optional:** The board, filters, profile editing, and claim flow
  must all work at 360 px width. No "desktop first, mobile later" — the mobile filter
  drawer (`Sheet`) and accordion profile sections are M3 requirements.
- **Read-model untouched:** jobs data is purely contributions-DB; the nightly read-model
  pipeline and R2 hot-swap are unaffected.
- **Empty states need design effort:** Every list view (board, talent search, my postings,
  my applications) needs a deliberate empty state with illustration + CTA. Don't let
  "no results" render as a blank page.

---

## Ideas / backlog (not committed)

- **Saved searches + alerts** for employees ("notify me of new brass-tech jobs near me")
  and employers ("new talent matching this search") — reuse Resend.
- **Seasonal lens:** jobs are highly seasonal (summer corps, fall band, winter guard);
  tag postings by season and default the board to the upcoming one.
- **Caption/instrument taxonomy** shared with the existing judge/caption data so skills
  filtering uses the same vocabulary as the rest of the site.
- **"Open to work" badge** + featured talent on the landing page.
- **Cross-link from corps.place:** a corps's staff page could link to that person's
  PageantryJobs profile if they have one (identity is merge-by-name elsewhere —
  see `[[staff-bios-and-name-merge]]`). *(Now a committed M2.5 deliverable.)*
- **Claim dispute path:** lightweight "this isn't me / I'm the real person" report that
  queues a moderator revoke, since auto-claim has no upfront proof.
- **Merge multiple identities:** let a user attach several staff `person_id`s + a
  `judge_id` to one jobs profile (people who taught several corps and also judge).
- **Verified employer** badge (manual or domain-email verification) to fight spam and add
  a paid tier.
- **Application inbox** for employers if on-platform apply gets traction.
- **Boost analytics** (views/clicks) once payments exist, to justify boost pricing.

---

## Open questions & unresolved considerations

These are genuinely undecided or under-informed. **An executing agent should NOT silently
guess on the 🔴 items — stop and ask, or pick the stated provisional default and flag it in
the PR.** 🟡 items are lower-stakes but worth surfacing.

### Product / scope
- 🔴 **One profile per user vs. both roles.** Plan assumes one `jobs_profile` per user (v1).
  Real industry people are often *both* an employer contact (corps director) and a
  for-hire instructor. Is the one-profile limit acceptable, or do we need both from day one?
  *Provisional default:* one profile; revisit if it blocks real users.
- 🔴 **Who is an "employer"?** A corps/org, or an individual hiring manager? Does an employer
  profile attach to an existing corps entity on corps.place (and reuse its logo/identity), or
  is it free-standing? This affects whether `jobs_profile(kind='employer')` should carry a
  `corps_key`. *Unknown — needs a decision before M3.*
- 🟡 **Geography/scope of jobs.** US-only, or international? Drives whether "location" needs
  structured country/region, and how search radius behaves. *Provisional:* free-text location.
- 🟡 **What counts as a "job"?** Full season staff contracts, one-off clinics, audition
  calls, volunteer roles? May need a `posting.type`. Currently one freeform posting type.
- 🟡 **Expiration policy.** `expires_at` exists but nothing sets/enforces it. Auto-expire after
  N days? Who runs that sweep (a cron? the read-model build?)? Undefined.
- ✅ **Pricing model** resolved to boost-only (free listings, paid boost). See scope decisions.
- ✅ **Salary fields** resolved to structured + freeform. `salary_min`/`salary_max`/`salary_currency`
  added to schema alongside `comp_text`.
- ✅ **Moderation surface** committed as M2.5 deliverable, not deferred.
- ✅ **Application notifications** committed as M3 core, not optional.

### Identity & claiming (highest-uncertainty area)
- 🔴 **Impersonation with no proof.** Auto-claim + admin-reversal was chosen, but we have **no
  email/identity proof** for staff/judge people. A bad actor can claim a famous name first.
  Is moderator reversal genuinely enough at launch, or do we need at least a soft gate
  (e.g. claims of pages with >X assignments require approval)? *Needs a risk call before
  M2.5 ships publicly.*
- 🔴 **Name-match quality is unmeasured.** We assume normalized-name matching is "good enough"
  to suggest claims, but haven't measured collision/duplicate rates on the real read-model.
  Common names (e.g. "Mike Smith") and the same human split across staff+judge will collide.
  **Action:** before building, dump read-model `display_name` counts and eyeball duplicates.
  See `[[read-the-page-when-building-parsers]]` (measure before inferring).
- 🟡 **Prefill ownership/licensing.** Scraped bios may be third-party copyrighted text. Is
  copying a scraped `biography` into a user-editable profile acceptable, or should prefill be
  facts-only (assignments/seasons) and leave the bio for the user to write? *Lean facts-only
  if unsure.*
- 🟡 **Stale-claim & re-scrape drift.** Prefill is copy-once; if the canonical page later gains
  data, the claimed profile won't reflect it. "Re-import diff" is hand-waved — its UX is
  undesigned.

### Auth & multi-domain (assumptions not yet verified in prod)
- 🔴 **Cross-domain cookies actually work?** `trustedOrigins` is the planned fix but
  cross-root-domain session behavior (corps.place ↔ pageantryjobs.com) is **untested**. If
  it fights us, the fallback is per-domain sessions (a user signs in separately on each) —
  acceptable, but confirm before promising "one login spans both."
- 🔴 **Proxy/tunnel host handling unverified.** Plan claims `proxy.mjs` is host-agnostic and
  a second domain "just works." Nobody has confirmed the Cloudflare tunnel can terminate a
  second root domain on this setup. **Verify with infra before M1 acceptance.** See
  `[[tailnet-mini-pc-reverse-tunnel]]` / `docs/DEPLOYMENT_REALITY.md`.
- 🟡 **Passkey UX gap.** corps.place passkey users can't passkey-login on the jobs domain.
  Is the magic-link/Google fallback an acceptable v1 experience, or confusing?

### Payments (M5 — almost entirely open)
- 🔴 **Is there a Stripe account / legal entity to receive money?** No payment infra exists
  today (the shop is link-out only). Pricing, tax, refunds, and who owns the merchant account
  are all undecided. Don't start M5 until this is real.
- 🟡 **What exactly is paid?** Per-listing fee vs. boosting vs. paid talent-outreach — the
  user was explicitly unsure. Needs a pricing decision and probably market validation first.

### AI résumé parsing (M6 — under-specified)
- 🟡 **Build vs. buy + cost.** "Off-the-shelf AI/OCR parser" is named but none chosen.
  Self-host (`unpdf` + LLM) vs. a hosted API has cost/latency/privacy tradeoffs. Résumés are
  PII — uploading them to a third party needs a privacy decision.
- 🟡 **OCR for image résumés** has no chosen library. PDF text via `unpdf` is fine; scanned
  images are unsolved.

### Legal / privacy / abuse (cross-cutting, mostly unaddressed)
- 🔴 **PII deletion vs. append-only audit.** M0 defines a moderator "purge" procedure that
  nulls PII columns and retains only the audit row with stripped data. This is a pragmatic
  compromise — confirm it satisfies GDPR/CCPA requirements before a public launch with real
  users.
- 🟡 **Terms/privacy for the new brand.** M0 creates placeholder pages. These need real legal
  copy before any listing goes live. Who writes the copy? (corps.place operator? template?
  lawyer?)
- 🟡 **Spam/abuse at scale.** The moderation queue (M2.5) handles reported content, but there
  is no automated rate-limiter in the codebase today. A simple per-user cooldown on posting
  (max 3 jobs per 24h for unverified employers) should be implemented before M3 ships publicly.
- 🟡 **Moderation reuse.** corps.place moderators auto-inherit power over jobs content via the
  shared capability check. If the jobs board needs its own moderator pool, add a
  `jobs_moderator` table — not needed for v1.
- 🟡 **Onboarding completion rate.** The wizard (M2.6) helps, but what if users still skip it?
  Profile completeness scoring and nudges ("Your profile is 40% complete — add skills to be
  found by employers") should be designed but are uncommitted.
- 🟡 **Alert frequency trade-off.** "Instant" alerts on every publish could be noisy at scale.
  Consider batching (daily digest default, instant opt-in). The M4.5 design defaults to daily
  with instant as opt-in — verify this matches user expectations before launch.

### Technical unknowns to verify during build
- 🟡 **Formisch with arbitrary nested arrays** (e.g. `experience[]`) — confirm it introspects
  the Valibot array-of-objects schema cleanly; the existing usages are simpler. Spike in M2.
- 🟡 **Reading the read-model from a contributions-DB-context server fn.** The staff/judge
  builders live in `sdk/` and read the read-model DB; confirm they're callable from a jobs
  server fn (the existing `getStaffProfile` in `app/lib/server-fns/hybrid.ts` proves it's
  possible — reuse that path rather than re-wiring DB clients).
- 🟡 **Multi-brand sitemap routing.** The sitemap route is a single file. Can it branch on
  brand and still be discovered by search engines for both domains, or do we need two
  sitemap routes (one per domain)? Search engines send the `Host` header, so `getBrand()`
  can distinguish. Verify: does the sitemap route receive the correct `Host` header from
  the proxy/tunnel?
- 🟡 **Application email deliverability.** Resend is already wired for magic links, but
  application notification emails are transactional and may have deliverability requirements
  (SPF/DKIM). Verify the existing setup handles bulk-ish transactional email from the
  `pageantryjobs.com` domain (or use the corps.place domain as sender).
- 🟡 **XState claim machine testing.** The claim flow has 5 states with async transitions.
  The existing codebase has no XState testing pattern. Add a simple `@xstate/test` or
  `describeMachine` test for the claim machine before wiring it into the route.

---

## Files to create / modify (representative)

- **Modify:** `app/lib/auth.ts` (trustedOrigins), `app/lib/authz.ts` (add
  `requireJobsProfileOwner`), `app/routes/__root.tsx` (brand switch), `app/routes/index.tsx`
  (brand home), `app/lib/contributions-db.ts` (new tables + indexes in the existing `SCHEMA`
  array), `app/app.css` (`.brand-jobs` tokens), `vite.config.ts` (allowedHosts),
  `app/routes/staff/$personId.tsx` + `app/routes/judges/$judgeId.tsx` (reciprocal link),
  `app/routes/sitemap[.]xml.ts` (jobs sitemap, later).
- **Create:** `app/lib/brand.ts`, `app/lib/jobs/store.ts`, `app/lib/jobs/schemas.ts`,
  `app/lib/server-fns/jobs.ts`, `app/lib/job-filtering.ts`,
  `app/machines/job-filter-machine.ts`, `app/components/jobs/landing.tsx`,
  `app/routes/jobs/{index,board,$jobSlug,talent,me,post}.tsx`,
  `app/routes/jobs/profile/$slug.tsx`, jobs UI components (`JobCard`, `TalentCard`).
- **Claim (M2.5):** claim server fns in `app/lib/server-fns/jobs.ts` (reading read-model via
  `buildStaffProfile`/`buildJudgeProfile` in `sdk/src/readModel/builders/`); modify
  `app/routes/staff/$personId.tsx` + `app/routes/judges/$judgeId.tsx` loaders to surface the
  reciprocal PageantryJobs link; reuse the staff name-normalize helper for match suggestions.

---

## Verification

- **Local dev:** `npm run dev`; simulate the jobs brand via `?brand=jobs` / `JOBS_HOST`
  (real Host routing needs the proxy). Confirm `__root.tsx` renders jobs branding and `/`
  shows the jobs landing while corps.place is unchanged.
- **Auth:** sign in via magic link on the jobs brand; confirm the session works and
  `trustedOrigins` accepts the jobs origin (dev console logs the link when `RESEND_API_KEY`
  is unset).
- **Profiles:** create an employee profile, edit structured + freeform blocks, publish,
  view the public page; confirm contact-visibility and ownership enforcement; confirm
  `jobs_revision` rows append.
- **Claim (M2.5):** sign in as a user whose name matches a known staff/judge page; confirm
  the page is suggested, claim it, and verify the jobs profile is pre-filled from the
  read-model fields; confirm the staff/judge page now shows the reciprocal link; attempt a
  second claim of the same page and confirm it's refused; revoke as a moderator and confirm
  the audit row + link removal.
- **Postings:** create a posting as an employer; verify it on the board with filters
  reflected in URL search params; open detail; click apply.
- **Search:** as an employer, search talent by location/skill; confirm results and that
  hidden-contact profiles don't leak.
- **DB:** restart and confirm tables/indexes create idempotently with no errors.
- **Payments (M5):** Stripe test-mode checkout → webhook flips `is_boosted` once → boosted
  job sorts first.
- **Build (run after every milestone):** `npm run check` (typecheck) and `npm run lint`
  must both pass; `npm run fmt` to format. `routeTree.gen.ts` regenerates automatically when
  `npm run dev` is running — do not hand-edit it.
- **Inspect the DB directly** (dev): `sqlite3 sdk/contributions.db ".tables"` and
  `sqlite3 sdk/contributions.db "SELECT op,target_kind,created_at FROM jobs_revision ORDER BY created_at DESC LIMIT 10"`.
- **Simulate the jobs brand** without DNS: append `?brand=jobs` to any URL, or set
  `JOBS_HOST=localhost` in the env. Real `Host` routing only matters in production behind the
  proxy.
