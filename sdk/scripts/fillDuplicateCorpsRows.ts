import { createClient } from '@libsql/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const apply = process.argv.includes('--apply');
const dbUrl = process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`;
const reportFile = path.resolve(
  process.cwd(),
  'sdk',
  'results',
  `duplicate-corps-fill-${apply ? 'apply' : 'dryrun'}.json`,
);

const FILL_FIELDS = [
  'about',
  'website',
  'corps_logo',
  'corps_photo',
  'cover_image',
  'display_city',
  'city',
  'state',
  'country',
  'address',
  'phone',
  'facebook',
  'instagram',
  'twitter',
  'youtube',
] as const;

type FillField = (typeof FILL_FIELDS)[number];
type Row = Record<FillField, string | null> & {
  corps_key: string;
  name: string;
  slug: string | null;
  division_name: string | null;
};

const normalizeName = (value: string | null | undefined) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\band\b/g, '')
    .replace(/\bdrum\b/g, '')
    .replace(/\bbugle\b/g, '')
    .replace(/\bcorps\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

const hasValue = (value: unknown) => typeof value === 'string' && value.trim() !== '';
const completeness = (row: Row) =>
  FILL_FIELDS.reduce((count, field) => count + (hasValue(row[field]) ? 1 : 0), 0);

const run = async () => {
  const db = createClient({ url: dbUrl });
  await db.execute('PRAGMA busy_timeout = 5000');

  const rows = (
    await db.execute({
      sql: `SELECT corps_key, name, slug, division_name, ${FILL_FIELDS.join(', ')} FROM corps`,
      args: [],
    })
  ).rows as unknown as Row[];

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const changes: Array<{
    sourceKey: string;
    targetKey: string;
    name: string;
    field: FillField;
    value: string;
  }> = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const source = [...group].sort((a, b) => completeness(b) - completeness(a))[0];
    if (!source || completeness(source) === 0) continue;

    for (const target of group) {
      if (target.corps_key === source.corps_key) continue;
      const updates: Partial<Record<FillField, string>> = {};
      for (const field of FILL_FIELDS) {
        const value = source[field];
        if (!hasValue(value) || hasValue(target[field])) continue;
        updates[field] = value;
        changes.push({
          sourceKey: source.corps_key,
          targetKey: target.corps_key,
          name: target.name,
          field,
          value,
        });
      }

      if (apply) {
        for (const [field, value] of Object.entries(updates) as Array<[FillField, string]>) {
          await db.execute({
            sql: `UPDATE corps SET ${field} = ? WHERE corps_key = ?`,
            args: [value, target.corps_key],
          });
        }
      }
    }
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    dbUrl,
    changeCount: changes.length,
    changes,
  };

  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await db.close();

  console.log(JSON.stringify({ mode: report.mode, changeCount: changes.length, report: path.relative(process.cwd(), reportFile) }, null, 2));
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
