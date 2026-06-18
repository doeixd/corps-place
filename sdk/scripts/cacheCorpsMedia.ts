import { createClient } from '@libsql/client';
import { LibsqlClient } from '@effect/sql-libsql';
import { Effect } from 'effect';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const getArg = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};

const dbUrl =
  getArg('--db') ??
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`;
const mediaDbUrl =
  getArg('--media-db') ??
  process.env.MEDIA_CACHE_DB_URL ??
  `file:${path.resolve(process.cwd(), 'sdk', 'media-cache.db')}`;
const refresh = has('--refresh');
const ownerFilter = getArg('--owner');
const researchFile = getArg('--research');
const reportFile = getArg('--report');

type CorpsMediaRow = {
  corps_key: string;
  name: string;
  corps_logo: string | null;
  corps_photo: string | null;
};

type ResearchCandidate = {
  corps_key?: string;
  corpsKey?: string;
  name?: string;
  fields?: {
    logo_url?: string | null;
    photo_url?: string | null;
    cover_image?: string | null;
  };
};

type CacheInput = Parameters<MediaService['cache']>[0];

const researchInputs = async (filePath: string): Promise<CacheInput[]> => {
  const text = await fs.readFile(filePath, 'utf8');
  const candidates = JSON.parse(text) as ResearchCandidate[];
  return candidates.flatMap((candidate) => {
    const ownerId = candidate.corps_key ?? candidate.corpsKey;
    if (!ownerId) return [];
    const name = candidate.name ?? ownerId;
    const logo = candidate.fields?.logo_url ?? null;
    const photo = candidate.fields?.photo_url ?? candidate.fields?.cover_image ?? null;
    return [
      logo
        ? {
            ownerType: 'corps',
            ownerId,
            role: 'logo',
            sourceUrl: logo,
            title: `${name} logo`,
            metadata: { source: 'corps_research', file: path.relative(process.cwd(), filePath) },
            refresh,
          }
        : null,
      photo
        ? {
            ownerType: 'corps',
            ownerId,
            role: 'cover',
            sourceUrl: photo,
            title: `${name} cover image`,
            metadata: { source: 'corps_research', file: path.relative(process.cwd(), filePath) },
            refresh,
          }
        : null,
    ].filter((input): input is CacheInput => input !== null);
  });
};

const program = Effect.gen(function* () {
  const media = yield* (MediaService);
  const db = createClient({ url: dbUrl });

  const inputs = researchFile
    ? yield* (Effect.tryPromise({ try: () => researchInputs(path.resolve(researchFile)), catch: (cause) => cause }))
    : yield* (
        Effect.tryPromise({
          try: () =>
            db.execute({
              sql: `
                SELECT corps_key, name, corps_logo, corps_photo
                FROM corps
                WHERE (? IS NULL OR corps_key = ? OR slug = ? OR lower(name) = lower(?))
                  AND (corps_logo IS NOT NULL OR corps_photo IS NOT NULL)
                ORDER BY name COLLATE NOCASE
              `,
              args: [
                ownerFilter ?? null,
                ownerFilter ?? null,
                ownerFilter ?? null,
                ownerFilter ?? null,
              ],
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((result) => {
            const rows = result.rows as unknown as CorpsMediaRow[];
            return rows.flatMap((row) =>
              [
                row.corps_logo
                  ? {
                      ownerType: 'corps',
                      ownerId: row.corps_key,
                      role: 'logo',
                      sourceUrl: row.corps_logo,
                      title: `${row.name} logo`,
                      metadata: { source: 'corps_table' },
                      refresh,
                    }
                  : null,
                row.corps_photo
                  ? {
                      ownerType: 'corps',
                      ownerId: row.corps_key,
                      role: 'cover',
                      sourceUrl: row.corps_photo,
                      title: `${row.name} cover image`,
                      metadata: { source: 'corps_table' },
                      refresh,
                    }
                  : null,
              ].filter((input): input is CacheInput => input !== null)
            );
          })
        )
      );

  const outcomes = yield* (
    Effect.forEach(
      inputs,
      (input) =>
        media.cache(input).pipe(
          Effect.match({
            onFailure: (error) => ({
              ok: false as const,
              ownerId: input.ownerId,
              role: input.role,
              url: input.sourceUrl,
              error: error.message,
            }),
            onSuccess: (asset) => ({
              ok: true as const,
              ownerId: input.ownerId,
              role: input.role,
              url: asset.url,
              format: asset.format,
              width: asset.width,
              height: asset.height,
            }),
          })
        ),
      { concurrency: 6 }
    )
  );

  db.close();

  const cached = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const report = { dbUrl, mediaDbUrl, considered: inputs.length, cached, failed };
  if (reportFile) {
    yield* (
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(path.dirname(path.resolve(reportFile)), { recursive: true });
          await fs.writeFile(path.resolve(reportFile), `${JSON.stringify(report, null, 2)}\n`);
        },
        catch: (cause) => cause,
      })
    );
  }
  console.log(JSON.stringify(report, null, 2));
});

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  Effect.runPromise(
    program.pipe(
      Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
      Effect.provide(LibsqlClient.layer({ url: dbUrl }))
    )
  ).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
