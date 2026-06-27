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
import { createJobPosting, getMyJobsProfile, upsertJobsProfile } from '@/lib/server-fns/jobs';
import { AddCircleIcon, CheckmarkCircle02Icon } from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';

export const Route = createFileRoute('/jobs/post')({
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

function PostJobPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const profile = Route.useLoaderData();
  const prefillName =
    profile?.profile.display_name && profile.profile.display_name !== 'User'
      ? profile.profile.display_name
      : '';
  const [orgName, setOrgName] = useState(prefillName);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [zip, setZip] = useState('');
  const [remoteOk, setRemoteOk] = useState(false);
  const [compText, setCompText] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [applyEmail, setApplyEmail] = useState('');
  const [expiresDays, setExpiresDays] = useState(60);
  const [description, setDescription] = useState<FreeFormDoc>(emptyJobDescription);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lexical is client-only; gate the editor mount so SSR stays stable.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      const result = await createJobPosting({
        data: {
          title: title.trim(),
          location,
          zip,
          remoteOk,
          compText,
          salaryMin: salaryMin ? Number(salaryMin) : null,
          salaryMax: salaryMax ? Number(salaryMax) : null,
          applyUrl,
          applyEmail,
          expiresDays,
          contentJson: JSON.stringify(description),
        },
      });
      if (result.ok) {
        setDone(true);
        router.invalidate();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post');
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

  return (
    <PageShell>
      <PageHeader title="Post a Job" subtitle="Reach the pageantry community" subtitleClassName="text-sm" backTo="/" backLabel="Home" />
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
              <JobDescriptionEditor value={description} onChange={setDescription} />
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
              {saving ? 'Posting…' : 'Post Job'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
