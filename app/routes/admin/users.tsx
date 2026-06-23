// User management (ADMIN_PAGE_PLAN §7/§10). List, role, ban, impersonate — guard-railed
// + audited server-side. Users fetched in the loader; the search box filters the loaded
// list in render (no client re-fetch). Gated to admins.
import { useState } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Badge } from '@/components/reui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  listUsers,
  setUserRole,
  setUserBanned,
  logImpersonation,
  type AdminUserRow,
} from '@/lib/server-fns/admin-users';
import type { Role } from '@/lib/authz';
import { authClient } from '@/lib/auth-client';
import { seoHead } from '@/lib/seo';

const ROLES: Role[] = ['user', 'trusted', 'moderator', 'admin'];

export const Route = createFileRoute('/admin/users')({
  loader: adminLoader('manageUsers', () => listUsers({ data: { q: '', limit: 200 } })),
  head: () =>
    seoHead({ title: 'Admin — Users', description: 'User management', path: '/admin/users' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Users all={data ?? []} />}</AdminPage>;
  },
});

function Users({ all }: { all: AdminUserRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  // Derived in render (no effect) — filter the loaded list.
  const term = q.trim().toLowerCase();
  const users = term
    ? all.filter(
        (u) =>
          (u.name ?? '').toLowerCase().includes(term) ||
          (u.email ?? '').toLowerCase().includes(term)
      )
    : all;

  const act = useAsyncAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await router.invalidate();
  });

  const impersonate = useAsyncAction(async (id: string) => {
    await logImpersonation({ data: { userId: id } });
    const res = await authClient.admin.impersonateUser({ userId: id });
    if (res.error) throw new Error(res.error.message ?? 'Impersonation failed');
    window.location.href = '/';
  });

  return (
    <>
      <PageHeader title="Users" subtitle="Roles, ban, impersonate" />
      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Show when={act.error || impersonate.error}>
        <p className="mb-4 text-sm text-destructive">{act.error ?? impersonate.error}</p>
      </Show>
      <Card>
        <CardContent className="text-sm">
          <Show when={users.length > 0} fallback={<p className="text-text-secondary">No users.</p>}>
            <div className="flex flex-col divide-y divide-border">
              <For each={users}>
                {(u) => (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="font-medium">{u.name ?? '—'}</span>
                    <span className="text-text-secondary">{u.email ?? u.id}</span>
                    <Show when={u.banned}>
                      <Badge variant="destructive-light" size="sm">
                        banned
                      </Badge>
                    </Show>
                    <Select
                      value={u.role}
                      disabled={act.busy}
                      onValueChange={(v) => {
                        if (v)
                          void act.run(() =>
                            setUserRole({ data: { userId: u.id, role: v as Role } })
                          );
                      }}
                    >
                      <SelectTrigger size="sm" className="ml-auto w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <For each={ROLES}>{(r) => <SelectItem value={r}>{r}</SelectItem>}</For>
                      </SelectContent>
                    </Select>
                    <BusyButton
                      variant="ghost"
                      size="sm"
                      busy={act.busy}
                      onClick={() => {
                        if (!u.banned && !confirm(`Ban ${u.email ?? u.id}?`)) return;
                        void act.run(() =>
                          setUserBanned({ data: { userId: u.id, banned: !u.banned, reason: '' } })
                        );
                      }}
                    >
                      {u.banned ? 'Unban' : 'Ban'}
                    </BusyButton>
                    <BusyButton
                      variant="ghost"
                      size="sm"
                      busy={impersonate.busy}
                      onClick={() => void impersonate.run(u.id)}
                    >
                      Impersonate
                    </BusyButton>
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
