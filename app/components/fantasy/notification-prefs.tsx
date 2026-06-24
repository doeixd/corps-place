import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { setMemberNotifyPrefs } from '@/lib/server-fns/fantasy';

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
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
