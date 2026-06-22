import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { signIn, useSession } from '@/lib/auth-client';
import type { AdminGate } from '@/lib/admin-loader';

/**
 * Shared wrapper for every `/admin/*` page: renders the sign-in card for a
 * signed-out (or unauthorized-but-signed-in) visitor, else the `AdminShell` with
 * the section content. The route loader (`requireAdminLoader`) supplies `gate`;
 * `notFound()` already handled the signed-in-wrong-role case, so here `!signedIn`
 * means "offer sign-in". Keeps the gate UI in one place (ADMIN_PAGE_PLAN §2).
 */
export function AdminPage({
  gate,
  children,
}: {
  gate: AdminGate;
  children: (role: string) => ReactNode;
}) {
  const { data: session } = useSession();

  if (!gate.signedIn) {
    return (
      <PageShell>
        <PageHeader title="Admin" subtitle="Operator console" />
        <Card className="mx-auto mt-6 max-w-md">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-text-secondary">
            <p>
              {session
                ? 'Your account does not have access to this area.'
                : 'Sign in with an authorized account to continue.'}
            </p>
            {!session ? (
              <Button
                onClick={() => void signIn.social({ provider: 'google', callbackURL: '/admin' })}
              >
                Continue with Google
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return <AdminShell role={gate.actor.role}>{children(gate.actor.role)}</AdminShell>;
}
