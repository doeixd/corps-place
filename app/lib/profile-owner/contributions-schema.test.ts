import { describe, expect, it } from 'vite-plus/test';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Integration test for the persistence invariants the profile-ownership claim
// flow relies on, run against the REAL DDL (extracted from contributions-db.ts)
// on an in-memory libsql DB. This exercises the guarantees the service trusts —
// most importantly "one ACTIVE owner per entity, but re-claim is allowed after a
// revoke" (the partial-unique index behind the ClaimExists mapping + the race fix)
// — so a schema regression (e.g. dropping the partial index) fails loudly here
// instead of in production.

// Pull the profile_* CREATE statements straight from the app's schema source so
// the test can never drift from the real tables.
const profileDdl = (() => {
  const src = readFileSync(resolve(process.cwd(), 'app/lib/contributions-db.ts'), 'utf8');
  return [...src.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((s) => /profile_(claims|overrides|revisions)/.test(s) && /CREATE/i.test(s));
})();

const freshDb = async (): Promise<Client> => {
  const db = createClient({ url: ':memory:' });
  for (const stmt of profileDdl) await db.execute(stmt);
  return db;
};

const insertClaim = (
  db: Client,
  o: { id: string; entity: string; user: string; status: string }
) =>
  db.execute({
    sql: `INSERT INTO profile_claims
            (claim_id, entity_type, entity_id, user_id, status, attested_at, attestation_version, claimed_at)
          VALUES (?, 'staff', ?, ?, ?, '2026-06-30', '2026-06-29', '2026-06-30')`,
    args: [o.id, o.entity, o.user, o.status],
  });

describe('profile-ownership schema invariants', () => {
  it('extracts the real profile_* DDL (claims, overrides, revisions + indexes)', () => {
    // 3 CREATE TABLE + the partial-unique + supporting indexes.
    expect(profileDdl.some((s) => /CREATE TABLE.*profile_claims/i.test(s))).toBe(true);
    expect(profileDdl.some((s) => /CREATE TABLE.*profile_overrides/i.test(s))).toBe(true);
    expect(profileDdl.some((s) => /CREATE TABLE.*profile_revisions/i.test(s))).toBe(true);
    expect(profileDdl.some((s) => /uq_profile_claims_active/i.test(s))).toBe(true);
  });

  it('allows exactly ONE active owner per entity', async () => {
    const db = await freshDb();
    await insertClaim(db, { id: 'c1', entity: 'alice', user: 'u1', status: 'active' });
    // A second ACTIVE claim on the same (entity_type, entity_id) must be rejected —
    // this is the constraint the service maps to ClaimExists instead of a 500.
    await expect(
      insertClaim(db, { id: 'c2', entity: 'alice', user: 'u2', status: 'active' })
    ).rejects.toThrow();
    // A different entity is fine.
    await insertClaim(db, { id: 'c3', entity: 'bob', user: 'u2', status: 'active' });
    const n = await db.execute(`SELECT COUNT(*) AS n FROM profile_claims WHERE status='active'`);
    expect(Number((n.rows[0] as any).n)).toBe(2);
  });

  it('permits a fresh claim once the prior one is revoked (re-claim after revoke)', async () => {
    const db = await freshDb();
    await insertClaim(db, { id: 'c1', entity: 'alice', user: 'u1', status: 'active' });
    await db.execute({
      sql: `UPDATE profile_claims SET status='revoked', revoked_at='2026-06-30' WHERE claim_id=?`,
      args: ['c1'],
    });
    // The partial index excludes revoked rows, so a new owner can claim.
    await insertClaim(db, { id: 'c2', entity: 'alice', user: 'u2', status: 'active' });
    const active = await db.execute(
      `SELECT user_id FROM profile_claims WHERE entity_id='alice' AND status='active'`
    );
    expect(active.rows.length).toBe(1);
    expect((active.rows[0] as any).user_id).toBe('u2');
  });

  it('keeps the editable overlay one row per (entity, field) and records revisions', async () => {
    const db = await freshDb();
    const putOverride = (field: string, content: string) =>
      db.execute({
        sql: `INSERT INTO profile_overrides (entity_type, entity_id, field_key, content_json, updated_at, updated_by)
              VALUES ('staff','alice',?,?,'2026-06-30','u1')
              ON CONFLICT (entity_type, entity_id, field_key)
              DO UPDATE SET content_json=excluded.content_json`,
        args: [field, content],
      });
    await putOverride('biography', '{"v":1}');
    await putOverride('biography', '{"v":2}'); // upsert, not a duplicate row
    const rows = await db.execute(
      `SELECT content_json FROM profile_overrides WHERE entity_id='alice' AND field_key='biography'`
    );
    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as any).content_json).toBe('{"v":2}');

    // Append-only history is per-entity and ordered by created_at.
    for (const [i, op] of [['r1', 'edit'], ['r2', 'edit']].entries()) {
      await db.execute({
        sql: `INSERT INTO profile_revisions
                (revision_id, entity_type, entity_id, target_kind, actor_user_id, actor_role, op, created_at)
              VALUES (?, 'staff','alice','override','u1','user',?,?)`,
        args: [op[0], op[1], `2026-06-30T0${i}:00:00Z`],
      });
    }
    const hist = await db.execute(
      `SELECT revision_id FROM profile_revisions WHERE entity_id='alice' ORDER BY created_at`
    );
    expect(hist.rows.map((r: any) => r.revision_id)).toEqual(['r1', 'r2']);
  });
});
