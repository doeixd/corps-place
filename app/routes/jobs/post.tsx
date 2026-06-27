import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  JobDescriptionEditor,
  emptyJobDescription,
} from '@/components/jobs/job-description-editor';
import type { FreeFormDoc } from '@/lib/contrib/free-form';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import {
  createJobPosting,
  getJobForEdit,
  getMyJobsProfile,
  updateJobPosting,
  upsertJobsProfile,
} from '@/lib/server-fns/jobs';
import { toast } from 'sonner';
import { DISCIPLINES } from '@/lib/jobs/disciplines';
import { AddCircleIcon, CheckmarkCircle02Icon } from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';
import { SectionErrorBoundary } from '@/components/error-boundary';

export const Route = createFileRoute('/jobs/post')({
  validateSearch: (search: Record<string, unknown>): { edit?: string } => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
  }),
  head: () =>
    buildSeo({
      title: 'Post a Job — PageantryJobs',
      description: 'Post a job listing on PageantryJobs.',
      path: '/jobs/post',
      noindex: true,
    }),
  loader: async () => getMyJobsProfile(),
  component: PostJobPage,
});

// Map a stored expires_at timestamp back to the nearest auto-hide option (30/60/90).
const daysUntil = (expiresAt: string | null): number => {
  if (!expiresAt) return 60;
  const days = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  return [30, 60, 90].reduce((best, opt) => (Math.abs(opt - days) < Math.abs(best - days) ? opt : best), 60);
};

function PostJobPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const { edit: editId } = Route.useSearch();
  const profile = Route.useLoaderData();
  const prefillName =
    profile?.profile.display_name && profile.profile.display_name !== 'User'
      ? profile.profile.display_name
      : '';
  const [orgName, setOrgName] = useState(prefillName);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [zip, setZip] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [remoteOk, setRemoteOk] = useState(false);
  const [compText, setCompText] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [applyEmail, setApplyEmail] = useState('');
  const [expiresDays, setExpiresDays] = useState(60);
  // Prefilled expiry in edit mode — used to avoid resetting the countdown unless changed.
  const [initialExpiresDays, setInitialExpiresDays] = useState<number | null>(null);
  const [description, setDescription] = useState<FreeFormDoc>(emptyJobDescription);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lexical is client-only; gate the editor mount so SSR stays stable.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Edit mode: load the existing posting (owner-guarded) and prefill the form.
  // 'loading' until the fetch resolves; 'denied' when not found / not owned.
  const isEdit = Boolean(editId);
  const [editState, setEditState] = useState<'loading' | 'ready' | 'denied'>(
    isEdit ? 'loading' : 'ready'
  );
  useEffect(() => {
    if (!editId) {
      // Create mode (incl. navigating here from an edit) — clear any prefilled
      // state so a prior listing's data can't leak into a brand-new posting.
      setEditState('ready');
      setTitle('');
      setLocation('');
      setZip('');
      setDiscipline('');
      setRemoteOk(false);
      setCompText('');
      setSalaryMin('');
      setSalaryMax('');
      setApplyUrl('');
      setApplyEmail('');
      setExpiresDays(60);
      setInitialExpiresDays(null);
      setDescription(emptyJobDescription);
      return;
    }
    if (!session) return;
    setEditState('loading');
    let alive = true;
    getJobForEdit({ data: { postingId: editId } })
      .then((row) => {
        if (!alive) return;
        if (!row) {
          setEditState('denied');
          return;
        }
        setTitle(row.title ?? '');
        setLocation(row.location ?? '');
        setZip(row.zip ?? '');
        setDiscipline(row.discipline ?? '');
        setRemoteOk(row.remote_ok === 1);
        setCompText(row.comp_text ?? '');
        setSalaryMin(row.salary_min != null ? String(row.salary_min) : '');
        setSalaryMax(row.salary_max != null ? String(row.salary_max) : '');
        setApplyUrl(row.apply_url ?? '');
        setApplyEmail(row.apply_email ?? '');
        const days = daysUntil(row.expires_at);
        setExpiresDays(days);
        setInitialExpiresDays(days);
        try {
          setDescription(JSON.parse(row.content_json) as FreeFormDoc);
        } catch {
          /* leave the empty doc on a malformed content_json */
        }
        setEditState('ready');
      })
      .catch(() => {
        if (alive) setEditState('denied');
      });
    return () => {
      alive = false;
    };
  }, [editId, session]);

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Post a Job" subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo="/" backLabel="Home" />
        <JobsSignInGate icon={AddCircleIcon} title="Post a job" path="/jobs/post" />
      </PageShell>
    );
  }

  const handleSubmit = async () => {
    if (!orgName.trim()) {
      setError('Organization / display name is required');
      return;
    }
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Persist the employer's display name so it shows on the posting ("Posted by …").
      await upsertJobsProfile({ data: { kind: 'employer', displayName: orgName.trim() } });
      const fields = {
        title: title.trim(),
        location,
        zip,
        discipline,
        remoteOk,
        compText,
        salaryMin: salaryMin ? Number(salaryMin) : null,
        salaryMax: salaryMax ? Number(salaryMax) : null,
        applyUrl,
        applyEmail,
        contentJson: JSON.stringify(description),
      };
      if (editId) {
        // Only send expiresDays when the employer changed it, so editing a listing
        // doesn't silently reset its expiry countdown.
        const expiryChanged = initialExpiresDays == null || expiresDays !== initialExpiresDays;
        const result = await updateJobPosting({
          data: { postingId: editId, ...fields, ...(expiryChanged ? { expiresDays } : {}) },
        });
        if (result.ok) {
          toast.success('Listing updated');
          router.invalidate();
          navigate({ to: '/jobs/me' });
        }
      } else {
        const result = await createJobPosting({ data: { ...fields, expiresDays } });
        if (result.ok) {
          setDone(true);
          router.invalidate();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : editId ? 'Failed to save' : 'Failed to post');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <PageShell>
        <PageHeader title="Post a Job" subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={CheckmarkCircle02Icon} size="xl" className="text-success" />
            <p className="text-lg font-semibold text-text-primary">Job posted!</p>
            <Button
              onClick={() => {
                setDone(false);
                setTitle('');
                setDescription(emptyJobDescription());
              }}
              size="sm"
            >
              Post another
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (isEdit && editState === 'loading') {
    return (
      <PageShell>
        <PageHeader title="Edit listing" subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo="/jobs/me" backLabel="My listings" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-text-muted">Loading listing…</CardContent>
        </Card>
      </PageShell>
    );
  }

  if (isEdit && editState === 'denied') {
    return (
      <PageShell>
        <PageHeader title="Edit listing" subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo="/jobs/me" backLabel="My listings" />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium text-text-primary">Listing not found</p>
            <p className="text-sm text-text-secondary">
              This listing doesn’t exist, or you don’t have access to edit it.
            </p>
            <Button onClick={() => navigate({ to: '/jobs/me' })} size="sm">
              Back to my listings
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title={isEdit ? 'Edit listing' : 'Post a Job'} subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo={isEdit ? '/jobs/me' : '/'} backLabel={isEdit ? 'My listings' : 'Home'} />
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-sm font-medium text-text-primary">
                Organization / Display name *
              </label>
              <input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Blue Devils Performing Arts"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
              <p className="text-xs text-text-muted">Shown on your posting as “Posted by”.</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-sm font-medium text-text-primary">Job Title *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Brass Caption Head"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Location</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, State"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">ZIP code</label>
              <input
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                inputMode="numeric"
                maxLength={5}
                placeholder="e.g. 90210"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Discipline</label>
              <select
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              >
                <option value="">Select discipline…</option>
                {DISCIPLINES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={remoteOk}
                  onChange={(e) => setRemoteOk(e.target.checked)}
                />
                Remote OK
              </label>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Compensation (text)</label>
              <input
                value={compText}
                onChange={(e) => setCompText(e.target.value)}
                placeholder="e.g. Competitive, commensurate with experience"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Salary Range</label>
              <div className="flex gap-2">
                <input
                  value={salaryMin}
                  onChange={(e) => setSalaryMin(e.target.value)}
                  type="number"
                  placeholder="Min"
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
                <input
                  value={salaryMax}
                  onChange={(e) => setSalaryMax(e.target.value)}
                  type="number"
                  placeholder="Max"
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Apply URL</label>
              <input
                value={applyUrl}
                onChange={(e) => setApplyUrl(e.target.value)}
                placeholder="https://example.com/apply"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
              <p className="text-xs text-text-muted">
                If set, applicants apply on your site and won’t appear in your PageantryJobs dashboard.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-primary">Apply Email</label>
              <input
                value={applyEmail}
                onChange={(e) => setApplyEmail(e.target.value)}
                placeholder="hiring@example.com"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-primary">Job Description</label>
            {mounted ? (
              <SectionErrorBoundary label="the description editor">
                <JobDescriptionEditor value={description} onChange={setDescription} />
              </SectionErrorBoundary>
            ) : (
              <div className="min-h-40 rounded-lg px-3 py-2 text-sm text-text-muted ring-1 ring-foreground/15">
                Describe the role, responsibilities, requirements…
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-text-primary">
              Auto-hide this listing after
            </label>
            <select
              value={expiresDays}
              onChange={(e) => setExpiresDays(Number(e.target.value))}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 sm:w-auto"
            >
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
            <p className="text-xs text-text-muted">
              Expired listings stop showing on the board; you can repost anytime.
            </p>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex gap-3">
            <Button onClick={handleSubmit} disabled={saving} size="sm">
              {isEdit
                ? saving
                  ? 'Saving…'
                  : 'Save changes'
                : saving
                  ? 'Posting…'
                  : 'Post Job'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
