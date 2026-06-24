import { useState } from 'react';
import { BusyButton } from '@/components/fantasy/busy-button';
import {
  getVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
} from '@/lib/server-fns/fantasy';
import { useAsyncAction } from '@/lib/use-async-action';

const isSupported = (): boolean =>
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

const readyRegistration = async (): Promise<ServiceWorkerRegistration> => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('Notifications need the offline app worker, which is not active here.');
  return reg;
};

/**
 * Opt into draft push alerts (on-the-clock / draft-starting). No `useEffect`:
 * the subscribe/unsubscribe flows run on click and drive local state. Requires
 * the service worker (prod + VITE_ENABLE_SW) and configured VAPID keys.
 */
export function PushToggle() {
  const [on, setOn] = useState(false);

  const enable = useAsyncAction(async () => {
    const { publicKey } = await getVapidPublicKey();
    if (!publicKey) throw new Error('Push notifications are not configured.');
    if ((await Notification.requestPermission()) !== 'granted') {
      throw new Error('Notifications permission was denied.');
    }
    const reg = await readyRegistration();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    const json = sub.toJSON();
    await savePushSubscription({
      data: {
        endpoint: json.endpoint ?? '',
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      },
    });
    setOn(true);
  });

  const disable = useAsyncAction(async () => {
    const reg = await readyRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await deletePushSubscription({ data: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    setOn(false);
  });

  if (!isSupported()) return null;
  const busy = enable.busy || disable.busy;
  const error = enable.error ?? disable.error;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <BusyButton
          size="sm"
          variant="outline"
          busy={busy}
          onClick={() => void (on ? disable.run() : enable.run())}
        >
          {on ? 'Disable draft alerts' : 'Enable draft alerts'}
        </BusyButton>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {on
          ? '✓ On — we’ll alert this device when the draft goes live and when you’re on the clock.'
          : 'Get a heads-up when the draft starts and when it’s your turn to pick.'}
      </p>
    </div>
  );
}
