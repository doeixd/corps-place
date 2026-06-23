/**
 * Feature flag for the Fantasy DCI feature (plan §0.5 #9, Appendix A).
 *
 * All fantasy routes and nav entries are gated behind `VITE_ENABLE_FANTASY`.
 * When off, the routes 404. `VITE_`-prefixed env vars are statically replaced by
 * Vite in the client bundle and also readable server-side via import.meta.env.
 */
import { notFound } from '@tanstack/react-router';

export const FANTASY_ENABLED = import.meta.env.VITE_ENABLE_FANTASY === 'true';

/** Route `beforeLoad` guard: 404 the whole route when the feature is off. */
export const requireFantasyEnabled = (): void => {
  if (!FANTASY_ENABLED) throw notFound();
};

/**
 * Server-only sub-flag (strangler A/B, plan P3/R2): when `FANTASY_EFFECT_DRAFT=1`
 * the draft runs on the Effect `DraftService` (+ its PubSub SSE source) instead of
 * the legacy `draft-engine.ts` (+ `bus.ts`). Defaults OFF so production keeps the
 * proven legacy engine until the Effect path is verified live. Runtime env (NOT a
 * `VITE_` build flag) — it only gates server-side engine selection; the client SSE
 * endpoint + server-fn signatures are identical either way, so no client change.
 */
export const effectDraftEnabled = (): boolean => process.env.FANTASY_EFFECT_DRAFT === '1';
