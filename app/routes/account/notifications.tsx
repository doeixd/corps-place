import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import {
  listMyScoreSubscriptions,
  updateMyScoreSubscription,
  removeMyScoreSubscription,
  type MyScoreSubscription,
} from '@/lib/server-fns/account';
import { AccountShell, AccountSignedOut } from '@/components/account/account-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/reui/badge';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/account/notifications')({
  loader: async () => listMyScoreSubscriptions(),
  staleTime: 0,
  head: () =>
    buildSeo({
      title: 'Your notifications',
      description: 'Score alert subscriptions for events and corps.',
      path: '/account/notifications',
      noindex: true,
    }),
  component: AccountNotifications,
});

function SubscriptionRow({ sub }: { sub: MyScoreSubscription }) {
  const router = useRouter();
  const [email, setEmail] = useState(sub.email);
  const [push, setPush] = useState(sub.push);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (removed) return null;

  const save = async (nextEmail: boolean, nextPush: boolean) => {
    setBusy(true);
    try {
      await updateMyScoreSubscription({ data: { id: sub.id, email: nextEmail, push: nextPush } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{sub.targetLabel ?? sub.targetSlug}</span>
            <Badge variant="outline" radius="full">
              {sub.targetKind === 'corps' ? 'Corps' : 'Event'}
            </Badge>
          </div>
          <div className="text-xs text-text-muted">
            Since{' '}
            {new Date(sub.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={email}
              disabled={busy}
              onCheckedChange={(v) => {
                const next = v === true;
                setEmail(next);
                void save(next, push);
              }}
            />
            Email
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={push}
              disabled={busy}
              onCheckedChange={(v) => {
                const next = v === true;
                setPush(next);
                void save(email, next);
              }}
            />
            Push
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await removeMyScoreSubscription({ data: { id: sub.id } });
                setRemoved(true);
                void router.invalidate();
              } finally {
                setBusy(false);
              }
            }}
          >
            Unsubscribe
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountNotifications() {
  const { signedIn, subscriptions } = Route.useLoaderData();

  if (!signedIn) {
    return (
      <AccountShell>
        <AccountSignedOut callbackURL="/account/notifications" />
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Score alerts</h2>
          <p className="text-sm text-text-secondary">
            You&rsquo;re notified as soon as scores publish for these. Subscribe from any corps,
            event or show page via the bell button.
          </p>
        </div>
        {subscriptions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-text-secondary">
              No subscriptions yet — open any{' '}
              <Link to="/scores" className="text-primary hover:underline">
                scores page
              </Link>{' '}
              or corps page and tap &ldquo;Notify me&rdquo;.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {subscriptions.map((s) => (
              <SubscriptionRow key={s.id} sub={s} />
            ))}
          </div>
        )}
        <p className="text-xs text-text-muted">
          Push notifications also require enabling them on each device (the bell button offers it
          when subscribing).
        </p>
      </div>
    </AccountShell>
  );
}
