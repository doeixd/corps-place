import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useSession } from '@/lib/auth-client';
import { setMemberNotifyPrefs } from '@/lib/server-fns/fantasy';
import { setTimeZone } from '@/lib/server-fns/consent';
import { track } from '@/lib/analytics/client';
import {
  getVapidPublicKey,
  savePushSubscription,
  deletePushSubscription,
} from '@/lib/server-fns/fantasy';

// --- Browser push (device subscription) helpers ------------------------------
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

const readyRegistration = async (): Promise<ServiceWorkerRegistration> => {
  // `.ready` resolves once the worker is active (register-sw.ts registers it on load).
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) throw new Error('Notifications need the offline app worker, which is not active here.');
  return reg;
};

/** Subscribe this device to push and persist the subscription. */
async function subscribeDevice(): Promise<void> {
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
}

/** Remove this device's push subscription. */
async function unsubscribeDevice(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await deletePushSubscription({ data: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  }
}

// --- Add-to-calendar (.ics) ---------------------------------------------------
/** UTC timestamp in the iCalendar basic format, e.g. 20260702T150000Z. */
const icsStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Build a one-hour VEVENT .ics for the draft and trigger a download. */
function downloadDraftIcs(opts: {
  leagueId: string;
  startsAtIso: string;
  leagueName?: string;
  leagueSlug?: string;
}): void {
  const start = new Date(opts.startsAtIso);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const title = `${opts.leagueName ? `${opts.leagueName} — ` : ''}Fantasy Drum Corps Draft`;
  const url = opts.leagueSlug ? `https://drumcorps.app/fantasy/${opts.leagueSlug}/draft` : '';
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//drumcorps.app//Fantasy Draft//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.leagueId}-draft@drumcorps.app`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(`Your fantasy drum corps draft.${url ? ` Join here: ${url}` : ''}`)}`,
    ...(url ? [`URL:${url}`] : []),
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Fantasy draft starts soon',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = 'fantasy-draft.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

// A short, drum-corps-centric list; the user's actual zone is always added on top.
const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Australia/Sydney',
  'UTC',
];

const detectTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * Per-member notification preferences for one league (P1 notification matrix).
 * Lets a member mute their own email/push for this league without affecting
 * anyone else. Email is additionally gated by the account-wide contact opt-in
 * (the first-sign-in consent) — noted here so a muted-globally member understands
 * why this toggle alone won't start emails.
 */
export function NotificationPrefs({
  leagueId,
  initialEmail,
  initialPush,
  draftScheduledAt = null,
  leagueName,
  leagueSlug,
}: {
  leagueId: string;
  initialEmail: boolean;
  initialPush: boolean;
  /** The scheduled draft time (ISO), if the owner has set one — enables "Add to calendar". */
  draftScheduledAt?: string | null;
  leagueName?: string;
  leagueSlug?: string;
}) {
  const [prefs, setPrefs] = useState({ email: initialEmail, push: initialPush });
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const supported = pushSupported();

  // Reflect this device's *actual* subscription state (the server pref can be on
  // while this particular device has never subscribed, and vice versa).
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription() ?? null)
      .then((sub) => {
        if (!cancelled) setPrefs((p) => ({ ...p, push: !!sub }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Toggling push both subscribes/unsubscribes THIS device and sets the league pref.
  const togglePush = async (want: boolean) => {
    setPushError(null);
    setPushBusy(true);
    const prev = prefs.push;
    setPrefs((p) => ({ ...p, push: want })); // optimistic
    try {
      if (want) await subscribeDevice();
      else await unsubscribeDevice();
      await setMemberNotifyPrefs({ data: { leagueId, email: prefs.email, push: want } });
      track('push_alerts_toggle', { on: want });
    } catch (e) {
      setPrefs((p) => ({ ...p, push: prev })); // revert
      setPushError((e as Error).message);
    } finally {
      setPushBusy(false);
    }
  };

  const { data: session } = useSession();
  const savedTz = (session?.user as { timeZone?: string | null } | undefined)?.timeZone ?? null;
  const [tz, setTz] = useState(savedTz ?? detectTimeZone());

  // Auto-detect default: if the account has no time zone yet, save the browser's once.
  useEffect(() => {
    if (session?.user && !savedTz) {
      const detected = detectTimeZone();
      setTz(detected);
      void setTimeZone({ data: { timeZone: detected } }).catch(() => {});
    }
  }, [session?.user, savedTz]);

  const saveTz = async (next: string) => {
    setTz(next); // optimistic
    setError(null);
    try {
      await setTimeZone({ data: { timeZone: next } });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tzOptions = [tz, ...COMMON_TIMEZONES.filter((z) => z !== tz)];

  const update = async (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic
    setError(null);
    try {
      await setMemberNotifyPrefs({ data: { leagueId, email: next.email, push: next.push } });
    } catch (e) {
      setPrefs(prefs); // revert
      setError((e as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Choose how this league reaches you.
        </p>
        <label className="flex items-start gap-2">
          <Checkbox
            checked={prefs.email}
            onCheckedChange={(v) => void update({ email: !!v })}
            className="mt-0.5"
          />
          <span className="text-sm">
            Email me about drafts, reminders, and standings
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Requires the account-wide “email me” opt-in (set when you first signed in).
            </span>
          </span>
        </label>
        {supported ? (
          <label className="flex items-start gap-2">
            <Checkbox
              checked={prefs.push}
              disabled={pushBusy}
              onCheckedChange={(v) => void togglePush(!!v)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Enable draft alerts on this device{pushBusy ? '…' : ''}
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Push notifications for live draft updates — when the draft starts, when
                you’re on deck, and when you’re on the clock.
              </span>
              {pushError ? (
                <span className="mt-0.5 block text-xs text-destructive">{pushError}</span>
              ) : null}
            </span>
          </label>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tz">Time zone</Label>
          <select
            id="tz"
            value={tz}
            onChange={(e) => void saveTz(e.target.value)}
            className="h-9 w-fit max-w-full rounded-lg border border-border bg-background px-2 text-sm"
          >
            {tzOptions.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            Auto-detected. Draft times in your emails and reminders use this zone.
          </span>
        </div>
        {draftScheduledAt ? (
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                track('draft_calendar_download');
                downloadDraftIcs({
                  leagueId,
                  startsAtIso: draftScheduledAt,
                  leagueName,
                  leagueSlug,
                });
              }}
            >
              Add draft to calendar
            </Button>
            <span className="text-xs text-muted-foreground">
              Downloads a calendar invite for the scheduled draft (Apple, Google, Outlook), with a
              15-minute reminder.
            </span>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
