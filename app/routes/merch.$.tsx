import { createFileRoute, redirect } from '@tanstack/react-router';

// Catch-all for old /merch/* URLs → /shop/* (stores, cart, product detail pages).
export const Route = createFileRoute('/merch/$')({
  beforeLoad: ({ params, location }) => {
    const rest = params._splat ?? '';
    throw redirect({ href: `/shop/${rest}${location.searchStr}` });
  },
});
