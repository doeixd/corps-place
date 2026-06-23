// Jobs & scripts (ADMIN_PAGE_PLAN §5, M2). The web tier ENQUEUES; a VM worker runs
// the scripts (scripts/admin-job-worker.sh) and streams status back. Admin-gated.
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { JOB_KIND_META, JOB_KINDS, isJobKind, type JobKind } from '@/lib/admin-jobs';
import {
  adminEnqueueJob,
  adminJobs,
  adminCancelJob,
  type JobRow,
} from '@/lib/server-fns/admin-jobs';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/jobs')({
  loader: requireAdminLoader('runJobs'),
  head: () => seoHead({ title: 'Admin — Jobs', description: 'Job runner', path: '/admin/jobs' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Jobs />}</AdminPage>;
  },
});

import type { BadgeProps } from '@/components/reui/badge';

const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  queued: 'secondary',
  running: 'info-light',
  success: 'success-light',
  failed: 'destructive-light',
  canceled: 'outline',
};

function Jobs() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminJobs({ data: { limit: 50 } })
      .then(setJobs)
      .catch((e: unknown) => setError((e as Error).message));
  }, []);

  // Poll while anything is queued/running.
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  const enqueue = async (kind: JobKind, args?: Record<string, string>) => {
    setBusy(kind);
    setError(null);
    try {
      await adminEnqueueJob({ data: { kind, args: args ?? {} } });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Jobs & scripts"
        subtitle="Enqueue data-pipeline jobs (run by the VM worker)"
      />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {JOB_KINDS.filter((k) => !JOB_KIND_META[k].needsArgs).map((k) => {
          const m = JOB_KIND_META[k];
          return (
            <Card key={k}>
              <CardHeader>
                <CardTitle className="text-sm font-semibold">{m.label}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <p className="text-text-secondary">{m.description}</p>
                <Button
                  variant={m.danger ? 'destructive' : 'default'}
                  size="sm"
                  disabled={busy === k}
                  onClick={() => {
                    if (m.danger && !confirm(`Enqueue "${m.label}"? This is a heavy job.`)) return;
                    void enqueue(k);
                  }}
                >
                  Enqueue
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!jobs ? (
            <p className="text-text-secondary">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="text-text-secondary">No jobs yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {jobs.map((j) => (
                <div key={j.jobId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                  <span className="font-medium">
                    {isJobKind(j.kind) ? JOB_KIND_META[j.kind].label : j.kind}
                  </span>
                  <Badge variant={STATUS_VARIANT[j.status] ?? 'secondary'} size="sm">
                    {j.status}
                  </Badge>
                  {j.exitCode != null ? (
                    <span className="text-xs text-text-secondary">exit {j.exitCode}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-text-secondary tabular-nums">
                    {new Date(j.queuedAt).toLocaleString()}
                  </span>
                  {j.status === 'queued' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void adminCancelJob({ data: { jobId: j.jobId } })
                          .then(reload)
                          .catch(() => {})
                      }
                    >
                      Cancel
                    </Button>
                  ) : null}
                  {j.errorMessage ? (
                    <span className="w-full text-xs text-destructive">{j.errorMessage}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
