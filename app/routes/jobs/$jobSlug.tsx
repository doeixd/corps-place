import { createFileRoute, Link } from '@tanstack/react-router';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/reui/badge';
import { PageShell } from '@/components/page-shell';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';
import {
  getJobPosting,
  applyToJob,
  reportContent,
  createBoostCheckout,
  bookmarkJob,
  removeBookmark,
} from '@/lib/server-fns/jobs';
import {
  Briefcase01Icon,
  Location01Icon,
  CheckmarkCircle02Icon,
  Alert02Icon,
  FireIcon,
  BookOpen01Icon,
  SentIcon,
} from '@/components/icons/generated';
import { useState } from 'react';

export const Route = createFileRoute('/jobs/$jobSlug')({
  loader: async ({ params }) => getJobPosting({ slug: params.jobSlug }),
  head: ({ loaderData }) => {
    if (!loaderData) return seoHead({ title: 'Job Not Found — PageantryJobs', description: '' });
    const title = `${loaderData.title} — PageantryJobs`;
    const desc = clampDescription(loaderData.comp_text, `${loaderData.title} job posting`);
    const url = `/jobs/${loaderData.slug}`;
    const jobPostingLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: loaderData.title,
      description: loaderData.comp_text ?? '',
      datePosted: loaderData.published_at ?? loaderData.created_at,
      hiringOrganization: { '@type': 'Organization', name: 'PageantryJobs' },
    };
    if (loaderData.location) {
      jobPostingLd.jobLocation = {
        '@type': 'Place',
        address: { addressLocality: loaderData.location },
      };
    }
    if (loaderData.remote_ok) {
      jobPostingLd.employmentType = 'SEASONAL';
      jobPostingLd.remote = true;
    }
    if (loaderData.salary_min || loaderData.salary_max) {
      const value: Record<string, unknown> = { '@type': 'QuantitativeValue' };
      if (loaderData.salary_min) value.minValue = loaderData.salary_min;
      if (loaderData.salary_max) value.maxValue = loaderData.salary_max;
      jobPostingLd.baseSalary = { '@type': 'MonetaryAmount', value };
    }

    return seoHead({
      title,
      description: desc,
      path: url,
      image: 'https://pageantryjobs.com/og-jobs.png',
      jsonLd: [
        breadcrumbLd([
          { name: 'Job Board', path: '/jobs/board' },
          { name: loaderData.title, path: url },
        ]),
        jobPostingLd,
      ],
    });
  },
  component: JobDetail,
});

