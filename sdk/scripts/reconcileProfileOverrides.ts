// Reconcile profile-ownership overrides against the freshly-emitted read-model
// (STAFF_PROFILE_OWNERSHIP_PLAN §11, step 8). For each profile_overrides row:
//   • compute a hash of the CURRENT scraped value for that field,
//   • if source_hash is NULL → set it (baseline, first run after an edit),
//   • else set scrape_diverged = (hash != source_hash) — drives the owner-facing
//     "the source record changed since you edited this" notice.
// Also flags ORPHANED active claims (entity_id no longer resolves in the read-model,
// e.g. after an identity merge/split) for moderator review.
//
// Reads contributions.db (overrides/claims) + the read-model (scraped values).
// Idempotent; tolerant of missing tables (feature not shipped yet → no-op). Run
// nightly AFTER emitReadModel.
//   npx tsx scripts/reconcileProfileOverrides.ts            # dry-run
//   npx tsx scripts/reconcileProfileOverrides.ts --apply
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRepoEnv } from './scriptEnv.js';
import { readStaffProfile, readJudgeProfile } from '../src/readModel/readers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, '..');
loadRepoEnv(SDK_DIR);
const APPLY = process.argv.includes('--apply');

const contribUrl = process.env.CONTRIBUTIONS_DB_URL ?? 'file:/data/corps-place/contributions.db';
// Resolve the active read-model A/B slot (falls back to env / sdk-local).
const resolveReadModel = (): string => {
  if (process.env.READ_MODEL_DB_URL) return process.env.READ_MODEL_DB_URL;
  for (const base of ['/data/corps-place', SDK_DIR]) {
    try {
      const slot = readFileSync(`${base}/read-model.active`, 'utf8').trim();
      return `file:${base}/read-model.${slot}.db`;
    } catch {
      /* try next */
    }
  }
  return `file:${resolve(SDK_DIR, 'read-model.db')}`;
};

const contrib = createClient({ url: contribUrl });
const rm = createClient({ url: resolveReadModel() });

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

/** The scraped value the merge would overlay, per field_key (mirrors merge.ts). */
const scrapedField = (profile: any, field: string): unknown => {
  switch (field) {
    case 'biography': return profile?.biography ?? null;
    case 'photo': return profile?.photo_url ?? null;
    case 'hometown': return profile?.bioFacts?.hometown ?? null;
    case 'current_position': return profile?.bioFacts?.currentPosition ?? null;
    default: return null; // links/etc. have no scraped counterpart → never diverges
  }
};

const main = async () => {
  if (APPLY) await contrib.execute('PRAGMA busy_timeout=15000');

  // ── Divergence: per-field source-hash recompute ─────────────────────────────
  let baselined = 0, diverged = 0, cleared = 0;
  let overrides: { entity_type: string; entity_id: string; field_key: string; source_hash: string | null; scrape_diverged: number }[] = [];
  try {
    overrides = (await contrib.execute('SELECT entity_type, entity_id, field_key, source_hash, scrape_diverged FROM profile_overrides')).rows as any[];
  } catch {
    console.log('No profile_overrides table yet — nothing to reconcile.');
    process.exit(0);
  }
  // Cache profiles per entity (avoid re-reading the read-model per field).
  const profileCache = new Map<string, any>();
  const getProfile = async (type: string, id: string) => {
    const key = `${type}|${id}`;
    if (!profileCache.has(key)) profileCache.set(key, type === 'staff' ? await readStaffProfile(rm, id) : await readJudgeProfile(rm, id));
    return profileCache.get(key);
  };

  for (const o of overrides) {
    const profile = await getProfile(o.entity_type, o.entity_id);
    const h = hash(scrapedField(profile, o.field_key));
    if (o.source_hash == null) {
      console.log(`  [baseline] ${o.entity_type}/${o.entity_id}.${o.field_key}`);
      if (APPLY) await contrib.execute({ sql: 'UPDATE profile_overrides SET source_hash=? WHERE entity_type=? AND entity_id=? AND field_key=?', args: [h, o.entity_type, o.entity_id, o.field_key] });
      baselined++;
    } else {
      const nowDiverged = h !== o.source_hash ? 1 : 0;
      if (nowDiverged !== o.scrape_diverged) {
        console.log(`  [${nowDiverged ? 'diverged' : 'converged'}] ${o.entity_type}/${o.entity_id}.${o.field_key}`);
        if (APPLY) await contrib.execute({ sql: 'UPDATE profile_overrides SET scrape_diverged=? WHERE entity_type=? AND entity_id=? AND field_key=?', args: [nowDiverged, o.entity_type, o.entity_id, o.field_key] });
        if (nowDiverged) diverged++; else cleared++;
      }
    }
  }

  // ── Orphaned active claims: entity no longer resolves in the read-model ──────
  let orphaned = 0;
  try {
    const claims = (await contrib.execute("SELECT claim_id, entity_type, entity_id FROM profile_claims WHERE status='active'")).rows as { claim_id: string; entity_type: string; entity_id: string }[];
    for (const c of claims) {
      const profile = await getProfile(c.entity_type, c.entity_id);
      if (!profile) {
        console.log(`  [orphaned-claim] ${c.claim_id} → ${c.entity_type}/${c.entity_id} (no longer in read-model)`);
        orphaned++;
      }
    }
  } catch {
    /* no profile_claims table */
  }

  console.log(`\n${APPLY ? 'Applied' : 'DRY-RUN'} — ${overrides.length} override(s): ${baselined} baselined, ${diverged} diverged, ${cleared} cleared; ${orphaned} orphaned active claim(s).`);
  process.exit(0);
};
main();
