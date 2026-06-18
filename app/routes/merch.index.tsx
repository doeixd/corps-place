import { createFileRoute, redirect } from '@tanstack/react-router';

// /merch was renamed to /shop; the old catalog lives at /shop/all. Preserve any
// query string (?store=, ?q=, ?cat=, …) so existing links/filters keep working.
export const Route = createFileRoute('/merch/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/shop/all${location.searchStr}` });
  },
});
