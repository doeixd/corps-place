/**
 * Fire a celebratory confetti burst. Client-only and best-effort: it no-ops on the
 * server, when the user prefers reduced motion, or if the (lazily-imported) library
 * fails to load — confetti is never essential to the action that triggered it.
 */
export async function celebrate(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  try {
    const confetti = (await import('canvas-confetti')).default;
    const fire = (ratio: number, opts: Record<string, unknown>) =>
      confetti({ origin: { y: 0.7 }, particleCount: Math.floor(180 * ratio), ...opts });
    fire(0.25, { spread: 26, startVelocity: 55 });
    fire(0.2, { spread: 60 });
    fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    fire(0.1, { spread: 120, startVelocity: 45 });
  } catch {
    /* non-essential — ignore */
  }
}
