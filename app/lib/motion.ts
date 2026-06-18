/**
 * Motion configuration helpers.
 *
 * `MotionConfig` from `motion/react` is mounted in `__root.tsx` with
 * `reducedMotion="user"` so all animations gracefully degrade for users who
 * request reduced motion. SSR note: animated content rendered on the server
 * should pass `initial={false}` to avoid hydration mismatches.
 */
// NOTE: `motion` is intentionally NOT re-exported here. It is a lazy proxy
// export from `motion/react`; re-exporting it through this barrel makes rollup
// drop the binding in the SSR bundle ("motion is not defined" at runtime).
// Import `motion` directly from `motion/react` at the call site instead.
export { MotionConfig, AnimatePresence } from 'motion/react';

/** Default reduced-motion strategy for the app-wide MotionConfig. */
export const REDUCED_MOTION = 'user' as const;
