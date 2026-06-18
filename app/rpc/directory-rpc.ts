import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Effect, Schema } from 'effect';
import { EventDirectoryService } from '@/lib/event-directory';

// Input schemas (reuse or mirror service needs)
const GetRefreshInput = Schema.Struct({
  refreshId: Schema.String,
});

// Procedures
export const DirectoryRpc = RpcGroup.make(
  // Start a background refresh (fire-and-forget style, returns the run record)
  Rpc.make('startRefresh', {
    success: Schema.Struct({
      refresh_id: Schema.String,
      status: Schema.Literals(['running', 'success', 'failed']),
      started_at: Schema.String,
    }),
    error: Schema.Union([
      Schema.Struct({ _tag: Schema.Literal('EventDirectoryDataError'), message: Schema.String }),
      Schema.Struct({ _tag: Schema.Literal('EventDirectoryRefreshError'), message: Schema.String }),
    ]),
  }),

  // Get latest refresh status
  Rpc.make('getLatestRefresh', {
    success: Schema.NullOr(
      Schema.Struct({
        refresh_id: Schema.String,
        status: Schema.Literals(['running', 'success', 'failed']),
        started_at: Schema.String,
        finished_at: Schema.NullOr(Schema.String),
        event_count: Schema.NullOr(Schema.Number),
      })
    ),
    error: Schema.Struct({
      _tag: Schema.Literal('EventDirectoryDataError'),
      message: Schema.String,
    }),
  }),

  // Get specific refresh by id
  Rpc.make('getRefresh', {
    payload: GetRefreshInput,
    success: Schema.NullOr(Schema.Any),
    error: Schema.Struct({
      _tag: Schema.Literal('EventDirectoryDataError'),
      message: Schema.String,
    }),
  })
);

// Handlers — these run with full Effect layers.
// Per effect-best-practices, we keep the actual business logic in the Service (using Effect.fn).
// The RPC layer is a thin typed transport.
export const DirectoryRpcLive = DirectoryRpc.toLayer({
  startRefresh: Effect.fn('DirectoryRpc.startRefresh')(function* () {
    const svc = yield* EventDirectoryService;
    const run = yield* svc.start2026Refresh();
    return {
      refresh_id: run.refresh_id,
      status: run.status,
      started_at: run.started_at,
    };
  }),

  getLatestRefresh: Effect.fn('DirectoryRpc.getLatestRefresh')(function* () {
    const svc = yield* EventDirectoryService;
    const run = yield* svc.latest2026Refresh();
    if (!run) return null;
    return {
      refresh_id: run.refresh_id,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      event_count: run.event_count,
    };
  }),

  getRefresh: Effect.fn('DirectoryRpc.getRefresh')(function* (payload: { refreshId: string }) {
    const svc = yield* EventDirectoryService;
    const run = yield* svc.get2026Refresh(payload.refreshId);
    return run ?? null;
  }),
});

export type DirectoryRpc = typeof DirectoryRpc;
