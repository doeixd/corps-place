// Legacy share path — locked predictions moved to /predict/finals/$id. Redirect
// so ballots shared before the rename keep resolving.
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/predict/ballot/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/predict/finals/$id', params: { id: params.id }, replace: true });
  },
});
