// User management (ADMIN_PAGE_PLAN §7/§10). List/search users, change roles, ban,
// and impersonate ("view as user") — all guard-railed + audited server-side. Gated to
// admins via requireAdminLoader('manageUsers').
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  loader: requireAdminLoader('manageUsers'),
  head: () =>
    seoHead({ title: 'Admin — Users', description: 'User management', path: '/admin/users' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Users />}</AdminPage>;
  },
});

function Users() {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((query: string) => {
    setError(null);
    listUsers({ data: { q: query, limit: 100 } })
      .then(setUsers)
      .catch((e: unknown) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  const changeRole = async (id: string, role: Role) => {
    setBusy(id);
    setError(null);
    try {
      await setUserRole({ data: { userId: id, role } });
      setUsers((prev) => prev?.map((u) => (u.id === id ? { ...u, role } : u)) ?? prev);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleBan = async (u: AdminUserRow) => {
    if (u.banned ? false : !confirm(`Ban ${u.email ?? u.id}?`)) return;
    setBusy(u.id);
    setError(null);
    try {
      await setUserBanned({ data: { userId: u.id, banned: !u.banned, reason: '' } });
      setUsers(
        (prev) => prev?.map((x) => (x.id === u.id ? { ...x, banned: !u.banned } : x)) ?? prev
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Impersonation rides the better-auth client (cookies via the auth route). On
  // success we land on the home page acting as that user; an admin banner/stop lives
  // in the global session UI.
  const impersonate = async (id: string) => {
    setError(null);
    try {
      // Enforce our `impersonate` capability + write the audit row before the actual
      // (better-auth) impersonation, which only checks adminRoles (H2).
      await logImpersonation({ data: { userId: id } });
    } catch (e) {
      return setError((e as Error).message);
    }
    const res = await authClient.admin.impersonateUser({ userId: id });
    if (res.error) return setError(res.error.message ?? 'Impersonation failed');
    window.location.href = '/';
  };

  return (
    <>
      <PageHeader title="Users" subtitle="Roles, search" />
      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      <Card>
        <CardContent className="text-sm">
          {!users ? (
            <p className="text-text-secondary">Loading…</p>
          ) : users.length === 0 ? (
            <p className="text-text-secondary">No users.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {users.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-medium">{u.name ?? '—'}</span>
                  <span className="text-text-secondary">{u.email ?? u.id}</span>
                  {u.banned ? (
                    <Badge variant="destructive-light" size="sm">
                      banned
                    </Badge>
                  ) : null}
                  <Select
                    value={u.role}
                    disabled={busy === u.id}
                    onValueChange={(v) => {
                      if (v) void changeRole(u.id, v as Role);
                    }}
                  >
                    <SelectTrigger size="sm" className="ml-auto w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === u.id}
                    onClick={() => void toggleBan(u)}
                  >
                    {u.banned ? 'Unban' : 'Ban'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void impersonate(u.id)}>
                    Impersonate
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
