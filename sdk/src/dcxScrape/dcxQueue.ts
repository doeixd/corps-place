import { Context, Effect, Layer, Schedule } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, claimable work queue backed by `dcx.db` (table `scrape_queue`).
 *
 * Why a queue and not just a status table: we must be able to kill the process
 * at any point and resume without losing or re-doing work. A status-only gate
 * can't tell "in flight" from "never started" after a crash. This queue models
 * in-flight work with a **lease**: a worker claims a row, sets a lease; if it
 * dies, the lease expires and the row becomes claimable again. Nothing is lost,
 * nothing is double-done.
 *
 * Lifecycle of a row:
 *   pending --claim--> claimed --complete--> done
 *                              \--markEmpty-> empty   (honest gap, terminal)
 *                              \--fail------> pending  (attempts<max, retried)
 *                                          \> failed   (attempts>=max, terminal)
 *   claimed (expired lease, e.g. crash) --reclaim--> pending
 */

export interface QueueTask {
  readonly taskKey: string;
  readonly taskType: string;
  readonly params: unknown; // JSON-serializable
  readonly priority?: number; // lower = sooner; default 100
  readonly maxAttempts?: number; // default 5
}

export interface ClaimedTask {
  readonly taskKey: string;
  readonly taskType: string;
  readonly params: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface QueueCounts {
  readonly pending: number;
  readonly claimed: number;
  readonly done: number;
  readonly empty: number;
  readonly failed: number;
}

// How long a claim is valid before it's considered abandoned (crashed worker).
const LEASE_MS = 5 * 60_000;

const now = () => Date.now();

const makeQueue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Idempotently enqueue a task. Re-enqueuing an existing key is a no-op. */
  const enqueue = (task: QueueTask) =>
    sql`
      INSERT INTO scrape_queue
        (task_key, task_type, params_json, status, priority, attempts,
         max_attempts, enqueued_at, updated_at)
      VALUES
        (${task.taskKey}, ${task.taskType}, ${JSON.stringify(task.params ?? null)},
         'pending', ${task.priority ?? 100}, 0, ${task.maxAttempts ?? 5},
         ${now()}, ${now()})
      ON CONFLICT(task_key) DO NOTHING
    `.pipe(Effect.asVoid);

  const enqueueMany = (tasks: ReadonlyArray<QueueTask>) =>
    Effect.forEach(tasks, enqueue, { discard: true });

  /**
   * Atomically claim the highest-priority claimable row for `workerId`.
   * Claimable = pending, OR a claimed row whose lease has expired (crash).
   * The single UPDATE…RETURNING is atomic, so two fibers never get the same row.
   */
  const claim = (workerId: string): Effect.Effect<ClaimedTask | null, never, never> =>
    sql`
      UPDATE scrape_queue
         SET status = 'claimed',
             worker_id = ${workerId},
             lease_expires_at = ${now() + LEASE_MS},
             attempts = attempts + 1,
             updated_at = ${now()}
       WHERE task_key = (
         SELECT task_key FROM scrape_queue
          WHERE status = 'pending'
             OR (status = 'claimed' AND lease_expires_at < ${now()})
          ORDER BY priority ASC, enqueued_at ASC
          LIMIT 1
       )
      RETURNING task_key, task_type, params_json, attempts, max_attempts
    `.pipe(
      Effect.map((rows) => {
        const r = rows[0] as
          | {
              task_key: string;
              task_type: string;
              params_json: string | null;
              attempts: number;
              max_attempts: number;
            }
          | undefined;
        if (!r) return null;
        return {
          taskKey: r.task_key,
          taskType: r.task_type,
          params: r.params_json ? JSON.parse(r.params_json) : null,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
        } satisfies ClaimedTask;
      }),
      Effect.orDie,
    );

  const complete = (taskKey: string, httpStatus?: number) =>
    sql`
      UPDATE scrape_queue
         SET status = 'done', worker_id = NULL, lease_expires_at = NULL,
             http_status = ${httpStatus ?? null}, last_error = NULL,
             updated_at = ${now()}
       WHERE task_key = ${taskKey}
    `.pipe(Effect.asVoid);

