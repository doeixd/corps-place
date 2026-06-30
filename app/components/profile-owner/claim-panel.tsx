import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon';
import { CheckmarkCircle02Icon, JusticeScale01Icon } from '@/components/icons/generated';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSession, signIn } from '@/lib/auth-client';
import { claimProfile, evaluateProfileNameMatch } from '@/lib/server-fns/profile-owner';
import { ATTESTATION_COPY } from '@/lib/profile-owner/attestation';
import type { OwnershipInfo } from '@/lib/profile-owner/merge';

/**
 * Claim flow for staff/judge profiles (STAFF_PROFILE_OWNERSHIP_PLAN.md §3–5).
 * Self-contained client island: a verified badge when claimed, or an "Is this
 * you? Claim" button → sign in (if needed) → binding-attestation dialog → claim.
 * The field editor is a separate step; this only handles claim + status.
 *
 * SSR-safe: reads ownership from the merged loader data (props); `useSession`
 * drives the signed-in/out affordance.
 */
export function ClaimPanel({
  entityType,
  entityId,
  displayName,
  ownership,
}: {
  entityType: 'staff' | 'judge';
  entityId: string;
  displayName: string;
  ownership?: OwnershipInfo;
}) {
  const { data: session } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ match: string; matchedName: string | null } | null>(null);

  // Name-match preview (plan §4) — tells the user, BEFORE they attest, whether their
  // Google name matches (→ activates now) or not (→ a moderator will review). Best-effort.
  const openDialog = async () => {
    setOpen(true);
    setPreview(null);
    try {
      const r = await evaluateProfileNameMatch({ data: { entityType, entityId } });
      setPreview({ match: r.match, matchedName: r.matchedName });
    } catch {
      /* preview is non-blocking; the dialog still works without it */
    }
  };

  // Already claimed (active): show a "managed by the artist" chip — verified when
  // the name matched. Pending claims are NOT surfaced publicly.
  if (ownership?.claimed) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        <Icon icon={CheckmarkCircle02Icon} size="sm" className={ownership.verified ? 'text-success' : undefined} />
        {ownership.verified ? 'Verified — managed by this person' : 'Managed by this person'}
      </div>
    );
  }
  if (ownership?.pending) {
    return ownership.mine ? (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        Your claim is pending review.
      </div>
    ) : null;
  }

  const signedIn = !!session?.user;

  const onClaim = async () => {
    setBusy(true);
    try {
      const res = await claimProfile({ data: { entityType, entityId, attested: true } });
      toast.success(
        res.status === 'active'
          ? 'Profile claimed — you can now manage it.'
          : 'Claim submitted — a moderator will review it shortly.'
      );
      setOpen(false);
      setAttested(false);
      await router.invalidate();
    } catch {
      toast.error('Could not claim this profile. It may already be claimed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (!signedIn) {
            void signIn.social({ provider: 'google', callbackURL: window.location.pathname });
            return;
          }
          void openDialog();
        }}
      >
        {signedIn ? 'Is this you? Claim this profile' : 'Sign in to claim this profile'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={JusticeScale01Icon} size="sm" />
              Confirm this is you
            </DialogTitle>
            <DialogDescription>
              You’re about to claim the profile for <strong>{displayName}</strong>. {ATTESTATION_COPY}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              Signed in as <strong>{session?.user?.name ?? 'your account'}</strong>.{' '}
              {preview.match === 'exact' || preview.match === 'close' ? (
                <>
                  This matches <strong>{preview.matchedName ?? displayName}</strong> — your claim
                  will activate immediately.
                </>
              ) : (
                <>
                  This doesn’t closely match <strong>{preview.matchedName ?? displayName}</strong>,
                  so a moderator will review your claim before it goes live.
                </>
              )}
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={attested}
              onCheckedChange={(v) => setAttested(v === true)}
              className="mt-0.5"
            />
            <span>I understand and affirm the above.</span>
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" disabled={busy} />}>
              Cancel
            </DialogClose>
            <BusyButton busy={busy} size="sm" disabled={!attested} onClick={() => void onClaim()}>
              Claim this profile
            </BusyButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
