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
import {
  subscribeScores,
  getScoreVapidPublicKey,
  saveScorePushSubscription,
} from '@/lib/server-fns/score-notify';
import { cn } from '@/lib/utils';

/** Does this browser support Web Push at all? */
const pushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Decode a base64url VAPID key into the Uint8Array the Push API wants. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Subscribe this device to push; returns the subscription JSON or throws. */
async function subscribeDevice(publicKey: string) {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications permission was denied.');
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('Notifications need the offline app worker, which is not active here.');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint ?? '',
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

/**
 * "Notify me of scores" — a small megaphone button that opens a dialog where
 * anyone (signed in or not) can subscribe to be notified when scores post for an
 * event or corps, by email and/or native push. SSR-safe (no window at module
 * scope); the Push option only appears when the browser supports it and VAPID
 * keys are configured server-side.
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
  const [wantPush, setWantPush] = useState(false);
  // null = unknown/not loaded, '' = not configured, string = usable key.
  const [vapidKey, setVapidKey] = useState<string | null>(null);

  const canPush = pushSupported() && !!vapidKey;

  // Prefill email + probe push config when the dialog opens.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setEmail((cur) => cur || session?.user?.email || '');
      if (vapidKey === null && pushSupported()) {
        void getScoreVapidPublicKey().then((r) => setVapidKey(r.publicKey ?? ''));
      }
    }
    setOpen(next);
  };

  const submit = async () => {
    const value = email.trim();
    if (!value || !value.includes('@')) {
      toast.error('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    let pushOn = false;
    try {
      // Try push first (if requested) so we can record the right method, but
      // never let a push failure block the email subscription.
      if (wantPush && canPush) {
        try {
          const device = await subscribeDevice(vapidKey as string);
          await saveScorePushSubscription({ data: { ...device, email: value } });
          pushOn = true;
        } catch (err) {
          toast.warning(
            err instanceof Error && err.message.includes('denied')
              ? 'Push was blocked — you can enable it in your browser settings. Subscribing by email.'
              : 'Could not enable push on this device — subscribing by email.'
          );
        }
      }

      await subscribeScores({
        data: {
          targetKind,
          targetSlug,
          targetLabel,
          email: value,
          methods: { email: true, push: pushOn },
        },
      });
      toast.success(
        pushOn
          ? "You're subscribed — we'll email and push you when scores post."
          : "You're subscribed — we'll email you when scores post."
      );
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
          <button
            type="button"
            aria-label="Notify me of scores"
            // Match FavoriteCorpsButton's labelled variant so the pair reads as
            // a matched set (same border, padding, type scale, hover).
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
              'border-border text-text-secondary hover:border-text-secondary/40 hover:text-text-primary',
              className
            )}
          />
        }
      >
        <Icon icon={Megaphone01Icon} size="md" />
        Notify me
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Notify me of scores</DialogTitle>
          <DialogDescription>
            We&apos;ll let you know as soon as scores are posted for {targetLabel}.
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
            {canPush ? (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <Checkbox
                  checked={wantPush}
                  onCheckedChange={(c) => setWantPush(c === true)}
                  aria-label="Push notifications"
                />
                Push notifications on this device
              </label>
            ) : null}
          </fieldset>

          {wantPush ? (
            <p className="text-xs text-text-secondary">
              On iPhone, add DrumCorps.app to your Home Screen first to receive push.
            </p>
          ) : null}
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