  /** Terminal "no data here" outcome — recorded honestly, not retried. */
  const markEmpty = (taskKey: string, httpStatus?: number) =>
    sql`
      UPDATE scrape_queue
         SET status = 'empty', worker_id = NULL, lease_expires_at = NULL,
             http_status = ${httpStatus ?? null}, updated_at = ${now()}
       WHERE task_key = ${taskKey}
    `.pipe(Effect.asVoid);

  /**
   * Record a failure. Requeue (pending) until attempts hit max_attempts, then
   * mark terminally failed. `attempts` was already incremented at claim time.
   */
  const fail = (taskKey: string, error: string, httpStatus?: number) =>
    sql`
      UPDATE scrape_queue
         SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
             worker_id = NULL, lease_expires_at = NULL,
             http_status = ${httpStatus ?? null}, last_error = ${error},
             updated_at = ${now()}
       WHERE task_key = ${taskKey}
    `.pipe(Effect.asVoid);

  /** Reset any claimed-but-expired rows back to pending (crash recovery). */
  const reclaimExpired = () =>
    sql`
      UPDATE scrape_queue
         SET status = 'pending', worker_id = NULL, lease_expires_at = NULL,
             updated_at = ${now()}
       WHERE status = 'claimed' AND lease_expires_at < ${now()}
    `.pipe(Effect.asVoid);

  /** Requeue terminally-failed rows (operator action: `--reset`). */
  const resetFailed = () =>
    sql`
      UPDATE scrape_queue
         SET status = 'pending', attempts = 0, worker_id = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ${now()}
       WHERE status = 'failed'
    `.pipe(Effect.asVoid);

  const counts = (): Effect.Effect<QueueCounts, never, never> =>
    sql`
      SELECT status, COUNT(*) AS n FROM scrape_queue GROUP BY status
    `.pipe(
      Effect.map((rows) => {
        const base: QueueCounts = { pending: 0, claimed: 0, done: 0, empty: 0, failed: 0 };
        const acc: Record<string, number> = { ...base };
        for (const row of rows as ReadonlyArray<{ status: string; n: number }>) {
          acc[row.status] = row.n;
        }
        return acc as unknown as QueueCounts;
      }),
      Effect.orDie,
    );

  /**
   * Run `n` worker fibers that each loop claim→handle→settle until the queue is
   * drained (no claimable rows for `idleWaitMs`). The `handler` returns the
   * outcome; thrown/failed effects are caught and routed to `fail` (retry/backoff
   * is via re-claim of the requeued row, not an in-fiber retry, so a restart is
   * equivalent to staying up).
   */
  const runWorkers = <R>(
    n: number,
    handler: (task: ClaimedTask) => Effect.Effect<"done" | "empty", unknown, R>,
    opts?: { idleWaitMs?: number },
  ) => {
    const idleWaitMs = opts?.idleWaitMs ?? 1_000;

    const worker = (workerId: string) =>
      Effect.gen(function* () {
        // Loop: claim one; if none, wait a beat and re-check (another worker may
        // still produce enqueue work, and leases may expire). Stop when idle.
        let idleRounds = 0;
        while (true) {
          const task = yield* claim(workerId);
          if (!task) {
            idleRounds += 1;
            if (idleRounds >= 3) return; // drained
            yield* Effect.sleep(idleWaitMs);
            continue;
          }
          idleRounds = 0;
          const outcome = yield* handler(task).pipe(
            Effect.matchEffect({
              onSuccess: (o) => (o === "empty" ? markEmpty(task.taskKey) : complete(task.taskKey)),
              onFailure: (e) => fail(task.taskKey, e instanceof Error ? e.message : String(e)),
            }),
          );
          void outcome;
        }
      });

    return Effect.forEach(
      Array.from({ length: n }, (_x, i) => `w${i}`),
      (id) => worker(id),
      { concurrency: n, discard: true },
    );
  };

  return {
    enqueue,
    enqueueMany,
    claim,
    complete,
    markEmpty,
    fail,
    reclaimExpired,
    resetFailed,
    counts,
    runWorkers,
  };
});

export class DcxQueue extends Context.Service<
  DcxQueue,
  Effect.Success<typeof makeQueue>
>()("DcxQueue") {}

export const DcxQueueLive = Layer.effect(DcxQueue, makeQueue);

// Retry schedule for transient fetch failures, exported for the handler to use
// on the fetch itself (the queue handles the durable-restart dimension).
export const transientRetry = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(4)),
);
