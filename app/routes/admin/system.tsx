// System & ops (ADMIN_PAGE_PLAN §8/M5). Read-model generation + data-quality + DB size
// + storage health + announcement banner. Fetched in the loader; banner save invalidates.
import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { BusyButton } from '@/components/fantasy/busy-button';
import { showInstallPromptForTest, resetInstallPromptState } from '@/components/install-prompt';
import { Badge } from '@/components/reui/badge';
import { useAsyncAction } from '@/lib/use-async-action';
import { adminSystem, getAnnouncement, setAnnouncement } from '@/lib/server-fns/admin';
import { seoHead } from '@/lib/seo';

type SystemData = { sys: Awaited<ReturnType<typeof adminSystem>>; announcement: string | null };

export const Route = createFileRoute('/admin/system')({
  loader: adminLoader(
    'viewAdmin',
    async (): Promise<SystemData> => ({
      sys: await adminSystem(),
      announcement: (await getAnnouncement()).text,
    })
  ),
  head: () =>
    seoHead({ title: 'Admin — System', description: 'System & ops', path: '/admin/system' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => (data ? <System data={data} /> : null)}</AdminPage>;
  },
});

const fmtBytes = (n: number): string => {
  if (!n) return '—';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

function System({ data }: { data: SystemData }) {
  const router = useRouter();
  const { sys } = data;
  const rm = sys.readModel;
  const dq = rm.dqCounts ? Object.entries(rm.dqCounts).filter(([, n]) => n > 0) : [];
  const [banner, setBanner] = useState(data.announcement ?? '');

  const save = useAsyncAction(async () => {
    await setAnnouncement({ data: { text: banner } });
    await router.invalidate();
  });

  return (
    <>
      <PageHeader title="System & ops" subtitle="Read-model, data quality, storage" />
      <Show when={save.error}>
        <p className="mb-4 text-sm text-destructive">{save.error}</p>
      </Show>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">Read-model</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            <Show
              when={rm.enabled}
              fallback={
                <span className="col-span-2 text-text-secondary">
                  Read-model not configured (dev).
                </span>
              }
            >
              <span className="text-text-secondary">Built</span>
              <span className="text-right">
                {rm.builtAt ? new Date(rm.builtAt).toLocaleString() : '—'}
              </span>
              <span className="text-text-secondary">Schema version</span>
              <span className="text-right">{rm.schemaVersion ?? '—'}</span>
              <span className="text-text-secondary">Ingest commit</span>
              <span className="text-right">{rm.ingestCommit ?? '—'}</span>
              <span className="text-text-secondary">Season</span>
              <span className="text-right">{rm.currentSeason ?? '—'}</span>
            </Show>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">
              Storage & health
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-text-secondary">contributions.db</span>
            <span className="text-right">{fmtBytes(sys.contributionsDbBytes)}</span>
            <span className="text-text-secondary">Durable storage</span>
            <span className="flex justify-end">
              <Badge variant={sys.durable.ready ? 'success-light' : 'destructive'} size="sm">
                {sys.durable.ready ? 'ready' : 'NOT READY'}
              </Badge>
            </span>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Consent & notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
          <span className="text-text-secondary">Terms version</span>
          <span className="text-right">{sys.consent.version}</span>
          <span className="text-text-secondary">Accepted current terms</span>
          <span className="text-right tabular-nums">
            {sys.consent.accepted} / {sys.consent.totalUsers}
          </span>
          <span className="text-text-secondary">Opted in to contact</span>
          <span className="text-right tabular-nums">{sys.consent.optedIn}</span>
          <span className="text-text-secondary">Members: email on / push on</span>
          <span className="text-right tabular-nums">
            {sys.notifications.emailOn} / {sys.notifications.pushOn} of{' '}
            {sys.notifications.activeMembers}
          </span>
          <span className="text-text-secondary">Push subscriptions</span>
          <span className="text-right tabular-nums">{sys.notifications.pushSubs}</span>
          <span className="text-text-secondary">Pending emails / jobs due</span>
          <span className="text-right tabular-nums">
            {sys.notifications.pendingEmails} / {sys.notifications.jobsDue}
          </span>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Data quality</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show when={rm.enabled} fallback={<p className="text-text-secondary">—</p>}>
            <Show
              when={dq.length > 0}
              fallback={<p className="text-green-600">All guardrails clean ✓</p>}
            >
              <ul className="flex flex-col gap-1">
                <For each={dq}>
                  {([k, n]) => (
                    <li className="flex justify-between">
                      <span>{k}</span>
                      <span className="text-destructive tabular-nums">{n}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Announcement banner
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-text-secondary">
            Current: {data.announcement ? `“${data.announcement}”` : '(none)'}
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Site-wide notice (blank to clear)"
              value={banner}
              onChange={(e) => setBanner(e.target.value)}
            />
            <BusyButton size="sm" busy={save.busy} onClick={() => void save.run()}>
              Save
            </BusyButton>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Install prompt (testing)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-text-secondary">
            The Add-to-Home-Screen banner normally shows only on mobile, after 3 pages, once
            per person. Preview it here (bypasses those gates; on desktop it shows the iOS-style
            variant), or reset the “already seen” state to test the real trigger.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => showInstallPromptForTest()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Preview install prompt
            </button>
            <button
              type="button"
              onClick={() => resetInstallPromptState()}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-foreground/5"
            >
              Reset “seen” state
            </button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
