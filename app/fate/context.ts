/**
 * Request context handed to every Fate resolver/source.
 *
 * Kept intentionally tiny: our source layer delegates to Effect.Services which
 * acquire their own DB clients, so the context only needs the incoming Request
 * (useful later for auth / per-request scoping).
 */
export type AppContext = {
  request: Request;
};
