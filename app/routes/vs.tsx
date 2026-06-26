import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { resolveVsSeries } from '@/lib/server-fns/vs';
import { VsChart } from '@/components/vs/vs-chart';
import type { VsSeries } from '@/lib/vs/types';

// Default comparison until the URL `?s=` codec lands (plan M4). A clear demo:
// two finalist corps' most-recent complete season + the 1st-place reference curve.
const DEFAULT_SERIES: VsSeries[] = [
  { kind: 'corps', corpsSlug: 'blue-devils', season: '2025' },
  { kind: 'corps', corpsSlug: 'bluecoats', season: '2025' },
  { kind: 'baseline', rank: 1 },
];

export const Route = createFileRoute('/vs')({
  loader: async () => resolveVsSeries({ data: { series: DEFAULT_SERIES } }),
  head: () =>
    seoHead({
      title: 'VS — Compare drum corps scores',
      description:
        'Compare any corps, seasons, and reference baselines on one curve, aligned by % through the season.',
      path: '/vs',
    }),
  component: VsPage,
});

function VsPage() {
  const { series } = Route.useLoaderData();
  return (
    <PageShell className="flex flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">VS — Score Comparison</h1>
        <p className="text-sm text-muted-foreground">
          Compare corps, seasons, and reference baselines on one curve. The x-axis is{' '}
          <span className="font-medium text-text-secondary">% through the season</span> — 0% = first
          show, 100% = finals — so different seasons line up.
        </p>
      </div>
      <Card>
        <CardContent className="px-2 py-4">
          <VsChart series={series} />
        </CardContent>
      </Card>
    </PageShell>
  );
}
