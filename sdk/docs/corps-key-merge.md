# Merging duplicate corps_keys

## The problem

A single corps can end up with **two `corps_key`s** in `dci-relational.db`, so it
appears **twice** in score / rankings / event-recap tables on drumcorps.app (the
corps *directory* `rm_corps` dedupes, so the corps page itself looks fine — the
doubles show up in event recaps, season rankings, and the prediction "diff" view).

The two keys are almost always:

- a **slug key** — `bushwackers-drum-corps`, `southern-knights`, `encorps` … (the
  human-facing canonical), and
- an **orphan key** — a Salesforce-style record id (`0010a00001…`, `001j0000…`),
  the literal placeholder `"0"`, or a `the-…` slug variant of the canonical.

It comes from inconsistent corps-key assignment during ingestion (the website
scraper vs. the API/legacy paths key the same corps differently). The durable fix
would be consistent key assignment at ingest; until then, merge after the fact.

Find them:

```sql
SELECT corps_name, COUNT(DISTINCT corps_key)
FROM corps_scores GROUP BY corps_name HAVING COUNT(DISTINCT corps_key) > 1;
```

## The tool

`sdk/scripts/mergeDuplicateCorpsKeys.ts` — idempotent, dry-run by default.

```bash
cd /root/corps-place/sdk
vp exec tsx scripts/mergeDuplicateCorpsKeys.ts            # dry run (no writes)
vp exec tsx scripts/mergeDuplicateCorpsKeys.ts --apply    # execute
# then publish:
bash /root/corps-place/scripts/refresh-prod-read-model.sh
```

Run under **Node 20** via `vp exec tsx` (the box default Node 24 breaks
better-sqlite3’s ABI). Always dry-run first and read the plan.

### Choosing the canonical key (in order)

1. The key whose `corps` row has a **non-empty slug** (tiebreak: `status='Active'`).
2. Otherwise prefer a **slug-style** key over a Salesforce-id / `"0"` key
   (`isIdStyle`: `"0"`, or starts with `0` and is 14–20 alphanumerics).
3. Otherwise prefer the slug **without a `the-` prefix**
   (`concord-voices-blue-devils` over `the-concord-voices-blue-devils`).
4. Otherwise the key with more `corps_scores` rows; a true tie ⇒ **skipped** and
   reported for manual resolution.

> The canonical key *type* varies per corps — e.g. Connecticut Hurricanes’
> canonical is the Salesforce key `0015b00002eebx5aaf`, but Bushwackers’ is the
> slug key `bushwackers-drum-corps`. There is no universal rule; the corps record
> decides.

### Safety gate

A corps is merged only when its **shared-event score rows are exact duplicates**
— matching `(competition_slug, division_name, total_score)` (the unreliable
`round` field is ignored; `total_score` already distinguishes prelims/finals).
If an orphan has *differing* data in a shared event, the corps is **skipped** so
the merge never deletes real, non-duplicate data.

### Per-table merge rule

For every table with a `corps_key` column:

- **competition/season tables** (have `competition_slug`, else `season`):
  delete orphan rows that collide with a canonical row on that column (they’re the
  duplicates), then remap the remaining orphan rows to the canonical.
- **singleton tables** (`corps`, `merch_stores`, `ml_corps_vocab`, …): if a
  canonical row exists, delete the orphan; otherwise remap it.

### Foreign keys

The merge runs with `foreign_keys = OFF` (set outside the transaction, since the
PRAGMA is a no-op inside one) so parent rows like the orphan `corps` record can be
removed regardless of table order. It captures `foreign_key_check` **before and
after** and fails only if the count **increased** — pre-existing violations don’t
trip it.

> Pre-existing note (2026-06-28): `event_participants` has ~343 rows (62 corps,
> e.g. `racine-scouts`, `city-sound`) referencing corps that never had a `corps`
> record. This predates the merge and is unrelated; a separate cleanup.

## History

- **2026-06-28** — merged 13 corps: Bushwackers (manual, first), then Impact,
  Zephyrus, Encorps, Southern Knights, Golden Empire Sax Quartet, Jack Patterson
  (Shadow), Spartans Brass #1, The Raiders Dance Ensemble, and the four
  `the-…`/`…` Blue Devils / Pacific Crest / River City / Southwind sub-ensemble
  pairs. 0 corps left dual-keyed; 0 new FK violations.

See also: the related name/label dedupe in `docs`-adjacent notes — DCA division
labels and lineup aliases are normalized by `src/normalizeDivisions.ts`
(`normalizeIngestedData`), a different class of duplicate.
