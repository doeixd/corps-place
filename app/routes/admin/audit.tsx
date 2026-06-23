// Admin audit log (ADMIN_PAGE_PLAN §8, M3). Read-only feed of every mutating admin
// action. Gated to moderators+ via requireAdminLoader('viewAdmin').
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { listAudit, type AuditRow } from '@/lib/server-fns/admin';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/audit')({
  loader: requireAdminLoader('viewAdmin'),
  head: () =>
    seoHead({ title: 'Admin — Audit', description: 'Admin action log', path: '/admin/audit' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Audit />}</AdminPage>;
  },
});

function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAudit({ data: { limit: 200 } })
      .then((r) => alive && setRows(r))
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PageHeader title="Audit" subtitle="Every admin action" />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      <Card>
        <CardContent className="text-sm">
          {!rows ? (
            <p className="text-text-secondary">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-text-secondary">No admin actions recorded yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {rows.map((r) => (
                <div
                  key={r.auditId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                >
                  <Badge variant="secondary" size="sm">
                    {r.action}
                  </Badge>
                  <span className="text-text-secondary">{r.actorName ?? r.actorId}</span>
                  <span className="text-xs text-text-secondary">{r.actorRole}</span>
                  {r.target ? <span className="text-text-secondary">→ {r.target}</span> : null}
                  <span className="ml-auto text-xs text-text-secondary tabular-nums">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
