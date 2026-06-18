# Lineup Classification Hardening Plan

## Goal

Make event lineup classification robust across ingestion, DB views, app queries, corps directory visibility, and prediction inputs.

The immediate bug was schedule text such as `Event Concludes` being linked/rendered as a corps in the app lineup table. The root cause was stale derived data: some `event_lineup_entries` rows had `is_non_performance = 0` and were linked through `event_participants` to bogus corps rows, even though `domain_event_exclusion_patterns` already classifies `%concludes%` as `schedule_item`.

The long-term target is:

- `domain_event_exclusion_patterns` remains the single source of truth for heuristic lineup classification.
- Ingest/backfill writes correct derived rows where practical.
- Shared DB views expose classified lineup data so consumers do not duplicate SQL.
- App reads use the shared view and stay dumb.
- Audits catch newly scraped schedule noise before it becomes linked corps data.

## Current State

Relevant files:

- `sdk/src/lineupClassification.ts`
  - Canonical seed patterns and TS matcher.
  - Has `schedule_item`, `not_a_corps`, `alumni`, `exhibition`, `model` categories.
  - Includes `%concludes%`.
- `sdk/src/relational.ts`
  - Creates `domain_event_exclusion_patterns`.
  - Seeds `ALL_EXCLUSION_PATTERNS`.
  - Defines `scored_event_lineup`, `event_lineup_exclusions`, and `season_performing_corps`.
  - `scored_event_lineup` / `event_lineup_exclusions` still contain hard-coded keyword checks for legacy/alumni/exhibition cases.
- `sdk/scripts/applyLineupClassification.ts`
  - Seeds/upserts patterns and recreates `season_performing_corps`.
  - Can delete bogus non-corps rows, but this is a broad data-writing operation and should remain dry-run first.
- `sdk/src/eventLineupRebuild.ts`
  - Rebuilds current `event_lineup_entries` / `event_participants` from archived `event_page_scrapes.lineup_json`.
  - Currently trusts scraped `entry.isNonPerformance` and `entry.isExhibition`.
- `sdk/scripts/backfillEventLineupIsNonPerformance.ts`
  - Has a separate local keyword list. This can drift from `lineupClassification.ts`.
- `app/lib/event-directory.ts`
  - App schedule query now defensively applies `domain_event_exclusion_patterns` and masks `corps_key` / `division_name` for `schedule_item` / `not_a_corps`.
- `app/components/prediction/lineup-schedule.tsx`
  - Renders rows based on `is_non_performance`, `is_exhibition`, and `corps_key`.

## Design

### Shared Classification View

Create a non-destructive view, tentatively named `classified_event_lineup`, in `sdk/src/relational.ts`.

Purpose: one row per `event_lineup_entries` row with pattern-derived classification and masked corps linkage for non-corps rows.

Proposed columns:

- `event_slug`
- `entry_id`
- `lineup_index`
- `performance_order`
- `unit_name`
- `display_city`
- `time`
- `raw_participant_id`
- `raw_corps_key`
- `participant_id`
  - `NULL` when the row matches `schedule_item` or `not_a_corps`.
- `corps_key`
  - `NULL` when the row matches `schedule_item` or `not_a_corps`.
- `division_name`
  - `NULL` when the row matches `schedule_item` or `not_a_corps`.
- `canonical_corps_name`
- `is_exhibition`
- `stored_is_non_performance`
- `pattern_category`
  - First matching category from `domain_event_exclusion_patterns`, or `NULL`.
- `pattern_reason`
  - Reason for the selected pattern, or `NULL`.
- `is_non_corps`
  - `1` for `schedule_item` / `not_a_corps`.
- `effective_is_non_performance`
  - `1` when `is_non_corps = 1`, otherwise stored `is_non_performance`.
- `effective_exclusion_reason`
  - Suggested values: `schedule_item`, `not_a_corps`, `non_performance`, `exhibition`, `unmatched_participant`, `unresolved_corps`, `legacy_or_alumni`, `model_excluded`, `scored`.

Pattern selection detail:

- Multiple patterns can match a row. Avoid multiplying rows.
- Use a correlated subquery ordered by category priority.
- Suggested priority:
  - `schedule_item`
  - `not_a_corps`
  - `alumni`
  - `exhibition`
  - `model`
- Keep this priority documented in SQL comments.

Edge case: `alumni` and `exhibition` are real performers. They should not be masked from corps directory/profile links by the app schedule view. They may still be excluded from `scored_event_lineup`.

### Update Existing Views

Update or recreate these views to consume `classified_event_lineup`:

- `scored_event_lineup`
  - Use `classified_event_lineup`.
  - Require `effective_is_non_performance = 0`.
  - Require `COALESCE(is_exhibition, 0) = 0`.
  - Require non-null `corps_key` and `division_name`.
  - Exclude pattern categories that should not enter the model, using `domain_event_exclusion_patterns` instead of hard-coded `LIKE` clauses where possible.
