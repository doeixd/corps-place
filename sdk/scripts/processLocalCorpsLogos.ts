import { createClient } from '@libsql/client';
import { LibsqlClient } from '@effect/sql-libsql';
import { Effect } from 'effect';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';

const apply = process.argv.includes('--apply');
// Optional `--only=ownerId,ownerId` filter to reprocess specific logos instead of
// the whole set (e.g. to re-trim just a few without churning every other logo).
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyIds = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
const scriptPath = fileURLToPath(import.meta.url);
const sdkDir = path.resolve(path.dirname(scriptPath), '..');
const root = path.resolve(sdkDir, '..');
const logoDir = path.resolve(root, 'public', 'corps-logos');
const dbUrl = `file:${path.resolve(sdkDir, 'dci-relational.db')}`;
const mediaDbUrl = `file:${path.resolve(sdkDir, 'media-cache.db')}`;

const LOGOS = [
  {
    ownerId: '001j000000iwwsmaal',
    name: 'Alliance',
    fileName: 'alliance.png',
    removeWhite: true,
  },
  {
    ownerId: 'latrobe-music-center',
    name: 'Apogee',
    fileName: 'apogee.png',
    removeWhite: false,
  },
  {
    ownerId: 'beijing-57-high-school',
    name: 'Beijing 57 High School',
    fileName: 'beijing-57-high-school.png',
    removeWhite: true,
  },
  {
    ownerId: '0010a00001iprmyaah',
    name: 'Cadets 2',
    fileName: 'cadets2.png',
    removeWhite: true,
  },
  {
    ownerId: 'chien-kuo',
    name: 'Chien Kuo',
    fileName: 'chien-kuo.png',
    legacyFileNames: ['CKHS_Taipei_Logo.png'],
    removeWhite: true,
  },
  {
    ownerId: 'city-sound',
    name: 'City Sound',
    fileName: 'city-sound.png',
    removeWhite: true,
  },
  {
    ownerId: '001j000000iwwspaal',
    name: 'Blue Saints',
    fileName: 'blue-saints.png',
    removeWhite: true,
  },
  {
    ownerId: 'conquest-drum-bugle-corps',
    name: 'Conquest Drum & Bugle Corps',
    fileName: 'conquest.png',
    removeWhite: true,
  },
  {
    ownerId: 'legacy-drum-bugle-corps',
    name: 'Legacy Drum & Bugle Corps',
    fileName: 'legacy.png',
    legacyFileNames: ['legacy.jpg'],
    removeWhite: true,
  },
  {
    ownerId: 'mercedes-marching-band',
    name: 'Mercedes Marching Band',
    fileName: 'mercedes.png',
    removeWhite: true,
  },
  {
    ownerId: 'phoenix',
    name: 'Phoenix',
    fileName: 'phoenix.png',
    legacyFileNames: ['pheonix.png'],
    removeWhite: true,
  },
  {
    ownerId: 'sparta-ignite',
    name: 'Sparta Ignite',
    fileName: 'sparta-ignite.png',
    removeWhite: true,
  },
  {
    ownerId: 'north-star',
    name: 'North Star',
    fileName: 'north-star.png',
    removeWhite: true,
  },
  {
    ownerId: 'baldwinsville-high-school-band',
    name: 'Baldwinsville High School Band',
    fileName: 'baldwinsville-high-school-band.png',
    legacyFileNames: ['Baldwinsville-High-School-Band.jpeg'],
    removeWhite: true,
  },
  {
    ownerId: 'rcr-street-club',
    name: 'RCR Street Club',
    fileName: 'rcr-street-club.png',
    legacyFileNames: ['RCRlogo-river-city-rhythm-street-club.webp'],
    removeWhite: true,
  },
  {
    ownerId: 'u-s-marine-drum-bugle-corps',
    name: 'U.S. Marine Drum & Bugle Corps',
    fileName: 'us-marine-dbc.png',
    legacyFileNames: ['USMCDBCEmblem.png'],
    removeWhite: true,
  },
  {
    ownerId: 'alisal-union-school-district-marching-band',
    name: 'Alisal Union School District',
    fileName: 'alisal-union-school-district.png',
    removeWhite: true,
  },
  {
    ownerId: 'allegheny-eclipse',
    name: 'Allegheny Eclipse',
    fileName: 'allegheny-eclipse.png',
    legacyFileNames: ['allegheny-eclipse.webp'],
    removeWhite: true,
  },
  {
    ownerId: 'apollo-marching-theatre',
    name: 'Apollo Marching Theatre',
    fileName: 'apollo-marching-theatre.png',
    removeWhite: true,
  },
  {
    ownerId: 'inpact-bandtastic-band',
    name: 'INpact & BANDtastic Band',
    fileName: 'bandtastic.png',
    removeWhite: true,
  },
  {
    ownerId: 'brig-juice-brass',
    name: 'Brig Juice Brass',
    fileName: 'brig-juice-brass.png',
    removeWhite: true,
  },
  {
    ownerId: 'connexion',
    name: 'The ConneXion',
    fileName: 'connexion.png',
    removeWhite: true,
  },
  {
    ownerId: 'eastern-connecticut-symphony-orchestra',
    name: 'Eastern Connecticut Symphony Orchestra',
    fileName: 'eastern-ct-symphony-orchestra.png',
    removeWhite: true,
  },
  {
    ownerId: 'en-corps-by-en-rich-ment',
    name: 'EN-CORPS by EN-RICH-MENT',
    fileName: 'en-corps-by-enrich-ment.png',
    removeWhite: true,
  },
  {
    ownerId: 'sacramento-freelancers-drum-bugle-corps',
    name: 'Sacramento Freelancers Drum & Bugle Corps',
    fileName: 'freelancers.png',
    removeWhite: true,
  },
  {
    ownerId: 'nc-a-t-cold-steel-drumline',
    name: 'NC A&T Cold Steel Drumline',
    fileName: 'nc-a&t-cold-steel-drumline.png',
    removeWhite: true,
  },
  {
    ownerId: 'rocky-mountain-brassworks',
    name: 'Rocky Mountain Brassworks',
    fileName: 'rocky-mountain-brassworks.png',
    legacyFileNames: ['rocky-moutain-brass-works.webp'],
    removeWhite: true,
  },
  {
    ownerId: 'rosemont-king-cobras',
    name: 'Rosemont King Cobras',
    fileName: 'rosemont-king-cobras.png',
    removeWhite: true,
  },
  {
    ownerId: 'blue-way-summer-arts-camp',
    name: 'The Blue Way',
    fileName: 'the-blue-way.png',
    removeWhite: true,
  },
  {
    ownerId: 'marching-elite',
    name: 'The Marching Elite',
    fileName: 'the-marching-elite.png',
    removeWhite: true,
  },
  {
    ownerId: 'minnesota-state-university-clinic-band',
    name: 'Minnesota State University Clinic Band',
    fileName: 'minnesota-university.png',
    removeWhite: true,
  },
  {
    ownerId: 'rhythm-in-blue',
    name: 'Rhythm IN BLUE',
    fileName: 'rhythm-in-blue.png',
    removeWhite: true,
  },
  {
    ownerId: '0010a00001cxz0gaab',
    name: 'Green Beret',
    fileName: 'green-beret.png',
    removeWhite: true,
  },
  {
    ownerId: 'gita-surosowan-banten',
    name: 'Gita Surosowan Banten',
    fileName: 'gita-surosowan-banten.png',
    legacyFileNames: ['gita-surosowan-banten.jpg'],
    removeWhite: true,
  },
  {
    ownerId: '0015b00002bxwbjaap',
    name: 'Gems',
    fileName: 'gem.png',
    removeWhite: true,
  },
  {
    ownerId: 'high-school-affiliated-to-bit',
    name: 'High School Affiliated to BIT',
    fileName: 'high-school-affiliated-to-BIT.png',
    removeWhite: true,
  },
  {
    ownerId: 'kilties',
    name: 'Kilties',
    fileName: 'kilties.png',
    removeWhite: true,
  },
  {
    ownerId: 'racine-scouts',
    name: 'Racine Scouts',
    fileName: 'racine-scouts.png',
    removeWhite: true,
  },
  {
    ownerId: '001j0000012tpxmaa2',
    name: 'Shadow',
    fileName: 'shadow.png',
    removeWhite: true,
  },
  {
    ownerId: 'spark',
    name: 'Spark',
    fileName: 'spark.png',
    legacyFileNames: ['spark-logo.png'],
    removeWhite: true,
  },
  {
    ownerId: 'socal-dream',
    name: 'SoCal Dream',
    fileName: 'socal-dream.png',
    removeWhite: true,
  },
  {
    ownerId: '0010a00001bpafnaar',
    name: 'Sound of Sun Prairie',
    fileName: 'sound-of-sun-prairie.png',
    legacyFileNames: ['sound of sun prairie.png'],
    removeWhite: true,
  },
  {
    ownerId: '001j000000dlalkaag',
    name: 'Southern Knights',
    fileName: 'southern-knights.png',
    removeWhite: true,
  },
  {
    ownerId: 'southern-knights',
    name: 'Southern Knights',
    fileName: 'southern-knights.png',
    removeWhite: true,
  },
  {
    ownerId: '001j000000u5nhqaaj',
    name: 'Spirit of Sunnyvale',
    fileName: 'spirit-of-sunnyvale.png',
    removeWhite: true,
  },
  {
    ownerId: '001j000000iwxaiaa1',
    name: 'Thunder',
    fileName: 'spokane-thunder.png',
    removeWhite: true,
  },
  {
    ownerId: 'teal-sound',
    name: 'Teal Sound',
    fileName: 'teal-sound-grey-bg.png',
    removeWhite: true,
  },
  {
    ownerId: '0010a000019s6ceaay',
    name: 'Erie Thunderbirds',
    fileName: 'thunderbirds.png',
    removeWhite: true,
  },
] as const;

