import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/events/$yearSlug/')({
  // `/events/<year>` is just a shortcut for `/events?season=<year>`. The events
  // directory page owns all filtering, sorting, and search UI; this route
  // exists only to give each season a clean, shareable URL. Throwing a redirect
  // from the loader keeps the URL in sync with what's actually rendered.
  loader: ({ params }) => {
    throw redirect({
      to: '/events',
      search: { season: params.yearSlug },
    });
  },
});