- `event_lineup_exclusions`
  - Use `effective_exclusion_reason`.
  - Include pattern reason/category for audit.
  - Preserve existing output columns expected by `sdk/scripts/predictEventRecap.ts`.
- `season_performing_corps`
  - Use `classified_event_lineup`.
  - Include real performers, including exhibition/alumni/legacy.
  - Exclude only `is_non_corps = 1`.

Important DB safety:

- Do not add table drops to `ensureRelationalSchema`.
- View replacement can use `DROP VIEW IF EXISTS` only for views, not tables.
- If view replacement must be applied to the live DB, put it in a dedicated script with a dry-run/report mode.

### Ingestion and Rebuild

Update `sdk/src/eventLineupRebuild.ts` so target rows apply the same classification at rebuild time.

Options:

1. Preferred: import `isScheduleItem` / `isNonCorpsName` / category match helpers from `sdk/src/lineupClassification.ts`.
2. Better if SQL category parity is needed: expose a helper returning the first matched `ExclusionPattern`.

Rules:

- If `isNonCorpsName(unit_name)` is true:
  - `is_non_performance = 1`
  - `participant_id` should be null in the derived rows if the rebuild path controls participant creation.
  - Do not create or resolve a corps row for that unit.
- If category is `exhibition`:
  - `is_exhibition = 1`
  - Keep participant/corps linkage if it resolves to a real performing unit.
- If category is `alumni`:
  - Keep as real performer.
  - Do not force `is_non_performance = 1` unless another rule requires it.
- If category is `model`:
  - Keep performer identity; model views handle exclusion.

Files likely requiring changes:

- `sdk/src/eventLineupRebuild.ts`
- `sdk/src/relational.ts`, especially `upsertEventPageScrape` / lineup participant normalization if that path creates participants for schedule items.
- `sdk/scripts/ingestLineupsFromScrapes.ts`, if it has its own participant creation or matching logic outside `upsertEventPageScrape`.
- `sdk/scripts/scrapeEventPages.ts`, only if parsed `isNonPerformance` can be improved at scrape time.

### Backfill Script Replacement

Replace or revise `sdk/scripts/backfillEventLineupIsNonPerformance.ts`.

Problems with the current script:

- It has a separate hard-coded keyword list.
- It sets `is_non_performance = 1` but does not necessarily unlink bogus `participant_id` / `corps_key`.
- It treats some real performers (`legacy`, `alumni`, `community`, `exhibition`) as non-performance, which is not the same as `schedule_item` / `not_a_corps`.

New script proposal: `sdk/scripts/backfillLineupClassification.ts`.

Default dry-run output:

- Count rows matching `schedule_item` / `not_a_corps` where `is_non_performance = 0`.
- Count rows matching `schedule_item` / `not_a_corps` with non-null `participant_id`.
- Count bogus `corps` rows whose names match `schedule_item` / `not_a_corps`, with zero scores and zero prediction rows.
- List sample rows by event slug, unit name, current participant/corps key, matched pattern/category/reason.
- Report exact mutations that `--apply` would run.

Apply behavior:

- Set `event_lineup_entries.is_non_performance = 1` for `schedule_item` / `not_a_corps`.
- Null `event_lineup_entries.participant_id` for `schedule_item` / `not_a_corps` where safe.
- Delete `event_participants` rows only when:
  - They are referenced exclusively by non-corps lineup rows, and
  - The linked corps has no scores/prediction rows, and
  - The operation is explicitly `--apply`.
- Delete bogus corps rows only under the same conservative safeguards used by `applyLineupClassification.ts`.

Do not:

- Delete rows from `event_page_scrapes`.
- Delete real alumni/exhibition/community performers.
- Rewrite curated corps metadata.

### App Query Cleanup

After `classified_event_lineup` exists in the live DB:

- Update `app/lib/event-directory.ts` `eventScheduleForSlug` to read from the view instead of embedding classification SQL.
- Preserve the current response type:
  - `performance_order`
  - `unit_name`
  - `time`
  - `is_non_performance`
  - `is_exhibition`
  - `division_name`
  - `corps_key`
- Map `effective_is_non_performance AS is_non_performance`.
- Use masked `corps_key` and `division_name` from the view.

This removes duplicated SQL from the app and makes future consumers safer.

### Prediction and Model Inputs

Audit consumers:

- `sdk/scripts/predictEventRecap.ts`
  - Preferred lineup query currently filters `ele.is_non_performance = 0`.
  - Switch to `scored_event_lineup` if possible, or use `classified_event_lineup.effective_is_non_performance`.
- `app/lib/event-prediction-api.ts`
  - Query around `scored_event_lineup` is probably already safe if the view is updated.
