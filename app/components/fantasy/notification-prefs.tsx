import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useSession } from '@/lib/auth-client';
import { setMemberNotifyPrefs } from '@/lib/server-fns/fantasy';
import { setTimeZone } from '@/lib/server-fns/consent';

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
}: {
  leagueId: string;
  initialEmail: boolean;
  initialPush: boolean;
}) {
  const [prefs, setPrefs] = useState({ email: initialEmail, push: initialPush });
  const [error, setError] = useState<string | null>(null);

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
        <label className="flex items-start gap-2">
          <Checkbox
            checked={prefs.push}
            onCheckedChange={(v) => void update({ push: !!v })}
            className="mt-0.5"
          />
          <span className="text-sm">
            Push notifications for live draft updates (on the clock, on deck, picks)
          </span>
        </label>
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
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
