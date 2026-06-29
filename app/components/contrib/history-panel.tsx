import { useEffect, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import {
  getShowHistory,
  revertRevision,
  reconcileShowDivergence,
  type HistoryEntry,
} from '@/lib/server-fns/contrib';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/reui/badge';
import { Icon } from '@/components/icon';
import { Clock01Icon, RestoreBinIcon } from '@/components/icons/generated';
import { StructuredDiff } from '@/components/contrib/structured-diff';

/**
 * Edit-history sidebar (M6): the full, transparent revision log for a show page —
 * the wiki's "anyone can edit, with history" promise made visible. Append-only
 * (I-5); signed-in users can revert a block edit (revert-as-forward-revision).
 */
export function HistoryPanel({
  corpsKey,
  season,
  initial,
}: {
  corpsKey: string;
  season: string;
  /** Optional: when omitted (deferred from the route loader to speed first paint),
   *  the panel fetches its own history on mount. */
  initial?: HistoryEntry[];
}) {
  const { data: session } = useSession();
  const [entries, setEntries] = useState<HistoryEntry[]>(initial ?? []);
  const [loading, setLoading] = useState(initial == null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const signedIn = Boolean(session?.user);
  const role = (session?.user as { role?: string } | undefined)?.role;
  const canReconcile = role === 'moderator' || role === 'admin';

  const refresh = async () => setEntries(await getShowHistory({ data: { corpsKey, season } }));
  // Deferred-load: the show route no longer fetches history in its blocking loader
  // (keeps the initial paint fast). Pull it in after mount when not pre-provided.
  useEffect(() => {
    if (initial == null)
      void refresh()
        .catch(() => {})
        .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpsKey, season]);
  // Re-check overrides against the latest scrape; updates the "source changed" badges.
  const reconcile = async () => {
    setBusy('reconcile');
    setError(null);
    setReconcileMsg(null);
    try {
      const res = await reconcileShowDivergence({ data: { corpsKey, season } });
      setReconcileMsg(
        res.status === 'reconciled'
          ? res.changed > 0
            ? `Checked ${res.checked} rows — ${res.diverged} now differ from the source.`
            : `Checked ${res.checked} rows — all still match the source.`
          : res.status === 'missing-page'
            ? 'No contributions to check yet.'
            : 'No scraped data to compare against.'
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check scraped changes');
    } finally {
      setBusy(null);
    }
  };
  const revert = async (revisionId: string) => {
    setBusy(revisionId);
    setError(null);
    try {
      await revertRevision({ data: { revisionId } });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Icon icon={Clock01Icon} size="sm" />
            Edit history
          </h2>
          {canReconcile ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={reconcile}
              disabled={busy === 'reconcile'}
              title="Re-check fan edits against the latest scraped data"
            >
              {busy === 'reconcile' ? 'Checking…' : 'Check scraped changes'}
            </Button>
          ) : null}
        </div>
        {reconcileMsg ? <p className="mb-3 text-sm text-text-secondary">{reconcileMsg}</p> : null}
        {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
        {loading && entries.length === 0 ? (
          <div className="space-y-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="size-6 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-text-secondary">No edits yet — be the first to contribute.</p>
        ) : (
          <ol className="space-y-4">
            {groupBySession(entries).map((group, gi) => {
              const author = group[0].authorName || 'A contributor';
              return (
                <li key={gi} className="border-b border-foreground/10 pb-4 last:border-0 last:pb-0">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-semibold text-text-secondary"
                      aria-hidden
                    >
                      {initials(author)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {author}
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {rel(group[0].createdAt)}
                    </span>
                  </div>
                  <ul className="space-y-2 pl-8">
                    {group.map((e) => (
                      <li key={e.revisionId} className="text-sm text-text-secondary">
                        <div className="flex items-start justify-between gap-2">
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <Badge variant={opVariant(e.op)} size="sm">
                              {opLabel(e.op)}
                            </Badge>
                            <span className="text-text-primary">{targetLabel(e)}</span>
                          </span>
                          {signedIn && e.targetKind === 'block' && e.beforeJson != null ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => revert(e.revisionId)}
                              disabled={busy === e.revisionId}
                              title="Revert to the version before this edit"
                              aria-label="Revert this edit"
                              className="shrink-0"
                            >
                              <Icon icon={RestoreBinIcon} size="sm" />
                            </Button>
                          ) : null}
                        </div>
                        <StructuredDiff before={e.beforeJson} after={e.afterJson} />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

const opLabel = (op: string): string =>
  ({
    create: 'created',
    edit: 'edited',
    revert: 'reverted',
    add: 'added',
    hide: 'removed',
    restore: 'restored',
    reorder: 'reordered',
  })[op] ?? op;

const OP_VARIANT: Record<string, BadgeProps['variant']> = {
  create: 'success-light',
  add: 'success-light',
  edit: 'info-light',
  revert: 'warning-light',
  restore: 'warning-light',
  reorder: 'secondary',
  hide: 'destructive-light',
};
const opVariant = (op: string): BadgeProps['variant'] => OP_VARIANT[op] ?? 'secondary';

const targetLabel = (e: HistoryEntry): string => {
  if (e.summary) return e.summary;
  if (e.targetKind === 'page') return 'the page';
  return e.targetKind;
};

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

const rel = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Group consecutive revisions by the same author within a 30-minute window.
function groupBySession(entries: HistoryEntry[]): HistoryEntry[][] {
  const groups: HistoryEntry[][] = [];
  const WINDOW = 30 * 60 * 1000;
  for (const e of entries) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (
      g &&
      prev &&
      prev.authorId === e.authorId &&
      new Date(prev.createdAt).getTime() - new Date(e.createdAt).getTime() < WINDOW
    ) {
      g.push(e);
    } else {
      groups.push([e]);
    }
  }
  return groups;
}
