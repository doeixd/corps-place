// Legacy path — the editor moved to /predict/finals (SEO rename). Kept as a
// permanent redirect so old links keep working.
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/predict/ballot/')({
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/predict/finals', search: search as never, replace: true });
  },
});
