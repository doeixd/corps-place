import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import {
  Search01Icon,
  UserMultipleIcon,
  AddCircleIcon,
  BookOpen01Icon,
} from '@/components/icons/generated';

export function JobsLanding() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const runSearch = () => {
    const q = query.trim();
    void navigate({ to: '/jobs/board', search: q ? { q } : {} });
  };

  return (
    <PageShell>
      {/* Hero */}
      <section className="flex flex-col items-center gap-6 py-12 text-center sm:py-20">
        <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
          For the pageantry &amp; marching-arts community
        </span>
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight text-text-primary sm:text-5xl">
          Find your next gig in the pageantry world
        </h1>
        <p className="max-w-lg text-lg text-text-secondary">
          The job board for drum corps, marching band, winter guard, and indoor percussion
          professionals.
        </p>

        {/* Search bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
          className="mt-4 flex w-full max-w-xl gap-2"
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search jobs, skills, or keywords…"
            className="h-11 flex-1 rounded-lg border border-border bg-card px-4 text-sm text-text-primary outline-none ring-0 placeholder:text-text-muted focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
          <button
            type="submit"
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            <Icon icon={Search01Icon} size="sm" />
            Search
          </button>
        </form>

        <div className="flex gap-3">
          <Link
            to="/jobs/me"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:border-primary/60"
          >
            <Icon icon={UserMultipleIcon} size="sm" />
            Create profile
          </Link>
          <Link
            to="/jobs/post"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:border-primary/60"
          >
            <Icon icon={AddCircleIcon} size="sm" />
            Post a job
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="space-y-6 py-8">
        <h2 className="text-center text-xl font-semibold text-text-primary">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="card-hover-flat">
            <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Icon icon={UserMultipleIcon} size="lg" className="text-primary" />
              </div>
              <h3 className="font-semibold text-text-primary">Create your profile</h3>
              <p className="text-sm text-text-secondary">
                Showcase your experience, skills, and availability. Your profile is your industry
                home page.
              </p>
            </CardContent>
          </Card>
          <Card className="card-hover-flat">
            <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Icon icon={Search01Icon} size="lg" className="text-primary" />
              </div>
              <h3 className="font-semibold text-text-primary">Get discovered</h3>
              <p className="text-sm text-text-secondary">
                Employers search by location, skills, and experience. Save searches and get notified
                when new jobs match.
              </p>
            </CardContent>
          </Card>
          <Card className="card-hover-flat">
            <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Icon icon={BookOpen01Icon} size="lg" className="text-primary" />
              </div>
              <h3 className="font-semibold text-text-primary">Apply or hire</h3>
              <p className="text-sm text-text-secondary">
                Apply with one click or post openings to find the best talent in the pageantry
                community.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* CTA footer */}
      <section className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-2xl font-bold text-text-primary">
          Ready to find your next opportunity?
        </h2>
        <div className="flex gap-3">
          <Link
            to="/jobs/me"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            <Icon icon={UserMultipleIcon} size="sm" />
            Create your profile
          </Link>
          <Link
            to="/jobs/post"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-primary/60"
          >
            <Icon icon={AddCircleIcon} size="sm" />
            Post a job
          </Link>
        </div>
      </section>

      {/* Legal footer */}
      <footer className="border-t border-border pt-6 text-center">
        <p className="text-xs text-text-muted">
          <Link to="/jobs/terms" className="transition-colors hover:text-text-secondary">
            Terms of Service
          </Link>
          <span className="mx-2 text-border">·</span>
          <Link to="/jobs/privacy" className="transition-colors hover:text-text-secondary">
            Privacy Policy
          </Link>
          <span className="mx-2 text-border">·</span>
          <Link to="/jobs/guidelines" className="transition-colors hover:text-text-secondary">
            Content Guidelines
          </Link>
        </p>
      </footer>
    </PageShell>
  );
}
