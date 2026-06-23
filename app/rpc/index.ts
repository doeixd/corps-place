import { Effect, Layer } from 'effect';
import { DirectoryRpc, DirectoryRpcLive } from './directory-rpc';
import { PredictionRpc, PredictionRpcLive } from './prediction-rpc';
import { FantasyRpc, FantasyRpcLive } from './fantasy-rpc';
import { EventDirectoryServiceLive } from '@/lib/event-directory';
import { EventPredictionServiceLive } from '@/lib/event-prediction-api';
import { LeagueServiceLive } from '@/lib/fantasy/services/league-service';
import { StandingsServiceLive } from '@/lib/fantasy/services/standings-service';
import { InviteServiceLive } from '@/lib/fantasy/services/invite-service';
import { MembershipServiceLive } from '@/lib/fantasy/services/membership-service';

// Re-export the individual groups + lives (the primary units).
export {
  DirectoryRpc,
  DirectoryRpcLive,
  PredictionRpc,
  PredictionRpcLive,
  FantasyRpc,
  FantasyRpcLive,
};

// Self-contained fantasy service layers (each provides its own SqlClient).
// These are what a direct-call boundary (server-fn shim, loader) provides — they
// have no residual requirements. Append further fantasy *Live layers as
// milestones land.
const FantasyServicesLive = Layer.mergeAll(
  LeagueServiceLive,
  StandingsServiceLive,
  InviteServiceLive,
  MembershipServiceLive
);

// The fantasy slice for AppLive: the RPC handlers wired OVER the services (so the
// group's LeagueService requirement is satisfied), plus the services themselves.
export const FantasyLive = Layer.mergeAll(
  FantasyServicesLive,
  FantasyRpcLive.pipe(Layer.provide(FantasyServicesLive))
);

// Full application live layer:
// - RPC handler layers (DirectoryRpcLive etc.)
// - The Effect.Services they depend on
// This is what server functions and other boundaries should provide.
export const AppLive = Layer.mergeAll(
  DirectoryRpcLive,
  PredictionRpcLive,
  EventDirectoryServiceLive,
  EventPredictionServiceLive,
  FantasyLive
);

// Back-compat alias + convenience helper
export const AppRpcLive = AppLive;

export const provideApp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AppLive));

/** Boundary helper for fantasy server-fn shims / loaders — provides the self-contained services. */
export const provideFantasy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(FantasyServicesLive));

/** @deprecated Use provideApp (or provideAppRpc for pure RPC transport later) */
export const provideAppRpc = provideApp;

// Type representing the union of available RPC groups (for documentation / future router)
export type AppRpc = typeof DirectoryRpc | typeof PredictionRpc;
