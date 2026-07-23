// /accuracy RPC. Reads the rm_accuracy shard in prod (relational builder
// fallback in dev) and returns the frozen prediction-accuracy payload for the
// season. LEAK-SAFE: a createServerFn module — server/SDK/node value-imports are
// stripped client-side.
import { createServerFn } from '@tanstack/react-start';
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import {
  buildPredictionAccuracy,
  type AccuracyPayload,
} from '@sdk/src/readModel/builders/predictionAccuracy.js';
import { readAccuracy } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

let sharedDb: Client | null = null;
const getDb = () =>
  (sharedDb ??= createClient({
    url:
      process.env.DCI_RELATIONAL_DB_URL ??
      `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`,
  }));

const readOrBuild = <A>(read: (db: Client) => Promise<A>, build: (db: Client) => Promise<A>) =>
  readModelEnabled() ? read(getReadModelClient()) : build(getDb());

const SEASON = '2026';

export const getAccuracy = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ payload: AccuracyPayload | null }> => {
    const payload = await readOrBuild(
      (db) => readAccuracy(db, SEASON),
      (db) => buildPredictionAccuracy(db, SEASON)
    ).catch(() => null);
    return { payload };
  }
);
