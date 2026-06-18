import { createServerFn } from '@tanstack/react-start/client';
import { Effect } from 'effect';
import { EventDirectoryService, EventDirectoryServiceLive } from '../event-directory';

export const getEventDirectory = createServerFn({ method: 'GET' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (svc) => svc.list2026Events()).pipe(
    Effect.provide(EventDirectoryServiceLive)
  );

  return Effect.runPromise(program);
});

export const getRefreshStatus = createServerFn({ method: 'GET' })
  .validator((data: unknown): string | undefined => {
    const obj = (data ?? {}) as { refreshId?: string };
    return obj.refreshId;
  })
  .handler(async ({ data: refreshId }) => {
    const program = Effect.flatMap(EventDirectoryService, (svc) =>
      refreshId ? svc.get2026Refresh(refreshId) : svc.latest2026Refresh()
    ).pipe(Effect.provide(EventDirectoryServiceLive));

    return Effect.runPromise(program);
  });

export const startRefresh = createServerFn({ method: 'POST' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (svc) => svc.start2026Refresh()).pipe(
    Effect.provide(EventDirectoryServiceLive)
  );

  return Effect.runPromise(program);
});

export const refreshEvents = createServerFn({ method: 'POST' }).handler(async () => {
  const program = Effect.flatMap(EventDirectoryService, (svc) => svc.refresh2026Events()).pipe(
    Effect.provide(EventDirectoryServiceLive)
  );

  return Effect.runPromise(program);
});
