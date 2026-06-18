import { Effect, Layer } from 'effect';
import { DirectoryRpc, DirectoryRpcLive } from './directory-rpc';
import { PredictionRpc, PredictionRpcLive } from './prediction-rpc';
import { EventDirectoryServiceLive } from '@/lib/event-directory';
import { EventPredictionServiceLive } from '@/lib/event-prediction-api';

// Re-export the individual groups + lives (the primary units).
export { DirectoryRpc, DirectoryRpcLive, PredictionRpc, PredictionRpcLive };

// Full application live layer:
// - RPC handler layers (DirectoryRpcLive etc.)
// - The Effect.Services they depend on
// This is what server functions and other boundaries should provide.
export const AppLive = Layer.mergeAll(
  DirectoryRpcLive,
  PredictionRpcLive,
  EventDirectoryServiceLive,
  EventPredictionServiceLive
);

// Back-compat alias + convenience helper
export const AppRpcLive = AppLive;

export const provideApp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AppLive));

/** @deprecated Use provideApp (or provideAppRpc for pure RPC transport later) */
export const provideAppRpc = provideApp;

// Type representing the union of available RPC groups (for documentation / future router)
export type AppRpc = typeof DirectoryRpc | typeof PredictionRpc;
