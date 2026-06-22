// Content moderation (ADMIN_PAGE_PLAN §6, M4). The cross-page revisions firehose
// + locked-pages list. Read-only in this slice (revert/hide actions are wired next,
// reusing revertRevision and the §6.3 hidden-column migration). Gated in the loader;
// every server-fn re-checks capability.
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  listRecentRevisions,
  listShowPages,
  type AdminRevisionRow,
  type AdminPageRow,
} from '@/lib/server-fns/admin-content';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/content')({
  loader: requireAdminLoader('viewAdmin'),
  head: () =>
    seoHead({ title: 'Admin — Content', description: 'Moderation', path: '/admin/content' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Content />}</AdminPage>;
  },
});

function Content() {
  const [revisions, setRevisions] = useState<AdminRevisionRow[] | null>(null);
  const [locked, setLocked] = useState<AdminPageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      listRecentRevisions({ data: { limit: 100 } }),
      listShowPages({ data: { lockedOnly: true, limit: 100 } }),
    ])
      .then(([revs, pages]) => {
        if (!alive) return;
        setRevisions(revs);
        setLocked(pages);
      })
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PageHeader title="Content" subtitle="Recent edits across all wiki pages" />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Locked pages {locked ? `(${locked.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!locked ? (
            <p className="text-text-secondary">Loading…</p>
          ) : locked.length === 0 ? (
            <p className="text-text-secondary">No locked pages.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {locked.map((p) => (
                <li key={p.pageId} className="flex justify-between gap-4">
                  <span>
                    {p.corpsKey} · {p.season}
                  </span>
                  <span className="text-text-secondary">{p.lockLevel}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Recent revisions
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!revisions ? (
            <p className="text-text-secondary">Loading…</p>
          ) : revisions.length === 0 ? (
            <p className="text-text-secondary">No revisions yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {revisions.map((r) => (
                <div
                  key={r.revisionId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                >
                  <span className="font-medium">
                    {r.corpsKey ?? '—'} · {r.season ?? '—'}
                  </span>
                  <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-text-secondary">
                    {r.op} {r.targetKind}
                  </span>
                  <span className="text-text-secondary">{r.authorName ?? r.authorId}</span>
                  <span className="ml-auto text-xs text-text-secondary tabular-nums">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                  {r.summary ? (
                    <span className="w-full text-xs text-text-secondary">{r.summary}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
