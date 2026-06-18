import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:./dci-relational.db' });

// Check first few rows
const rows = await db.execute({
  sql: 'SELECT * FROM ml_sequence_rows_v5 LIMIT 3',
  args: []
});

console.log('\n=== Sample rows from ml_sequence_rows_v5 ===\n');
rows.rows.forEach((row, i) => {
  console.log(`\nRow ${i + 1}:`);
  console.log('  Season:', row.season);
  console.log('  Competition:', row.competition_slug);
  console.log('  Corps:', row.corps_key);
  console.log('  Split:', row.split);

  const yRecap = JSON.parse(row.y_recap_json);
  console.log('\n  y_recap captions:', Object.keys(yRecap));
  console.log('  y_recap values:', yRecap);

  const yResiduals = JSON.parse(row.y_residuals_json);
  console.log('\n  y_residuals captions:', Object.keys(yResiduals));
});

// Count stats
const stats = await db.execute({
  sql: 'SELECT split, COUNT(*) as count FROM ml_sequence_rows_v5 GROUP BY split',
  args: []
});

console.log('\n\n=== Data split statistics ===');
stats.rows.forEach(row => {
  console.log(`  ${row.split}: ${row.count} rows`);
});

db.close();
