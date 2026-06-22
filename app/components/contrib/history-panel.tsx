import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { getShowHistory, revertRevision, type HistoryEntry } from '@/lib/server-fns/contrib';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/reui/badge';
import { Icon } from '@/components/icon';
import { Clock01Icon, RestoreBinIcon } from '@/components/icons/generated';

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
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(session?.user);

  const refresh = async () => setEntries(await getShowHistory({ data: { corpsKey, season } }));
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
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
          <Icon icon={Clock01Icon} size="sm" />
          Edit history
        </h2>
        {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
        {entries.length === 0 ? (
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
                        <Diff before={e.beforeJson} after={e.afterJson} />
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

// Compact before→after for the structured block JSON (v1: plain-ish text diff).
function Diff({ before, after }: { before: string | null; after: string | null }) {
  if (before == null && after == null) return null;
  const b = summarize(before);
  const a = summarize(after);
  if (b === a) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-text-secondary/70 hover:text-text-secondary">
        view changes
      </summary>
      <div className="mt-1 space-y-0.5 rounded-md bg-muted/50 p-2 font-mono">
        {before != null ? <p className="break-words text-destructive">− {b}</p> : null}
        {after != null ? <p className="break-words text-success-foreground">+ {a}</p> : null}
      </div>
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
