import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { BusyButton } from '@/components/fantasy/busy-button';
import { formatDraftDateTime, shortZoneCode } from '@/lib/fantasy/format-time';

/** ISO → the `YYYY-MM-DDTHH:mm` a <input type="datetime-local"> expects, in local time. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const [when, setWhen] = useState(() => toLocalInputValue(scheduledAt));
  const [autoStart, setAutoStart] = useState(savedAutoStart);

  // Keep the fields in sync with the persisted settings so both places this
  // component renders (league home + draft page) always show the current saved
  // time/auto-start — e.g. after scheduling on one page and returning to the other.
  useEffect(() => {
    setWhen(toLocalInputValue(scheduledAt));
  }, [scheduledAt]);
  useEffect(() => {
    setAutoStart(savedAutoStart);
  }, [savedAutoStart]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The <strong>draft</strong> is where everyone takes turns picking real drum corps for their
        lineup, one caption at a time. Set a time below and all members get reminders before it
        begins.
      </p>
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
      {/* Primary action at the bottom of the section. */}
      <BusyButton
        busy={scheduling}
        disabled={!when}
        onClick={() => onSchedule(new Date(when).toISOString(), autoStart)}
        className="w-full sm:w-auto"
      >
        {scheduledAt ? 'Reschedule draft' : 'Schedule draft'}
      </BusyButton>
    </div>
  );
}
