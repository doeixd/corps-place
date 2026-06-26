import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Match } from 'effect';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { jobsProfileMachine } from '@/machines/jobs-profile-machine';
import { jobsClaimMachine } from '@/machines/jobs-claim-machine';
import {
  getMyJobsProfile,
  getMyApplications,
  getMyBookmarks,
  listMyAlerts,
  deleteJobAlert,
  createJobAlert,
} from '@/lib/server-fns/jobs';
import {
  UserMultipleIcon,
  CheckmarkCircle02Icon,
  AddCircleIcon,
  Search01Icon,
  Briefcase01Icon,
  FireIcon,
  BookOpen01Icon,
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

type Tab = 'profile' | 'applications' | 'bookmarks' | 'alerts';

function MePage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();
  const [tab, setTab] = useState<Tab>('profile');
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

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="My Profile" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={UserMultipleIcon} size="xl" className="text-text-muted" />
            <p className="text-text-secondary">Sign in to manage your profile.</p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const tabs: { key: Tab; label: string; icon: typeof Briefcase01Icon }[] = [
    { key: 'profile', label: 'Profile', icon: UserMultipleIcon },
    { key: 'applications', label: 'Applications', icon: Briefcase01Icon },
    { key: 'bookmarks', label: 'Saved Jobs', icon: BookOpen01Icon },
    { key: 'alerts', label: 'Alerts', icon: FireIcon },
  ];

  return (
    <PageShell>
      <PageHeader title="My Dashboard" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-muted/50 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all ${
              tab === t.key
                ? 'bg-card text-text-primary shadow-xs'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Icon icon={t.icon} size="sm" /> {t.label}
          </button>
        ))}
      </div>

      {Match.value(tab).pipe(
        Match.when('profile', () => (
          <ProfileTab initial={initial} snapshot={snapshot} send={send} />
        )),
        Match.when('applications', () => <ApplicationsTab />),
        Match.when('bookmarks', () => <BookmarksTab />),
        Match.when('alerts', () => <AlertsTab />),
        Match.exhaustive
      )}
    </PageShell>
  );
}

// ── Profile tab ──────────────────────────────────────────────────────────────

