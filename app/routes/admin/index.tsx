// Admin console Overview (ADMIN_PAGE_PLAN §4, M1). Gated by `requireAdminLoader`
// in the loader (repo idiom: auth in the loader, not async beforeLoad); the real
// security gate is `requireCapability` inside each admin server-fn. Shows a live
// snapshot from `contributions.db`; relational/read-model freshness is VM-fed (§8.1)
// and lands later.
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { adminStatusMachine } from '@/machines/admin-status-machine';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/')({
  loader: requireAdminLoader('viewAdmin'),
  head: () =>
    seoHead({ title: 'Admin — Overview', description: 'Operator console', path: '/admin' }),
  component: AdminOverview,
});

const fmtBytes = (n: number): string => {
  if (!n) return '—';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

function StatCard({ title, rows }: { title: string; rows: [string, number | string][] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-text-secondary">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-text-secondary">{label}</span>
            <span className="text-right font-medium tabular-nums">{value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AdminOverview() {
  const gate = Route.useLoaderData();
  return <AdminPage gate={gate}>{() => <Overview />}</AdminPage>;
}

function Overview() {
  const [state] = useMachine(adminStatusMachine);
  const s = state.context.status;
  const loading = !s && state.matches('fetching');

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={s ? `Snapshot ${new Date(s.generatedAt).toLocaleTimeString()}` : 'Loading…'}
      />
      {state.context.error ? (
        <p className="mb-4 text-sm text-destructive">{state.context.error}</p>
      ) : null}
      {loading ? (
        <p className="text-sm text-text-secondary">Loading status…</p>
      ) : s ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="Wiki (contributions)"
            rows={[
              ['Pages', s.wiki.pages],
              ['Revisions', s.wiki.revisions],
              ['Media', s.wiki.media],
              ['Citations', s.wiki.citations],
            ]}
          />
          <StatCard
            title="Fantasy"
            rows={[
              ['Leagues', s.fantasy.leagues],
              ['Members', s.fantasy.members],
            ]}
          />
          <StatCard
            title="Storage"
            rows={[['contributions.db', fmtBytes(s.contributionsDb.sizeBytes)]]}
          />
        </div>
      ) : null}
    </>
  );
}
