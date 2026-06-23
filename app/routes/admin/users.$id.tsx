// Unified user detail — the support home base (ADMIN_PAGE_PLAN §10.1). Aggregates an
// account + its activity across features. Cap: customerSupport.
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getUserDetail } from '@/lib/server-fns/support';
import { exportUserData, anonymizeUser } from '@/lib/server-fns/admin-users';
import { seoHead } from '@/lib/seo';

type Detail = Awaited<ReturnType<typeof getUserDetail>>;

export const Route = createFileRoute('/admin/users/$id')({
  loader: requireAdminLoader('customerSupport'),
  head: () => seoHead({ title: 'Admin — User', description: 'User detail', path: '/admin/users' }),
  component: () => {
    const gate = Route.useLoaderData();
    const { id } = Route.useParams();
    return <AdminPage gate={gate}>{() => <UserDetail id={id} />}</AdminPage>;
  },
});

function UserDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getUserDetail({ data: { userId: id } })
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id]);

  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const exportData = async () => {
    try {
      const data = await exportUserData({ data: { userId: id } });
      const blob = new Blob([data.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `user-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionMsg((e as Error).message);
    }
  };

  const erase = async () => {
    if (!confirm('Erase this user’s PII (GDPR)? Content is kept but anonymized. This bans them.'))
      return;
    try {
      await anonymizeUser({ data: { userId: id } });
      setActionMsg('User anonymized.');
    } catch (e) {
      setActionMsg((e as Error).message);
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!detail) return <p className="text-sm text-text-secondary">Loading…</p>;
  const { user, activity } = detail;

  return (
    <>
      <PageHeader
        title={user.name ?? user.email ?? user.id}
        subtitle={`${user.role}${user.banned ? ' · banned' : ''}`}
        actions={
          <Link
            to="/admin/users"
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            ← All users
          </Link>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">Account</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-text-secondary">Email</span>
            <span className="text-right">{user.email ?? '—'}</span>
            <span className="text-text-secondary">Role</span>
            <span className="text-right">{user.role}</span>
            <span className="text-text-secondary">Banned</span>
            <span className="text-right">{user.banned ? 'yes' : 'no'}</span>
            <span className="text-text-secondary">Created</span>
            <span className="text-right">
              {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-text-secondary">Activity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm tabular-nums">
            <span className="text-text-secondary">Wiki revisions</span>
            <span className="text-right">{activity.revisions}</span>
            <span className="text-text-secondary">Media uploads</span>
            <span className="text-right">{activity.uploads}</span>
            <span className="text-text-secondary">Leagues owned</span>
            <span className="text-right">{activity.leaguesOwned}</span>
            <span className="text-text-secondary">Leagues joined</span>
            <span className="text-right">{activity.leaguesJoined}</span>
            <span className="text-text-secondary">Contact messages</span>
            <span className="text-right">{activity.contacts}</span>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">GDPR</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {actionMsg ? <p className="text-text-secondary">{actionMsg}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void exportData()}>
              Export data (JSON)
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void erase()}>
              Erase PII
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