const run = (command: string, args: readonly string[]) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout.trim();
};

const imageSize = (filePath: string) => {
  const output = run('magick', ['identify', '-format', '%w %h', filePath]);
  const [width, height] = output.split(/\s+/).map((part) => Number(part));
  if (!width || !height) throw new Error(`Could not identify image size: ${filePath}`);
  return { width, height };
};

const removeConnectedWhiteBackground = async (filePath: string) => {
  const { width, height } = imageSize(filePath);
  const tmp = `${filePath}.tmp.png`;
  run('magick', [
    filePath,
    '-alpha',
    'set',
    '-fuzz',
    '8%',
    '-fill',
    'none',
    '-draw',
    'color 0,0 floodfill',
    '-draw',
    `color ${width - 1},0 floodfill`,
    '-draw',
    `color 0,${height - 1} floodfill`,
    '-draw',
    `color ${width - 1},${height - 1} floodfill`,
    '-define',
    'png:color-type=6',
    tmp,
  ]);
  await fs.rename(tmp, filePath);
};

// Crop fully-transparent margins down to the artwork, then re-add a small
// transparent buffer (~3% of the longer side, min 4px) so the logo isn't flush
// against the edge. Idempotent: trimming re-adds the same buffer each run.
const trimToContent = async (filePath: string) => {
  const trimmed = `${filePath}.trim.png`;
  run('magick', [filePath, '-trim', '+repage', '-define', 'png:color-type=6', trimmed]);
  const { width, height } = imageSize(trimmed);
  const buffer = Math.max(4, Math.round(Math.max(width, height) * 0.03));
  run('magick', [
    trimmed,
    '-bordercolor',
    'none',
    '-border',
    String(buffer),
    '-define',
    'png:color-type=6',
    filePath,
  ]);
  await fs.rm(trimmed);
};