function ProfileTab({ initial, snapshot, send }: { initial: any; snapshot: any; send: any }) {
  const ctx = snapshot.context;
  const isSaving = snapshot.matches('saving');
  const isSaved = snapshot.matches('saved');

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-sm font-medium text-text-primary">Display Name</label>
              <input
                value={ctx.displayName}
                onChange={(e) => send({ type: 'SET_DISPLAY_NAME', value: e.target.value })}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Profile Type</label>
              <select
                value={ctx.kind}
                onChange={(e) =>
                  send({ type: 'SET_KIND', value: e.target.value as 'employee' | 'employer' })
                }
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              >
                <option value="employee">Employee</option>
                <option value="employer">Employer</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Headline</label>
              <input
                value={ctx.headline}
                onChange={(e) => send({ type: 'SET_HEADLINE', value: e.target.value })}
                placeholder="e.g. Brass Caption Head"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-sm font-medium text-text-primary">Location</label>
              <input
                value={ctx.location}
                onChange={(e) => send({ type: 'SET_LOCATION', value: e.target.value })}
                placeholder="City, State"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => send({ type: 'SAVE' })} disabled={isSaving} size="sm">
              {isSaving ? 'Saving…' : 'Save'}
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

      {ctx.profileId ? (
        <ClaimSection profileId={ctx.profileId} userId={initial?.profile.user_id ?? ''} />
      ) : null}

      {ctx.profileId && ctx.status !== 'published' ? (
        <Card className="border-2 border-dashed border-foreground/15">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Icon icon={AddCircleIcon} size="lg" className="text-text-muted" />
            <p className="text-sm text-text-secondary">Ready to show your profile to employers?</p>
            <Button onClick={() => send({ type: 'PUBLISH' })} size="sm">
              Publish Profile
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ── Applications tab ─────────────────────────────────────────────────────────

function ApplicationsTab() {
  const [apps, setApps] = useState<any[] | null>(null);
  if (!apps) {
    getMyApplications()
      .then(setApps)
      .catch(() => setApps([]));
    return <LoadingCard />;
  }

  if (apps.length === 0) {
    return (
      <EmptyCard
        icon={Briefcase01Icon}
        title="No applications yet"
        hint="Jobs you apply to will appear here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {apps.map((a: any) => (
        <Link
          key={a.application_id}
          to="/jobs/$jobSlug"
          params={{ jobSlug: a.slug }}
          className="block focus-visible:outline-none"
        >
          <Card className="card-hover">
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-primary">{a.title}</p>
                <p className="text-sm text-text-secondary">
                  {a.employer_name} · {new Date(a.created_at).toLocaleDateString()}
                </p>
              </div>
              <Badge variant="secondary-light" size="sm">
                Applied
              </Badge>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

// ── Bookmarks tab ────────────────────────────────────────────────────────────

function BookmarksTab() {
  const [bms, setBms] = useState<any[] | null>(null);
  if (!bms) {
    getMyBookmarks()
      .then(setBms)
      .catch(() => setBms([]));
    return <LoadingCard />;
  }

  if (bms.length === 0) {
    return (
      <EmptyCard
        icon={BookOpen01Icon}
        title="No saved jobs"
        hint="Bookmark jobs to review them later."
      />
    );
  }

  return (
    <div className="space-y-3">
      {bms.map((b: any) => (
        <Link
          key={b.posting_id}
          to="/jobs/$jobSlug"
          params={{ jobSlug: b.slug }}
          className="block focus-visible:outline-none"
        >
          <Card className="card-hover">
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-primary">{b.title}</p>
                {b.location ? <p className="text-sm text-text-secondary">{b.location}</p> : null}
              </div>
              <Badge variant="secondary-light" size="sm">
                Saved
              </Badge>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

// ── Alerts tab ───────────────────────────────────────────────────────────────

function AlertsTab() {
  const [alerts, setAlerts] = useState<any[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');

  if (!alerts) {
    listMyAlerts()
      .then(setAlerts)
      .catch(() => setAlerts([]));
    return <LoadingCard />;
  }

  const addAlert = async () => {
    if (!newKeyword.trim()) return;
    setSaving(true);
    try {
      await createJobAlert({
        kind: 'employee',
        filtersJson: JSON.stringify({ q: newKeyword.trim() }),
      });
      setNewKeyword('');
      setAlerts(await listMyAlerts());
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const removeAlert = async (alertId: string) => {
    await deleteJobAlert({ alertId });
    setAlerts((prev) => prev?.filter((a) => a.alert_id !== alertId) ?? []);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <h3 className="text-sm font-semibold text-text-primary">New Alert</h3>
          <div className="flex gap-2">
            <input
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addAlert()}
              placeholder="e.g. Brass, Percussion, Visual…"
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
            />
            <Button
              onClick={addAlert}
              disabled={saving || !newKeyword.trim()}
              variant="outline"
              size="sm"
            >
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {alerts.length === 0 ? (
        <EmptyCard
          icon={FireIcon}
          title="No alerts set"
          hint="Create alerts to get notified about new jobs."
        />
      ) : (
        <div className="space-y-2">
          {alerts.map((a: any) => {
            const filters = (() => {
              try {
                return JSON.parse(a.filters_json);
              } catch {
                return {};
              }
            })();
            return (
              <Card key={a.alert_id}>
                <CardContent className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">
                      {filters.q || 'All jobs'}
                    </p>
                    <p className="text-xs text-text-muted">
                      {a.frequency} · {a.active ? 'Active' : 'Paused'}
                    </p>
                  </div>
                  <Button
                    onClick={() => removeAlert(a.alert_id)}
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                  >
                    Remove
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function LoadingCard() {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-text-muted">Loading…</CardContent>
    </Card>
  );
}

function EmptyCard({ icon, title, hint }: { icon: any; title: string; hint: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Icon icon={icon} size="xl" className="text-text-muted" />
        <p className="font-medium text-text-primary">{title}</p>
        <p className="text-sm text-text-secondary">{hint}</p>
      </CardContent>
    </Card>
  );
}

// ── Claim section (kept from before) ─────────────────────────────────────────

function ClaimSection({ profileId, userId }: { profileId: string; userId: string }) {
  const [snapshot, send] = useMachine(jobsClaimMachine, {
    input: { initialClaims: [], userName: userId },
  });
  const { candidates, claims, search, claimingId, error } = snapshot.context;
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Icon icon={Search01Icon} size="sm" /> Claim Your Page
        </h2>
        <p className="text-sm text-text-secondary">
          Claim your staff or judge page to auto-fill your profile.
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
          Match.when({ matches: (_s: typeof snapshot) => candidates.length > 0 }, () => (
            <div className="grid gap-3 sm:grid-cols-2">
              {candidates.map((c: any) => (
                <Card key={`${c.entityType}:${c.entityId}`} className="card-hover-flat">
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
                      (cl: any) =>
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
            () => <p className="text-sm text-text-muted">No matches found.</p>
          ),
          Match.orElse(() => null)
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
