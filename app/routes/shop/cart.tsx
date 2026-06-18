import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/shop/cart')({
  beforeLoad: () => {
    throw redirect({ to: '/shop/bookmarks' });
  },
});
