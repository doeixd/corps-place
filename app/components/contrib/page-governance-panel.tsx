import { useState } from 'react';
import { For, Show } from 'jotai-solid-api';
import { useSession } from '@/lib/auth-client';
import {
  setShowLockLevel,
  setShowSteward,
  setShowOrphaned,
  type ShowGovernance,
} from '@/lib/server-fns/contrib';
import type { ShowPageLock } from '@/lib/contrib/store';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from '@/components/icon';
import { CheckmarkCircle02Icon, UserGroupIcon } from '@/components/icons/generated';

const LOCK_LABELS: Record<ShowPageLock, string> = {
  none: 'Open editing',
  trusted: 'Trusted editors',
  mod: 'Moderators only',
};

export function PageGovernancePanel({
  corpsKey,
  season,
  initial,
}: {
  corpsKey: string;
  season: string;
  initial: ShowGovernance;
}) {
  const { data: session } = useSession();
  const [governance, setGovernance] = useState(initial);
  const [busy, setBusy] = useState<'steward' | 'lock' | 'orphan' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(session?.user) || governance.signedIn;

  const runAction = async (
    kind: 'steward' | 'lock' | 'orphan',
    fn: () => Promise<ShowGovernance>,
    fallback: string
  ) => {
    setBusy(kind);
    setError(null);
    try {
      setGovernance(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(null);
    }
  };

  const toggleOrphan = () =>
    runAction(
      'orphan',
      () =>
        setShowOrphaned({
          data: { corpsKey, season, orphaned: governance.status !== 'orphaned' },
        }),
      'Could not update page status'
    );

  const toggleSteward = () =>
    runAction(
      'steward',
      () => setShowSteward({ data: { corpsKey, season, steward: !governance.mySteward } }),
      'Could not update stewardship'
    );

  const changeLock = (lockLevel: ShowPageLock) => {
    if (lockLevel === governance.lockLevel) return;
    return runAction(
      'lock',
      () => setShowLockLevel({ data: { corpsKey, season, lockLevel } }),
      'Could not update page lock'
    );
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          <Icon icon={UserGroupIcon} size="sm" />
          Stewardship
        </h2>

        <div className="space-y-1">
          <p className="text-2xl font-semibold tabular-nums text-text-primary">
            {governance.stewardCount}
          </p>
          <p className="text-sm text-text-secondary">
            {governance.stewardCount === 1 ? 'person watches' : 'people watch'} this page
          </p>
        </div>

        <Show when={governance.stewards.length > 0}>
          <div className="space-y-1 rounded-md bg-foreground/5 px-2.5 py-2">
            <For each={governance.stewards}>
              {(steward) => (
                <p className="truncate text-xs text-text-secondary">
                  {steward.name || 'A contributor'}
                </p>
              )}
            </For>
            <Show when={governance.stewardCount > governance.stewards.length}>
              <p className="text-xs text-text-secondary">
                +{governance.stewardCount - governance.stewards.length} more
              </p>
            </Show>
          </div>
        </Show>

        <Button
          type="button"
          variant={governance.mySteward ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => void toggleSteward()}
          disabled={!signedIn || busy === 'steward'}
          className="w-full"
        >
          <Icon icon={CheckmarkCircle02Icon} size="sm" />
          {governance.mySteward ? 'Stewarding' : 'Steward this page'}
        </Button>

        <div className="border-t border-foreground/10 pt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-text-primary">Edit access</span>
            <span className="text-xs text-text-secondary">{LOCK_LABELS[governance.lockLevel]}</span>
          </div>

          {governance.canLock ? (
            <Select
              value={governance.lockLevel}
              onValueChange={(value) => {
                const lockLevel = (value ?? 'none') as ShowPageLock;
                void changeLock(lockLevel);
              }}
              disabled={busy === 'lock'}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Open editing</SelectItem>
                <SelectItem value="trusted">Trusted editors</SelectItem>
                <SelectItem value="mod">Moderators only</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-text-secondary">
              Moderators can raise or clear page locks when a show needs protection.
            </p>
          )}
        </div>

        <Show when={governance.canModerate}>
          <div className="border-t border-foreground/10 pt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-primary">Page status</span>
              <span className="text-xs text-text-secondary">
                {governance.status === 'orphaned' ? 'Orphaned' : 'Active'}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void toggleOrphan()}
              disabled={busy === 'orphan'}
              className="w-full"
            >
              {governance.status === 'orphaned' ? 'Restore page' : 'Mark orphaned'}
            </Button>
          </div>
        </Show>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
