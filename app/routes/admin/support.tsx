// Support inbox (ADMIN_PAGE_PLAN §10.3). Triage /contact submissions, reply by email
// (logged), and deep-link to the sender's user detail. Cap: customerSupport.
import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { requireAdminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  listContactMessages,
  setContactStatus,
  replyContact,
  type ContactRow,
} from '@/lib/server-fns/support';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/support')({
  loader: requireAdminLoader('customerSupport'),
  head: () =>
    seoHead({ title: 'Admin — Support', description: 'Support inbox', path: '/admin/support' }),
  component: () => {
    const gate = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Support />}</AdminPage>;
  },
});

function Support() {
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<{ id: string; subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    listContactMessages({ data: { status: 'open', limit: 100 } })
      .then(setRows)
      .catch((e: unknown) => setError((e as Error).message));
  }, []);
  useEffect(() => reload(), [reload]);

  const sendReply = async () => {
    if (!reply) return;
    setBusy(true);
    setError(null);
    try {
      await replyContact({
        data: { messageId: reply.id, subject: reply.subject, body: reply.body },
      });
      setReply(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = (id: string) =>
    setContactStatus({ data: { messageId: id, status: 'closed' } })
      .then(reload)
      .catch((e: unknown) => setError((e as Error).message));

  return (
    <>
      <PageHeader title="Support" subtitle="Open contact messages" />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {!rows ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-secondary">Inbox zero. 🎉</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((m) => (
            <Card key={m.messageId}>
              <CardContent className="flex flex-col gap-2 pt-6 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{m.subject || '(no subject)'}</span>
                  <span className="text-text-secondary">{m.email}</span>
                  {m.userId ? (
                    <Link
                      to="/admin/users/$id"
                      params={{ id: m.userId }}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      view user
                    </Link>
                  ) : null}
                  <span className="ml-auto text-xs text-text-secondary tabular-nums">
                    {new Date(m.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-text-secondary">{m.body}</p>
                {reply?.id === m.messageId ? (
                  <div className="flex flex-col gap-2 border-t border-border pt-2">
                    <Input
                      placeholder="Reply subject"
                      value={reply.subject}
                      onChange={(e) => setReply({ ...reply, subject: e.target.value })}
                    />
                    <Textarea
                      rows={4}
                      placeholder="Reply…"
                      value={reply.body}
                      onChange={(e) => setReply({ ...reply, body: e.target.value })}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void sendReply()}>
                        Send reply
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setReply(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setReply({
                          id: m.messageId,
                          subject: `Re: ${m.subject || 'your message'}`,
                          body: '',
                        })
                      }
                    >
                      Reply
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void close(m.messageId)}>
                      Close
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
