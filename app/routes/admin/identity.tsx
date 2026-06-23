// Entity/identity data console (ADMIN_PAGE_PLAN §6.5). Staff identity is in
// dci-relational.db (NOT on the serving container), so the live review queue can't be
// read here — actions are ENQUEUED to the VM worker (§1.1). Corps-colors lives at
// /admin/corps-colors (read-model list is web-readable). Cap: runJobs (actions enqueue).
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminEnqueueJob } from '@/lib/server-fns/admin-jobs';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/identity')({
  loader: requireAdminLoader('runJobs'),
  head: () =>
    seoHead({ title: 'Admin — Identity', description: 'Entity data', path: '/admin/identity' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Identity />}</AdminPage>;
  },
});

function Identity() {
  const [op, setOp] = useState<'merge' | 'split'>('merge');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enqueue = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(`Enqueued: ${label}. The VM worker will run it; watch /admin/jobs.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Identity & entity data"
        subtitle="Staff merges + corps colors (VM-executed)"
      />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {msg ? <p className="mb-4 text-sm text-green-600">{msg}</p> : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Staff identity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-text-secondary">
            The staff review queue lives in the source DB (not on this server), so it isn’t shown
            here — these actions are queued for the VM worker. Results land in the read-model after
            the next re-emit.
          </p>
          <div>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!confirm('Merge all exact-name duplicate staff? (respects keep-separate)'))
                  return;
                void enqueue(
                  () => adminEnqueueJob({ data: { kind: 'merge_staff_by_name', args: {} } }),
                  'merge staff by name'
                );
              }}
            >
              Merge by name (apply)
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <select
              className="rounded border border-border bg-transparent px-2 py-1"
              value={op}
              onChange={(e) => setOp(e.target.value as 'merge' | 'split')}
            >
              <option value="merge">merge</option>
              <option value="split">split</option>
            </select>
            <Input
              className="w-40"
              placeholder="staff_id A"
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            <Input
              className="w-40"
              placeholder="staff_id B"
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
            <Button
              size="sm"
              disabled={busy || !a || !b}
              onClick={() =>
                void enqueue(
                  () =>
                    adminEnqueueJob({
                      data: { kind: 'resolve_staff_identity', args: { op, a, b } },
                    }),
                  `${op} ${a} ${b}`
                )
              }
            >
              Enqueue {op}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Corps colors</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Link
            to="/admin/corps-colors"
            className="text-primary underline-offset-2 hover:underline"
          >
            Open the corps colors editor →
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
