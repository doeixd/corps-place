import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { listPredictedEvents } from '@/lib/server-fns/hybrid';
import { getEventPrediction } from '@/lib/server-fns/event-prediction';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import {
  PalettePredictionTable,
  type PaletteRowInput,
  type PaletteEdits,
} from '@/components/predict/palette-table';
import { CAPTIONS, type Caption, type CaptionInterval } from '@/lib/prediction-scenario';
import { seoHead } from '@/lib/seo';

/**
 * Prediction Palette — pick a predicted event and edit its recap inline (every
 * caption is an editable field); category subtotals, Total and the ranking
 * recompute live. Fully client-side once loaded; the event lives in the URL so a
 * given event is shareable.
 */
export const Route = createFileRoute('/predict/palette')({
  head: () =>
    seoHead({
      title: 'Prediction Palette — DrumCorps.app',
      description: 'Edit a predicted DCI recap and watch the ranking change.',
      path: '/predict/palette',
    }),
  validateSearch: (s: Record<string, unknown>) => ({
    event: typeof s.event === 'string' && s.event ? s.event : undefined,
    edits: typeof s.edits === 'string' && s.edits ? s.edits : undefined,
  }),
  // Only `event` drives the loader — changing `edits` (a shared scenario) must
  // not re-fetch the prediction.
  loaderDeps: ({ search }) => ({ event: search.event }),
  loader: async ({ deps }) => {
    const events = await listPredictedEvents();
    const selected = deps.event ?? events[0]?.slug ?? null;
    let rows: PaletteRowInput[] = [];
    let error = false;
    if (selected) {
      try {
        const payload = (await getEventPrediction({ data: { slug: selected } })) as {
          recap?: Array<Record<string, unknown>>;
          summary?: { recap?: Array<Record<string, unknown>> };
        };
        const recap = payload?.recap ?? payload?.summary?.recap ?? [];
        rows = recap
          .map((r) => {
            const corps = typeof r.corps === 'string' ? r.corps : '';
            const corpsKey = typeof r.corps_key === 'string' ? r.corps_key : corps;
            return {
              corpsKey,
              corps: corps || corpsKey,
              division: typeof r.division === 'string' ? r.division : null,
              caps: Object.fromEntries(
                CAPTIONS.map((c) => [c, Number(r[c]) || 0])
              ) as Record<Caption, number>,
              intervals: (r.caption_intervals ?? undefined) as
                | Partial<Record<Caption, CaptionInterval>>
                | undefined,
            };
          })
          .filter((r) => r.corpsKey);
      } catch {
        error = true;
      }
    }
    return { events, selected, rows, error };
  },
  component: PalettePage,
});

function parseEdits(raw: string | undefined): PaletteEdits | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as PaletteEdits) : null;
  } catch {
    return null;
  }
}

function PalettePage() {
  const { events, selected, rows, error } = Route.useLoaderData();
  const { edits } = Route.useSearch();
  const navigate = useNavigate();
  const initialEdits = parseEdits(edits);

  return (
    <PageShell>
      <div className="space-y-6 p-4 sm:p-6">
        <PageHeader
          title="Prediction Palette"
          subtitle="A what-if sandbox for DCI predictions."
        />

        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-text-secondary">
          Start from the model&apos;s forecast for any event, then edit caption scores to ask
          &ldquo;what if?&rdquo; — e.g. <em>if a corps finds half a point in General Effect, do they
          win?</em> Totals and the ranking update as you go, ▲/▼ shows how each corps moved versus
          the forecast, and your edits are saved on this device. Hit{' '}
          <span className="font-medium text-text-primary">Roll scenario</span> for a plausible
          alternate finish sampled from the model&apos;s confidence bands, or{' '}
          <span className="font-medium text-text-primary">Copy share link</span> to send a scenario
          to someone.
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[16rem] flex-col gap-1 text-sm">
            <span className="font-medium text-text-secondary">Event</span>
            <select
              value={selected ?? ''}
              onChange={(e) =>
                navigate({ to: '/predict/palette', search: { event: e.target.value } })
              }
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {events.length === 0 ? <option value="">No predictions available</option> : null}
              {events.map((ev) => (
                <option key={ev.slug} value={ev.slug}>
                  {ev.eventName}
                  {ev.startDate ? ` — ${ev.startDate}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {rows.length > 0 && selected ? (
          <PalettePredictionTable
            key={`${selected}:${edits ?? ''}`}
            initial={rows}
            eventSlug={selected}
            initialEdits={initialEdits as PaletteEdits | null}
          />
        ) : (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
            {!selected
              ? 'Pick an event above to start editing its predicted recap.'
              : error
                ? "Couldn't load this event's prediction — please try again or pick another event."
                : 'No prediction rows for this event yet — try another event.'}
          </p>
        )}
      </div>
    </PageShell>
  );
}
