import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import * as path from 'node:path';
import {
  buildJudgeDirectory,
  buildJudgeProfile,
  type CaptionCount,
  type JudgeAssignment,
  type JudgeCorpsScore,
  type JudgeProfile,
  type JudgeSummary,
} from '@sdk/src/readModel/builders/judges.js';
import { readJudgeDirectory, readJudgeProfile } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

export type { CaptionCount, JudgeAssignment, JudgeCorpsScore, JudgeProfile, JudgeSummary };

export class JudgeDirectoryDataError extends Schema.TaggedErrorClass<JudgeDirectoryDataError>()(
  'JudgeDirectoryDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);

let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

// Read-model fast path (READ_MODEL_PLAN §8) with builder fallback.
const judgeError = (message: string) => (cause: unknown) =>
  new JudgeDirectoryDataError({ message, details: String(cause) });

const readOrBuild = <A>(
  message: string,
  read: (db: Client) => Promise<A>,
  build: (db: Client) => Promise<A>
) =>
  Effect.suspend(() =>
    readModelEnabled()
      ? Effect.tryPromise({ try: () => read(getReadModelClient()), catch: judgeError(message) })
      : Effect.tryPromise({ try: () => build(getDb()), catch: judgeError(message) })
  );

const listJudgesRows = () =>
  readOrBuild('Could not load the judge directory.', readJudgeDirectory, buildJudgeDirectory);

const judgeProfileById = (judgeId: string) =>
  readOrBuild(
    'Could not load the judge profile.',
    (db) => readJudgeProfile(db, judgeId),
    (db) => buildJudgeProfile(db, judgeId)
  );

const makeJudgeDirectoryService = Effect.gen(function* () {
  const listJudges = Effect.fn('JudgeDirectoryService.listJudges')(function* () {
    return yield* listJudgesRows();
  });

  const getJudgeProfile = Effect.fn('JudgeDirectoryService.getJudgeProfile')(function* (
    judgeId: string
  ) {
    return yield* judgeProfileById(judgeId.trim());
  });

  return { listJudges, getJudgeProfile };
});

export class JudgeDirectoryService extends Context.Service<
  JudgeDirectoryService,
  Effect.Success<typeof makeJudgeDirectoryService>
>()('JudgeDirectoryService') {}

export const JudgeDirectoryServiceLive = Layer.effect(
  JudgeDirectoryService,
  makeJudgeDirectoryService
);
