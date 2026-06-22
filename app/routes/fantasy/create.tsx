import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { createLeague } from '@/lib/server-fns/fantasy';
import { useSession } from '@/lib/auth-client';
import { useAsyncAction } from '@/lib/use-async-action';
import { SignInButton } from '@/components/fantasy/sign-in-button';

const CURRENT_SEASON = String(new Date().getFullYear());

export const Route = createFileRoute('/fantasy/create')({
  beforeLoad: requireFantasyEnabled,
  head: () =>
    seoHead({
      title: 'Create a Fantasy League',
      description: 'Start a private fantasy drum corps league.',
      path: '/fantasy/create',
    }),
  component: CreateLeague,
});

function CreateLeague() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [name, setName] = useState('');
  const [season, setSeason] = useState(CURRENT_SEASON);

  const create = useAsyncAction(async () => {
    const res = await createLeague({ data: { name: name.trim(), season } });
    await navigate({ to: '/fantasy/$slug', params: { slug: res.slug } });
  });

  if (!session?.user) {
    return (
      <PageShell className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Create a league</h1>
        <p className="text-muted-foreground">Sign in to create a league.</p>
        <SignInButton className="self-start" callbackURL="/fantasy/create" />
      </PageShell>
    );
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Create a league</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create.run();
        }}
        className="flex max-w-md flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">League name</Label>
          <Input
            id="name"
            value={name}
            maxLength={60}
            required
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lot Talk Legends"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="season">Season</Label>
          <Input
            id="season"
            value={season}
            pattern="\d{4}"
            required
            onChange={(e) => setSeason(e.target.value)}
          />
        </div>
        {create.error ? <p className="text-sm text-destructive">{create.error}</p> : null}
        <Button type="submit" disabled={create.busy || name.trim().length === 0}>
          {create.busy ? 'Creating…' : 'Create league'}
        </Button>
      </form>
    </PageShell>
  );
}
