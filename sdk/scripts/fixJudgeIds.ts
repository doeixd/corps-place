// Usage: npx tsx scripts/fixJudgeIds.ts --db file:./dci-relational.db

import { createClient } from '@libsql/client';

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const normalizeKey = (value: string | null | undefined) => {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  return lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
};

const parseDisplayName = (displayName: string | null | undefined) => {
  if (!displayName) return { firstInitial: undefined, lastName: undefined };
  const parts = displayName.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return { firstInitial: undefined, lastName: undefined };
  const first = parts[0]?.replace(/[^A-Za-z0-9]/g, '') ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return { firstInitial: first.slice(0, 1).toLowerCase() || undefined, lastName: last };
};

const computeJudgeId = (row: {
  judge_id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
}) => {
  const firstKey = normalizeKey(row.first_name) ?? '';
  const initial = firstKey.replace(/-/g, '').slice(0, 1);
  let lastKey = normalizeKey(row.last_name);

  if (!lastKey) {
    const fallback = parseDisplayName(row.display_name);
    lastKey = normalizeKey(fallback.lastName);
  }

  const firstInitial = initial || parseDisplayName(row.display_name).firstInitial || 'u';
  if (!lastKey) {
    return row.judge_id;
  }
  return `${firstInitial}-${lastKey}-1`;
};

const main = async () => {
  const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
  const client = createClient({ url: dbUrl });

  const judgeRows = await client.execute(
    'SELECT judge_id, first_name, last_name, display_name, metadata_json FROM judges'
  );
  const judges = judgeRows.rows as unknown as Array<{
    judge_id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    metadata_json: string | null;
  }>;

  const map = new Map<string, string>();
  const insertRows: Array<{
    judge_id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    metadata_json: string | null;
  }> = [];

  for (const row of judges) {
    const newId = computeJudgeId(row);
    if (newId !== row.judge_id) {
      map.set(row.judge_id, newId);
      insertRows.push({
        judge_id: newId,
        first_name: row.first_name,
        last_name: row.last_name,
        display_name: row.display_name,
        metadata_json: row.metadata_json,
      });
    }
  }

  const tablesResult = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  const tables = (tablesResult.rows as unknown as Array<{ name: string }>).map((r) => r.name);
  const tablesWithJudgeId: string[] = [];

  for (const table of tables) {
    const columns = await client.execute(`PRAGMA table_info(${table})`);
    const hasJudgeId = (columns.rows as unknown as Array<{ name: string }>).some(
      (col) => col.name === 'judge_id'
    );
    if (hasJudgeId && table !== 'judges') {
      tablesWithJudgeId.push(table);
    }
  }

  await client.execute('PRAGMA foreign_keys=OFF');
  await client.execute('BEGIN');

  for (const row of insertRows) {
    await client.execute({
      sql:
        'INSERT INTO judges (judge_id, first_name, last_name, display_name, metadata_json) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(judge_id) DO UPDATE SET ' +
        'first_name=COALESCE(excluded.first_name, judges.first_name), ' +
        'last_name=COALESCE(excluded.last_name, judges.last_name), ' +
        'display_name=COALESCE(excluded.display_name, judges.display_name), ' +
        'metadata_json=COALESCE(excluded.metadata_json, judges.metadata_json)',
      args: [row.judge_id, row.first_name, row.last_name, row.display_name, row.metadata_json],
    });
  }

  for (const [oldId, newId] of map.entries()) {
    for (const table of tablesWithJudgeId) {
      await client.execute({
        sql: `UPDATE OR REPLACE ${table} SET judge_id = ? WHERE judge_id = ?`,
        args: [newId, oldId],
      });
    }
  }

  for (const oldId of map.keys()) {
    await client.execute({
      sql: 'DELETE FROM judges WHERE judge_id = ?',
      args: [oldId],
    });
  }

  await client.execute('COMMIT');
  await client.execute('PRAGMA foreign_keys=ON');

  console.log(`Updated ${map.size} judge_id entries across ${tablesWithJudgeId.length} tables.`);
  client.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
