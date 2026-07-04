import { createFileRoute, redirect } from '@tanstack/react-router';

// Retired 2026-07-04 (4 pageviews ever, all one visit) — the finals editor
// replaced it. Redirect kept so any old /predict/palette links still land
// somewhere useful instead of 404ing.
export const Route = createFileRoute('/predict/palette')({
  beforeLoad: () => {
    throw redirect({ to: '/predict/finals' });
  },
});
