import Database from 'better-sqlite3';

const db = new Database('./dci-relational.db', { readonly: true });

function main() {
  const rows = db.prepare('SELECT event_name, venue_name, city FROM competitions').all() as { event_name: string, venue_name: string, city: string }[];

  const categories = {
    finals: 0,
    regionals: 0,
    major_city: 0,
    others: 0
  };

  const sampleFinals: string[] = [];
  const sampleRegionals: string[] = [];
  const majorCities = new Set(['San Antonio', 'Atlanta', 'Murfreesboro', 'Allentown', 'Indianapolis']);

  for (const row of rows) {
    const low = (row.event_name || '').toLowerCase();
    const city = row.city;
    const isFinals = low.includes('finals') || low.includes('championship');
    const isRegional = low.includes('regional') || majorCities.has(city);

    if (isFinals) {
      categories.finals++;
      if (sampleFinals.length < 5) sampleFinals.push(row.event_name);
    } else if (isRegional) {
      categories.regionals++;
      if (sampleRegionals.length < 5) sampleRegionals.push(row.event_name);
    } else {
      categories.others++;
    }
  }

  console.log('--- Event Statistics ---');
  console.log('Total Competitions:', rows.length);
  console.log('Categories:', categories);
  console.log('\nFinals Samples:', sampleFinals);
  console.log('Regionals Samples:', sampleRegionals);
}

main();
