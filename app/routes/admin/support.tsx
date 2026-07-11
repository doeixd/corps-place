// Support inbox (ADMIN_PAGE_PLAN §10.3). Triage /contact submissions, reply by email
// (logged), deep-link to the sender. Data fetched in the loader; refresh via invalidate.
import { useState } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/fantasy/busy-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAsyncAction } from '@/lib/use-async-action';
import {
  listContactMessages,
  listContactThread,
  setContactStatus,
  replyContact,
  type ContactRow,
  type ThreadTurn,
} from '@/lib/server-fns/support';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/support')({
  loader: adminLoader('customerSupport', () =>
    listContactMessages({ data: { status: 'open', limit: 100 } })
  ),
  head: () =>
    seoHead({ title: 'Admin — Support', description: 'Support inbox', path: '/admin/support' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => <Support rows={data ?? []} />}</AdminPage>;
  },
});

function Support({ rows }: { rows: ContactRow[] }) {
  const router = useRouter();
  const [reply, setReply] = useState<{ id: string; subject: string; body: string } | null>(null);
  // Which message's conversation thread is open, and its turns (fetched on demand).
  const [thread, setThread] = useState<{ id: string; turns: ThreadTurn[] } | null>(null);
  const viewThread = useAsyncAction(async (id: string) => {
    if (thread?.id === id) return setThread(null); // toggle closed
    setThread({ id, turns: await listContactThread({ data: { messageId: id } }) });
  });

  const send = useAsyncAction(async () => {
    if (!reply) return;
    await replyContact({ data: { messageId: reply.id, subject: reply.subject, body: reply.body } });
    setReply(null);
    setThread(null);
    await router.invalidate();
  });
  const close = useAsyncAction(async (id: string) => {
    await setContactStatus({ data: { messageId: id, status: 'closed' } });
    await router.invalidate();
  });

  return (
    <>
      <PageHeader title="Support" subtitle="Open contact messages" />
      <Show when={send.error || close.error}>
        <p className="mb-4 text-sm text-destructive">{send.error ?? close.error}</p>
      </Show>
      <Show
        when={rows.length > 0}
        fallback={<p className="text-sm text-text-secondary">Inbox zero. 🎉</p>}
      >
        <div className="flex flex-col gap-3">
          <For each={rows}>
            {(m) => (
              <Card>
                <CardContent className="flex flex-col gap-2 pt-6 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium">{m.subject || '(no subject)'}</span>
                    <span className="text-text-secondary">{m.email}</span>
                    <Show when={m.userId}>
                      <Link
                        to="/admin/users/$id"
                        params={{ id: m.userId! }}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        view user
                      </Link>
                    </Show>
                    <Show when={m.inboundReplies > 0}>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {m.inboundReplies === 1 ? 'Replied' : `${m.inboundReplies} replies`}
                      </span>
                    </Show>
                    <span className="ml-auto text-xs text-text-secondary tabular-nums">
                      {new Date(m.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-text-secondary">{m.body}</p>

                  {/* Conversation thread — admin replies + the sender's responses. */}
                  <Show when={thread?.id === m.messageId}>
                    <div className="flex flex-col gap-2 border-t border-border pt-2">
                      <For each={thread?.turns ?? []}>
                        {(t) => (
                          <div
                            className={
                              'rounded-md border px-3 py-2 ' +
                              (t.direction === 'inbound'
                                ? 'border-primary/30 bg-primary/5'
                                : 'border-border bg-muted/40')
                            }
                          >
                            <div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs text-text-secondary">
                              <span className="font-medium">
                                {t.direction === 'inbound' ? `${m.email} (them)` : 'You'}
                              </span>
                              <span className="tabular-nums">
                                {new Date(t.createdAt).toLocaleString()}
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap text-sm text-text-primary">{t.body}</p>
                          </div>
                        )}
                      </For>
                      <Show when={(thread?.turns.length ?? 0) === 0}>
                        <p className="text-xs text-text-secondary">No replies yet.</p>
                      </Show>
                    </div>
                  </Show>

                  <Show
                    when={reply?.id === m.messageId}
                    fallback={
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
                        <BusyButton
                          size="sm"
                          variant="ghost"
                          busy={viewThread.busy}
                          onClick={() => void viewThread.run(m.messageId)}
                        >
                          {thread?.id === m.messageId ? 'Hide conversation' : 'View conversation'}
                        </BusyButton>
                        <BusyButton
                          size="sm"
                          variant="ghost"
                          busy={close.busy}
                          onClick={() => void close.run(m.messageId)}
                        >
                          Close
                        </BusyButton>
                      </div>
                    }
                  >
                    <div className="flex flex-col gap-2 border-t border-border pt-2">
                      <Input
                        placeholder="Reply subject"
                        value={reply?.subject ?? ''}
                        onChange={(e) =>
                          setReply((r) => (r ? { ...r, subject: e.target.value } : r))
                        }
                      />
                      <Textarea
                        rows={4}
                        placeholder="Reply…"
                        value={reply?.body ?? ''}
                        onChange={(e) => setReply((r) => (r ? { ...r, body: e.target.value } : r))}
                      />
                      <div className="flex gap-2">
                        <BusyButton size="sm" busy={send.busy} onClick={() => void send.run()}>
                          Send reply
                        </BusyButton>
                        <Button size="sm" variant="ghost" onClick={() => setReply(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </Show>
                </CardContent>
              </Card>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
