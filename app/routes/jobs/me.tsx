import { useEffect, useState } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { Match } from 'effect';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { SectionErrorBoundary } from '@/components/error-boundary';
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
  deleteJobPosting,
  setApplicantStatus,
  getMyBookmarks,
  listMyAlerts,
  deleteJobAlert,
  createJobAlert,
  saveJobsProfileBlock,
} from '@/lib/server-fns/jobs';
import { JobDescriptionEditor } from '@/components/jobs/job-description-editor';
import { ConfirmDialog } from '@/components/fantasy/confirm-dialog';
import { toast } from 'sonner';
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

      <SectionErrorBoundary key={tab} label="this tab">
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
      </SectionErrorBoundary>
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
  // Existing tiptap-format About docs won't render in Lexical (About is new) —
  // only seed when the stored doc is already lexical; otherwise start empty.
  const [about, setAbout] = useState<FreeFormDoc>(() =>
    seed && seed.format === 'lexical' && typeof seed.doc === 'string'
      ? {
          format: 'lexical',
          version: 1,
          doc: seed.doc,
          plain: typeof seed.plain === 'string' ? seed.plain : '',
        }
      : emptyFreeFormDoc('lexical')
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
          content: { format: 'lexical', version: 1, doc: about.doc, plain: about.plain },
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
        <JobDescriptionEditor
          value={about}
          onChange={setAbout}
          placeholder="Write a short professional summary…"
        />
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
  useEffect(() => {
    let alive = true;
    getMyPostings()
      .then((d) => { if (alive) setPostings(d); })
      .catch(() => { if (alive) setPostings([]); });
    return () => { alive = false; };
  }, []);

  const refresh = () => getMyPostings().then(setPostings).catch(() => {});
  const removeLocal = (postingId: string) =>
    setPostings((prev) => prev?.filter((p: any) => p.posting_id !== postingId) ?? null);

  if (!postings) return <LoadingCard />;

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

  const active = postings.filter((p: any) => p.status === 'published').length;
  const closed = postings.length - active;
  const totalApplicants = postings.reduce((n: number, p: any) => n + (p.applicant_count ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Active" value={active} />
        <StatTile label="Closed" value={closed} />
        <StatTile label="Applicants" value={totalApplicants} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-text-secondary">Your listings</p>
        <Link
          to="/jobs/post"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-primary/60"
        >
          <Icon icon={AddCircleIcon} size="xs" /> Post a job
        </Link>
      </div>
      <div className="space-y-3">
        {postings.map((p: any) => (
          <PostingRow
            key={p.posting_id}
            posting={p}
            onChanged={refresh}
            onRemoved={() => removeLocal(p.posting_id)}
          />
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-0.5 py-3 text-center">
        <span className="text-2xl font-semibold tabular-nums text-text-primary">{value}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
          {label}
        </span>
      </CardContent>
    </Card>
  );
}

function relativeFuture(value: string | null | undefined): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.round((then - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return 'in 1 day';
  if (days < 30) return `in ${days} days`;
  if (days < 60) return 'in about a month';
  return `in ${Math.round(days / 30)} months`;
}

function PostingRow({
  posting,
  onChanged,
  onRemoved,
}: {
  posting: any;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [applicants, setApplicants] =
    useState<Awaited<ReturnType<typeof getPostingApplicants>> | null>(null);

  const isClosed = posting.status === 'closed';
  const isExpired =
    !isClosed &&
    posting.expires_at != null &&
    new Date(posting.expires_at).getTime() < Date.now();
  const expiresRelative = !isClosed && !isExpired ? relativeFuture(posting.expires_at) : null;

  const closeListing = async () => {
    await closeJobPosting({ data: { postingId: posting.posting_id } });
    toast.success('Listing closed');
    onChanged();
  };

  const removeListing = async () => {
    await deleteJobPosting({ data: { postingId: posting.posting_id } });
    toast.success('Listing deleted');
    onRemoved();
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

  const setApplicantLocal = (applicationId: string, status: string) =>
    setApplicants(
      (prev) => prev?.map((a: any) => (a.application_id === applicationId ? { ...a, status } : a)) ?? prev
    );

  const count = posting.applicant_count ?? 0;
  const statusChip = isClosed
    ? { label: 'Closed', variant: 'secondary-light' as const }
    : isExpired
      ? { label: 'Expired', variant: 'warning-light' as const }
      : posting.status === 'published'
        ? { label: 'Published', variant: 'success-light' as const }
        : { label: String(posting.status), variant: 'secondary-light' as const };

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to="/jobs/$jobSlug"
              params={{ jobSlug: posting.slug }}
              className="block truncate font-medium text-text-primary hover:underline"
            >
              {posting.title}
            </Link>
            <p className="mt-0.5 text-xs text-text-muted">
              Posted {new Date(posting.created_at).toLocaleDateString()}
              {isClosed ? null : isExpired ? (
                <> · Expired</>
              ) : expiresRelative ? (
                <> · Expires {expiresRelative}</>
              ) : null}
              {posting.apply_url ? <> · External apply</> : null}
            </p>
          </div>
          <Badge variant={statusChip.variant} size="sm">
            {statusChip.label}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={toggle} variant="outline" size="xs">
            <Icon icon={UserMultipleIcon} size="xs" />{' '}
            {open ? 'Hide applicants' : `${count} ${count === 1 ? 'applicant' : 'applicants'}`}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            {!isClosed ? (
              <ConfirmDialog
                title="Close this listing?"
                description="It stops accepting new applicants. Existing applicants stay visible to you."
                confirmLabel="Close listing"
                onConfirm={closeListing}
                trigger={
                  <Button variant="ghost" size="xs" className="text-text-muted hover:text-text-primary">
                    Close
                  </Button>
                }
              />
            ) : null}
            <ConfirmDialog
              title="Delete this listing?"
              description="This permanently removes the listing and all of its applications. This can't be undone."
              confirmLabel="Delete"
              onConfirm={removeListing}
              trigger={
                <Button variant="ghost" size="xs" className="text-destructive">
                  Delete
                </Button>
              }
            />
          </div>
        </div>

        {open ? (
          applicants === null ? (
            <p className="border-t border-border pt-3 text-sm text-text-muted">Loading applicants…</p>
          ) : applicants.length === 0 ? (
            <p className="border-t border-border pt-3 text-sm text-text-muted">No applicants yet.</p>
          ) : (
            <ApplicantsPanel applicants={applicants} onStatusChange={setApplicantLocal} />
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

const APPLICANT_STATUSES = ['new', 'reviewed', 'shortlisted', 'passed'] as const;
const STATUS_ORDER: Record<string, number> = { new: 0, reviewed: 1, shortlisted: 2, passed: 3 };
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

function ApplicantsPanel({
  applicants,
  onStatusChange,
}: {
  applicants: readonly any[];
  onStatusChange: (applicationId: string, status: string) => void;
}) {
  // Live pipeline counts + a stable new→passed ordering so unreviewed applicants
  // always surface at the top.
  const counts = applicants.reduce<Record<string, number>>((acc, ap) => {
    const s = ap.status ?? 'new';
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const sorted = [...applicants].sort(
    (a, b) => (STATUS_ORDER[a.status ?? 'new'] ?? 0) - (STATUS_ORDER[b.status ?? 'new'] ?? 0)
  );

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-1.5">
        {APPLICANT_STATUSES.map((s) =>
          counts[s] ? (
            <Badge key={s} variant={STATUS_VARIANT[s]} size="sm">
              {counts[s]} {STATUS_LABEL[s]}
            </Badge>
          ) : null
        )}
      </div>
      <div className="space-y-2.5">
        {sorted.map((ap) => (
          <ApplicantRow key={ap.application_id} applicant={ap} onStatusChange={onStatusChange} />
        ))}
      </div>
    </div>
  );
}

function ApplicantRow({
  applicant: ap,
  onStatusChange,
}: {
  applicant: any;
  onStatusChange: (applicationId: string, status: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const status = ap.status ?? 'new';

  const change = async (next: string) => {
    if (next === status || saving) return;
    onStatusChange(ap.application_id, next); // optimistic — keeps panel counts/order live
    setSaving(true);
    try {
      await setApplicantStatus({ data: { applicationId: ap.application_id, status: next as any } });
    } catch {
      onStatusChange(ap.application_id, status);
      toast.error('Could not update status');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-3 rounded-lg border border-border bg-card/50 p-3">
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
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
          <span className="text-xs text-text-muted">
            Applied {new Date(ap.created_at).toLocaleDateString()}
          </span>
        </div>
        {ap.headline || ap.location ? (
          <p className="text-xs text-text-muted">
            {[ap.headline, ap.location].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {ap.message ? (
          <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-text-secondary">
            {ap.message}
          </p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {APPLICANT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => change(s)}
              aria-pressed={status === s}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                status === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-text-secondary hover:bg-muted/70'
              )}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
          {ap.applicant_email ? (
            <a
              href={`mailto:${ap.applicant_email}`}
              className="ml-1 text-xs font-medium text-primary hover:underline"
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
  useEffect(() => {
    let alive = true;
    getMyApplications()
      .then((d) => { if (alive) setApps(d); })
      .catch(() => { if (alive) setApps([]); });
    return () => { alive = false; };
  }, []);

  if (!apps) return <LoadingCard />;

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
  useEffect(() => {
    let alive = true;
    getMyBookmarks()
      .then((d) => { if (alive) setBms(d); })
      .catch(() => { if (alive) setBms([]); });
    return () => { alive = false; };
  }, []);

  if (!bms) return <LoadingCard />;

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

  useEffect(() => {
    let alive = true;
    listMyAlerts()
      .then((d) => { if (alive) setAlerts(d); })
      .catch(() => { if (alive) setAlerts([]); });
    return () => { alive = false; };
  }, []);

  if (!alerts) return <LoadingCard />;

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
        {snapshot.matches('searching') || snapshot.matches('suggesting') ? (
          <p className="text-sm text-text-muted">Searching…</p>
        ) : candidates.length > 0 ? (
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
        ) : search.trim().length >= 2 && snapshot.matches('idle') ? (
          <p className="text-sm text-text-muted">No matches found.</p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
