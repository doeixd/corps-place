// Profile-claim moderation queue (STAFF_PROFILE_OWNERSHIP_PLAN §9, build step 7).
// Pending (weak name-match) claims await a moderator; active claims can be revoked.
// Claims live in contributions.db (on the serving container), so this reads/writes
// directly via server-fns — no VM worker hop. Gated to `manageProfileClaims`.
import { useState } from 'react';
import { createFileRoute, useRouter, Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { Input } from '@/components/ui/input';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/reui/badge';
import { BusyButton } from '@/components/fantasy/busy-button';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  listProfileClaims,
  approveProfileClaim,
  revokeProfileClaim,
  reconcileProfileOverrides,
  repointProfileClaim,
} from '@/lib/server-fns/profile-owner';
import { toast } from 'sonner';
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
  orphaned: boolean; // entity_id no longer resolves in the read-model (merged/removed)
  currentName: string | null;
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

function RepointControl({ claim, onDone }: { claim: ClaimRow; onDone: () => Promise<void> }) {
  const [val, setVal] = useState('');
  const act = useAsyncAction(async () => {
    await repointProfileClaim({ data: { claimId: claim.claim_id, newEntityId: val.trim() } });
    await onDone();
  });
  return (
    <span className="flex items-center gap-1">
      <Input
        className="h-7 w-48"
        placeholder="new entity id"
        value={val}
        onChange={(e) => setVal(e.target.value)}
      />
      <BusyButton
        size="sm"
        variant="outline"
        busy={act.busy}
        disabled={!val.trim()}
        onClick={() => void act.run()}
      >
        Re-point
      </BusyButton>
    </span>
  );
}

// Per-row actions own their busy/error state so one claim's action doesn't spin every
// other row's buttons (a single shared flag would).
function ClaimActions({ claim, onDone }: { claim: ClaimRow; onDone: () => Promise<void> }) {
  const act = useAsyncAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await onDone();
  });
  const label = claim.currentName ?? claim.matched_name ?? claim.entity_id;
  return (
    <span className="ml-auto flex items-center gap-2">
      <Show when={act.error}>
        <span className="text-xs text-destructive">{act.error}</span>
      </Show>
      <Show when={claim.orphaned}>
        <RepointControl claim={claim} onDone={onDone} />
      </Show>
      <Show when={claim.status === 'pending'}>
        <BusyButton
          size="sm"
          busy={act.busy}
          onClick={() => void act.run(() => approveProfileClaim({ data: { claimId: claim.claim_id } }))}
        >
          Approve
        </BusyButton>
      </Show>
      <BusyButton
        size="sm"
        variant="destructive"
        busy={act.busy}
        onClick={() => {
          if (!confirm(`Revoke the claim on “${label}”? This removes the owner's edits.`)) return;
          void act.run(() =>
            revokeProfileClaim({
              data: {
                claimId: claim.claim_id,
                entityType: claim.entity_type as 'staff' | 'judge',
                entityId: claim.entity_id,
              },
            })
          );
        }}
      >
        Revoke
      </BusyButton>
    </span>
  );
}

const matchBadge = (m: string | null) =>
  m === 'exact' || m === 'close' ? 'success-light' : m === 'weak' ? 'warning-light' : 'secondary';

function ProfileClaims({ all }: { all: ClaimRow[] }) {
  const router = useRouter();

  const reconcile = useAsyncAction(async () => {
    const res = await reconcileProfileOverrides();
    toast.success(`Reconciled — checked ${res.checked}, updated ${res.changed}.`);
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
        <Show when={c.orphaned}>
          <Badge variant="destructive-light" size="sm">
            orphaned — entity merged/removed
          </Badge>
        </Show>
        <span className="text-text-secondary">
          claimed as “{c.google_name ?? '—'}” · {new Date(c.claimed_at).toLocaleDateString()}
        </span>
        <ClaimActions claim={c} onDone={() => router.invalidate()} />
      </div>
    );
  };

  return (
    <>
      <PageHeader title="Profile Claims" subtitle="Approve pending ownership claims · revoke disputes" />
      <div className="mb-4 flex items-center gap-3">
        <BusyButton size="sm" variant="outline" busy={reconcile.busy} onClick={() => void reconcile.run()}>
          Recheck source divergence
        </BusyButton>
      </div>
      <Show when={reconcile.error}>
        <p className="mb-4 text-sm text-destructive">{reconcile.error}</p>
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
