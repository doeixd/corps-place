// Admin audit log (ADMIN_PAGE_PLAN §8, M3). Read-only feed of every mutating admin
// action. Data is fetched in the loader (SSR, no client effect); gated to moderators+.
import { createFileRoute } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { listAudit, type AuditRow } from '@/lib/server-fns/admin';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/audit')({
  loader: adminLoader('viewAdmin', () => listAudit({ data: { limit: 200 } })),
  head: () =>
    seoHead({ title: 'Admin — Audit', description: 'Admin action log', path: '/admin/audit' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Audit rows={data ?? []} />}</AdminPage>;
  },
});

function Audit({ rows }: { rows: AuditRow[] }) {
  return (
    <>
      <PageHeader title="Audit" subtitle="Every admin action" />
      <Card>
        <CardContent className="text-sm">
          <Show
            when={rows.length > 0}
            fallback={<p className="text-text-secondary">No admin actions recorded yet.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={rows}>
                {(r) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                    <Badge variant="secondary" size="sm">
                      {r.action}
                    </Badge>
                    <span className="text-text-secondary">{r.actorName ?? r.actorId}</span>
                    <span className="text-xs text-text-secondary">{r.actorRole}</span>
                    <Show when={r.target}>
                      <span className="text-text-secondary">→ {r.target}</span>
                    </Show>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
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
