// Jobs & scripts (ADMIN_PAGE_PLAN §5, M2). The web tier ENQUEUES; a VM worker runs the
// scripts. Initial list from the loader; live status via the jobs machine (5s poll);
// enqueue/cancel force an immediate refetch. Admin-gated.
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
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
  type JobRow,
} from '@/lib/server-fns/admin-jobs';
import { adminJobsMachine } from '@/machines/admin-jobs-machine';
import { seoHead } from '@/lib/seo';

const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  queued: 'secondary',
  running: 'info-light',
  success: 'success-light',
  failed: 'destructive-light',
  canceled: 'outline',
};

export const Route = createFileRoute('/admin/jobs')({
  loader: adminLoader('runJobs', () => adminJobs({ data: { limit: 50 } })),
  head: () => seoHead({ title: 'Admin — Jobs', description: 'Job runner', path: '/admin/jobs' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Jobs initial={data ?? []} />}</AdminPage>;
  },
});

function Jobs({ initial }: { initial: JobRow[] }) {
  const [state, send] = useMachine(adminJobsMachine, { input: { jobs: initial } });
  const jobs = state.context.jobs;

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
                    <Show when={j.errorMessage}>
                      <span className="w-full text-xs text-destructive">{j.errorMessage}</span>
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
