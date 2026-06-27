import { useState } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Match } from 'effect';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { jobsProfileMachine } from '@/machines/jobs-profile-machine';
import { jobsClaimMachine } from '@/machines/jobs-claim-machine';
import {
  getMyJobsProfile,
  getMyApplications,
  getMyPostings,
  getPostingApplicants,
  closeJobPosting,
  setApplicantStatus,
  getMyBookmarks,
  listMyAlerts,
  deleteJobAlert,
  createJobAlert,
  saveJobsProfileBlock,
} from '@/lib/server-fns/jobs';
import { TiptapFreeForm } from '@/components/contrib/tiptap-free-form';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';
import {
  UserMultipleIcon,
  CheckmarkCircle02Icon,
  AddCircleIcon,
  Search01Icon,
  Briefcase01Icon,
  FireIcon,
  BookOpen01Icon,
} from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';
import { PhotoUpload, imageFileToUploadBase64 } from '@/components/fantasy/photo-upload';
import { setJobsProfilePhoto } from '@/lib/server-fns/jobs-media';

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

type Tab = 'profile' | 'postings' | 'applications' | 'bookmarks' | 'alerts';

function MePage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();
  const [tab, setTab] = useState<Tab>('profile');
  const [snapshot, send] = useMachine(jobsProfileMachine, {
    input: {
      displayName: initial?.profile.display_name ?? '',
      headline: initial?.profile.headline ?? '',
      location: initial?.profile.location ?? '',
      zip: initial?.profile.zip ?? '',
      kind: (initial?.profile.kind as 'employee' | 'employer') ?? 'employee',
      directoryOptOut: (initial?.profile?.directory_opt_out ?? 0) === 1,
      profileId: initial?.profile.profile_id ?? null,
      slug: initial?.profile.slug ?? null,
      status: initial?.profile.status ?? 'draft',
    },
  });

  const ctx = snapshot.context;

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="My Profile" subtitle="Your profile, applications, and alerts" subtitleClassName="text-sm" backTo="/" backLabel="Home" />
        <JobsSignInGate icon={UserMultipleIcon} title="Manage your profile" path="/jobs/me" />
      </PageShell>
    );
  }

  const tabs: { key: Tab; label: string; icon: typeof Briefcase01Icon }[] = [
    { key: 'profile', label: 'Profile', icon: UserMultipleIcon },
    { key: 'postings', label: 'My Listings', icon: Briefcase01Icon },
    { key: 'applications', label: 'Applications', icon: Briefcase01Icon },
    { key: 'bookmarks', label: 'Saved Jobs', icon: BookOpen01Icon },
    { key: 'alerts', label: 'Alerts', icon: FireIcon },
  ];

  return (
    <PageShell>
      <PageHeader title="My Dashboard" subtitle="Your profile, applications, and alerts" subtitleClassName="text-sm" backTo="/" backLabel="Home" />

      {/* Tabs — scroll horizontally on narrow screens instead of overflowing/wrapping */}
      <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-all ${
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
        Match.when('postings', () => <PostingsTab />),
        Match.when('applications', () => <ApplicationsTab />),
        Match.when('bookmarks', () => <BookmarksTab />),
        Match.when('alerts', () => <AlertsTab />),
        Match.exhaustive
      )}
    </PageShell>
  );
}

// ── Profile tab ──────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary/60 focus:ring-1 focus:ring-primary/30';

function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label className="text-sm font-medium text-text-primary">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </label>
      {children}
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

