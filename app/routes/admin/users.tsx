// User management (ADMIN_PAGE_PLAN §7, M3). List/search users and change roles
// (guard-railed + audited server-side). Ban/impersonate arrive with the better-auth
// admin plugin. Gated to admins via requireAdminLoader('manageUsers').
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { listUsers, setUserRole, type AdminUserRow } from '@/lib/server-fns/admin-users';
import type { Role } from '@/lib/authz';
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
                  <select
                    className="ml-auto rounded border border-border bg-transparent px-2 py-1 text-sm"
                    value={u.role}
                    disabled={busy === u.id}
                    onChange={(e) => void changeRole(u.id, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
