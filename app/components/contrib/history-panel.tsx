import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import {
  getShowHistory,
  reconcileShowDivergence,
  revertRevision,
  type HistoryEntry,
} from '@/lib/server-fns/contrib';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { Clock01Icon, RefreshIcon, RestoreBinIcon } from '@/components/icons/generated';

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
  initial: HistoryEntry[];
}) {
  const { data: session } = useSession();
  const [entries, setEntries] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);
  const signedIn = Boolean(session?.user);
  const role = (session?.user as { role?: string } | undefined)?.role ?? 'user';
  const canReconcile = role === 'moderator' || role === 'admin';

  const refresh = async () => setEntries(await getShowHistory({ data: { corpsKey, season } }));
  const reconcile = async () => {
    setBusy('reconcile');
    setReconcileMessage(null);
    try {
      const res = await reconcileShowDivergence({ data: { corpsKey, season } });
      setReconcileMessage(
        res.status === 'reconciled'
          ? `${res.changed} flags updated; ${res.diverged} overridden rows differ from the current scrape.`
          : res.status === 'missing-page'
            ? 'No contribution page exists yet.'
            : 'No scraped show data was found.'
      );
    } catch (e) {
      setReconcileMessage(e instanceof Error ? e.message : 'Could not check scraped changes');
    } finally {
      setBusy(null);
    }
  };
  const revert = async (revisionId: string) => {
    setBusy(revisionId);
    try {
      await revertRevision({ data: { revisionId } });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          <Icon icon={Clock01Icon} size="sm" />
          Edit history
        </h2>
        {canReconcile ? (
          <button
            type="button"
            onClick={() => void reconcile()}
            disabled={busy === 'reconcile'}
            className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:border-primary/60 hover:text-foreground disabled:opacity-50"
          >
            <Icon icon={RefreshIcon} size="sm" />
            Check scraped changes
          </button>
        ) : null}
        {reconcileMessage ? (
          <p className="mb-3 rounded-md bg-foreground/5 px-2 py-1.5 text-xs text-text-secondary">
            {reconcileMessage}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="text-sm text-text-secondary">No edits yet — be the first to contribute.</p>
        ) : (
          <ol className="space-y-3">
            {groupBySession(entries).map((group, gi) => (
              <li key={gi} className="border-b border-foreground/10 pb-3 last:border-0 last:pb-0">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {group[0].authorName || 'A contributor'}
                  </span>
                  <span className="text-xs text-text-secondary">{rel(group[0].createdAt)}</span>
                </div>
                <ul className="space-y-1.5">
                  {group.map((e) => (
                    <li key={e.revisionId} className="text-sm text-text-secondary">
                      <div className="flex items-start justify-between gap-2">
                        <span>
                          <span className="text-text-primary">{opLabel(e.op)}</span>{' '}
                          {targetLabel(e)}
                        </span>
                        {signedIn && e.targetKind === 'block' && e.beforeJson != null ? (
                          <button
                            type="button"
                            onClick={() => revert(e.revisionId)}
                            disabled={busy === e.revisionId}
                            title="Revert to the version before this edit"
                            className="shrink-0 text-text-secondary hover:text-foreground disabled:opacity-50"
                          >
                            <Icon icon={RestoreBinIcon} size="sm" />
                          </button>
                        ) : null}
                      </div>
                      <Diff before={e.beforeJson} after={e.afterJson} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// Compact before→after for the structured block JSON (v1: plain-ish text diff).
function Diff({ before, after }: { before: string | null; after: string | null }) {
  if (before == null && after == null) return null;
  const b = summarize(before);
  const a = summarize(after);
  if (b === a) return null;
  return (
    <details className="mt-0.5 text-xs">
      <summary className="cursor-pointer text-text-secondary/70">changes</summary>
      {before != null ? <p className="text-red-500/80">− {b}</p> : null}
      {after != null ? <p className="text-green-600/80">+ {a}</p> : null}
    </details>
  );
}

const summarize = (json: string | null): string => {
  if (json == null) return '(empty)';
  try {
    const v = JSON.parse(json);
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  } catch {
    return json.slice(0, 160);
  }
};

const opLabel = (op: string): string =>
  ({
    create: 'created',
    edit: 'edited',
    revert: 'reverted',
    add: 'added',
    hide: 'removed',
    restore: 'restored',
    reorder: 'reordered',
    steward: 'started stewarding',
    unsteward: 'stopped stewarding',
    lock: 'changed lock for',
  })[op] ?? op;

const targetLabel = (e: HistoryEntry): string => {
  if (e.summary) return e.summary;
  if (e.targetKind === 'page') return 'the page';
  return e.targetKind;
};

const rel = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Group consecutive revisions by the same author within a 30-minute window.
export function groupBySession(entries: HistoryEntry[]): HistoryEntry[][] {
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