function ProfileTab({ initial, snapshot, send }: { initial: any; snapshot: any; send: any }) {
  const ctx = snapshot.context;
  const router = useRouter();
  const isSaving = snapshot.matches('saving');
  const isSaved = snapshot.matches('saved');
  const nameOk = ctx.displayName.trim().length > 0;

  // Throws on failure so PhotoUpload's machine reverts the preview + toasts the error.
  const handlePhoto = async (file: File) => {
    const dataBase64 = await imageFileToUploadBase64(file);
    await setJobsProfilePhoto({ data: { dataBase64 } });
    await router.invalidate();
  };

  return (
    <div className="space-y-6">
      {/* Identity header — a quick read on how the profile presents */}
      <div className="flex items-center gap-4">
        {/* Always available — the upload server-fn auto-creates the profile on first
            upload, so new users can add a photo before saving the rest. */}
        <PhotoUpload
          variant="overlay"
          shape="round"
          size="size-16 sm:size-20"
          mediaId={initial?.profile?.image_media_id ?? null}
          alt={ctx.displayName}
          labels={{ empty: 'Add photo', change: 'Change photo' }}
          onFile={handlePhoto}
        />
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-text-primary">
            {ctx.displayName.trim() || 'Your name'}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={ctx.status === 'published' ? 'success-light' : 'secondary-light'} size="sm">
              {ctx.status === 'published' ? 'Published' : 'Draft'}
            </Badge>
            <span className="text-xs capitalize text-text-muted">
              {ctx.kind === 'employer' ? 'Hiring' : 'Looking for work'}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Display name"
              required
              hint="How employers see you across the job board."
              className="sm:col-span-2"
            >
              <input
                value={ctx.displayName}
                onChange={(e) => send({ type: 'SET_DISPLAY_NAME', value: e.target.value })}
                placeholder="e.g. Jordan Rivera"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Profile type" hint="Looking for work, or hiring?">
              <select
                value={ctx.kind}
                onChange={(e) =>
                  send({ type: 'SET_KIND', value: e.target.value as 'employee' | 'employer' })
                }
                className={INPUT_CLASS}
              >
                <option value="employee">Looking for work</option>
                <option value="employer">Hiring</option>
              </select>
            </Field>
            <Field label="Headline" hint="Your role or specialty.">
              <input
                value={ctx.headline}
                onChange={(e) => send({ type: 'SET_HEADLINE', value: e.target.value })}
                placeholder="e.g. Brass Caption Head"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Location" hint="City, State — helps employers find local talent.">
              <input
                value={ctx.location}
                onChange={(e) => send({ type: 'SET_LOCATION', value: e.target.value })}
                placeholder="City, State"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="ZIP code" hint="Powers “nearest first” search.">
              <input
                value={ctx.zip}
                onChange={(e) => send({ type: 'SET_ZIP', value: e.target.value })}
                inputMode="numeric"
                maxLength={5}
                placeholder="e.g. 90210"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          {snapshot.matches('idle') && ctx.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {ctx.error.toLowerCase().includes('forbidden') || ctx.error.toLowerCase().includes('sign')
                ? 'Your session expired. Please sign in again, then save.'
                : ctx.error}
            </div>
          ) : null}

          {ctx.kind === 'employee' ? (
            <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm cursor-pointer hover:bg-muted/30">
              <input
                type="checkbox"
                checked={!ctx.directoryOptOut}
                onChange={(e) =>
                  send({ type: 'SET_DIRECTORY_OPT_OUT', value: !e.target.checked })
                }
                className="mt-0.5 size-4 shrink-0"
              />
              <span>
                <span className="font-medium text-text-primary">Show my profile in the talent directory</span>
                <span className="block text-xs text-text-muted">Uncheck to keep your profile link-only.</span>
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-3 border-t border-border pt-4">
            <Button onClick={() => send({ type: 'SAVE' })} disabled={isSaving || !nameOk} size="sm">
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
            {isSaved ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
                <Icon icon={CheckmarkCircle02Icon} size="xs" /> Saved
              </span>
            ) : (
              <span className="text-xs text-text-muted">
                {nameOk ? 'Changes aren’t saved until you click Save.' : 'Add a display name to save.'}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {ctx.profileId ? (
        <>
          <AboutSection profileId={ctx.profileId} blocks={initial?.blocks ?? []} />
          <ExperienceSection profileId={ctx.profileId} blocks={initial?.blocks ?? []} />
          <EducationSection profileId={ctx.profileId} blocks={initial?.blocks ?? []} />
        </>
      ) : null}

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

// ── About / Experience / Education block editors ─────────────────────────────

type Block = { kind: string; content_json: string };

const parseBlock = (blocks: Block[], kind: string): Record<string, unknown> | null => {
  const b = blocks.find((bl) => bl.kind === kind);
  if (!b) return null;
  try {
    return JSON.parse(b.content_json) as Record<string, unknown>;
  } catch {
    return null;
  }
};

function AboutSection({ profileId, blocks }: { profileId: string; blocks: Block[] }) {
  const router = useRouter();
  const seed = parseBlock(blocks, 'summary');
  const [about, setAbout] = useState<FreeFormDoc>(() =>
    seed && typeof seed.doc === 'string'
      ? {
          format: 'tiptap',
          version: 1,
          doc: seed.doc,
          plain: typeof seed.plain === 'string' ? seed.plain : '',
        }
      : emptyFreeFormDoc('tiptap')
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await saveJobsProfileBlock({
        data: {
          profileId,
          kind: 'summary',
          content: { format: 'tiptap', version: 1, doc: about.doc, plain: about.plain },
        },
      });
      await router.invalidate();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-base font-semibold text-text-primary">About</h2>
        <TiptapFreeForm value={about} onChange={setAbout} />
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving} variant="outline" size="sm">
            {saving ? 'Saving…' : 'Save About'}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
              <Icon icon={CheckmarkCircle02Icon} size="xs" /> Saved
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type ExpItem = { org: string; role: string; startYear: string; endYear: string; description: string };

function ExperienceSection({ profileId, blocks }: { profileId: string; blocks: Block[] }) {
  const router = useRouter();
  const seed = parseBlock(blocks, 'experience');
  const [items, setItems] = useState<ExpItem[]>(() =>
    Array.isArray(seed?.items)
      ? (seed!.items as any[]).map((it) => ({
          org: String(it.org ?? ''),
          role: String(it.role ?? ''),
          startYear: String(it.startYear ?? ''),
          endYear: String(it.endYear ?? ''),
          description: String(it.description ?? ''),
        }))
      : []
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const update = (i: number, patch: Partial<ExpItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const add = () =>
    setItems((prev) => [...prev, { org: '', role: '', startYear: '', endYear: '', description: '' }]);
  const remove = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await saveJobsProfileBlock({
        data: {
          profileId,
          kind: 'experience',
          content: { items: items.filter((it) => it.org.trim()) },
        },
      });
      await router.invalidate();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-base font-semibold text-text-primary">Experience</h2>
        {items.map((it, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Organization" required className="sm:col-span-2">
                <input
                  value={it.org}
                  onChange={(e) => update(i, { org: e.target.value })}
                  placeholder="Organization"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Role">
                <input
                  value={it.role}
                  onChange={(e) => update(i, { role: e.target.value })}
                  placeholder="Role"
                  className={INPUT_CLASS}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Start year">
                  <input
                    value={it.startYear}
                    onChange={(e) => update(i, { startYear: e.target.value })}
                    placeholder="2019"
                    className={INPUT_CLASS}
                  />
                </Field>
                <Field label="End year">
                  <input
                    value={it.endYear}
                    onChange={(e) => update(i, { endYear: e.target.value })}
                    placeholder="2022"
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
              <Field label="Description" className="sm:col-span-2">
                <textarea
                  value={it.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                  rows={2}
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
            <Button onClick={() => remove(i)} variant="ghost" size="xs" className="text-destructive">
              Remove
            </Button>
          </div>
        ))}
        <Button onClick={add} variant="outline" size="sm">
          <Icon icon={AddCircleIcon} size="sm" /> Add experience
        </Button>
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? 'Saving…' : 'Save Experience'}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
              <Icon icon={CheckmarkCircle02Icon} size="xs" /> Saved
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type EduItem = { school: string; degree: string; field: string; year: string };

function EducationSection({ profileId, blocks }: { profileId: string; blocks: Block[] }) {
  const router = useRouter();
  const seed = parseBlock(blocks, 'education');
  const [items, setItems] = useState<EduItem[]>(() =>
    Array.isArray(seed?.items)
      ? (seed!.items as any[]).map((it) => ({
          school: String(it.school ?? ''),
          degree: String(it.degree ?? ''),
          field: String(it.field ?? ''),
          year: String(it.year ?? ''),
        }))
      : []
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const update = (i: number, patch: Partial<EduItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const add = () => setItems((prev) => [...prev, { school: '', degree: '', field: '', year: '' }]);
  const remove = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await saveJobsProfileBlock({
        data: {
          profileId,
          kind: 'education',
          content: { items: items.filter((it) => it.school.trim()) },
        },
      });
      await router.invalidate();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-base font-semibold text-text-primary">Education</h2>
        {items.map((it, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="School" required className="sm:col-span-2">
                <input
                  value={it.school}
                  onChange={(e) => update(i, { school: e.target.value })}
                  placeholder="School"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Degree">
                <input
                  value={it.degree}
                  onChange={(e) => update(i, { degree: e.target.value })}
                  placeholder="e.g. B.A."
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Field">
                <input
                  value={it.field}
                  onChange={(e) => update(i, { field: e.target.value })}
                  placeholder="e.g. Music Education"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Year">
                <input
                  value={it.year}
                  onChange={(e) => update(i, { year: e.target.value })}
                  placeholder="2021"
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
            <Button onClick={() => remove(i)} variant="ghost" size="xs" className="text-destructive">
              Remove
            </Button>
          </div>
        ))}
        <Button onClick={add} variant="outline" size="sm">
          <Icon icon={AddCircleIcon} size="sm" /> Add education
        </Button>
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? 'Saving…' : 'Save Education'}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
              <Icon icon={CheckmarkCircle02Icon} size="xs" /> Saved
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Postings tab (employer-facing) ───────────────────────────────────────────

function PostingsTab() {
  const [postings, setPostings] =
    useState<Awaited<ReturnType<typeof getMyPostings>> | null>(null);
  if (!postings) {
    getMyPostings()
      .then(setPostings)
      .catch(() => setPostings([]));
    return <LoadingCard />;
  }

  const refresh = () => getMyPostings().then(setPostings).catch(() => {});

  if (postings.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <Icon icon={Briefcase01Icon} size="xl" className="text-text-muted" />
          <p className="font-medium text-text-primary">No job postings yet</p>
          <p className="text-sm text-text-secondary">Post a job to start receiving applicants.</p>
          <Link
            to="/jobs/post"
            className="mt-1 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Post a job
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {postings.map((p: any) => (
        <PostingRow key={p.posting_id} posting={p} onChanged={refresh} />
      ))}
    </div>
  );
}

function PostingRow({ posting, onChanged }: { posting: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [applicants, setApplicants] =
    useState<Awaited<ReturnType<typeof getPostingApplicants>> | null>(null);

  const isClosed = posting.status === 'closed';

  const close = async () => {
    if (!confirm('Close this listing? It will stop accepting applicants.')) return;
    setClosing(true);
    try {
      await closeJobPosting({ data: { postingId: posting.posting_id } });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setClosing(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && applicants === null) {
      getPostingApplicants({ data: { postingId: posting.posting_id } })
        .then(setApplicants)
        .catch(() => setApplicants([]));
    }
  };

  const count = posting.applicant_count ?? 0;

  return (
    <Card>
      <CardContent className="space-y-3 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link
              to="/jobs/$jobSlug"
              params={{ jobSlug: posting.slug }}
              className="truncate font-medium text-text-primary hover:underline"
            >
              {posting.title}
            </Link>
            <p className="text-sm text-text-secondary">
              {new Date(posting.created_at).toLocaleDateString()}
              {posting.apply_url ? (
                <span className="text-text-muted"> · External apply — applicants tracked on your site</span>
              ) : (
                <> · {count} {count === 1 ? 'applicant' : 'applicants'}</>
              )}
            </p>
          </div>
          <Badge
            variant={
              isClosed
                ? 'secondary-light'
                : posting.status === 'published'
                  ? 'success-light'
                  : 'secondary-light'
            }
            size="sm"
          >
            {isClosed ? 'Closed' : posting.status === 'published' ? 'Published' : posting.status}
          </Badge>
          <Button onClick={toggle} variant="outline" size="xs">
            {open ? 'Hide' : 'View applicants'}
          </Button>
          {!isClosed ? (
            <Button
              onClick={close}
              disabled={closing}
              variant="ghost"
              size="xs"
              className="text-destructive"
            >
              {closing ? '…' : 'Close'}
            </Button>
          ) : null}
        </div>

        {open ? (
          applicants === null ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : applicants.length === 0 ? (
            <p className="border-t border-border pt-3 text-sm text-text-muted">No applicants yet</p>
          ) : (
            <div className="space-y-3 border-t border-border pt-3">
              {applicants.map((ap: any) => (
                <ApplicantRow key={ap.application_id} applicant={ap} />
              ))}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

const APPLICANT_STATUSES = ['new', 'reviewed', 'shortlisted', 'passed'] as const;
const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  shortlisted: 'Shortlisted',
  passed: 'Passed',
};
const STATUS_VARIANT: Record<string, 'secondary-light' | 'success-light' | 'warning-light'> = {
  new: 'secondary-light',
  reviewed: 'warning-light',
  shortlisted: 'success-light',
  passed: 'secondary-light',
};

function ApplicantRow({ applicant: ap }: { applicant: any }) {
  const [status, setStatus] = useState<string>(ap.status ?? 'new');
  const [saving, setSaving] = useState(false);

  const change = async (next: string) => {
    const prev = status;
    setStatus(next);
    setSaving(true);
    try {
      await setApplicantStatus({ data: { applicationId: ap.application_id, status: next as any } });
    } catch {
      setStatus(prev);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-3">
      {ap.image_media_id ? (
        <img
          src={`/api/fantasy-media/${ap.image_media_id}`}
          alt={ap.display_name ?? ''}
          className="size-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {(ap.display_name ?? '?').charAt(0)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {ap.slug ? (
            <Link
              to="/jobs/profile/$slug"
              params={{ slug: ap.slug }}
              className="font-medium text-text-primary hover:underline"
            >
              {ap.display_name ?? 'Applicant'}
            </Link>
          ) : (
            <p className="font-medium text-text-primary">{ap.display_name ?? 'Applicant'}</p>
          )}
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary-light'} size="sm">
            {STATUS_LABEL[status] ?? status}
          </Badge>
        </div>
        {ap.headline || ap.location ? (
          <p className="text-xs text-text-muted">
            {[ap.headline, ap.location].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <p className="text-xs text-text-muted">
          Applied {new Date(ap.created_at).toLocaleDateString()}
        </p>
        {ap.message ? (
          <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-text-secondary">
            {ap.message}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={status}
            onChange={(e) => change(e.target.value)}
            disabled={saving}
            className="rounded-lg border border-border bg-card px-2 py-1 text-xs outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          >
            {APPLICANT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {ap.applicant_email ? (
            <a
              href={`mailto:${ap.applicant_email}`}
              className="text-xs font-medium text-primary hover:underline"
            >
              Contact
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Applications tab ─────────────────────────────────────────────────────────

function ApplicationsTab() {
  const [apps, setApps] = useState<Awaited<ReturnType<typeof getMyApplications>> | null>(null);
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
  const [bms, setBms] = useState<Awaited<ReturnType<typeof getMyBookmarks>> | null>(null);
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
  const [alerts, setAlerts] = useState<Awaited<ReturnType<typeof listMyAlerts>> | null>(null);
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
        data: {
          kind: 'employee',
          filtersJson: JSON.stringify({ q: newKeyword.trim() }),
        },
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
    await deleteJobAlert({ data: { alertId } });
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
