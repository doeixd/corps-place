import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:./dci-relational.db' });

// Check 2024 Finals data
const rows = await db.execute({
  sql: `SELECT * FROM ml_sequence_rows_v5
        WHERE season = '2024'
        AND competition_slug LIKE '%finals%'
        LIMIT 3`,
  args: []
});

console.log('\n=== 2024 Finals Data ===\n');
rows.rows.forEach((row, i) => {
  console.log(`\nRow ${i + 1}:`);
  console.log('  Competition:', row.competition_slug);
  console.log('  Corps:', row.corps_key);

  const yRecap = JSON.parse(row.y_recap_json);
  console.log('\n  Caption scores:');
  Object.entries(yRecap).forEach(([caption, score]) => {
    console.log(`    ${caption}: ${score}`);
  });
});

db.close();
