import { createPrismaSourceAdapter } from '@nkzw/fate/server/prisma';
import { Effect } from 'effect';
import { EventDirectoryService, EventDirectoryServiceLive } from '../lib/event-directory';
import type { AppContext } from './context';
import { eventDataView, type EventNode } from './views';

/**
 * Custom Fate source adapter backed by our Effect.Services (the chosen
 * "custom adapter over Effect" path — keeps Effect Services as the single
 * source of truth instead of letting Fate hit the DB directly).
 *
 * HOW: Fate's Prisma adapter only needs a "delegate" per entity — an object
 * with Prisma-shaped `findMany` / `findUnique`. We implement those by calling
 * the Effect service and projecting `id = slug`. Fate handles all the
 * selection-plan / registry / masking machinery; the `select` arg can be
 * ignored because Fate masks the result down to the requested view anyway.
 *
 * BOUNDARY NOTE (effect-best-practices): `Effect.runPromise` is used here only
 * because this is the transport/adapter edge. All real logic stays inside
 * EventDirectoryService (with Effect.fn tracing). This is the single allowed
 * place for runPromise — never inside a Service body.
 */
const listEvents = (): Promise<EventNode[]> =>
  Effect.runPromise(
    Effect.flatMap(EventDirectoryService, (svc) => svc.list2026Events()).pipe(
      Effect.provide(EventDirectoryServiceLive),
      Effect.map((rows) => rows.map((row) => ({ ...row, id: row.slug })))
    )
  );

type FindManyArgs = {
  where?: { id?: { in?: string[] } };
  take?: number;
  skip?: number;
  cursor?: { id?: string };
};

const eventDelegate = {
  findMany: async (args: FindManyArgs = {}) => {
    let rows = await listEvents();

    const ids = args.where?.id?.in;
    if (ids) {
      const set = new Set(ids);
      rows = rows.filter((row) => set.has(row.id));
    }

    // Honor cursor-based pagination the way Fate's prismaConnectionArgs emits it:
    // forward => positive take, backward => negative take, cursor points at an id.
    if (args.cursor?.id) {
      const index = rows.findIndex((row) => row.id === args.cursor!.id);
      if (index >= 0) rows = rows.slice(index + (args.skip ?? 1));
    } else if (args.skip) {
      rows = rows.slice(args.skip);
    }

    if (typeof args.take === 'number') {
      rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    }

    return rows;
  },

  findUnique: async (args: { where?: { id?: string } } = {}) => {
    const id = args.where?.id;
    if (!id) return null;
    const rows = await listEvents();
    return rows.find((row) => row.id === id) ?? null;
  },
};

export const sources = createPrismaSourceAdapter<AppContext>({
  views: [{ view: eventDataView, delegate: () => eventDelegate }],
});
