/**
 * score-db's read-model path (UI/UX plan §2.1): when READ_MODEL_DB_URL is set
 * (prod), the four fantasy reads come from the frozen rm_fantasy_* tables instead
 * of the 3.4 GB relational DB. Seeds a temp read-model + asserts each reader.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let scoreDb: typeof import('./score-db');
const prevReadModel = process.env.READ_MODEL_DB_URL;
const prevRelational = process.env.DCI_RELATIONAL_DB_URL;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-rm-'));
  const rmPath = path.join(dir, 'read-model.db');
  process.env.READ_MODEL_DB_URL = `file:${rmPath}`;
  // Ensure the relational path is NOT silently used.
  delete process.env.DCI_RELATIONAL_DB_URL;

  const db = createClient({ url: `file:${rmPath}` });
  await db.batch(
    [
      `CREATE TABLE rm_fantasy_draft_pool (season TEXT, corps_key TEXT, slug TEXT, name TEXT, division_name TEXT, display_city TEXT, corps_logo TEXT, sort_index INTEGER)`,
      `CREATE TABLE rm_fantasy_prior_finals (season TEXT, corps_key TEXT, caption_name TEXT, score REAL)`,
      `CREATE TABLE rm_fantasy_season_best (season TEXT, corps_key TEXT, caption_name TEXT, best REAL)`,
      `CREATE TABLE rm_fantasy_season_finals (season TEXT, slug TEXT, date TEXT, recap_present INTEGER)`,
      `CREATE TABLE rm_corps (corps_key TEXT, corps_logo TEXT, corps_logo_dark INTEGER, corps_logo_dark_url TEXT)`,
      // 2025 pool (a 2026 league drafts from it). Includes Mandarins (must be
      // excluded) and Spartans seeded as Open Class (must be overridden to World).
      `INSERT INTO rm_fantasy_draft_pool VALUES ('2025','bd','blue-devils','Blue Devils','World Class','Concord',NULL,0)`,
      `INSERT INTO rm_fantasy_draft_pool VALUES ('2025','bk','bluecoats','Bluecoats','World Class','Canton',NULL,1)`,
      `INSERT INTO rm_fantasy_draft_pool VALUES ('2025','001j000000iwxacaa1','spartans','Spartans','Open Class','Nashua',NULL,2)`,
      `INSERT INTO rm_fantasy_draft_pool VALUES ('2025','001j000000iwxa3aal','mandarins','Mandarins','World Class','Sacramento',NULL,3)`,
      `INSERT INTO rm_corps VALUES ('bd',NULL,1,NULL)`,
      `INSERT INTO rm_corps VALUES ('bk',NULL,NULL,NULL)`,
      `INSERT INTO rm_fantasy_prior_finals VALUES ('2025','bd','General Effect 1',19.5)`,
      `INSERT INTO rm_fantasy_season_best VALUES ('2026','bd','General Effect 1',18.2)`,
      `INSERT INTO rm_fantasy_season_finals VALUES ('2026','2026-world-championship-finals','2026-08-08',1)`,
    ],
    'write'
  );
  scoreDb = await import('./score-db');
});

afterAll(() => {
  // Don't leak the read-model env to the relational-path integration tests.
  if (prevReadModel === undefined) delete process.env.READ_MODEL_DB_URL;
  else process.env.READ_MODEL_DB_URL = prevReadModel;
  if (prevRelational !== undefined) process.env.DCI_RELATIONAL_DB_URL = prevRelational;
});

describe('score-db reads the read-model when READ_MODEL_DB_URL is set', () => {
  it('getDraftPool reads the requested season, ordered by sort_index, with rules applied', async () => {
    const pool = await scoreDb.getDraftPool('2025');
    // Mandarins excluded; the rest kept in sort_index order.
    expect(pool.map((c) => c.corpsKey)).toEqual(['bd', 'bk', '001j000000iwxacaa1']);
    expect(pool[0].name).toBe('Blue Devils');
    expect(pool[0].divisionName).toBe('World Class');
    // Spartans seeded as Open Class are overridden to World Class.
    const spartans = pool.find((c) => c.corpsKey === '001j000000iwxacaa1');
    expect(spartans?.divisionName).toBe('World Class');
  });

  it('getDraftPool is empty for a season with no emitted pool', async () => {
    expect(await scoreDb.getDraftPool('2099')).toEqual([]);
  });

  it('getPriorSeasonRanking maps caption_name → CaptionKey', async () => {
    const r = await scoreDb.getPriorSeasonRanking('2025');
    expect(r.get('bd|GE1')).toBe(19.5);
  });

  it('getSeasonBestLookup reads rm_fantasy_season_best', async () => {
    const r = await scoreDb.getSeasonBestLookup('2026');
    expect(r.get('bd|GE1')).toBe(18.2);
  });

  it('getSeasonFinals reads rm_fantasy_season_finals (recap_present → boolean)', async () => {
    const r = await scoreDb.getSeasonFinals('2026');
    expect(r?.slug).toBe('2026-world-championship-finals');
    expect(r?.recapPresent).toBe(true);
  });
});
