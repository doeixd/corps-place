import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { BusyButton } from '@/components/fantasy/busy-button';
import { formatDraftDateTime, shortZoneCode } from '@/lib/fantasy/format-time';

/**
 * The draft-time scheduling fields, shared by the draft room and the league settings
 * page so the setting stays in sync — both read the server's scheduled time + auto-start
 * and persist through `scheduleDraft`. This component owns only the local inputs; the
 * caller wires `onSchedule` to its own mutation (the draft-room machine, or a direct
 * server-fn call from settings).
 */
export function DraftScheduleFields({
  scheduledAt,
  savedAutoStart,
  scheduling,
  onSchedule,
}: {
  scheduledAt: string | null;
  savedAutoStart: boolean;
  scheduling: boolean;
  onSchedule: (scheduledAtIso: string, autoStart: boolean) => void;
}) {
  const [when, setWhen] = useState('');
  const [autoStart, setAutoStart] = useState(savedAutoStart);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The <strong>draft</strong> is where everyone takes turns picking real drum corps for their
        lineup, one caption at a time. Set a time below and all members get reminders before it
        begins.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="draft-time">Draft time ({shortZoneCode()})</Label>
          <p className="max-w-xs text-xs text-muted-foreground">
            When the draft should happen. With <strong>Start automatically</strong> on (below), the
            room opens by itself at this time. Otherwise, you open it yourself — and{' '}
            <strong>Start draft now</strong> begins the draft <em>immediately</em>, whenever you
            click it (you can start early, or with no time set at all).
          </p>
          <Input
            id="draft-time"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="w-auto"
          />
        </div>
        <BusyButton
          variant="outline"
          busy={scheduling}
          disabled={!when}
          onClick={() => onSchedule(new Date(when).toISOString(), autoStart)}
        >
          {scheduledAt ? 'Reschedule' : 'Schedule'}
        </BusyButton>
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={autoStart}
          onCheckedChange={(v) => setAutoStart(!!v)}
          className="mt-0.5"
        />
        <span className="text-sm">
          Start the draft automatically at the scheduled time
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Off — you&apos;ll start it yourself with “Start draft now”. Either way, everyone gets
            reminders before it begins.
          </span>
        </span>
      </label>
      {scheduledAt ? (
        <p className="text-sm text-muted-foreground">
          Scheduled for {formatDraftDateTime(scheduledAt)} —{' '}
          {savedAutoStart ? 'starts automatically.' : 'you’ll start it manually.'}
        </p>
      ) : null}
    </div>
  );
}
