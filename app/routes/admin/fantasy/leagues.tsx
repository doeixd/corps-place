// Fantasy league ops console (ADMIN_PAGE_PLAN §9.2). Support/rescue tools for live
// leagues. Gated by manageFantasyLeagues.
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/fantasy/leagues')({
  loader: requireAdminLoader('manageFantasyLeagues'),
  head: () =>
    seoHead({
      title: 'Admin — Fantasy leagues',
      description: 'League ops',
      path: '/admin/fantasy/leagues',
    }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Leagues />}</AdminPage>;
  },
});

function Leagues() {
  const [leagues, setLeagues] = useState<AdminLeagueRow[] | null>(null);
  const [detail, setDetail] = useState<AdminLeagueDetail | null>(null);
  const [season, setSeason] = useState('2026');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminListLeagues({ data: { limit: 100 } })
      .then(setLeagues)
      .catch((e: unknown) => setError((e as Error).message));
  }, []);
  useEffect(() => reload(), [reload]);

  const act = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      reload();
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openDetail = (id: string) =>
    adminGetLeague({ data: { leagueId: id } })
      .then(setDetail)
      .catch((e: unknown) => setError((e as Error).message));

  return (
    <>
      <PageHeader title="Fantasy leagues" subtitle="Support & rescue" />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Recompute standings
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          <Input className="w-24" value={season} onChange={(e) => setSeason(e.target.value)} />
          <Button
            size="sm"
            disabled={busy === 'recompute'}
            onClick={() =>
              void act('recompute', () => adminRecomputeStandings({ data: { season } }))
            }
          >
            Recompute season
          </Button>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">Leagues</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!leagues ? (
            <p className="text-text-secondary">Loading…</p>
          ) : leagues.length === 0 ? (
            <p className="text-text-secondary">No leagues.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {leagues.map((l) => (
                <div key={l.leagueId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0 font-medium"
                    onClick={() => void openDetail(l.leagueId)}
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
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === `pause:${l.leagueId}`}
                      onClick={() =>
                        void act(`pause:${l.leagueId}`, () =>
                          adminPauseDraft({ data: { leagueId: l.leagueId } })
                        )
                      }
                    >
                      Pause
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === `resume:${l.leagueId}`}
                      onClick={() =>
                        void act(`resume:${l.leagueId}`, () =>
                          adminResumeDraft({ data: { leagueId: l.leagueId } })
                        )
                      }
                    >
                      Resume
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === `cancel:${l.leagueId}` || l.status === 'canceled'}
                      onClick={() => {
                        if (!confirm(`Cancel league "${l.name}"?`)) return;
                        void act(`cancel:${l.leagueId}`, () =>
                          adminCancelLeague({ data: { leagueId: l.leagueId } })
                        );
                      }}
                    >
                      Cancel
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {detail ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {detail.league.name} — members{' '}
              <span className="text-text-secondary">(draft: {detail.draftStatus ?? 'none'})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex flex-col divide-y divide-border">
              {detail.members.map((m) => (
                <div key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-medium">{m.corpsName ?? '(no corps name)'}</span>
                  <span className="text-text-secondary">
                    {m.role} · {m.status}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={busy === `td:${m.userId}`}
                    onClick={() => {
                      if (!confirm('Clear this member’s corps identity (name/logo/colors)?'))
                        return;
                      void act(
                        `td:${m.userId}`,
                        () =>
                          adminTakedownIdentity({
                            data: { leagueId: detail.league.leagueId, userId: m.userId },
                          }),
                        () => void openDetail(detail.league.leagueId)
                      );
                    }}
                  >
                    Take down identity
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
