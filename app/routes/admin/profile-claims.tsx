// Profile-claim moderation queue (STAFF_PROFILE_OWNERSHIP_PLAN §9, build step 7).
// Pending (weak name-match) claims await a moderator; active claims can be revoked.
// Claims live in contributions.db (on the serving container), so this reads/writes
// directly via server-fns — no VM worker hop. Gated to `manageProfileClaims`.
import { createFileRoute, useRouter, Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import { listProfileClaims, approveProfileClaim, revokeProfileClaim } from '@/lib/server-fns/profile-owner';
import { seoHead } from '@/lib/seo';

type ClaimRow = {
  claim_id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  status: string;
  google_name: string | null;
  matched_name: string | null;
  name_match: string | null;
  name_score: number | null;
  claimed_at: string;
  attested_at: string;
};

export const Route = createFileRoute('/admin/profile-claims')({
  loader: adminLoader('manageProfileClaims', () => listProfileClaims({ data: {} })),
  head: () =>
    seoHead({
      title: 'Admin — Profile Claims',
      description: 'Moderate staff/judge profile ownership claims',
      path: '/admin/profile-claims',
    }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <ProfileClaims all={(data ?? []) as ClaimRow[]} />}</AdminPage>;
  },
});

const matchBadge = (m: string | null) =>
  m === 'exact' || m === 'close' ? 'success-light' : m === 'weak' ? 'warning-light' : 'secondary';

function ProfileClaims({ all }: { all: ClaimRow[] }) {
  const router = useRouter();
  const act = useAsyncAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await router.invalidate();
  });

  const pending = all.filter((c) => c.status === 'pending');
  const active = all.filter((c) => c.status === 'active');

  const row = (c: ClaimRow) => {
    const to = c.entity_type === 'staff' ? '/staff/$personId' : '/judges/$judgeId';
    const params = c.entity_type === 'staff' ? { personId: c.entity_id } : { judgeId: c.entity_id };
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" key={c.claim_id}>
        <Badge variant="secondary" size="sm">
          {c.entity_type}
        </Badge>
        <Link to={to} params={params} className="font-medium hover:text-primary">
          {c.matched_name ?? c.entity_id}
        </Link>
        <Badge variant={matchBadge(c.name_match)} size="sm">
          {c.name_match ?? '—'}
          {typeof c.name_score === 'number' ? ` ${Math.round(c.name_score * 100)}%` : ''}
        </Badge>
        <span className="text-text-secondary">
          claimed as “{c.google_name ?? '—'}” · {new Date(c.claimed_at).toLocaleDateString()}
        </span>
        <span className="ml-auto flex gap-2">
          <Show when={c.status === 'pending'}>
            <BusyButton
              size="sm"
              busy={act.busy}
              onClick={() => void act.run(() => approveProfileClaim({ data: { claimId: c.claim_id } }))}
            >
              Approve
            </BusyButton>
          </Show>
          <BusyButton
            size="sm"
            variant="destructive"
            busy={act.busy}
            onClick={() =>
              void act.run(() =>
                revokeProfileClaim({
                  data: { claimId: c.claim_id, entityType: c.entity_type as 'staff' | 'judge', entityId: c.entity_id },
                })
              )
            }
          >
            Revoke
          </BusyButton>
        </span>
      </div>
    );
  };

  return (
    <>
      <PageHeader title="Profile Claims" subtitle="Approve pending ownership claims · revoke disputes" />
      <Show when={act.error}>
        <p className="mb-4 text-sm text-destructive">{act.error}</p>
      </Show>

      <h3 className="mb-2 mt-2 text-sm font-semibold text-text-secondary">
        Pending review ({pending.length})
      </h3>
      <Card className="mb-6">
        <CardContent className="text-sm">
          <Show when={pending.length > 0} fallback={<p className="text-text-secondary">Nothing pending.</p>}>
            <div className="flex flex-col divide-y divide-border">
              <For each={pending}>{row}</For>
            </div>
          </Show>
        </CardContent>
      </Card>

      <h3 className="mb-2 text-sm font-semibold text-text-secondary">Active ({active.length})</h3>
      <Card>
        <CardContent className="text-sm">
          <Show when={active.length > 0} fallback={<p className="text-text-secondary">No active claims.</p>}>
            <div className="flex flex-col divide-y divide-border">
              <For each={active}>{row}</For>
            </div>
          </Show>
        </CardContent>
      </Card>
    </>
  );
}
