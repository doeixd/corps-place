import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { getStaffProfile } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import type { StaffAssignment, StaffProfile } from '@/lib/staff-directory';
import { ProgressiveImage } from '@/components/progressive-image';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { Card, CardContent } from '@/components/ui/card';

export const Route = createFileRoute('/staff/$personId')({
  loader: async ({ params }) => ({
    profile: await loadDetailOrServer<StaffProfile | null>(`staff/${params.personId}.json`, () =>
      getStaffProfile({ data: params.personId })
    ),
  }),
  staleTime: 60_000,
  component: StaffProfilePage,
});

function StaffProfilePage() {
  const { profile } = Route.useLoaderData();

  // Group assignments by corps (hook must run unconditionally — before any early return).
  const byCorps = useMemo(() => groupByCorps(profile?.assignments ?? []), [profile]);

  if (!profile) {
    return (
      <PageShell>
        <PageHeader title="Staff" backTo="/staff" backLabel="Staff" />
        <StatusCard
          tone="info"
          title="Not found"
          description="This staff profile isn’t available."
        />
      </PageShell>
    );
  }

  const seasons = profile.seasons ?? [];
  const range =
    seasons.length > 1 ? `${seasons[seasons.length - 1]}–${seasons[0]}` : (seasons[0] ?? '');

  return (
    <PageShell>
      <PageHeader
        title={profile.display_name}
        subtitle={range ? `Active ${range}` : undefined}
        backTo="/staff"
        backLabel="Staff"
      />
      <div className="flex flex-col gap-6 sm:flex-row">
        <ProgressiveImage
          src={profile.photo_url}
          alt={profile.display_name}
          width={160}
          fit="cover"
          assumeCached
          fallback={null}
          className="size-40 shrink-0 self-start rounded-xl"
        />
        {profile.biography && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {profile.biography}
          </p>
        )}
      </div>

      <h2 className="mt-8 mb-3 text-lg font-semibold">Where they’ve taught</h2>
      <div className="flex flex-col gap-3">
        {byCorps.map((g) => (
          <Card key={g.corps_key}>
            <CardContent className="p-4">
              <p className="font-medium">{g.corps_name}</p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
                {g.rows.map((r, i) => (
                  <li key={`${r.season}-${r.title}-${i}`} className="flex gap-2">
                    <span className="w-12 shrink-0 tabular-nums">{r.season ?? '—'}</span>
                    <span>
                      {r.title ?? r.role_type ?? 'Staff'}
                      {r.role_type && r.title && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                          {r.role_type}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      {profile.performed && profile.performed.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 text-lg font-semibold">Performed with</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {profile.performed.map((p) => (
              <li key={p.corps_key} className="rounded bg-muted px-2 py-1">
                {p.corps_name}
                {p.since_season && (
                  <span className="ml-1 text-muted-foreground tabular-nums">
                    {p.since_season}
                    {p.through_season && p.through_season !== p.since_season
                      ? `–${p.through_season}`
                      : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {profile.bioFacts &&
        (profile.bioFacts.education.length > 0 ||
          profile.bioFacts.awards.length > 0 ||
          profile.bioFacts.currentPosition ||
          profile.bioFacts.hometown) && (
          <>
            <h2 className="mt-8 mb-3 text-lg font-semibold">Background</h2>
            <dl className="flex flex-col gap-2 text-sm">
              {profile.bioFacts.currentPosition && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Currently</dt>
                  <dd>
                    {profile.bioFacts.currentPosition.title}
                    {profile.bioFacts.currentPosition.org
                      ? ` @ ${profile.bioFacts.currentPosition.org}`
                      : ''}
                  </dd>
                </div>
              )}
              {profile.bioFacts.hometown && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Hometown</dt>
                  <dd>{profile.bioFacts.hometown}</dd>
                </div>
              )}
              {profile.bioFacts.education.length > 0 && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Education</dt>
                  <dd>
                    {profile.bioFacts.education
                      .map((e) => [e.degree, e.field, e.institution].filter(Boolean).join(', '))
                      .join('; ')}
                  </dd>
                </div>
              )}
              {profile.bioFacts.awards.length > 0 && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">Awards</dt>
                  <dd>
                    {profile.bioFacts.awards
                      .map((a) => a.name + (a.year ? ` (${a.year})` : ''))
                      .join('; ')}
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
    </PageShell>
  );
}

function groupByCorps(assignments: readonly StaffAssignment[]) {
  const map = new Map<string, { corps_key: string; corps_name: string; rows: StaffAssignment[] }>();
  for (const a of assignments) {
    const g = map.get(a.corps_key) ?? {
      corps_key: a.corps_key,
      corps_name: a.corps_name,
      rows: [],
    };
    g.rows.push(a);
    map.set(a.corps_key, g);
  }
  return [...map.values()];
}
