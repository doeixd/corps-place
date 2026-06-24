import { useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useSession, authClient } from '@/lib/auth-client';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { acceptTerms } from '@/lib/server-fns/consent';
import { needsConsent, type ConsentUser } from '@/lib/consent';

/**
 * Site-wide first-sign-in gate: a blocking modal shown to any signed-in user who
 * hasn't accepted the current Terms/Privacy version. Accepting Terms + Privacy is
 * required; the contact opt-in is optional and seeds their email preference.
 * Signed-out users (and those already current) see nothing.
 *
 * Lives in the root layout. `acceptTerms` is a code-split server-fn — this file
 * pulls no server code into the client bundle.
 */
export function ConsentGate() {
  const { data } = useSession();
  const user = data?.user as ConsentUser | undefined;
  // Never cover the legal pages themselves — the gate links to them (in a new tab),
  // so they must be readable without the modal on top.
  const pathname = useLocation({ select: (l) => l.pathname });
  const onLegalPage = pathname === '/terms-of-service' || pathname === '/privacy-policy';

  const [agreed, setAgreed] = useState(false);
  const [contact, setContact] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = !dismissed && !onLegalPage && needsConsent(user);
  if (!open) return null;

  const submit = async () => {
    if (!agreed) return;
    setBusy(true);
    setError(null);
    try {
      await acceptTerms({ data: { contactConsent: contact } });
      setDismissed(true);
      void authClient.getSession(); // refresh the cached session in the background
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showClose={false} className="max-w-md">
        <DialogTitle>Before you continue</DialogTitle>
        <DialogDescription>
          Please review and accept our terms to keep using drumcorps.app.
        </DialogDescription>

        <div className="flex flex-col gap-3 py-1 text-sm">
          <label className="flex items-start gap-2">
            <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(!!v)} className="mt-0.5" />
            <span>
              I agree to the{' '}
              <Link
                to="/terms-of-service"
                target="_blank"
                className="font-medium underline underline-offset-2"
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                to="/privacy-policy"
                target="_blank"
                className="font-medium underline underline-offset-2"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={contact}
              onCheckedChange={(v) => setContact(!!v)}
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              Email me about my leagues — drafts, reminders, and standings. Optional, and you can
              change it anytime in a league's notification settings.
            </span>
          </label>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button disabled={!agreed || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Agree & continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
