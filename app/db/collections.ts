// TanStack DB collections for the browseable read-model index
// (DATA_LAYER_DECISION §3). These are the eagerly-preloaded directory shards;
// per-detail data is fetched on demand, not held here.
//
// Collections are lazy: the chunked shard load (json-collection.ts) starts on
// first subscribe (e.g. a `useLiveQuery` in a directory route) and is a no-op
// during SSR, so routes still render from their loader for first paint.

import { createCollection } from '@tanstack/react-db';
import type { EventDirectoryRow } from '@/lib/event-directory';
import type { CorpsSummary } from '@/lib/corps-directory';
import type { JudgeSummary } from '@/lib/judge-directory';
import type { StaffSummary } from '@/lib/staff-directory';
import { jsonIndexCollectionOptions } from './json-collection';

export const eventsCollection = createCollection(
  jsonIndexCollectionOptions<EventDirectoryRow>({
    id: 'read-model-events',
    getKey: (event) => event.event_id ?? event.slug,
    shard: 'events',
  })
);

export const corpsCollection = createCollection(
  jsonIndexCollectionOptions<CorpsSummary>({
    id: 'read-model-corps',
    getKey: (corps) => corps.corps_key,
    shard: 'corps',
  })
);

export const judgesCollection = createCollection(
  jsonIndexCollectionOptions<JudgeSummary>({
    id: 'read-model-judges',
    getKey: (judge) => judge.judge_id,
    shard: 'judges',
  })
);

export const staffCollection = createCollection(
  jsonIndexCollectionOptions<StaffSummary>({
    id: 'read-model-staff',
    getKey: (staff) => staff.person_id,
    shard: 'staff',
  })
);
