# Maintainability Notes

Observations and suggestions from the Effect v3 → v4 migration (which touched ~125
files across `app/` and `sdk/`). Ordered by leverage. None of this is urgent — the
codebase ships a real product — but #1 compounds: a protected green baseline is what
turns "234 errors, can't tell what matters" into "1 new error, fix it now."

Status legend: ☐ not started · ◐ in progress · ☑ done

---

## 1. Protect a green typecheck baseline (highest leverage)

The `sdk/` project sat at **234 type errors** before the v4 migration. The real
problem wasn't the errors — it was that *a noisy baseline hides real bugs*. Concrete
proof: the `trainModelV9-improved.ts` bug found during the migration (the val-baseline
loop iterated a collated `{ xs, ys }` batch as if it were a `Sample[]`) had been
latent and silent, drowned out by 233 other errors nobody could act on.

Both projects are now at **0 errors**. Lock that in:

- ☐ Add `tsc --noEmit -p sdk/tsconfig.json` to CI. (`vp check` / `npm run check`
  only covers `app/`; `sdk/` is currently excluded.)
- ☐ Gate merges on both `app/` and `sdk/` typechecks.

A green baseline is what makes every other improvement below *detectable*.

---

## 2. Delete dead weight

The migration had to port code to v4 that **does not run**:

- `sdk/src/client.ts` — the `api.dci.org` network client. AGENTS.md: dead,
  "preserved for historical use." (`api.dci.org` was decommissioned May 2026.)
- `sdk/src/proxy.ts` — reverse-proxies that same dead endpoint.
- `sdk/src/scrapeWebsiteRecaps.ts` referenced `ingestRelationalDataFromApiResponses`,
  a function **that was never implemented** — a WIP stub committed in a
  `chore: commit workspace changes` dump (the dead reference has since been removed).

Carrying dead code means every migration pays for things nobody uses. "Preserved for
history" is what git is for.

- ☐ Delete the network/proxy path (`client.ts`, `proxy.ts`) or move to a clearly
  marked `legacy/` folder excluded from the build.
- ☐ Audit one-off scripts in `sdk/scripts/` for references to deleted/renamed
  functions; remove the orphans.

---

## 3. The `schemaCompat.ts` shim is deliberate, *temporary* debt

`sdk/src/schemaCompat.ts` reimplements the v3 `Schema.optionalWith` (nullable +
default) and variadic `Schema.Union` on v4 primitives, so 88 + 16 call sites could be
migrated by mechanical rename instead of hand-rewriting decode semantics. That was the
right call for the migration — but it is now a **fork of the framework's API**, and the
longer it lives the more it diverges from idiomatic v4.

- ☐ Track a task to migrate call sites to native `Schema.optional` /
  `Schema.NullOr` / `Schema.withDecodingDefaultType`, then **delete the shim**.
- ☐ Do it once Effect v4 leaves beta (so the native API is stable). Add a
  `// TODO(schemaCompat): remove after v4 GA` marker.

---

## 4. Structural smells

- **God files.** `sdk/src/relational.ts` is ~5,300 lines and mixes schema DDL,
  ingestion, queries, and helpers — it wants to be a folder.
  `sdk/src/training/trainModelV9-improved.ts` is ~2,000 lines.
  - ☐ Split `relational.ts` into `schema/`, `ingest/`, `queries/` modules.
- **Versioned-file sprawl.** `buildMlSequencesV4`…`V10`, plus `V6Production`,
  `V6FinalsBlind`, `V9Subcaption`, `V9All`, and `trainModelV5` / `V9-improved`. This is
  research-iteration debt frozen into the tree; a newcomer can't tell which is current.
  - ☐ Identify the live build/train file(s), archive the rest under `sdk/src/training/archive/`
    (excluded from build), leave a one-line README pointing at the current one.
- **Duplicated domain types.** `normalizeCorpsName` was defined in *two* read-model
  builders (caused an ambiguous re-export). `JudgeProfile` vs `RecapJudgeProfile`
  diverged on null-handling. Schemas overlap across `domain.ts` / `extraDomain.ts` /
  `recap.ts` / `recapSummary.ts` / `season.ts`.
  - ☐ Consolidate to one canonical domain module imported everywhere; kill the
    "which type is right?" class of bugs.

---

## 5. Type discipline — stop papering over with `as`

The DB-backed API had `DciApi.of({...})` with `as Effect<…, DciError>` casts and a
`trySources` helper typed with `never` errors that was simply **wrong** (it claimed no
errors while the methods returned `DciError`). These are now fixed properly — the
idiomatic pattern is to map infrastructure errors (`SqlError`) into the domain error
type at the service boundary (see `domainE` / `domainS` in `dbBackedApi.ts`).

The *habit* of casting away type mismatches is what let the baseline rot.

- ☐ Treat a needed `as` as a smell to investigate, not a tool. (A lint rule banning
  non-`const` assertions, with explicit allowlist comments, can enforce this.)

---

## 6. Hygiene (cheap, high annoyance-reduction)

- **Line endings.** Every commit during the migration threw CRLF warnings, and it
  *broke the merge* (phantom CRLF diffs blocked the fast-forward; had to `reset --hard`).
  - ☐ Add a repo `.gitattributes` with `* text=auto eol=lf` to end this permanently.
- **Hardcoded absolute paths.** `sdk/src/showScraperAgent.ts` bakes
  `cwd: "C:\\Users\\Patrick\\corps-place"` into an `exec` call — machine-specific, will
  silently break for anyone else.
  - ☐ Use `process.cwd()` (or a resolved project root).
- **`require()` inside ESM.** Same file does
  `const { exec } = require("node:child_process")` in an ESM module — mixing module
  systems.
  - ☐ Use a top-level `import`.
- **Real tests, not scripts.** `sdk/test/` is mostly runnable scripts, not assertions.
  The read-model already has an excellent (underused) pattern: `verifyReadModel.ts`
  builds via two paths and asserts equality.
  - ☐ Add a handful of `@effect/vitest` tests around the ingest/decode boundaries —
    that's where the latent bug found during migration lived.

---

## If you do just three things

1. **CI-gate `sdk/` typecheck at 0** — locks in everything the migration bought (§1).
2. **Add `.gitattributes`** — ends the CRLF churn taxing every commit and merge (§6).
3. **Delete the dead network/proxy path and orphaned scripts** — removes the biggest
   source of "why am I migrating code that doesn't run?" (§2).

---

## Migration context

- Effect v4 is still **beta** (`4.0.0-beta.79`), pinned exactly. `effect/unstable/*`
  namespaces can break on minor bumps — re-pin deliberately, and revisit §3 at GA.
- Full migration record: `docs/plans/EFFECT_V4_MIGRATION_PLAN.md`.
- v4 conventions for new code: see the Effect section in `AGENTS.md`.
