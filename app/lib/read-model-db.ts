// Shared read-model libsql client with zero-downtime hot-swap (A/B slots).
//
// The read-model is a small, batch-built, read-only SQLite file distributed via
// R2 (scripts/pushData.ts ↔ pullData.ts / the container entrypoint pulls it on
// boot — see docs/DEPLOYMENT_REALITY.md §5). This client only ever reads a LOCAL
// file; there is no live replication.
//
// The emitter/puller never overwrites the file a running server holds open (which
// is impossible on Windows and inode-stale on Linux). Instead it writes a fresh
// build into the *inactive* of two slots and flips a tiny pointer file:
//
//   <stem>.a.db   <stem>.b.db   <stem>.active   (text: "a" | "b")
//
// This client polls the pointer (throttled) and, when it flips, reconnects to the
// newly-active slot and closes the old one — no restart, no downtime. The pointer
// is a tiny file nobody holds open, so its atomic temp+rename always succeeds.
//
// READ_MODEL_DB_URL stays the *base* path (file:<dir>/<stem>.db). When no pointer
// exists we fall back to that literal path, so the legacy single-file layout (and
// the migration from it) keeps working unchanged.

import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const baseUrl = () => process.env.READ_MODEL_DB_URL;

export const readModelEnabled = () => Boolean(baseUrl());

interface Slots {
  dir: string;
  stem: string;
  pointer: string;
  /** Legacy single-file path used when no pointer is present. */
  fallback: string;
}

const slotsOf = (url: string): Slots => {
  const filePath = url.replace(/^file:/, '');
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath).replace(/\.db$/i, '');
  return { dir, stem, pointer: path.join(dir, `${stem}.active`), fallback: filePath };
};

const slotFile = (s: Slots, slot: 'a' | 'b') => path.join(s.dir, `${s.stem}.${slot}.db`);

// Resolve the active db file: pointer → slot file (only if it actually exists),
// else the legacy single-file path. Any read error degrades to the fallback.
const resolveActivePath = (s: Slots): string => {
  try {
    const slot = fs.readFileSync(s.pointer, 'utf8').trim();
    if (slot === 'a' || slot === 'b') {
      const f = slotFile(s, slot);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    // No pointer (legacy layout) or unreadable — fall back below.
  }
  return s.fallback;
};

const CHECK_INTERVAL_MS = 5_000;

let client: Client | null = null;
let clientPath: string | null = null;
let lastCheck = 0;

export const getReadModelClient = (): Client => {
  const url = baseUrl()!;
  const s = slotsOf(url);
  const now = Date.now();
  // Within the throttle window, return the cached client untouched.
  if (client && now - lastCheck < CHECK_INTERVAL_MS) return client;
  lastCheck = now;

  const active = resolveActivePath(s);
  if (client && active !== clientPath) {
    // Pointer flipped to a new slot — discard the stale client so reads
    // reconnect to the fresh file, and release the old handle so the puller can
    // reuse that slot on the next refresh.
    const stale = client;
    client = null;
    void Promise.resolve(stale.close?.()).catch(() => {});
  }
  if (!client) {
    client = createClient({ url: `file:${active}` });
    clientPath = active;
  }
  return client;
};
