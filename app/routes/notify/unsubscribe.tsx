import { createFileRoute } from '@tanstack/react-router';
import { unsubscribeScores } from '@/lib/server-fns/score-notify';
import { StatusCard } from '@/components/status-card';
import { PageShell } from '@/components/page-shell';
import { seoHead } from '@/lib/seo';

// One-click unsubscribe target for score-notify emails. Runs in the loader
// (server-side) so the link works even without JS.
export const Route = createFileRoute('/notify/unsubscribe')({
  head: () =>
    seoHead({
      title: 'Unsubscribe — DrumCorps.app',
      description: 'Manage your DrumCorps.app score notifications.',
      path: '/notify/unsubscribe',
    }),
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === 'string' ? s.token : '',
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    if (!deps.token) return { ok: false as const };
    try {
      await unsubscribeScores({ data: { token: deps.token } });
      return { ok: true as const };
    } catch {
      return { ok: false as const };
    }
  },
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { ok } = Route.useLoaderData();
  return (
    <PageShell>
      <div className="flex min-h-[50vh] items-center justify-center p-8">
        <StatusCard
          tone={ok ? 'info' : 'error'}
          title={ok ? 'Unsubscribed' : 'Link not valid'}
          description={
            ok
              ? "You won't receive score notifications for this anymore."
              : 'This unsubscribe link is invalid or has already been used.'
          }
        />
      </div>
    </PageShell>
  );
}
