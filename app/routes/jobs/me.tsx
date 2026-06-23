import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Match } from 'effect';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { jobsProfileMachine } from '@/machines/jobs-profile-machine';
import { jobsClaimMachine } from '@/machines/jobs-claim-machine';
import { getMyJobsProfile } from '@/lib/server-fns/jobs';
import {
  UserMultipleIcon,
  CheckmarkCircle02Icon,
  AddCircleIcon,
  Search01Icon,
} from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/me')({
  head: () =>
    buildSeo({
      title: 'My Profile — PageantryJobs',
      description: 'Manage your PageantryJobs profile.',
      path: '/jobs/me',
      noindex: true,
    }),
  loader: async () => getMyJobsProfile(),
  component: MePage,
});

function MePage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();
  const [snapshot, send] = useMachine(jobsProfileMachine, {
    input: {
      displayName: initial?.profile.display_name ?? '',
      headline: initial?.profile.headline ?? '',
      location: initial?.profile.location ?? '',
      kind: (initial?.profile.kind as 'employee' | 'employer') ?? 'employee',
      profileId: initial?.profile.profile_id ?? null,
      slug: initial?.profile.slug ?? null,
      status: initial?.profile.status ?? 'draft',
    },
  });

  const ctx = snapshot.context;
  const isSaving = snapshot.matches('saving');
  const isSaved = snapshot.matches('saved');
  const isPublishing = snapshot.matches('publishing');
  const isPublished = snapshot.matches('published');

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="My Profile" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={UserMultipleIcon} size="xl" className="text-text-muted" />
            <p className="text-text-secondary">Sign in to create your profile.</p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title="My Profile" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

      <div className="space-y-6">
        {/* Profile details */}
        <Card>
          <CardContent className="space-y-4 py-5">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Icon icon={UserMultipleIcon} size="sm" />
              Profile Details
            </h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-primary">Display Name</label>
                <input
                  value={ctx.displayName}
                  onChange={(e) => send({ type: 'SET_DISPLAY_NAME', value: e.target.value })}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-primary">Profile Type</label>
                <select
                  value={ctx.kind}
                  onChange={(e) =>
                    send({ type: 'SET_KIND', value: e.target.value as 'employee' | 'employer' })
                  }
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                >
                  <option value="employee">Employee — looking for work</option>
                  <option value="employer">Employer — hiring</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-primary">Headline</label>
                <input
                  value={ctx.headline}
                  onChange={(e) => send({ type: 'SET_HEADLINE', value: e.target.value })}
                  placeholder="e.g. Brass Caption Head | Instructor"
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-text-primary">Location</label>
                <input
                  value={ctx.location}
                  onChange={(e) => send({ type: 'SET_LOCATION', value: e.target.value })}
                  placeholder="City, State"
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={() => send({ type: 'SAVE' })} disabled={isSaving} size="sm">
                {isSaving ? 'Saving…' : 'Save profile'}
              </Button>
              {isSaved ? (
                <Badge variant="success-light" size="sm">
                  <Icon icon={CheckmarkCircle02Icon} size="xs" /> Saved
                </Badge>
              ) : null}
              {snapshot.matches('idle') && ctx.error ? (
                <p className="text-sm text-destructive">{ctx.error}</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Claim your page */}
        {ctx.profileId && initial?.profile.user_id ? (
          <ClaimSection profileId={ctx.profileId} userId={initial.profile.user_id} />
        ) : null}

        {/* Blocks summary (placeholder — full editor in M2.6) */}
        {initial?.blocks && initial.blocks.length > 0 ? (
          <div className="space-y-4">
            {initial.blocks.map((block) => (
              <Card key={block.kind}>
                <CardContent className="py-4">
                  <h3 className="mb-2 text-sm font-semibold capitalize text-text-secondary">
                    {block.kind}
                  </h3>
                  <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-xs text-text-secondary">
                    {JSON.stringify(JSON.parse(block.content_json), null, 2)}
                  </pre>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : ctx.profileId ? (
          <Card className="border-2 border-dashed border-foreground/15">
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <Icon icon={AddCircleIcon} size="lg" className="text-text-muted" />
              <p className="text-sm text-text-secondary">
                Add sections to your profile (coming in the onboarding wizard).
              </p>
            </CardContent>
          </Card>
        ) : null}

        {/* Publish */}
        {ctx.profileId && ctx.status !== 'published' && !isPublished ? (
          <Card className="border-2 border-dashed border-foreground/15">
            <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
              <Icon icon={AddCircleIcon} size="lg" className="text-text-muted" />
              <p className="text-sm text-text-secondary">
                Ready to show your profile to employers?
              </p>
              <Button
                onClick={() => send({ type: 'PUBLISH' })}
                disabled={isPublishing || isPublished}
                size="sm"
              >
                {isPublishing ? 'Publishing…' : isPublished ? 'Published!' : 'Publish profile'}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {isPublished ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-5">
              <Icon icon={CheckmarkCircle02Icon} size="lg" className="text-success" />
              <div>
                <p className="font-medium text-text-primary">Profile published!</p>
                {ctx.slug ? (
                  <a
                    href={`/jobs/profile/${ctx.slug}`}
                    className="text-sm text-primary underline hover:no-underline"
                  >
                    View your public profile
                  </a>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </PageShell>
  );
}

function ClaimSection({ profileId, userId }: { profileId: string; userId: string }) {
  const [snapshot, send] = useMachine(jobsClaimMachine, {
    input: { initialClaims: [], userName: userId },
  });
  const { candidates, claims, search, claimingId, error } = snapshot.context;

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Icon icon={Search01Icon} size="sm" />
          Claim Your Page
        </h2>
        <p className="text-sm text-text-secondary">
          Claim your staff or judge page to auto-fill your profile from existing data.
        </p>

        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => send({ type: 'SEARCH', search: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && send({ type: 'SEARCH', search })}
            placeholder="Search your name…"
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
          <Button
            onClick={() => send({ type: 'SEARCH', search })}
            disabled={snapshot.matches('searching') || search.trim().length < 2}
            variant="outline"
            size="sm"
          >
            Search
          </Button>
        </div>

        {Match.value(snapshot).pipe(
          Match.when(
            { matches: (s: typeof snapshot) => s.matches('searching') || s.matches('suggesting') },
            () => <p className="text-sm text-text-muted">Searching…</p>
          ),
          Match.when({ matches: (s: typeof snapshot) => candidates.length > 0 }, () => (
            <div className="grid gap-3 sm:grid-cols-2">
              {candidates.map((c) => (
                <Card key={`${c.entityType}:${c.entityId}`} className="border-border">
                  <CardContent className="flex items-center gap-3 py-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {c.displayName.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {c.displayName}
                      </p>
                      <p className="truncate text-xs text-text-muted capitalize">
                        {c.entityType} — {c.description}
                      </p>
                    </div>
                    {claims.some(
                      (cl) =>
                        cl.entity_type === c.entityType &&
                        cl.entity_id === c.entityId &&
                        cl.status === 'active'
                    ) ? (
                      <Badge variant="success-light" size="sm">
                        Claimed
                      </Badge>
                    ) : (
                      <Button
                        onClick={() =>
                          send({ type: 'CLAIM', entityType: c.entityType, entityId: c.entityId })
                        }
                        disabled={snapshot.matches('claiming')}
                        variant="outline"
                        size="xs"
                      >
                        {claimingId === `${c.entityType}:${c.entityId}` ? '…' : 'Claim'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )),
          Match.when(
            { matches: (s: typeof snapshot) => search.trim().length >= 2 && s.matches('idle') },
            () => <p className="text-sm text-text-muted">No matches found. Try a different name.</p>
          ),
          Match.orElse(() => null)
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {claims.length > 0 ? (
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-medium text-text-secondary">Claimed pages</p>
            {claims.map((c) => (
              <p key={c.claim_id} className="mt-1 text-sm text-text-primary">
                {c.entity_type}/{c.entity_id}
                <Badge
                  variant={c.status === 'active' ? 'success-light' : 'secondary-light'}
                  size="sm"
                  className="ml-2"
                >
                  {c.status}
                </Badge>
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
