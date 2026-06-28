import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Icon } from '@/components/icon';
import { Megaphone01Icon } from '@/components/icons/generated';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useSession } from '@/lib/auth-client';
import { subscribeScores } from '@/lib/server-fns/score-notify';
import { cn } from '@/lib/utils';

/**
 * "Notify me of scores" — a small megaphone button that opens a dialog where
 * anyone (signed in or not) can subscribe by email to be emailed when scores
 * post for an event or corps. SSR-safe (no window at module scope).
 */
export function ScoreNotifyButton({
  targetKind,
  targetSlug,
  targetLabel,
  className,
}: {
  targetKind: 'event' | 'corps';
  targetSlug: string;
  targetLabel: string;
  className?: string;
}) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefill from the signed-in user when the dialog opens.
  const onOpenChange = (next: boolean) => {
    if (next) setEmail((cur) => cur || session?.user?.email || '');
    setOpen(next);
  };

  const submit = async () => {
    const value = email.trim();
    if (!value || !value.includes('@')) {
      toast.error('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await subscribeScores({
        data: {
          targetKind,
          targetSlug,
          targetLabel,
          email: value,
          methods: { email: true, push: false },
        },
      });
      toast.success("You're subscribed — we'll email you when scores post.");
      setOpen(false);
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label="Notify me of scores"
            className={cn('gap-1.5', className)}
          />
        }
      >
        <Icon icon={Megaphone01Icon} size="sm" />
        Notify me
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Notify me of scores</DialogTitle>
          <DialogDescription>
            We&apos;ll email you as soon as scores are posted for {targetLabel}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="score-notify-email">Email</Label>
            <Input
              id="score-notify-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text-primary">Notify me via</legend>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <Checkbox checked disabled aria-label="Email" />
              Email
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary opacity-60">
              <Checkbox checked={false} disabled aria-label="Push notifications" />
              Push notifications
              <span className="text-xs italic text-text-secondary">Coming soon</span>
            </label>
          </fieldset>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <BusyButton size="sm" busy={busy} onClick={() => void submit()}>
            Subscribe
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
