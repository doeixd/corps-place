import { createFileRoute, Link } from '@tanstack/react-router';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { PageShell } from '@/components/page-shell';
import { seoHead, breadcrumbLd, clampDescription, SITE_URL } from '@/lib/seo';
import {
  getJobPosting,
  applyToJob,
  hasAppliedToJob,
  reportContent,
  bookmarkJob,
  removeBookmark,
  isJobBookmarked,
} from '@/lib/server-fns/jobs';
import { SignInButton } from '@/components/sign-in-button';
import {
  Briefcase01Icon,
  Location01Icon,
  CheckmarkCircle02Icon,
  FireIcon,
  HeartAddIcon,
  SentIcon,
} from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { lazy, Suspense, useEffect, useState } from 'react';
import { celebrate } from '@/lib/confetti';
import { ConfirmDialog } from '@/components/fantasy/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { toast } from 'sonner';
// Lazy: the Lexical runtime is ~200KB and only renders the rich description —
// the plain-text flattening (what LexicalView itself SSRs pre-mount) serves as
// the Suspense fallback, so text is visible immediately either way.
const LexicalView = lazy(() =>
  import('@/components/jobs/lexical-view').then((m) => ({ default: m.LexicalView }))
);
import { SectionErrorBoundary } from '@/components/error-boundary';

