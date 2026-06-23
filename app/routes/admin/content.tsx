// Content moderation (ADMIN_PAGE_PLAN §6, M4). Cross-page revisions firehose +
// locked-pages list, with revert / hide / unlock. Data fetched in the loader; refresh
// after a mutation via router.invalidate(). Gated; every server-fn re-checks capability.
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  listRecentRevisions,
  listShowPages,
  hideRevision,
  setPageLock,
  type AdminRevisionRow,
  type AdminPageRow,
} from '@/lib/server-fns/admin-content';
import { revertRevision } from '@/lib/server-fns/contrib';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/content')({
  loader: adminLoader('viewAdmin', async () => ({
    revisions: await listRecentRevisions({ data: { limit: 100 } }),
    locked: await listShowPages({ data: { lockedOnly: true, limit: 100 } }),
  })),
  head: () =>
    seoHead({ title: 'Admin — Content', description: 'Moderation', path: '/admin/content' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return (
      <AdminPage gate={gate}>
        {() => <Content revisions={data?.revisions ?? []} locked={data?.locked ?? []} />}
      </AdminPage>
    );
  },
});

function Content({ revisions, locked }: { revisions: AdminRevisionRow[]; locked: AdminPageRow[] }) {
  const router = useRouter();
  const act = useAsyncAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await router.invalidate();
  });

  return (
    <>
      <PageHeader title="Content" subtitle="Recent edits across all wiki pages" />
      <Show when={act.error}>
        <p className="mb-4 text-sm text-destructive">{act.error}</p>
      </Show>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Locked pages ({locked.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={locked.length > 0}
            fallback={<p className="text-text-secondary">No locked pages.</p>}
          >
            <ul className="flex flex-col gap-1">
              <For each={locked}>
                {(p) => (
                  <li className="flex items-center justify-between gap-4">
                    <span>
                      {p.corpsKey} · {p.season}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant="warning-light" size="sm">
                        {p.lockLevel}
                      </Badge>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={act.busy}
                        onClick={() =>
                          void act.run(() =>
                            setPageLock({ data: { pageId: p.pageId, level: 'none' } })
                          )
                        }
                      >
                        Unlock
                      </BusyButton>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Recent revisions
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={revisions.length > 0}
            fallback={<p className="text-text-secondary">No revisions yet.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={revisions}>
                {(r) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                    <span className="font-medium">
                      {r.corpsKey ?? '—'} · {r.season ?? '—'}
                    </span>
                    <Badge variant="secondary" size="sm">
                      {r.op} {r.targetKind}
                    </Badge>
                    <span className="text-text-secondary">{r.authorName ?? r.authorId}</span>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <Show when={r.targetKind === 'block'}>
                        <BusyButton
                          variant="ghost"
                          size="sm"
                          busy={act.busy}
                          onClick={() =>
                            void act.run(() =>
                              revertRevision({ data: { revisionId: r.revisionId } })
                            )
                          }
                        >
                          Revert
                        </BusyButton>
                      </Show>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={act.busy}
                        onClick={() =>
                          void act.run(() =>
                            hideRevision({ data: { revisionId: r.revisionId, hidden: true } })
                          )
                        }
                      >
                        Hide
                      </BusyButton>
                    </span>
                    <Show when={r.summary}>
                      <span className="w-full text-xs text-text-secondary">{r.summary}</span>
                    </Show>
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
