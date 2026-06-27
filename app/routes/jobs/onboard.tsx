import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { jobsOnboardMachine } from '@/machines/jobs-onboard-machine';
import { ResumeUpload } from '@/components/jobs/resume-upload';
import { CheckmarkCircle02Icon, AddCircleIcon } from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';

export const Route = createFileRoute('/jobs/onboard')({
  head: () =>
    buildSeo({
      title: 'Create Your Profile — PageantryJobs',
      description: '',
      path: '/jobs/onboard',
      noindex: true,
    }),
  component: OnboardPage,
});

const STEPS = ['About', 'Experience', 'Skills', 'Availability', 'Review'] as const;

function ProgressBar({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={`flex size-7 items-center justify-center rounded-full text-xs font-medium ${
              i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-text-muted'
            }`}
          >
            {i + 1}
          </div>
          <span
            className={`text-sm ${i <= step ? 'text-text-primary' : 'text-text-muted'} hidden sm:inline`}
          >
            {label}
          </span>
          {i < STEPS.length - 1 ? (
            <div className={`h-px w-4 ${i < step ? 'bg-primary' : 'bg-border'}`} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function OnboardPage() {
  const { data: session } = useSession();
  const [snapshot, send] = useMachine(jobsOnboardMachine);
  const ctx = snapshot.context;

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Create Your Profile" backTo="/" backLabel="Home" />
        <JobsSignInGate icon={AddCircleIcon} title="Create your profile" path="/jobs/onboard" />
      </PageShell>
    );
  }

  if (snapshot.matches('done')) {
    return (
      <PageShell>
        <PageHeader title="Profile Created!" backTo="/jobs/me" backLabel="My Profile" />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={CheckmarkCircle02Icon} size="xl" className="text-success" />
            <p className="text-lg font-semibold text-text-primary">Your profile is live!</p>
            <p className="text-sm text-text-secondary">
              Employers can now find you on PageantryJobs.
            </p>
            <Link to="/jobs/me" className="text-sm text-primary underline hover:no-underline">
              View my profile
            </Link>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const currentStep = (() => {
    if (snapshot.matches('about') || snapshot.matches('savingStep1')) return 0;
    if (snapshot.matches('experience') || snapshot.matches('savingStep2')) return 1;
    if (snapshot.matches('skills') || snapshot.matches('savingStep3')) return 2;
    if (snapshot.matches('availability') || snapshot.matches('savingStep4')) return 3;
    if (snapshot.matches('review') || snapshot.matches('publishing')) return 4;
    return 0;
  })();

  const isSaving = snapshot.toString().includes('saving') || snapshot.matches('publishing');

  return (
    <PageShell>
      <PageHeader
        title="Create Your Profile"
        subtitle="PageantryJobs"
        backTo="/"
        backLabel="Home"
      />

      <div className="mx-auto max-w-2xl space-y-6">
        <ProgressBar step={currentStep} />

        {/* Step 1: About */}
        {snapshot.matches('about') || snapshot.matches('savingStep1') ? (
          <>
            {ctx.profileId ? (
              <ResumeUpload profileId={ctx.profileId} onComplete={() => {}} />
            ) : null}
            <Card>
              <CardContent className="space-y-4 py-5">
                <h2 className="text-lg font-semibold text-text-primary">About You</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="text-sm font-medium">Display Name *</label>
                    <input
                      value={ctx.displayName}
                      onChange={(e) => send({ type: 'SET_DISPLAY_NAME', value: e.target.value })}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Profile Type</label>
                    <select
                      value={ctx.kind}
                      onChange={(e) =>
                        send({ type: 'SET_KIND', value: e.target.value as 'employee' | 'employer' })
                      }
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    >
                      <option value="employee">Employee</option>
                      <option value="employer">Employer</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Headline</label>
                    <input
                      value={ctx.headline}
                      onChange={(e) => send({ type: 'SET_HEADLINE', value: e.target.value })}
                      placeholder="e.g. Brass Caption Head"
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Location</label>
                    <input
                      value={ctx.location}
                      onChange={(e) => send({ type: 'SET_LOCATION', value: e.target.value })}
                      placeholder="City, State"
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">ZIP code</label>
                    <input
                      value={ctx.zip}
                      onChange={(e) => send({ type: 'SET_ZIP', value: e.target.value })}
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="e.g. 90210"
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    />
                  </div>
                </div>
                {ctx.error ? <p className="text-sm text-destructive">{ctx.error}</p> : null}
                <div className="flex justify-end">
                  <Button
                    onClick={() => send({ type: 'NEXT' })}
                    disabled={isSaving || !ctx.displayName.trim()}
                  >
                    {isSaving ? 'Saving…' : 'Continue'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}

        {/* Step 2: Experience */}
        {snapshot.matches('experience') || snapshot.matches('savingStep2') ? (
          <ExperienceStep ctx={ctx} send={send} isSaving={isSaving} />
        ) : null}

        {/* Step 3: Skills */}
        {snapshot.matches('skills') || snapshot.matches('savingStep3') ? (
          <SkillsStep ctx={ctx} send={send} isSaving={isSaving} />
        ) : null}

        {/* Step 4: Availability */}
        {snapshot.matches('availability') || snapshot.matches('savingStep4') ? (
          <AvailabilityStep ctx={ctx} send={send} isSaving={isSaving} />
        ) : null}

        {/* Step 5: Review */}
        {snapshot.matches('review') ? (
          <Card>
            <CardContent className="space-y-4 py-5">
              <h2 className="text-lg font-semibold text-text-primary">Review & Publish</h2>
              <div className="space-y-3 rounded-lg bg-muted/50 p-4">
                <p>
                  <span className="font-medium">Name:</span> {ctx.displayName}
                </p>
                <p>
                  <span className="font-medium">Headline:</span> {ctx.headline || '—'}
                </p>
                <p>
                  <span className="font-medium">Location:</span> {ctx.location || '—'}
                </p>
                <p>
                  <span className="font-medium">Experience:</span> {ctx.experience.length} entries
                </p>
                <p>
                  <span className="font-medium">Skills:</span> {ctx.skills.join(', ') || '—'}
                </p>
              </div>
              {ctx.error ? <p className="text-sm text-destructive">{ctx.error}</p> : null}
              <div className="flex justify-between">
                <Button onClick={() => send({ type: 'BACK' })} variant="outline">
                  Back
                </Button>
                <Button onClick={() => send({ type: 'PUBLISH' })}>Publish Profile</Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </PageShell>
  );
}

function ExperienceStep({
  ctx,
  send,
  isSaving,
}: {
  ctx: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[0]['context'];
  send: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[1];
  isSaving: boolean;
}) {
  const [org, setOrg] = useState('');
  const [role, setRole] = useState('');
  const [startYear, setStartYear] = useState('');
  const [endYear, setEndYear] = useState('');

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-lg font-semibold text-text-primary">Experience</h2>
        {ctx.experience.map((item, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
            <div>
              <p className="font-medium text-text-primary">{item.org}</p>
              <p className="text-sm text-text-secondary">
                {item.role} · {item.startYear}–{item.endYear}
              </p>
            </div>
            <Button
              onClick={() => send({ type: 'REMOVE_EXPERIENCE', index: i })}
              variant="ghost"
              size="xs"
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2">
          <input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="Organization"
            className="col-span-2 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
          <div className="flex gap-2">
            <input
              value={startYear}
              onChange={(e) => setStartYear(e.target.value)}
              placeholder="Start"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
            />
            <input
              value={endYear}
              onChange={(e) => setEndYear(e.target.value)}
              placeholder="End"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
            />
          </div>
        </div>
        <Button
          onClick={() => {
            if (org.trim()) {
              send({
                type: 'ADD_EXPERIENCE',
                item: { org: org.trim(), role, startYear, endYear, description: '' },
              });
              setOrg('');
              setRole('');
              setStartYear('');
              setEndYear('');
            }
          }}
          variant="outline"
          size="sm"
        >
          <Icon icon={AddCircleIcon} size="sm" /> Add Experience
        </Button>
        {ctx.error ? <p className="text-sm text-destructive">{ctx.error}</p> : null}
        <div className="flex justify-between">
          <Button onClick={() => send({ type: 'BACK' })} variant="outline">
            Back
          </Button>
          <Button onClick={() => send({ type: 'NEXT' })} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillsStep({
  ctx,
  send,
  isSaving,
}: {
  ctx: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[0]['context'];
  send: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[1];
  isSaving: boolean;
}) {
  const [value, setValue] = useState('');

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-lg font-semibold text-text-primary">Skills</h2>
        <div className="flex flex-wrap gap-2">
          {ctx.skills.map((s, i) => (
            <Badge
              key={i}
              variant="secondary-light"
              size="sm"
              className="cursor-pointer"
              onClick={() => send({ type: 'REMOVE_SKILL', index: i })}
            >
              {s} ✕
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) {
                send({ type: 'ADD_SKILL', value: value.trim() });
                setValue('');
              }
            }}
            placeholder="e.g. Brass, Percussion, Visual"
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
          <Button
            onClick={() => {
              if (value.trim()) {
                send({ type: 'ADD_SKILL', value: value.trim() });
                setValue('');
              }
            }}
            variant="outline"
            size="sm"
          >
            Add
          </Button>
        </div>
        {ctx.error ? <p className="text-sm text-destructive">{ctx.error}</p> : null}
        <div className="flex justify-between">
          <Button onClick={() => send({ type: 'BACK' })} variant="outline">
            Back
          </Button>
          <Button onClick={() => send({ type: 'NEXT' })} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AvailabilityStep({
  ctx,
  send,
  isSaving,
}: {
  ctx: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[0]['context'];
  send: ReturnType<typeof useMachine<typeof jobsOnboardMachine>>[1];
  isSaving: boolean;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <h2 className="text-lg font-semibold text-text-primary">Availability</h2>
        {(
          [
            { label: 'Full-time', key: 'fullTime' as const },
            { label: 'Part-time', key: 'partTime' as const },
            { label: 'Seasonal', key: 'seasonal' as const },
            { label: 'Willing to relocate', key: 'willingToRelocate' as const },
            { label: 'Remote only', key: 'remoteOnly' as const },
          ] as const
        ).map(({ label, key }) => (
          <label
            key={key}
            className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm cursor-pointer hover:bg-muted/30"
          >
            <input
              type="checkbox"
              checked={ctx[key]}
              onChange={(e) => {
                const typeMap = {
                  fullTime: 'SET_FULL_TIME',
                  partTime: 'SET_PART_TIME',
                  seasonal: 'SET_SEASONAL',
                  willingToRelocate: 'SET_RELOCATE',
                  remoteOnly: 'SET_REMOTE',
                } as const;
                send({ type: typeMap[key], value: e.target.checked } as any);
              }}
              className="size-4"
            />
            {label}
          </label>
        ))}
        {ctx.seasonal ? (
          <input
            value={ctx.seasonalPeriod}
            onChange={(e) => send({ type: 'SET_SEASONAL_PERIOD', value: e.target.value })}
            placeholder="e.g. Summer 2026"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
        ) : null}
        {ctx.error ? <p className="text-sm text-destructive">{ctx.error}</p> : null}
        <div className="flex justify-between">
          <Button onClick={() => send({ type: 'BACK' })} variant="outline">
            Back
          </Button>
          <Button onClick={() => send({ type: 'NEXT' })} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
