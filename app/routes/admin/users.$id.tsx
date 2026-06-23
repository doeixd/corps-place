// Unified user detail — the support home base (ADMIN_PAGE_PLAN §10.1). Account +
// activity + sessions + communications, with recovery (revoke sessions, sign-in link)
// and GDPR (export, erase). All fetched in the loader; refresh via invalidate.
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Badge } from '@/components/reui/badge';
import {
  getUserDetail,
  listUserEmails,
  listUserSessions,
  revokeUserSessions,
  logSignInLinkSent,
} from '@/lib/server-fns/support';
import { exportUserData, anonymizeUser } from '@/lib/server-fns/admin-users';
import { useAsyncAction } from '@/lib/use-async-action';
import { authClient } from '@/lib/auth-client';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/users/$id')({
  loader: async ({ params }) =>
    adminLoader('customerSupport', async () => ({
      detail: await getUserDetail({ data: { userId: params.id } }),
      emails: await listUserEmails({ data: { userId: params.id } }),
      sessions: await listUserSessions({ data: { userId: params.id } }),
    }))(),
  head: () => seoHead({ title: 'Admin — User', description: 'User detail', path: '/admin/users' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    const { id } = Route.useParams();
    return (
      <AdminPage gate={gate}>{() => (data ? <UserDetail id={id} data={data} /> : null)}</AdminPage>
    );
  },
});

type Data = {
  detail: Awaited<ReturnType<typeof getUserDetail>>;
  emails: Awaited<ReturnType<typeof listUserEmails>>;
  sessions: Awaited<ReturnType<typeof listUserSessions>>;
};

function UserDetail({ id, data }: { id: string; data: Data }) {
  const router = useRouter();
  const { user, activity } = data.detail;

  const revoke = useAsyncAction(async () => {
    if (!confirm('Sign this user out of all sessions?')) return;
    await revokeUserSessions({ data: { userId: id } });
    await router.invalidate();
  });
  const signin = useAsyncAction(async () => {
    if (!user.email) throw new Error('No email on file.');
    await logSignInLinkSent({ data: { userId: id } });
    const res = await authClient.signIn.magicLink({ email: user.email, callbackURL: '/' });
    if (res.error) throw new Error(res.error.message ?? 'Send failed');
  });
  const exportAction = useAsyncAction(async () => {
    const out = await exportUserData({ data: { userId: id } });
    const url = URL.createObjectURL(new Blob([out.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `user-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  const erase = useAsyncAction(async () => {
    if (!confirm('Erase this user’s PII (GDPR)? Content is kept but anonymized. This bans them.'))
      return;
    await anonymizeUser({ data: { userId: id } });
    await router.invalidate();
  });

  const anyError = revoke.error ?? signin.error ?? exportAction.error ?? erase.error;

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
      <Show when={anyError}>
        <p className="mb-4 text-sm text-destructive">{anyError}</p>
      </Show>

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
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Sessions ({data.sessions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Show
            when={data.sessions.length > 0}
            fallback={<p className="text-text-secondary">No active sessions.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={data.sessions}>
                {(s) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                    <span>{s.ipAddress ?? 'unknown IP'}</span>
                    <span className="truncate text-xs text-text-secondary">
                      {s.userAgent ?? ''}
                    </span>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div className="flex flex-wrap gap-2 pt-1">
            <BusyButton
              size="sm"
              variant="outline"
              busy={revoke.busy}
              disabled={data.sessions.length === 0}
              onClick={() => void revoke.run()}
            >
              Sign out everywhere
            </BusyButton>
            <BusyButton
              size="sm"
              variant="outline"
              busy={signin.busy}
              onClick={() => void signin.run()}
            >
              Send sign-in link
            </BusyButton>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Communications ({data.emails.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Show
            when={data.emails.length > 0}
            fallback={<p className="text-text-secondary">No emails sent to this user.</p>}
          >
            <div className="flex flex-col divide-y divide-border">
              <For each={data.emails}>
                {(e) => (
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                    <span className="font-medium">{e.subject ?? '(no subject)'}</span>
                    <Show when={e.tag}>
                      <Badge variant="secondary" size="sm">
                        {e.tag}
                      </Badge>
                    </Show>
                    <Show when={e.status && e.status !== 'sent'}>
                      <Badge
                        variant={e.status === 'failed' ? 'destructive-light' : 'outline'}
                        size="sm"
                      >
                        {e.status}
                      </Badge>
                    </Show>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {new Date(e.sentAt).toLocaleString()}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">GDPR</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 text-sm">
          <BusyButton
            size="sm"
            variant="outline"
            busy={exportAction.busy}
            onClick={() => void exportAction.run()}
          >
            Export data (JSON)
          </BusyButton>
          <BusyButton
            size="sm"
            variant="destructive"
            busy={erase.busy}
            onClick={() => void erase.run()}
          >
            Erase PII
          </BusyButton>
        </CardContent>
      </Card>
    </>
  );
}
