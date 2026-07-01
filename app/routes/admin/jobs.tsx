// Jobs & scripts (ADMIN_PAGE_PLAN §5, M2). The web tier ENQUEUES; a VM worker runs the
// scripts. Initial list from the loader; live status via the jobs machine (5s poll);
// enqueue/cancel force an immediate refetch. Admin-gated.
//
// Also surfaces (a) per-job stdout/stderr logs on demand (adminJob), (b) recent
// score auto-ingest CRON runs (adminIngestRuns) — cron health the job queue can't
// show — and (c) an opt-in to admin push alerts on ingest failure.
import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { AdminPushToggle } from '@/components/admin/admin-push-toggle';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Badge, type BadgeProps } from '@/components/reui/badge';
import { useAsyncAction } from '@/lib/use-async-action';
import { JOB_KIND_META, JOB_KINDS, isJobKind, type JobKind } from '@/lib/admin-jobs';
import {
  adminEnqueueJob,
  adminCancelJob,
  adminJobs,
  adminJob,
  adminIngestRuns,
  type JobRow,
  type IngestRunRow,
} from '@/lib/server-fns/admin-jobs';
import { adminJobsMachine } from '@/machines/admin-jobs-machine';
import { seoHead } from '@/lib/seo';

const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  queued: 'secondary',
  running: 'info-light',
  success: 'success-light',
  failed: 'destructive-light',
  canceled: 'outline',
  // ingest-run statuses
  published: 'success-light',
  scrape_failed: 'destructive-light',
  no_new_scores: 'secondary',
  idle: 'outline',
};

export const Route = createFileRoute('/admin/jobs')({
  loader: adminLoader('runJobs', async () => ({
    jobs: await adminJobs({ data: { limit: 50 } }),
    ingestRuns: await adminIngestRuns({ data: { limit: 30 } }),
  })),
  head: () => seoHead({ title: 'Admin — Jobs', description: 'Job runner', path: '/admin/jobs' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return (
      <AdminPage gate={gate}>
        {() => <Jobs initial={data?.jobs ?? []} ingestRuns={data?.ingestRuns ?? []} />}
      </AdminPage>
    );
  },
});

/** On-demand stdout/stderr for one job. Fetched on expand (click), not useEffect. */
function JobLogs({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const load = useAsyncAction(async () => {
    const j = await adminJob({ data: { jobId } });
    setLogs({ stdout: j.stdout, stderr: j.stderr });
  });
  return (
    <div className="w-full">
      <Show
        when={logs != null}
        fallback={
          <BusyButton variant="ghost" size="sm" busy={load.busy} onClick={() => void load.run()}>
            {load.error ? 'Retry logs' : 'View logs'}
          </BusyButton>
        }
      >
        <div className="mt-1 flex flex-col gap-2">
          <Show when={!!logs?.stdout}>
            <pre className="max-h-72 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug whitespace-pre-wrap">
              {logs?.stdout}
            </pre>
          </Show>
          <Show when={!!logs?.stderr}>
            <div>
              <p className="text-[11px] font-semibold text-destructive">stderr</p>
              <pre className="max-h-72 overflow-auto rounded bg-destructive/5 p-2 text-[11px] leading-snug whitespace-pre-wrap">
                {logs?.stderr}
              </pre>
            </div>
          </Show>
          <Show when={!logs?.stdout && !logs?.stderr}>
            <p className="text-xs text-text-secondary">No output captured.</p>
          </Show>
        </div>
      </Show>
      <Show when={!!load.error}>
        <span className="text-xs text-destructive">{load.error}</span>
      </Show>
    </div>
  );
}

function Jobs({ initial, ingestRuns }: { initial: JobRow[]; ingestRuns: IngestRunRow[] }) {
  const [state, send] = useMachine(adminJobsMachine, { input: { jobs: initial } });
  const jobs = state.context.jobs;
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  const enqueue = useAsyncAction(async (kind: JobKind) => {
    await adminEnqueueJob({ data: { kind, args: {} } });
    send({ type: 'FETCH' });
  });
  const cancel = useAsyncAction(async (jobId: string) => {
    await adminCancelJob({ data: { jobId } });
    send({ type: 'FETCH' });
  });

  return (
    <>
      <PageHeader
        title="Jobs & scripts"
        subtitle="Enqueue data-pipeline jobs (run by the VM worker)"
      />
      <Show when={enqueue.error || cancel.error || state.context.error}>
        <p className="mb-4 text-sm text-destructive">
          {enqueue.error ?? cancel.error ?? state.context.error}
        </p>
      </Show>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <For each={JOB_KINDS.filter((k) => !JOB_KIND_META[k].needsArgs)}>
          {(k) => {
            const m = JOB_KIND_META[k];
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold">{m.label}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <p className="text-text-secondary">{m.description}</p>
                  <BusyButton
                    variant={m.danger ? 'destructive' : 'default'}
                    size="sm"
                    busy={enqueue.busy}
                    onClick={() => {
                      if (m.danger && !confirm(`Enqueue "${m.label}"? This is a heavy job.`))
                        return;
                      void enqueue.run(k);
                    }}
                  >
                    Enqueue
                  </BusyButton>
                </CardContent>
              </Card>
            );
          }}
        </For>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Score auto-ingest (cron)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <AdminPushToggle />
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Recent runs</p>
            <Show
              when={ingestRuns.length > 0}
              fallback={
                <p className="text-text-secondary">
                  No runs recorded yet (the VM recorder writes these).
                </p>
              }
            >
              <div className="flex flex-col divide-y divide-border">
                <For each={ingestRuns}>
                  {(r) => (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'} size="sm">
                        {r.status}
                      </Badge>
                      <Show when={r.scoresDelta != null && r.scoresDelta > 0}>
                        <span className="text-xs text-text-secondary">+{r.scoresDelta} scores</span>
                      </Show>
                      <Show when={!!r.pendingEvents}>
                        <span className="text-xs text-text-secondary">{r.pendingEvents}</span>
                      </Show>
                      <span className="ml-auto text-xs text-text-secondary tabular-nums">
                        {new Date(r.ts).toLocaleString()}
                      </span>
                      <Show when={!!r.detail}>
                        <span className="w-full text-xs text-destructive">{r.detail}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={jobs.length > 0}
            fallback={<p className="text-text-secondary">No jobs yet.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={jobs}>
                {(j) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                    <span className="font-medium">
                      {isJobKind(j.kind) ? JOB_KIND_META[j.kind].label : j.kind}
                    </span>
                    <Badge variant={STATUS_VARIANT[j.status] ?? 'secondary'} size="sm">
                      {j.status}
                    </Badge>
                    <Show when={j.exitCode != null}>
                      <span className="text-xs text-text-secondary">exit {j.exitCode}</span>
                    </Show>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {new Date(j.queuedAt).toLocaleString()}
                    </span>
                    <Show when={j.status === 'queued'}>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={cancel.busy}
                        onClick={() => void cancel.run(j.jobId)}
                      >
                        Cancel
                      </BusyButton>
                    </Show>
                    <BusyButton
                      variant="ghost"
                      size="sm"
                      busy={false}
                      onClick={() => setOpenLogs(openLogs === j.jobId ? null : j.jobId)}
                    >
                      {openLogs === j.jobId ? 'Hide logs' : 'Logs'}
                    </BusyButton>
                    <Show when={j.errorMessage}>
                      <span className="w-full text-xs text-destructive">{j.errorMessage}</span>
                    </Show>
                    <Show when={openLogs === j.jobId}>
                      <JobLogs jobId={j.jobId} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>
    </>
  );
}
