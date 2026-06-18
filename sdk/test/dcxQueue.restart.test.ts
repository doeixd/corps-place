// Durable-queue restart test: proves the stop/restart guarantee.
//
// Simulates a crash mid-drain (workers interrupted while holding leases), then a
// "restart" (expired leases reclaimed, workers resume). Asserts: no task is lost,
// every task ends 'done' exactly once, idempotent enqueue is a no-op.
//
// Run with: npx tsx test/dcxQueue.restart.test.ts

import * as fs from "node:fs";
import { Effect, Fiber, Layer, Ref } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initSchema } from "../src/dcxScrape/dcxDb.js";
import { DcxQueue, DcxQueueLive } from "../src/dcxScrape/dcxQueue.js";

let passed = 0;
let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
};

const dbPath = `/tmp/dcx-queue-test-${process.pid}.db`;
for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
  try {
    fs.unlinkSync(f);
  } catch {
    /* ignore */
  }
}

const N = 12;

const program = Effect.gen(function* () {
  const queue = yield* DcxQueue;
  yield* initSchema();

  console.log("=== DCX durable queue restart test ===\n");

  // Enqueue N tasks.
  yield* queue.enqueueMany(
    Array.from({ length: N }, (_x, i) => ({
      taskKey: `corps:${i}`,
      taskType: "corps",
      params: { id: i },
    })),
  );
  let counts = yield* queue.counts();
  console.log("1. Enqueue");
  assert(counts.pending === N, `enqueued ${N} (pending=${counts.pending})`);

  // Idempotent enqueue: re-enqueue same keys → no change.
  yield* queue.enqueueMany(
    Array.from({ length: N }, (_x, i) => ({ taskKey: `corps:${i}`, taskType: "corps", params: {} })),
  );
  counts = yield* queue.counts();
  assert(counts.pending === N, "re-enqueue is a no-op (idempotent)");

  // Track how many times each task is handled (to detect loss / completion).
  const handledRef = yield* Ref.make<Record<string, number>>({});
  const handler = (taskKey: string) =>
    Ref.update(handledRef, (m) => ({ ...m, [taskKey]: (m[taskKey] ?? 0) + 1 })).pipe(
      Effect.as("done" as const),
    );

  // --- Phase 1: start workers, then "crash" mid-drain ---
  console.log("\n2. Crash mid-drain");
  // Workers that slow down so we can interrupt with leases held.
  const slowHandler = (task: { taskKey: string }) =>
    handler(task.taskKey).pipe(Effect.tap(() => Effect.sleep("40 millis")));
  const fiber = yield* Effect.forkChild(queue.runWorkers(2, slowHandler));
  // Let a few complete, then interrupt (≈ kill -9).
  yield* Effect.sleep("130 millis");
  yield* Fiber.interrupt(fiber);
  counts = yield* queue.counts();
  const doneAfterCrash = counts.done;
  assert(doneAfterCrash > 0 && doneAfterCrash < N, `partial progress before crash (done=${doneAfterCrash})`);
  assert(
    counts.done + counts.pending + counts.claimed === N,
    "no task lost across the crash (done+pending+claimed == N)",
  );

  // --- Phase 2: "restart" — expire leases, reclaim, resume ---
  console.log("\n3. Restart & resume");
  const sql = yield* SqlClient.SqlClient;
  // Simulate that the crashed process's leases have lapsed.
  yield* sql`UPDATE scrape_queue SET lease_expires_at = 0 WHERE status = 'claimed'`;
  yield* queue.reclaimExpired();
  counts = yield* queue.counts();
  assert(counts.claimed === 0, "expired leases reclaimed (claimed=0)");

  // Resume to completion.
  yield* queue.runWorkers(2, (task) => handler(task.taskKey));
  counts = yield* queue.counts();
  assert(counts.done === N, `all tasks done after resume (done=${counts.done})`);
  assert(counts.pending === 0 && counts.claimed === 0 && counts.failed === 0, "queue fully drained");

  const handled = yield* Ref.get(handledRef);
  const distinct = Object.keys(handled).length;
  assert(distinct === N, `every distinct task was handled (${distinct}/${N})`);
  // At-least-once delivery: a task interrupted before settle may be re-handled.
  const total = Object.values(handled).reduce((a, b) => a + b, 0);
  assert(total >= N, `at-least-once delivery (total handles=${total} >= ${N})`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
});

const SqlLayer = LibsqlClient.layer({ url: `file:${dbPath}` });
const AppLayer = DcxQueueLive.pipe(Layer.provideMerge(SqlLayer));

Effect.runPromise(program.pipe(Effect.provide(AppLayer)))
  .then(() => {
    for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
