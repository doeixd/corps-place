// Fantasy league ops console (ADMIN_PAGE_PLAN §9.2). Support/rescue tools for live
// leagues. List fetched in the loader; detail is loaded on click (event-handler, not a
// mount effect); mutations refresh via invalidate. Gated by manageFantasyLeagues.
import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Badge } from '@/components/reui/badge';
import { Input } from '@/components/ui/input';
import {
  adminListLeagues,
  adminGetLeague,
  adminPauseDraft,
  adminResumeDraft,
  adminCancelLeague,
  adminTakedownIdentity,
  adminRecomputeStandings,
  type AdminLeagueRow,
  type AdminLeagueDetail,
} from '@/lib/server-fns/admin-fantasy';
import { useAsyncAction } from '@/lib/use-async-action';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/fantasy/leagues')({
  loader: adminLoader('manageFantasyLeagues', () => adminListLeagues({ data: { limit: 100 } })),
  head: () =>
    seoHead({
      title: 'Admin — Fantasy leagues',
      description: 'League ops',
      path: '/admin/fantasy/leagues',
    }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Leagues leagues={data ?? []} />}</AdminPage>;
  },
});

function Leagues({ leagues }: { leagues: AdminLeagueRow[] }) {
  const router = useRouter();
  const [detail, setDetail] = useState<AdminLeagueDetail | null>(null);
  const [season, setSeason] = useState('2026');

  const openDetail = useAsyncAction(async (leagueId: string) => {
    setDetail(await adminGetLeague({ data: { leagueId } }));
  });
  const act = useAsyncAction(async (fn: () => Promise<unknown>, reopen?: string) => {
    await fn();
    await router.invalidate();
    if (reopen) setDetail(await adminGetLeague({ data: { leagueId: reopen } }));
  });

  const anyError = openDetail.error ?? act.error;

  return (
    <>
      <PageHeader title="Fantasy leagues" subtitle="Support & rescue" />
      <Show when={anyError}>
        <p className="mb-4 text-sm text-destructive">{anyError}</p>
      </Show>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Recompute standings
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          <Input className="w-24" value={season} onChange={(e) => setSeason(e.target.value)} />
          <BusyButton
            size="sm"
            busy={act.busy}
            onClick={() => void act.run(() => adminRecomputeStandings({ data: { season } }))}
          >
            Recompute season
          </BusyButton>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Leagues</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={leagues.length > 0}
            fallback={<p className="text-text-secondary">No leagues.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={leagues}>
                {(l) => (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0 font-medium"
                      onClick={() => void openDetail.run(l.leagueId)}
                    >
                      {l.name}
                    </Button>
                    <span className="text-text-secondary">
                      {l.season} · {l.members} members
                    </span>
                    <Badge
                      variant={l.status === 'canceled' ? 'destructive-light' : 'secondary'}
                      size="sm"
                    >
                      {l.status}
                    </Badge>
                    <span className="ml-auto flex gap-1">
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={act.busy}
                        onClick={() =>
                          void act.run(() => adminPauseDraft({ data: { leagueId: l.leagueId } }))
                        }
                      >
                        Pause
                      </BusyButton>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={act.busy}
                        onClick={() =>
                          void act.run(() => adminResumeDraft({ data: { leagueId: l.leagueId } }))
                        }
                      >
                        Resume
                      </BusyButton>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        busy={act.busy}
                        disabled={l.status === 'canceled'}
                        onClick={() => {
                          if (!confirm(`Cancel league "${l.name}"?`)) return;
                          void act.run(() => adminCancelLeague({ data: { leagueId: l.leagueId } }));
                        }}
                      >
                        Cancel
                      </BusyButton>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>

      <Show when={detail}>
        {(d) => (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">
                {d.league.name} — members{' '}
                <span className="text-text-secondary">(draft: {d.draftStatus ?? 'none'})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="flex flex-col divide-y divide-border">
                <For each={d.members}>
                  {(m) => (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="font-medium">{m.corpsName ?? '(no corps name)'}</span>
                      <span className="text-text-secondary">
                        {m.role} · {m.status}
                      </span>
                      <BusyButton
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        busy={act.busy}
                        onClick={() => {
                          if (!confirm('Clear this member’s corps identity (name/logo/colors)?'))
                            return;
                          void act.run(
                            () =>
                              adminTakedownIdentity({
                                data: { leagueId: d.league.leagueId, userId: m.userId },
                              }),
                            d.league.leagueId
                          );
                        }}
                      >
                        Take down identity
                      </BusyButton>
                    </div>
                  )}
                </For>
              </div>
            </CardContent>
          </Card>
        )}
      </Show>
    </>
  );
}
