import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { listPredictedEvents } from '@/lib/server-fns/hybrid';
import { getEventPrediction } from '@/lib/server-fns/event-prediction';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { PalettePredictionTable, type PaletteRowInput } from '@/components/predict/palette-table';
import { CAPTIONS, type Caption } from '@/lib/prediction-scenario';
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
  }),
  loaderDeps: ({ search }) => ({ event: search.event }),
  loader: async ({ deps }) => {
    const events = await listPredictedEvents();
    const selected = deps.event ?? events[0]?.slug ?? null;
    let rows: PaletteRowInput[] = [];
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
            };
          })
          .filter((r) => r.corpsKey);
      } catch {
        rows = [];
      }
    }
    return { events, selected, rows };
  },
  component: PalettePage,
});

function PalettePage() {
  const { events, selected, rows } = Route.useLoaderData();
  const navigate = useNavigate();

  return (
    <PageShell>
      <div className="space-y-6 p-4 sm:p-6">
        <PageHeader
          title="Prediction Palette"
          subtitle="Edit a predicted recap and watch the ranking change. Your edits stay on this device."
        />

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

        {rows.length > 0 ? (
          <PalettePredictionTable key={selected ?? 'none'} initial={rows} />
        ) : (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
            {selected
              ? 'No prediction rows for this event yet — try another event.'
              : 'Pick an event above to start editing its predicted recap.'}
          </p>
        )}
      </div>
    </PageShell>
  );
}
