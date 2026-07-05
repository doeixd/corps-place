import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import {
  getFlagQueue,
  getPendingClaims,
  dismissFlag,
  actionFlag,
  revokeJobsClaim,
} from '@/lib/server-fns/jobs';
import { Alert02Icon, CheckmarkCircle02Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/admin')({
  head: () =>
    buildSeo({
      title: 'Admin — PageantryJobs',
      description: 'PageantryJobs moderation queue.',
      path: '/jobs/admin',
      noindex: true,
    }),
  // getFlagQueue/getPendingClaims are moderator-gated server-fns; a non-moderator
  // (or signed-out) request throws ForbiddenError. Convert that to notFound() so
  // the moderation console's existence isn't advertised, matching /admin's idiom.
  loader: async () => {
    try {
      return { flags: await getFlagQueue(), claims: await getPendingClaims() };
    } catch {
      throw notFound();
    }
  },
  component: AdminPage,
});

function AdminPage() {
  const initial = Route.useLoaderData();
  const [flags, setFlags] = useState(initial.flags);
  const [claims, setClaims] = useState(initial.claims);
  const [loading, setLoading] = useState<string | null>(null);

  const handleDismiss = async (flagId: string) => {
    setLoading(flagId);
    await dismissFlag({ data: { flagId } });
    setFlags((prev) => prev.filter((f) => f.flag_id !== flagId));
    setLoading(null);
  };

  const handleAction = async (flagId: string) => {
    setLoading(flagId);
    await actionFlag({ data: { flagId } });
    setFlags((prev) => prev.filter((f) => f.flag_id !== flagId));
    setLoading(null);
  };

  const handleRevoke = async (claimId: string) => {
    setLoading(claimId);
    await revokeJobsClaim({ data: { claimId } });
    setClaims((prev) => prev.filter((c) => c.claim_id !== claimId));
    setLoading(null);
  };

  return (
    <PageShell>
      <PageHeader title="Admin" subtitle="Moderation and oversight" subtitleClassName="text-sm" backTo="/" backLabel="Home" />

      <div className="space-y-8">
        {/* Flagged content */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-text-primary">
            <Icon icon={Alert02Icon} size="sm" />
            Flagged Content
          </h2>
          {flags.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-text-muted">
                No open flags.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {flags.map((f) => (
                <Card key={f.flag_id}>
                  <CardContent className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary capitalize">
                        {f.target_kind}
                      </p>
                      <p className="text-xs text-text-muted">ID: {f.target_id}</p>
                      {f.reason ? (
                        <p className="mt-1 text-sm text-text-secondary">"{f.reason}"</p>
                      ) : null}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        onClick={() => handleDismiss(f.flag_id)}
                        disabled={loading === f.flag_id}
                        variant="ghost"
                        size="xs"
                      >
                        Dismiss
                      </Button>
                      <Button
                        onClick={() => handleAction(f.flag_id)}
                        disabled={loading === f.flag_id}
                        variant="destructive"
                        size="xs"
                      >
                        Hide
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Claims */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-text-primary">
            <Icon icon={CheckmarkCircle02Icon} size="sm" />
            Recent Claims
          </h2>
          {claims.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-text-muted">
                No claims.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {claims.map((c) => (
                <Card key={c.claim_id}>
                  <CardContent className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary capitalize">
                        {c.entity_type}
                      </p>
                      <p className="text-xs text-text-muted">
                        Entity: {c.entity_id} · Profile: {c.profile_id}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="success-light" size="sm">
                        {c.status}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={loading === c.claim_id}
                        onClick={() => handleRevoke(c.claim_id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
