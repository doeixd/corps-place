/**
 * Job-queue server-fns (ADMIN_PAGE_PLAN §5). The web tier ENQUEUES only — it never
 * spawns (the serving container has no sdk/scripts). A VM worker claims 'queued'
 * rows and runs them. Every fn re-checks capability; enqueue/cancel are audited.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import { JOB_KINDS } from '@/lib/admin-jobs';

// Singleton kinds: only one may be queued/running at a time (heavy, no per-item args).
// Parameterized kinds (regenerate_event, resolve_staff_identity, save_corps_colors) may
// have many distinct jobs queued. Mirrors the partial unique index in contributions-db.ts.
const SINGLETON_KINDS = new Set<string>([
  'season_update',
  'scrape_corps',
  'scrape_event_pages',
  'scrape_recaps',
  'ingest_lineups',
  'generate_predictions',
  'fine_tune',
  'merge_staff_by_name',
]);

export interface JobRow {
  jobId: string;
  kind: string;
  argsJson: string | null;
  status: string;
  requestedBy: string;
  claimedBy: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
}

const mapRow = (r: Record<string, unknown>): JobRow => ({
  jobId: String(r.job_id),
  kind: String(r.kind),
  argsJson: (r.args_json as string) ?? null,
  status: String(r.status),
  requestedBy: String(r.requested_by),
  claimedBy: (r.claimed_by as string) ?? null,
  queuedAt: String(r.queued_at),
  startedAt: (r.started_at as string) ?? null,
  finishedAt: (r.finished_at as string) ?? null,
  exitCode: r.exit_code == null ? null : Number(r.exit_code),
  errorMessage: (r.error_message as string) ?? null,
});

// Arg VALUES are interpolated into a shell command by the VM worker, so they must be
// a strict whitelist — no shell metacharacters (C1). Slugs/ids/uuids fit [A-Za-z0-9_.-].
const SafeArg = v.pipe(v.string(), v.maxLength(128), v.regex(/^[A-Za-z0-9_.-]+$/, 'invalid arg'));
const EnqueueInput = v.object({
  kind: v.picklist(JOB_KINDS),
  args: v.optional(v.record(v.string(), SafeArg), {}),
});

/** Enqueue a job (per-kind dedupe). Does NOT spawn. Cap: runJobs. */
export const adminEnqueueJob = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(EnqueueInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'runJobs');
    const db = await getContributionsDb();
    // Per-kind dedupe for SINGLETON kinds only (parameterized kinds allow many).
    if (SINGLETON_KINDS.has(data.kind)) {
      const active = (
        await db.execute({
          sql: `SELECT job_id FROM admin_jobs WHERE kind = ? AND status IN ('queued','running') LIMIT 1`,
          args: [data.kind],
        })
      ).rows[0];
      if (active) throw new Error(`A ${data.kind} job is already queued or running`);
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await db.execute({
        sql: `INSERT INTO admin_jobs (job_id, kind, args_json, status, requested_by, queued_at)
              VALUES (?, ?, ?, 'queued', ?, ?)`,
        args: [jobId, data.kind, JSON.stringify(data.args), actor.userId, now],
      });
    } catch (e) {
      // The partial unique index (one active job per kind) backstops the SELECT race.
      if (String(e).includes('UNIQUE'))
        throw new Error(`A ${data.kind} job is already queued or running`);
      throw e;
    }
    await writeAudit(db, actor, {
      action: 'enqueue_job',
      target: jobId,
      after: { kind: data.kind, args: data.args },
    });
    return { ok: true as const, jobId };
  });

const ListJobsInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50),
});

/** Recent jobs across all kinds. Cap: viewAdmin. */
export const adminJobs = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListJobsInput, d))
  .handler(async ({ data }): Promise<JobRow[]> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    const rows = (
      await db.execute({
        sql: `SELECT job_id, kind, args_json, status, requested_by, claimed_by, queued_at,
                     started_at, finished_at, exit_code, error_message
              FROM admin_jobs ORDER BY queued_at DESC LIMIT ?`,
        args: [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map(mapRow);
  });

/** One job + its streamed stdout/stderr tail (for polling). Cap: viewAdmin. */
export const adminJob = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ jobId: v.string() }), d))
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    const row = (
      await db.execute({ sql: 'SELECT * FROM admin_jobs WHERE job_id = ?', args: [data.jobId] })
    ).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error('NOT_FOUND');
    return {
      ...mapRow(row),
      stdout: (row.stdout as string) ?? '',
      stderr: (row.stderr as string) ?? '',
    };
  });

export interface IngestRunRow {
  runId: string;
  ts: string;
  kind: string;
  status: string;
  season: string | null;
  pendingEvents: string | null;
  scoresBefore: number | null;
  scoresAfter: number | null;
  scoresDelta: number | null;
  published: boolean;
  detail: string | null;
}

const IngestRunsInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 30),
});

/**
 * Recent auto-ingest (cron) runs — cron health the /admin/jobs queue can't show
 * (the score auto-ingest runs on a cron, not the admin_jobs queue). Rows are
 * written VM-side by scripts/recordIngestRun.ts. Cap: viewAdmin.
 */
export const adminIngestRuns = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(IngestRunsInput, d))
  .handler(async ({ data }): Promise<IngestRunRow[]> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    // The table is created lazily (by the app schema or the VM recorder); tolerate
    // its absence on a fresh DB so the page still renders.
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (
        await db.execute({
          sql: `SELECT run_id, ts, kind, status, season, pending_events,
                       scores_before, scores_after, scores_delta, published, detail
                FROM ingest_runs ORDER BY ts DESC LIMIT ?`,
          args: [data.limit],
        })
      ).rows as unknown as Record<string, unknown>[];
    } catch (e) {
      if (!String(e).includes('no such table')) throw e;
    }
    return rows.map((r) => ({
      runId: String(r.run_id),
      ts: String(r.ts),
      kind: String(r.kind),
      status: String(r.status),
      season: (r.season as string) ?? null,
      pendingEvents: (r.pending_events as string) ?? null,
      scoresBefore: r.scores_before == null ? null : Number(r.scores_before),
      scoresAfter: r.scores_after == null ? null : Number(r.scores_after),
      scoresDelta: r.scores_delta == null ? null : Number(r.scores_delta),
      published: Number(r.published ?? 0) === 1,
      detail: (r.detail as string) ?? null,
    }));
  });

/** Cancel a job — only while still 'queued' (a running job is owned by the worker). Cap: runJobs. */
export const adminCancelJob = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ jobId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'runJobs');
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: `UPDATE admin_jobs SET status = 'canceled', finished_at = ?
            WHERE job_id = ? AND status = 'queued'`,
      args: [new Date().toISOString(), data.jobId],
    });
    if (res.rowsAffected === 0) throw new Error('Job is not queued (already running or finished)');
    await writeAudit(db, actor, { action: 'cancel_job', target: data.jobId });
    return { ok: true as const };
  });
