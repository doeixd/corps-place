/**
 * Admin job kinds (ADMIN_PAGE_PLAN §5). Shared, client-safe metadata — NO server
 * imports (this is imported by the /admin/jobs UI). The VM worker
 * (`scripts/admin-job-worker.sh`) maps each kind → an `npx tsx` argv; the web tier
 * only enqueues. Keep this list and the worker's case statement in sync.
 */
export const JOB_KINDS = [
  'season_update',
  'scrape_corps',
  'scrape_event_pages',
  'scrape_recaps',
  'ingest_lineups',
  'generate_predictions',
  'regenerate_event',
  'fine_tune',
  'merge_staff_by_name',
  'resolve_staff_identity',
  'save_corps_colors',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export interface JobKindMeta {
  kind: JobKind;
  label: string;
  description: string;
  danger?: boolean; // requires a confirm + a daytime-CPU warning
  needsArgs?: boolean; // requires args (e.g. an event slug) before enqueue
}

export const JOB_KIND_META: Record<JobKind, JobKindMeta> = {
  season_update: {
    kind: 'season_update',
    label: 'Run nightly workflow',
    description: 'Full season update: ingest → scrape → recaps → ML rebuild → predictions.',
    danger: true,
  },
  scrape_corps: {
    kind: 'scrape_corps',
    label: 'Scrape corps',
    description: 'Refresh corps directory + profiles.',
  },
  scrape_event_pages: {
    kind: 'scrape_event_pages',
    label: 'Scrape event pages',
    description: 'Refresh event pages.',
  },
  scrape_recaps: {
    kind: 'scrape_recaps',
    label: 'Scrape recaps',
    description: 'Refresh website recaps.',
  },
  ingest_lineups: {
    kind: 'ingest_lineups',
    label: 'Ingest lineups',
    description: 'Re-ingest lineups from scrapes.',
  },
  generate_predictions: {
    kind: 'generate_predictions',
    label: 'Regenerate predictions',
    description: 'Batch-generate stale predictions for upcoming events.',
  },
  regenerate_event: {
    kind: 'regenerate_event',
    label: 'Regenerate one event',
    description: 'Force-regenerate a single event prediction (needs an event slug).',
    needsArgs: true,
  },
  fine_tune: {
    kind: 'fine_tune',
    label: 'Fine-tune model',
    description: 'Long CPU job — fine-tune the v9 model from the latest checkpoint.',
    danger: true,
  },
  merge_staff_by_name: {
    kind: 'merge_staff_by_name',
    label: 'Merge staff by name',
    description: 'Collapse exact-name duplicate staff into one person (respects keep-separate).',
    danger: true,
  },
  resolve_staff_identity: {
    kind: 'resolve_staff_identity',
    label: 'Merge/split two staff',
    description: 'Manually merge or split two staff_ids (needs op + two ids).',
    needsArgs: true,
  },
  save_corps_colors: {
    kind: 'save_corps_colors',
    label: 'Save corps colors',
    description: 'Durable write of a corps’ brand colors (enqueued by the colors editor).',
    needsArgs: true,
  },
};

export const isJobKind = (k: string): k is JobKind => (JOB_KINDS as readonly string[]).includes(k);
