import { createClient } from '@libsql/client';

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const url = arg('--url') ?? process.env.READ_MODEL_SYNC_URL;
const authToken = arg('--token') ?? process.env.READ_MODEL_AUTH_TOKEN;

if (!url) throw new Error('Missing --url or READ_MODEL_SYNC_URL');
if (!authToken) throw new Error('Missing --token or READ_MODEL_AUTH_TOKEN');

const db = createClient({ url, authToken });
try {
  const rows = await db.execute(`
    SELECT 'schema_version' AS key, value AS value FROM rm_meta WHERE key = 'schema_version'
    UNION ALL SELECT 'rm_events', CAST(COUNT(*) AS TEXT) FROM rm_events
    UNION ALL SELECT 'rm_show_info', CAST(COUNT(*) AS TEXT) FROM rm_show_info
    UNION ALL SELECT 'rm_event_prediction', CAST(COUNT(*) AS TEXT) FROM rm_event_prediction
  `);
  for (const row of rows.rows as unknown as { key: string; value: string }[]) {
    console.log(`${row.key}: ${row.value}`);
  }
} finally {
  db.close();
}
