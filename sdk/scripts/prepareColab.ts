import { Effect, Console, Schedule } from 'effect';
import { FileSystem, Path } from 'effect';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import * as fs from 'node:fs';
import archiver from 'archiver';

const ZIP_FILE = 'sdk-colab.zip';
const INCLUDES = [
  'src',
  'results/v9-subcaption-target-norm.json',
  'dci-relational.db',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'COLAB_GPU_GUIDE.md',
  'scripts/colab-setup.sh',
];

const program = Effect.gen(function* () {
  const fsPlatform = yield* (FileSystem.FileSystem);

  yield* (Console.log('\x1b[36m' + '📂 Preparing Colab archive...' + '\x1b[0m'));

  // 1. Check if zip already exists and remove it
  const exists = yield* (fsPlatform.exists(ZIP_FILE));
  if (exists) {
    yield* (Console.log(`🗑️ Removing old ${ZIP_FILE}...`));
    yield* (fsPlatform.remove(ZIP_FILE));
  }

  // 2. Create the archive using a specialized Effect wrapper for the stream
  const createArchive = Effect.callback<void, Error>((resume) => {
    const output = fs.createWriteStream(ZIP_FILE);
    const archive = archiver('zip', { zlib: { level: 1 } }); // Level 1 is much faster than Level 9

    output.on('close', () => {
      console.log(
        `\n\x1b[32m✅ Compression complete. Total bytes: ${(archive.pointer() / (1024 * 1024)).toFixed(2)} MB\x1b[0m`
      );
      resume(Effect.void);
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') console.warn('⚠️ Warning:', err);
      else resume(Effect.fail(err));
    });

    archive.on('error', (err) => {
      resume(Effect.fail(err));
    });

    // Progress reporting
    archive.on('progress', (data) => {
      const mb = (data.fs.processedBytes / (1024 * 1024)).toFixed(2);
      process.stdout.write(
        `\r🚀 Progress: ${mb} MB processed (${data.entries.processed}/${data.entries.total} files)`
      );
    });

    archive.on('entry', (entry) => {
      // Only log major directories or files to avoid spamming 1000s of lines
      if (!entry.name.includes('/')) {
        console.log(`  📄 Adding: ${entry.name}`);
      }
    });

    archive.pipe(output);

    // Add each inclusion
    for (const item of INCLUDES) {
      if (!fs.existsSync(item)) {
        console.warn(`  ⚠️ Skipping missing item: ${item}`);
        continue;
      }
      const stats = fs.statSync(item);
      if (stats.isDirectory()) {
        console.log(`  📁 Scanning directory: ${item}`);
        archive.directory(item, item);
      } else {
        archive.file(item, { name: item });
      }
    }

    archive.finalize();
  });

  yield* (createArchive);

  // 3. Final report
  yield* (Console.log('\n' + '\x1b[35m' + '🏁 Ready for upload!' + '\x1b[0m'));
  yield* (Console.log(`👉 Link: ${ZIP_FILE}`));
  yield* (Console.log('👉 Follow instructions in: COLAB_GPU_GUIDE.md'));
});

const runnable = program.pipe(
  Effect.provide(NodeContext.layer),
  Effect.catch((error) => Console.error(`❌ Failed to create zip: ${error}`))
);

NodeRuntime.runMain(runnable);
