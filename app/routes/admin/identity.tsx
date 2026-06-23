// Entity/identity data console (ADMIN_PAGE_PLAN §6.5). Staff identity is in
// dci-relational.db (NOT on the serving container) so the live review queue can't be
// read here — actions are ENQUEUED to the VM worker (§1.1). Cap: runJobs.
import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Show } from 'jotai-solid-api';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAsyncAction } from '@/lib/use-async-action';
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

  const enqueue = useAsyncAction(
    async (kind: 'merge_staff_by_name' | 'resolve_staff_identity', label: string) => {
      setMsg(null);
      const args = kind === 'resolve_staff_identity' ? { op, a, b } : {};
      await adminEnqueueJob({ data: { kind, args } });
      setMsg(`Enqueued: ${label}. The VM worker will run it; watch /admin/jobs.`);
    }
  );

  return (
    <>
      <PageHeader
        title="Identity & entity data"
        subtitle="Staff merges + corps colors (VM-executed)"
      />
      <Show when={enqueue.error}>
        <p className="mb-4 text-sm text-destructive">{enqueue.error}</p>
      </Show>
      <Show when={msg}>
        <p className="mb-4 text-sm text-green-600">{msg}</p>
      </Show>

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
            <BusyButton
              variant="destructive"
              size="sm"
              busy={enqueue.busy}
              onClick={() => {
                if (!confirm('Merge all exact-name duplicate staff? (respects keep-separate)'))
                  return;
                void enqueue.run('merge_staff_by_name', 'merge staff by name');
              }}
            >
              Merge by name (apply)
            </BusyButton>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Select value={op} onValueChange={(v) => v && setOp(v as 'merge' | 'split')}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="merge">merge</SelectItem>
                <SelectItem value="split">split</SelectItem>
              </SelectContent>
            </Select>
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
            <BusyButton
              size="sm"
              busy={enqueue.busy}
              disabled={!a || !b}
              onClick={() => void enqueue.run('resolve_staff_identity', `${op} ${a} ${b}`)}
            >
              Enqueue {op}
            </BusyButton>
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
