import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { PageShell } from '@/components/page-shell';
import { seoHead, breadcrumbLd, clampDescription } from '@/lib/seo';
import { getJobsProfile } from '@/lib/server-fns/jobs';
import { UserMultipleIcon, Briefcase01Icon, SentIcon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/profile/$slug')({
  loader: async ({ params }) => getJobsProfile({ data: { slug: params.slug } }),
  head: ({ loaderData }) => {
    const p = loaderData?.profile;
    const name = p?.display_name ?? 'Profile';
    const path = `/jobs/profile/${p?.slug ?? ''}`;
    const isEmployee = p?.kind === 'employee';
    return seoHead({
      title: `${name} — PageantryJobs profile`,
      description: clampDescription(p?.headline, `View ${name}'s profile on PageantryJobs.`),
      path,
      jsonLd: [
        breadcrumbLd([
          { name: 'Talent Search', path: '/jobs/talent' },
          { name, path },
        ]),
        (() => {
          const base: Record<string, unknown> = {
            '@context': 'https://schema.org',
            '@type': isEmployee ? 'Person' : 'Organization',
            name,
          };
          if (p?.location) {
            const loc = { '@type': 'Place', address: { addressLocality: p.location } } as const;
            base[isEmployee ? 'homeLocation' : 'location'] = loc;
          }
          return base;
        })(),
      ],
    });
  },
  component: PublicProfile,
});

function PublicProfile() {
  const data = Route.useLoaderData();
  if (!data) {
    return (
      <PageShell>
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <Icon icon={UserMultipleIcon} size="xl" className="text-text-muted" />
          <p className="text-lg font-medium text-text-primary">Profile not found</p>
          <Link to="/jobs/board" className="text-sm text-primary underline hover:no-underline">
            Browse jobs
          </Link>
        </div>
      </PageShell>
    );
  }

  const { profile, blocks } = data;
  const blockByKind = (kind: string) => {
    const b = blocks.find((bl) => bl.kind === kind);
    return b ? (JSON.parse(b.content_json) as Record<string, unknown>) : null;
  };
  const summary = blockByKind('summary') as { plain?: string } | null;
  const experience = blockByKind('experience') as {
    items?: Array<{ org: string; role?: string; startYear?: string; endYear?: string }>;
  } | null;
  const skills = blockByKind('skills') as { items?: string[] } | null;

  return (
    <PageShell>
      {/* Header */}
      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-start">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 sm:size-20">
            <Icon icon={UserMultipleIcon} size="xl" className="text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-text-primary">{profile.display_name}</h1>
            {profile.headline ? <p className="text-text-secondary">{profile.headline}</p> : null}
            {profile.location ? (
              <p className="mt-1 text-sm text-text-muted">{profile.location}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="secondary" size="sm">
                {profile.kind === 'employer' ? 'Employer' : 'Professional'}
              </Badge>
              {profile.status === 'published' ? (
                <Badge variant="success-light" size="sm">
                  Active
                </Badge>
              ) : null}
            </div>
          </div>
          <ShareButton />
        </CardContent>
      </Card>

      <div className="space-y-6">
        {/* Summary */}
        {summary?.plain ? (
          <Card>
            <CardContent className="py-5">
              <h2 className="mb-3 text-base font-semibold text-text-primary">Summary</h2>
              <p className="whitespace-pre-line text-sm text-text-secondary">{summary.plain}</p>
            </CardContent>
          </Card>
        ) : null}

        {/* Experience */}
        {experience?.items && experience.items.length > 0 ? (
          <Card>
            <CardContent className="py-5">
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-text-primary">
                <Icon icon={Briefcase01Icon} size="sm" />
                Experience
              </h2>
              <div className="space-y-4">
                {experience.items.map((item, i) => (
                  <div key={i} className="border-b border-border pb-4 last:border-0 last:pb-0">
                    <p className="font-medium text-text-primary">{item.org}</p>
                    {item.role ? <p className="text-sm text-text-secondary">{item.role}</p> : null}
                    {item.startYear || item.endYear ? (
                      <p className="text-xs text-text-muted">
                        {item.startYear || '?'} — {item.endYear || 'Present'}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Skills */}
        {skills?.items && skills.items.length > 0 ? (
          <Card>
            <CardContent className="py-5">
              <h2 className="mb-3 text-base font-semibold text-text-primary">Skills</h2>
              <div className="flex flex-wrap gap-2">
                {skills.items.map((skill, i) => (
                  <Badge key={i} variant="secondary-light" size="sm">
                    {skill}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Other blocks */}
        {blocks
          .filter((b) => !['summary', 'experience', 'skills'].includes(b.kind))
          .map((block) => (
            <Card key={block.kind}>
              <CardContent className="py-5">
                <h2 className="mb-3 text-base font-semibold capitalize text-text-primary">
                  {block.kind}
                </h2>
                <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-3 text-xs text-text-secondary">
                  {JSON.stringify(JSON.parse(block.content_json), null, 2)}
                </pre>
              </CardContent>
            </Card>
          ))}
      </div>

      {/* Footer */}
      <footer className="mt-8 border-t border-border pt-6 text-center">
        <p className="text-xs text-text-muted">
          <Link to="/jobs/terms" className="transition-colors hover:text-text-secondary">
            Terms
          </Link>
          <span className="mx-2 text-border">·</span>
          <Link to="/jobs/privacy" className="transition-colors hover:text-text-secondary">
            Privacy
          </Link>
        </p>
      </footer>
    </PageShell>
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
