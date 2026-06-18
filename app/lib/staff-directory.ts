import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import * as path from 'node:path';
import {
  buildStaffDirectory,
  buildStaffProfile,
  type StaffAssignment,
  type StaffGroup,
  type StaffProfile,
  type StaffSummary,
} from '@sdk/src/readModel/builders/staff.js';
import { readStaffDirectory, readStaffProfile } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

export type { StaffAssignment, StaffGroup, StaffProfile, StaffSummary };

export class StaffDirectoryDataError extends Schema.TaggedErrorClass<StaffDirectoryDataError>()(
  'StaffDirectoryDataError',
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

const staffError = (message: string) => (cause: unknown) =>
  new StaffDirectoryDataError({ message, details: String(cause) });

// Read-model fast path with builder fallback (mirrors judge-directory.ts).
const readOrBuild = <A>(
  message: string,
  read: (db: Client) => Promise<A>,
  build: (db: Client) => Promise<A>
) =>
  Effect.suspend(() =>
    readModelEnabled()
      ? Effect.tryPromise({ try: () => read(getReadModelClient()), catch: staffError(message) })
      : Effect.tryPromise({ try: () => build(getDb()), catch: staffError(message) })
  );

const makeStaffDirectoryService = Effect.gen(function* () {
  const listStaff = Effect.fn('StaffDirectoryService.listStaff')(function* () {
    return yield* readOrBuild(
      'Could not load the staff directory.',
      readStaffDirectory,
      buildStaffDirectory
    );
  });

  const getStaffProfile = Effect.fn('StaffDirectoryService.getStaffProfile')(function* (
    personId: string
  ) {
    const id = personId.trim();
    return yield* readOrBuild(
      'Could not load the staff profile.',
      (db) => readStaffProfile(db, id),
      (db) => buildStaffProfile(db, id)
    );
  });

  return { listStaff, getStaffProfile };
});

export class StaffDirectoryService extends Context.Service<
  StaffDirectoryService,
  Effect.Success<typeof makeStaffDirectoryService>
>()('StaffDirectoryService') {}

export const StaffDirectoryServiceLive = Layer.effect(
  StaffDirectoryService,
  makeStaffDirectoryService
);
