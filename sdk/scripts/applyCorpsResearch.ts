import { createClient } from '@libsql/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const getArg = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};

const dbUrl =
  getArg('--db') ??
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`;
const inputFile =
  getArg('--input') ??
  path.resolve(process.cwd(), 'sdk', 'results', 'corps-research-consolidated.json');
const reportFile =
  getArg('--report') ??
  path.resolve(
    process.cwd(),
    'sdk',
    'results',
    `corps-research-${apply ? 'apply' : 'dryrun'}.json`,
  );

type ResearchCandidate = {
  corps_key: string;
  name?: string;
  fields?: Record<string, unknown>;
};

type CorpsRow = Record<string, unknown> & {
  corps_key: string;
  name: string | null;
  corps_logo: string | null;
  corps_photo: string | null;
};

const FIELD_MAP: Record<string, string> = {
  about: 'about',
  website: 'website',
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  youtube: 'youtube',
  city: 'city',
  state: 'state',
  country: 'country',
  display_city: 'display_city',
  address: 'address',
  phone: 'phone',
};

const MEDIA_FIELD_MAP: Record<string, string> = {
  logo_url: 'corps_logo',
  photo_url: 'corps_photo',
  cover_image: 'corps_photo',
};

const cleanString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const isEmpty = (value: unknown): boolean => value == null || (typeof value === 'string' && !value.trim());

const isPlaceholderLogo = (value: unknown): boolean => {
  const url = cleanString(value);
  return (
    !url ||
    /dci-splash/i.test(url) ||
    /^\/corps-logos\/.+\.svg$/i.test(url)
  );
};

const isPlaceholderPhoto = (value: unknown): boolean => {
  const url = cleanString(value);
  return !url || /dci-splash/i.test(url);
};

const shouldWrite = (column: string, current: unknown, incoming: string): boolean => {
  if (column === 'corps_logo') return isPlaceholderLogo(current);
  if (column === 'corps_photo') return isPlaceholderPhoto(current);
  return isEmpty(current) && incoming.length > 0;
};

const run = async () => {
  const db = createClient({ url: dbUrl });
  await db.execute('PRAGMA busy_timeout = 5000');

  const candidates = JSON.parse(await fs.readFile(inputFile, 'utf8')) as ResearchCandidate[];
  const changes: Array<{
    corpsKey: string;
    name: string;
    field: string;
    from: unknown;
    to: string;
  }> = [];
  const skipped: Array<{
    corpsKey: string;
    name?: string;
    field?: string;
    reason: string;
  }> = [];

  for (const candidate of candidates) {
    const result = await db.execute({
      sql: 'SELECT * FROM corps WHERE corps_key = ? LIMIT 1',
      args: [candidate.corps_key],
    });
    const row = result.rows[0] as unknown as CorpsRow | undefined;
    if (!row) {
      skipped.push({ corpsKey: candidate.corps_key, name: candidate.name, reason: 'corps_key not found' });
      continue;
    }

    const fields = candidate.fields ?? {};
    const updates: Record<string, string> = {};
    for (const [sourceField, column] of Object.entries({ ...FIELD_MAP, ...MEDIA_FIELD_MAP })) {
      const incoming = cleanString(fields[sourceField]);
      if (!incoming) continue;
      if (!shouldWrite(column, row[column], incoming)) {
        skipped.push({
          corpsKey: row.corps_key,
          name: row.name ?? candidate.name,
          field: column,
          reason: 'already populated',
        });
        continue;
      }
      if (updates[column]) continue;
      updates[column] = incoming;
      changes.push({
        corpsKey: row.corps_key,
        name: row.name ?? candidate.name ?? row.corps_key,
        field: column,
        from: row[column],
        to: incoming,
      });
    }

    if (apply && Object.keys(updates).length > 0) {
      for (const [column, value] of Object.entries(updates)) {
        await db.execute({
          sql: `UPDATE corps SET ${column} = ? WHERE corps_key = ?`,
          args: [value, row.corps_key],
        });
      }
    }
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    dbUrl,
    inputFile: path.relative(process.cwd(), path.resolve(inputFile)),
    candidateCount: candidates.length,
    changeCount: changes.length,
    changes,
    skippedCount: skipped.length,
    skipped,
  };

  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await db.close();

  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        candidateCount: report.candidateCount,
        changeCount: report.changeCount,
        skippedCount: report.skippedCount,
        report: path.relative(process.cwd(), reportFile),
      },
      null,
      2,
    ),
  );
};

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
