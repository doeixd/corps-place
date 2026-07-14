import { memo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { DISCIPLINE_LABEL } from '@/lib/jobs/disciplines';
import { formatDistance } from '@/lib/geo';
import { cn } from '@/lib/utils';
import { HeartAddIcon, SentIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import type { listJobs } from '@/lib/server-fns/jobs';

export type JobRow = Awaited<ReturnType<typeof listJobs>>['rows'][number];

/** Plain-text preview pulled from the stored Lexical {doc, plain} blob (already on the row). */
export function descriptionPreview(job: JobRow): string {
  try {
    const parsed = JSON.parse((job as { content_json?: string }).content_json ?? '');
    const plain = typeof parsed?.plain === 'string' ? parsed.plain : '';
    return plain.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** One labeled meta row — a subtle uppercase label + its value. */
function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[4.25rem] shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate text-text-primary">{children}</dd>
    </div>
  );
}

/** Small, borderless heart that toggles the saved state (animated like the detail page). */
function CardFavoriteButton({ saved, onClick }: { saved: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={saved ? 'Remove bookmark' : 'Save job'}
      aria-pressed={saved}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors',
        saved ? 'text-primary' : 'text-text-muted hover:text-primary'
      )}
    >
      {/* Two crossfading icons via CSS transition (no motion/react — this card
          is on the home route's critical path; the animation library is 40KB). */}
      <span className="relative inline-flex">
        <span
          className={cn(
            'absolute inset-0 inline-flex items-center justify-center transition-[opacity,transform] duration-200 ease-out',
            saved ? 'scale-100 opacity-100' : 'scale-[0.3] opacity-0'
          )}
        >
          <Icon icon={FavouriteIcon} size="sm" />
        </span>
        <span
          className={cn(
            'inline-flex transition-[opacity,transform] duration-200 ease-out',
            saved ? 'scale-[0.3] opacity-0' : 'scale-100 opacity-100'
          )}
        >
          <Icon icon={HeartAddIcon} size="sm" />
        </span>
      </span>
    </button>
  );
}

/** Small, borderless share button — native share sheet, else copy link. */
function CardShareButton({ slug, title }: { slug: string; title: string }) {
  return (
    <button
      type="button"
      aria-label="Share job"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = `${window.location.origin}/jobs/${slug}`;
        if (typeof navigator !== 'undefined' && navigator.share) {
          navigator.share({ title, url }).catch(() => {});
        } else {
          void navigator.clipboard?.writeText(url);
          toast.success('Link copied');
        }
      }}
      className="inline-flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:text-primary"
    >
      <Icon icon={SentIcon} size="sm" />
    </button>
  );
}

/**
 * The canonical job card: title + labeled meta (employer / location / discipline /
 * salary), a short description preview, and remote/boosted badges. Shared by the
 * job board and the PageantryJobs landing so they stay visually identical. Pass
 * `onToggleSave` to show the save heart (board); omit it for read-only contexts.
 */
export const JobCard = memo(function JobCard({
  job,
  saved = false,
  onToggleSave,
}: {
  job: JobRow;
  saved?: boolean;
  onToggleSave?: (postingId: string) => void;
}) {
  const salary =
    job.comp_text ||
    (job.salary_min || job.salary_max
      ? `${job.salary_min ? `$${job.salary_min.toLocaleString()}` : ''}${
          job.salary_min && job.salary_max ? '–' : ''
        }${job.salary_max ? `$${job.salary_max.toLocaleString()}` : ''}`
      : null);
  const d = job.distance_miles ?? null;
  const employer = job.employer_name && job.employer_name !== 'User' ? job.employer_name : null;
  const location = job.location
    ? d != null
      ? `${job.location} · ${formatDistance(d)}`
      : job.location
    : d != null
      ? formatDistance(d)
      : null;
  const preview = descriptionPreview(job);

  return (
    // `group` so hovering anywhere (incl. the action buttons) lifts the card, and
    // the buttons lift with it via group-hover below.
    <div className="group relative h-full">
      <Link
        to="/jobs/$jobSlug"
        params={{ jobSlug: job.slug }}
        className="block h-full focus-visible:outline-none"
      >
        <Card className="card-hover h-full">
          <CardContent className="flex h-full flex-col gap-3 py-5">
            <h3 className="pr-16 text-base font-semibold leading-snug text-text-primary">
              {job.title}
            </h3>
            <dl className="space-y-1.5 text-sm">
              {employer ? <MetaField label="Employer">{employer}</MetaField> : null}
              {location ? <MetaField label="Location">{location}</MetaField> : null}
              {job.discipline ? (
                <MetaField label="Discipline">
                  {DISCIPLINE_LABEL[job.discipline] ?? job.discipline}
                </MetaField>
              ) : null}
              {salary ? <MetaField label="Salary">{salary}</MetaField> : null}
            </dl>
            {preview ? (
              <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{preview}</p>
            ) : null}
            {job.remote_ok || job.is_boosted ? (
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                {job.remote_ok ? (
                  <Badge variant="secondary-light" size="sm">
                    Remote
                  </Badge>
                ) : null}
                {job.is_boosted ? (
                  <Badge variant="warning-light" size="sm">
                    Boosted
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </Link>
      {/* Subtle, borderless actions — siblings of the Link so they don't nest
          interactives. Lift in sync with the card's hover (-translate-y-1). */}
      <div className="absolute right-3 top-3.5 flex gap-0.5 transition-transform duration-200 group-hover:-translate-y-1">
        {onToggleSave ? (
          <CardFavoriteButton saved={saved} onClick={() => onToggleSave(job.posting_id)} />
        ) : null}
        <CardShareButton slug={job.slug} title={job.title} />
      </div>
    </div>
  );
});