const toDataUrl = async (filePath: string) => {
  const bytes = await fs.readFile(filePath);
  return `data:image/png;base64,${bytes.toString('base64')}`;
};

const ensureStableFileName = async (logo: (typeof LOGOS)[number]) => {
  const target = path.join(logoDir, logo.fileName);
  if (await fs.stat(target).then(() => true, () => false)) return target;

  for (const legacy of logo.legacyFileNames ?? []) {
    const source = path.join(logoDir, legacy);
    if (!(await fs.stat(source).then(() => true, () => false))) continue;
    const sourceExtension = path.extname(source).toLowerCase();
    const targetExtension = path.extname(target).toLowerCase();
    if (sourceExtension !== targetExtension) {
      if (apply) {
        run('magick', [source, '-define', 'png:color-type=6', target]);
        return target;
      }
      return source;
    }
    if (apply) await fs.rename(source, target);
    return target;
  }
  throw new Error(`Missing local logo file: ${logo.fileName}`);
};

const program = Effect.gen(function* () {
  const media = yield* MediaService;
  const db = createClient({ url: dbUrl });
  yield* Effect.promise(() => db.execute('PRAGMA busy_timeout = 5000'));

  const results = [];
  for (const logo of LOGOS) {
    if (onlyIds && !onlyIds.has(logo.ownerId)) continue;
    const filePath = yield* Effect.promise(() => ensureStableFileName(logo));
    if (apply && logo.removeWhite) {
      yield* Effect.promise(() => removeConnectedWhiteBackground(filePath));
      // Tighten to the artwork with a small buffer once the bg is transparent.
      yield* Effect.promise(() => trimToContent(filePath));
    }

    const canonicalUrl = `/corps-logos/${logo.fileName}`;
    let cached: unknown = null;
    if (apply) {
      const asset = yield* media.cache({
        ownerType: 'corps',
        ownerId: logo.ownerId,
        role: 'logo',
        sourceUrl: yield* Effect.promise(() => toDataUrl(filePath)),
        canonicalUrl,
        title: `${logo.name} logo`,
        attribution: 'user-provided image',
        metadata: {
          via: 'user-upload',
          localFile: path.relative(root, filePath),
          background: logo.removeWhite ? 'connected white removed' : 'preserved',
        },
        refresh: true,
      });
      yield* Effect.promise(() =>
        db.execute({
          sql: 'UPDATE corps SET corps_logo = ? WHERE corps_key = ?',
          args: [canonicalUrl, logo.ownerId],
        }),
      );
      cached = {
        url: asset.url,
        format: asset.format,
        width: asset.width,
        height: asset.height,
        bytes: asset.metadata?.byteLength,
      };
    }

    results.push({
      ownerId: logo.ownerId,
      name: logo.name,
      file: path.relative(root, filePath),
      canonicalUrl,
      removeWhite: logo.removeWhite,
      cached,
    });
  }

  db.close();
  return results;
});

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  Effect.runPromise(
    program.pipe(
      Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
      Effect.provide(LibsqlClient.layer({ url: dbUrl })),
    ),
  )
    .then((results) => {
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', results }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
