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
