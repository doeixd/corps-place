// Admin console Overview (ADMIN_PAGE_PLAN §4, M1). Gated by `requireAdminLoader`
// in the loader (repo idiom: auth in the loader, not async beforeLoad); the real
// security gate is `requireCapability` inside each admin server-fn. Shows a live
// snapshot from `contributions.db`; relational/read-model freshness is VM-fed (§8.1)
// and lands later.
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Show } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { adminStatusMachine, type AdminStatus } from '@/machines/admin-status-machine';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { adminStatus } from '@/lib/server-fns/admin';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/')({
  // Fetch the first snapshot in the loader (SSR); the machine re-polls from there.
  loader: adminLoader('viewAdmin', () => adminStatus()),
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
  const { gate, data } = Route.useLoaderData();
  return <AdminPage gate={gate}>{() => <Overview initial={data} />}</AdminPage>;
}

function Overview({ initial }: { initial: AdminStatus | null }) {
  const [state] = useMachine(adminStatusMachine, { input: { status: initial } });
  const s = state.context.status;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={s ? `Snapshot ${new Date(s.generatedAt).toLocaleTimeString()}` : 'Loading…'}
      />
      <Show when={state.context.error}>
        <p className="mb-4 text-sm text-destructive">{state.context.error}</p>
      </Show>
      <Show when={s} fallback={<p className="text-sm text-text-secondary">Loading status…</p>}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title="Wiki (contributions)"
            rows={[
              ['Pages', s!.wiki.pages],
              ['Revisions', s!.wiki.revisions],
              ['Media', s!.wiki.media],
              ['Citations', s!.wiki.citations],
            ]}
          />
          <StatCard
            title="Fantasy"
            rows={[
              ['Leagues', s!.fantasy.leagues],
              ['Members', s!.fantasy.members],
            ]}
          />
          <StatCard
            title="Storage"
            rows={[['contributions.db', fmtBytes(s!.contributionsDb.sizeBytes)]]}
          />
        </div>
      </Show>
    </>
  );
}
