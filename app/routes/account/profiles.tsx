import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { listMyProfileClaims, type MyProfileClaim } from '@/lib/server-fns/account';
import { revokeProfileClaim, deleteProfile } from '@/lib/server-fns/profile-owner';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/profiles')({
  loader: async () => listMyProfileClaims(),
  staleTime: 0,
  head: () =>
    buildSeo({
      title: 'Your profiles',
      description: 'Staff and judge pages you have claimed.',
      path: '/account/profiles',
      noindex: true,
    }),
  component: AccountProfiles,
});

const STATUS_LABEL: Record<string, string> = {
  active: 'Claimed',
  pending: 'Pending review',
  revoked: 'Revoked',
};

function ClaimRow({ claim }: { claim: MyProfileClaim }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const isJudge = claim.entityType === 'judge';

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {isJudge ? (
              <Link
                to="/judges/$judgeId"
                params={{ judgeId: claim.entityId }}
                className="truncate font-medium text-primary hover:underline"
              >
                {claim.matchedName ?? claim.entityId}
              </Link>
            ) : (
              <Link
                to="/staff/$personId"
                params={{ personId: claim.entityId }}
                className="truncate font-medium text-primary hover:underline"
              >
                {claim.matchedName ?? claim.entityId}
              </Link>
            )}
            <Badge variant="outline" radius="full">
              {isJudge ? 'Judge' : 'Staff'}
            </Badge>
            <Badge
              variant={claim.status === 'active' ? 'default' : 'outline'}
              radius="full"
            >
              {STATUS_LABEL[claim.status] ?? claim.status}
            </Badge>
          </div>
          <div className="text-xs text-text-muted">
            Claimed{' '}
            {new Date(claim.claimedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
            {claim.status === 'active'
              ? ' — edit your bio, photo and details on the public page.'
              : ''}
          </div>
        </div>
        {claim.status === 'active' ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm('Release this profile? You can claim it again later.'))
                  return;
                setBusy(true);
                try {
                  await revokeProfileClaim({
                    data: {
                      claimId: claim.claimId,
                      entityType: claim.entityType,
                      entityId: claim.entityId,
                      reason: 'released from account page',
                    },
                  });
                  void router.invalidate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Working…' : 'Release claim'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    'Remove your page from the site? It will stop appearing in the staff/judges directories and search. This takes effect within a few minutes and a moderator can restore it if requested in error.'
                  )
                )
                  return;
                setBusy(true);
                try {
                  await deleteProfile({
                    data: {
                      entityType: claim.entityType,
                      entityId: claim.entityId,
                      reason: 'owner requested removal from account page',
                    },
                  });
                  void router.invalidate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove my page
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AccountProfiles() {
  const { signedIn, claims } = Route.useLoaderData();

  if (!signedIn) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/profiles" />
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Staff &amp; judge profiles</h2>
          <p className="text-sm text-text-secondary">
            Pages you&rsquo;ve claimed as your own. Editing (bio, photo, details) happens on the
            public page itself.
          </p>
        </div>
        {claims.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 py-8 text-sm text-text-secondary">
              <p>You haven&rsquo;t claimed a profile yet.</p>
              <p>
                Are you a staff member or judge? Find your page in the{' '}
                <Link to="/staff" className="text-primary hover:underline">
                  staff directory
                </Link>{' '}
                or{' '}
                <Link to="/judges" className="text-primary hover:underline">
                  judges directory
                </Link>{' '}
                and tap &ldquo;This is me&rdquo; to claim it.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {claims.map((c) => (
              <ClaimRow key={c.claimId} claim={c} />
            ))}
          </div>
        )}
      </div>
    </AccountShell>
  );
}
