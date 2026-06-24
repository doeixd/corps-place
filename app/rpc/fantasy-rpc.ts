/**
 * Fantasy DCI RPC group (migration plan §3.5). A thin typed transport — the
 * business logic stays in the services (`app/lib/fantasy/services/*`), each
 * handler just resolves the service and delegates. Merged into `AppLive`
 * (app/rpc/index.ts).
 *
 * P0 exposes only `getLeague`; subsequent milestones append mutations/reads here.
 */
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Effect, Schema } from 'effect';
import { LeagueService } from '@/lib/fantasy/services/league-service';
import { StandingsService } from '@/lib/fantasy/services/standings-service';

const GetLeagueInput = Schema.Struct({
  slug: Schema.String,
  viewerUserId: Schema.NullOr(Schema.String),
});

const NotFoundError = Schema.Struct({
  _tag: Schema.Literal('NotFound'),
  message: Schema.optional(Schema.String),
});

export const FantasyRpc = RpcGroup.make(
  Rpc.make('getLeague', {
    payload: GetLeagueInput,
    // The league payload nests LeagueConfig + member/draft objects; Schema.Any
    // mirrors the directory/prediction RPCs that return composed read shapes.
    success: Schema.Any,
    error: NotFoundError,
  }),
  Rpc.make('listMyLeagues', {
    payload: Schema.Struct({ userId: Schema.String }),
    success: Schema.Any,
  }),
  Rpc.make('getStandings', {
    payload: Schema.Struct({ slug: Schema.String }),
    success: Schema.Any,
    error: NotFoundError,
  })
);

export const FantasyRpcLive = FantasyRpc.toLayer({
  getLeague: Effect.fn('FantasyRpc.getLeague')(function* (payload) {
    const svc = yield* LeagueService;
    return yield* svc.get(payload);
  }),
  listMyLeagues: Effect.fn('FantasyRpc.listMyLeagues')(function* (payload) {
    const svc = yield* LeagueService;
    return yield* svc.listMyLeagues(payload.userId);
  }),
  getStandings: Effect.fn('FantasyRpc.getStandings')(function* (payload) {
    const svc = yield* StandingsService;
    return yield* svc.getStandings(payload.slug, null);
  }),
});
