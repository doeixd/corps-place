import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { createJobPosting } from '@/lib/server-fns/jobs';
import { AddCircleIcon, CheckmarkCircle02Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/post')({
  head: () =>
    buildSeo({
      title: 'Post a Job — PageantryJobs',
      description: 'Post a job listing on PageantryJobs.',
      path: '/jobs/post',
      noindex: true,
    }),
  component: PostJobPage,
});

function PostJobPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [remoteOk, setRemoteOk] = useState(false);
  const [compText, setCompText] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [applyEmail, setApplyEmail] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Post a Job" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="py-12 text-center text-text-secondary">
            Sign in to post a job.
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createJobPosting({
        data: {
          title: title.trim(),
          location,
          remoteOk,
          compText,
          salaryMin: salaryMin ? Number(salaryMin) : null,
          salaryMax: salaryMax ? Number(salaryMax) : null,
          applyUrl,
          applyEmail,
          contentJson: JSON.stringify({
            format: 'lexical',
            version: 1,
            doc: body,
            plain: body.replace(/<[^>]*>/g, '').slice(0, 500),
          }),
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
        <PageHeader title="Post a Job" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={CheckmarkCircle02Icon} size="xl" className="text-success" />
            <p className="text-lg font-semibold text-text-primary">Job posted!</p>
            <Button
              onClick={() => {
                setDone(false);
                setTitle('');
                setBody('');
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
      <PageHeader title="Post a Job" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
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
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Describe the role, responsibilities, requirements…"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
            />
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