export const Route = createFileRoute('/jobs/$jobSlug')({
  loader: async ({ params }) => getJobPosting({ data: { slug: params.jobSlug } }),
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
      // Marching-arts staff roles are overwhelmingly seasonal contract work.
      employmentType: 'SEASONAL',
      identifier: { '@type': 'PropertyValue', name: 'PageantryJobs', value: loaderData.slug },
      hiringOrganization: {
        '@type': 'Organization',
        name: employerName(loaderData) ?? 'PageantryJobs',
        sameAs: 'https://pageantryjobs.com',
      },
      // Applicants apply on-site (PageantryJobs), which Google for Jobs rewards.
      directApply: true,
    };
    // validThrough keeps the posting from being flagged stale / dropped by Google.
    if (loaderData.expires_at) jobPostingLd.validThrough = loaderData.expires_at;
    if (loaderData.location) {
      jobPostingLd.jobLocation = {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', addressLocality: loaderData.location },
      };
    }
    if (loaderData.remote_ok) {
      jobPostingLd.jobLocationType = 'TELECOMMUTE';
      jobPostingLd.applicantLocationRequirements = { '@type': 'Country', name: 'USA' };
    }
    if (loaderData.salary_min || loaderData.salary_max) {
      // Google needs currency + a period (unitText) for baseSalary to be valid;
      // the data captures min/max + currency, so default the period to YEAR.
      const value: Record<string, unknown> = { '@type': 'QuantitativeValue', unitText: 'YEAR' };
      if (loaderData.salary_min) value.minValue = loaderData.salary_min;
      if (loaderData.salary_max) value.maxValue = loaderData.salary_max;
      jobPostingLd.baseSalary = {
        '@type': 'MonetaryAmount',
        currency: loaderData.salary_currency ?? 'USD',
        value,
      };
    }

    return seoHead({
      title,
      description: desc,
      path: url,
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

// A posting's auto-provisioned employer profile defaults its name to 'User' until
// the employer fills it in — treat that (and empty) as "no real name to show".
function employerName(job: {
  employer_name?: string | null;
}): string | null {
  const n = job.employer_name?.trim();
  return n && n !== 'User' ? n : null;
}

function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function JobDetail() {
  const { data: session } = useSession();
  const job = Route.useLoaderData();
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [note, setNote] = useState('');

  // Reflect a prior application so "Application sent ✓" persists across reloads/return
  // visits (and the Apply button doesn't reappear). Skipped when signed out or no posting.
  const postingId = job?.posting_id;
  useEffect(() => {
    if (!session || !postingId) return;
    let cancelled = false;
    void hasAppliedToJob({ data: { postingId } })
      .then((did) => {
        if (!cancelled && did) setApplied(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, postingId]);

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
      await applyToJob({ data: { postingId: job.posting_id, message: note.trim() || undefined } });
      setApplied(true);
      setShowApply(false);
      void celebrate();
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

  const compensation =
    job.comp_text ||
    (job.salary_min || job.salary_max
      ? `${job.salary_min ? `$${job.salary_min.toLocaleString()}` : ''}${
          job.salary_min && job.salary_max ? '–' : ''
        }${job.salary_max ? `$${job.salary_max.toLocaleString()}` : ''}`
      : null);

  const postedAt = relativeTime(job.published_at ?? job.created_at);

  const keyFacts: Array<{ label: string; value: string }> = [];
  if (job.location) keyFacts.push({ label: 'Location', value: job.location });
  if (compensation) keyFacts.push({ label: 'Compensation', value: compensation });
  keyFacts.push({ label: 'Work type', value: job.remote_ok ? 'Remote' : 'On-site' });
  if (postedAt) keyFacts.push({ label: 'Posted', value: postedAt });

  const empName = employerName(job);

  const expired =
    job.status === 'closed' ||
    (job.expires_at != null && new Date(job.expires_at).getTime() < Date.now());

  const applyCta = expired ? (
    <div className="rounded-lg border border-border bg-muted/30 px-5 py-3 text-sm text-text-muted sm:self-start">
      This listing is no longer accepting applications.
    </div>
  ) : job.apply_url ? (
    <div className="flex flex-col gap-1">
      <a
        href={job.apply_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 sm:w-auto sm:self-start"
      >
        <Icon icon={Briefcase01Icon} size="sm" /> Apply on the employer&apos;s site
      </a>
      <span className="text-xs text-text-muted">You&apos;ll apply on the employer&apos;s own site.</span>
    </div>
  ) : applied ? (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-success/10 px-5 py-2.5 text-sm font-medium text-success sm:self-start">
        <Icon icon={CheckmarkCircle02Icon} size="sm" /> Application sent — the employer can now see your
        profile
      </span>
      <span className="text-xs text-text-muted">Their reply, if any, will come by email.</span>
    </div>
  ) : session ? (
    showApply ? (
      <div className="w-full space-y-2 rounded-lg border border-border bg-muted/30 p-3 sm:max-w-md">
        <label className="text-sm font-medium text-text-primary">
          Add a note to the employer (optional)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="Why you're a great fit…"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
        />
        <p className="text-xs text-text-muted">
          Your PageantryJobs profile and this note will be shared with the employer.
        </p>
        <div className="flex gap-2">
          <Button onClick={handleApply} disabled={applying} size="sm">
            {applying ? 'Sending…' : 'Send application'}
          </Button>
          <Button onClick={() => setShowApply(false)} variant="ghost" size="sm" disabled={applying}>
            Cancel
          </Button>
        </div>
      </div>
    ) : (
      <Button onClick={() => setShowApply(true)} className="w-full sm:w-auto">
        Apply
      </Button>
    )
  ) : (
    <div className="flex flex-col gap-1.5 sm:items-start">
      <span className="text-sm text-text-muted">Sign in to apply</span>
      <SignInButton callbackURL={`/jobs/${job.slug}`}>Sign in to apply</SignInButton>
    </div>
  );

  return (
    <PageShell>
      <Card className="mb-6">
        <CardContent className="space-y-5 py-6">
          <div>
            <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">{job.title}</h1>
            {empName ? (
              <Link
                to="/jobs/profile/$slug"
                params={{ slug: job.employer_slug ?? '' }}
                className="mt-2 inline-flex items-center gap-2 text-sm text-text-secondary hover:text-primary"
              >
                {job.employer_image_media_id ? (
                  <img
                    src={`/api/fantasy-media/${job.employer_image_media_id}`}
                    alt={empName}
                    className="size-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {empName.charAt(0)}
                  </span>
                )}
                <span>Posted by {empName}</span>
              </Link>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
              {job.location ? (
                <span className="flex items-center gap-1">
                  <Icon icon={Location01Icon} size="xs" /> {job.location}
                </span>
              ) : null}
              {job.location && job.remote_ok ? <span>•</span> : null}
              {job.remote_ok ? <span>Remote</span> : null}
              {(job.location || job.remote_ok) && postedAt ? <span>•</span> : null}
              {postedAt ? <span>Posted {postedAt}</span> : null}
            </div>
            {job.is_boosted ? (
              <div className="mt-2">
                <Badge variant="warning-light" size="sm">
                  <Icon icon={FireIcon} size="xs" /> Boosted
                </Badge>
              </div>
            ) : null}
          </div>

          {/* Key facts strip */}
          {keyFacts.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {keyFacts.map((fact) => (
                <div key={fact.label} className="rounded-lg bg-muted/50 px-3 py-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                    {fact.label}
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-text-primary">{fact.value}</p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <SectionErrorBoundary label="the apply panel">{applyCta}</SectionErrorBoundary>
            <div className="flex flex-wrap items-center gap-1">
              <BookmarkButton postingId={job.posting_id} />
              <ShareButton />
              <ConfirmDialog
                title="Report this job posting?"
                description="Flag this listing as inappropriate. A moderator will review it."
                confirmLabel="Report"
                onConfirm={async () => {
                  await reportContent({
                    data: { targetKind: 'posting', targetId: job.posting_id },
                  }).catch(() => {});
                  toast.success('Report submitted. A moderator will review it.');
                }}
                trigger={
                  <Button variant="ghost" size="xs" className="text-text-muted hover:text-destructive">
                    Report
                  </Button>
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardContent className="py-5">
          <h2 className="mb-3 text-base font-semibold text-text-primary">Job Description</h2>
          <SectionErrorBoundary label="the job description">
            {content?.format === 'lexical' &&
            typeof content.doc === 'string' &&
            content.doc.trim().startsWith('{') &&
            content.doc.includes('"root"') ? (
              <Suspense
                fallback={
                  <div className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">
                    {content.plain ?? ''}
                  </div>
                }
              >
                <LexicalView doc={content.doc} plain={content.plain ?? ''} />
              </Suspense>
            ) : content?.plain ? (
              <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">
                {content.plain}
              </p>
            ) : (
              <p className="text-sm text-text-muted">No description provided.</p>
            )}
          </SectionErrorBoundary>
        </CardContent>
      </Card>
      {/* Similar jobs — same location or remote */}
      {job.location ? (
        <SectionErrorBoundary label="similar jobs">
          <SimilarJobsSection location={job.location} slug={job.slug} />
        </SectionErrorBoundary>
      ) : null}
    </PageShell>
  );
}

function BookmarkButton({ postingId }: { postingId: string }) {
  const { data: session } = useSession();
  const [bookmarked, setBookmarked] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Reflect an existing bookmark so the button shows "Saved" on return visits
  // (mirrors the Apply button's hasAppliedToJob check). Skipped when signed out.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void isJobBookmarked({ data: { postingId } })
      .then((did) => {
        if (!cancelled && did) setBookmarked(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, postingId]);

  if (!session) return null;

  const label = bookmarked ? 'Remove bookmark' : 'Save job';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={bookmarked}
            disabled={toggling}
            onClick={async () => {
              setToggling(true);
              try {
                if (bookmarked) {
                  await removeBookmark({ data: { postingId } });
                  setBookmarked(false);
                } else {
                  await bookmarkJob({ data: { postingId } });
                  setBookmarked(true);
                }
              } catch {
                /* ignore */
              } finally {
                setToggling(false);
              }
            }}
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50',
              bookmarked
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border text-text-secondary hover:border-primary/60 hover:text-primary'
            )}
          />
        }
      >
        <span className="relative inline-flex">
          <motion.span
            animate={{ opacity: bookmarked ? 1 : 0, scale: bookmarked ? 1 : 0.3 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            <Icon icon={FavouriteIcon} size="sm" />
          </motion.span>
          <motion.span
            animate={{ opacity: bookmarked ? 0 : 1, scale: bookmarked ? 0.3 : 1 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="inline-flex"
          >
            <Icon icon={HeartAddIcon} size="sm" />
          </motion.span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
  // Simple client-side fetch for similar jobs by location
  useEffect(() => {
    let alive = true;
    import('@/lib/server-fns/jobs')
      .then((m) => m.listJobs({ data: { location, offset: 0, limit: 3 } }))
      .then((r) => { if (alive) setSimilar(r.rows.filter((j: any) => j.slug !== slug).slice(0, 3)); })
      .catch(() => { if (alive) setSimilar([]); });
    return () => { alive = false; };
  }, [location, slug]);
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
