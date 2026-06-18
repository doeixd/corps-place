import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:./dci-relational.db' });

console.log('Clearing ml_sequence_rows_v5 table...');
const result = await db.execute('DELETE FROM ml_sequence_rows_v5');
console.log(`Deleted ${result.rowsAffected} rows`);

db.close();
console.log('Done.');