function JobDetail() {
  const { data: session } = useSession();
  const job = Route.useLoaderData();
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);

  if (!job) {
    return (
      <PageShell>
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p className="text-lg font-medium text-text-primary">Job not found</p>
          <Link to="/jobs/board" className="text-sm text-primary underline hover:no-underline">
            Browse jobs
          </Link>
        </div>
      </PageShell>
    );
  }

  const handleApply = async () => {
    if (!session) return;
    setApplying(true);
    try {
      await applyToJob({ postingId: job.posting_id });
      setApplied(true);
    } catch {
      /* ignore */
    } finally {
      setApplying(false);
    }
  };

  const content = (() => {
    try {
      return JSON.parse(job.content_json);
    } catch {
      return null;
    }
  })();

  return (
    <PageShell>
      <Card className="mb-6">
        <CardContent className="space-y-4 py-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{job.title}</h1>
              {job.location ? (
                <p className="mt-1 flex items-center gap-1.5 text-text-secondary">
                  <Icon icon={Location01Icon} size="xs" /> {job.location}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {job.remote_ok ? (
                  <Badge variant="secondary-light" size="sm">
                    Remote OK
                  </Badge>
                ) : null}
                {job.is_boosted ? (
                  <Badge variant="warning-light" size="sm">
                    Boosted
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {job.apply_url ? (
                <a
                  href={job.apply_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
                >
                  <Icon icon={Briefcase01Icon} size="sm" /> Apply Now
                </a>
              ) : session && !applied ? (
                <Button onClick={handleApply} disabled={applying} size="sm">
                  {applying ? 'Applying…' : 'Apply'}
                </Button>
              ) : applied ? (
                <span className="inline-flex items-center gap-1 text-sm text-success">
                  <Icon icon={CheckmarkCircle02Icon} size="xs" /> Applied
                </span>
              ) : null}
              <Button
                onClick={async () => {
                  if (confirm('Report this job posting as inappropriate?')) {
                    await reportContent({ targetKind: 'posting', targetId: job.posting_id }).catch(
                      () => {}
                    );
                    alert('Report submitted. A moderator will review it.');
                  }
                }}
                variant="ghost"
                size="xs"
                className="text-text-muted hover:text-destructive"
              >
                <Icon icon={Alert02Icon} size="xs" /> Report
              </Button>
              {!job.is_boosted ? (
                <Button
                  onClick={async () => {
                    try {
                      const result = await createBoostCheckout({
                        postingId: job.posting_id,
                        slug: job.slug,
                      });
                      if (result.url) window.location.href = result.url;
                    } catch (e) {
                      alert((e as Error).message);
                    }
                  }}
                  variant="outline"
                  size="xs"
                >
                  <Icon icon={FireIcon} size="xs" /> Boost
                </Button>
              ) : null}
              <BookmarkButton postingId={job.posting_id} />
              <ShareButton />
            </div>
          </div>

          {/* Compensation */}
          {job.comp_text || job.salary_min || job.salary_max ? (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <span className="font-medium text-text-primary">Compensation: </span>
              {job.comp_text ? (
                <span className="text-text-secondary">{job.comp_text}</span>
              ) : job.salary_min || job.salary_max ? (
                <span className="text-text-secondary">
                  {job.salary_min ? `$${job.salary_min.toLocaleString()}` : ''}
                  {job.salary_min && job.salary_max ? ' — ' : ''}
                  {job.salary_max ? `$${job.salary_max.toLocaleString()}` : ''}
                  {job.salary_min || job.salary_max ? ` ${job.salary_currency ?? 'USD'}` : ''}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardContent className="py-5">
          <h2 className="mb-3 text-base font-semibold text-text-primary">Job Description</h2>
          {content?.plain ? (
            <p className="whitespace-pre-line text-sm text-text-secondary">{content.plain}</p>
          ) : (
            <p className="text-sm text-text-muted">No description provided.</p>
          )}
        </CardContent>
      </Card>
      {/* Similar jobs — same location or remote */}
      {job.location ? <SimilarJobsSection location={job.location} slug={job.slug} /> : null}
    </PageShell>
  );
}

function BookmarkButton({ postingId }: { postingId: string }) {
  const { data: session } = useSession();
  const [bookmarked, setBookmarked] = useState(false);
  const [toggling, setToggling] = useState(false);

  if (!session) return null;

  return (
    <Button
      onClick={async () => {
        setToggling(true);
        try {
          if (bookmarked) {
            await removeBookmark({ postingId });
            setBookmarked(false);
          } else {
            await bookmarkJob({ postingId });
            setBookmarked(true);
          }
        } catch {
          /* ignore */
        } finally {
          setToggling(false);
        }
      }}
      disabled={toggling}
      variant="ghost"
      size="xs"
      className={bookmarked ? 'text-primary' : 'text-text-muted hover:text-primary'}
    >
      <Icon icon={BookOpen01Icon} size="xs" /> {bookmarked ? 'Saved' : 'Save'}
    </Button>
  );
}

function ShareButton() {
  const onShare = async () => {
    if (typeof navigator === 'undefined') return;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url: window.location.href });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
      }
    } catch {
      /* user dismissed */
    }
  };
  return (
    <button
      type="button"
      onClick={onShare}
      aria-label="Share"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:border-primary/60 hover:text-primary"
    >
      <Icon icon={SentIcon} size="sm" className="-translate-x-px translate-y-px" />
    </button>
  );
}

function SimilarJobsSection({ location, slug }: { location: string; slug: string }) {
  const [similar, setSimilar] = useState<any[] | null>(null);
  if (!similar) {
    // Simple client-side fetch for similar jobs by location
    import('@/lib/server-fns/jobs')
      .then((m) => m.listJobs({ location, offset: 0, limit: 3 }))
      .then((r) => setSimilar(r.rows.filter((j: any) => j.slug !== slug).slice(0, 3)))
      .catch(() => setSimilar([]));
  }
  if (!similar || similar.length === 0) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-3 text-base font-semibold text-text-primary">Similar Jobs</h2>
        <div className="space-y-2">
          {similar.map((j: any) => (
            <Link
              key={j.posting_id}
              to="/jobs/$jobSlug"
              params={{ jobSlug: j.slug }}
              className="group flex items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary group-hover:text-primary">
                  {j.title}
                </p>
                {j.location ? <p className="text-xs text-text-muted">{j.location}</p> : null}
              </div>
              <Icon icon={Briefcase01Icon} size="sm" className="icon-shift text-text-muted" />
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