- `sdk/src/corpsDiscovery.ts`
  - Has `le.is_non_performance = 0`; switch to `classified_event_lineup` or `season_performing_corps`.
- Model build scripts
  - Confirm they read `scored_event_lineup` or an updated model view.

Do not broaden model input by accidentally including alumni/exhibition/legacy rows. The model and the directory have different definitions:

- Directory "performing" can include exhibition/alumni/legacy.
- Model "scored" should include only supported scored divisions.

### Tests and Audits

Add focused tests/smoke checks.

Suggested test fixture labels:

Should be non-corps / ceremony:

- `Event Concludes`
- `Competition Resumes`
- `Awards Ceremony`
- `Scores Announced`
- `Reserved Seating Takes Effect`
- `Movie Theater Cinecast`
- `Joint Performance - Example`

Should remain real performers:

- `Bluecoats Alumni`
- `Legacy Drum & Bugle Corps` if it is an actual corps row with division/context.
- `BKXperience`
- `Brassworks`
- `Some Corps Exhibition`

Should remain normal scored performers:

- `Blue Devils`
- `The Cavaliers`
- `Seattle Cascades`

Suggested checks:

- TS matcher parity:
  - Add/extend tests for `sdk/src/lineupClassification.ts`.
  - Verify `isNonCorpsName('Event Concludes') === true`.
  - Verify alumni/exhibition helpers do not imply non-corps.
- SQL view smoke:
  - Query `classified_event_lineup` for known bad rows and assert masked `corps_key`.
  - Query normal performers and assert `corps_key` remains present.
- App read smoke:
  - Directly query `eventScheduleForSlug` or route loader for `2026-dci-tour-preview`.
  - Assert `Event Concludes` has `is_non_performance = 1`, `corps_key = null`, `division_name = null`.
- Data audit:
  - Count non-corps patterns still linked to participants.
  - Count bogus corps rows still named like schedule items.

Verification commands:

```bash
vp check
cd sdk
npx tsc --noEmit -p tsconfig.json
npx tsx scripts/backfillLineupClassification.ts --dry-run
npx tsx scripts/rebuildDerivedEventLineup.ts --season 2026
```

Note: `sdk` has pre-existing type errors. Capture a baseline before/after and report only deltas.

## Rollout Sequence

1. Add `classified_event_lineup` to `sdk/src/relational.ts`.
2. Add a dry-run script to create/replace lineup classification views in the live DB.
3. Update `scored_event_lineup`, `event_lineup_exclusions`, and `season_performing_corps` definitions to consume `classified_event_lineup`.
4. Update `app/lib/event-directory.ts` to read the view and remove embedded pattern SQL.
5. Replace `backfillEventLineupIsNonPerformance.ts` with a classification-driven dry-run/apply script.
6. Update rebuild/ingest paths so future derived rows do not link schedule items as corps.
7. Audit prediction/corps discovery queries and switch them to shared views.
8. Run dry-run backfill against the live DB and review the candidate list.
9. Apply only after confirming candidates are schedule/noise rows, then rerun audits.
10. Document the final commands in `sdk/docs/ingest-scrape-data-generation.md`.

## Known Edge Cases

- Multiple pattern matches:
  - `Event Concludes - Something` may match both `%concludes%` and `% - %`.
  - Priority should classify it as `schedule_item`.
- Real corps names containing broad words:
  - Avoid adding broad patterns such as `%score%`, `%change%`, or `%community%` to non-corps categories.
  - Keep broad performer-type patterns in `exhibition` / `alumni`, not `schedule_item`.
- Hyphen variants:
  - SQL matcher intentionally mirrors SQLite `LIKE` without dash normalization.
  - Add explicit pattern variants when needed.
- Stale bogus corps rows:
  - Read-time masking fixes UI, but bogus rows may remain in `corps`.
  - Delete only when they have zero scores, zero prediction rows, and no real performer evidence.
- Archived scrape history:
  - Never mutate `event_page_scrapes` for this. It is the durable archive.
- Rebuild from archive:
  - A rebuild can reintroduce bad derived rows unless `eventLineupRebuild` applies classification.
- App route availability:
  - Use plain `vite` for route dev checks, not `vp dev`.

## Acceptance Criteria

- `Event Concludes` and similar schedule items never render as linked corps in lineup tables.
- `classified_event_lineup` is the shared source for classified schedule reads.
- Future rebuilds from `event_page_scrapes` do not recreate participant/corps links for non-corps schedule rows.
- `scored_event_lineup` excludes schedule items via the shared classification path.
- `season_performing_corps` still includes real exhibition/alumni performers but excludes schedule/noise rows.
- Dry-run audits show zero `schedule_item` / `not_a_corps` lineup rows with visible app `corps_key`.
