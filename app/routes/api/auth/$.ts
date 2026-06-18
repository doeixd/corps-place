import { createServerFileRoute } from '@tanstack/react-start/server';
import { auth } from '@/lib/auth';

/**
 * better-auth catch-all: every /api/auth/* request (OAuth start/callback, magic
 * link, passkey, session) is handled by better-auth's own router (plan §6.1).
 *
 * NOTE: like the other API routes, the '/api/auth/$' literal isn't in the generated
 * ServerFileRoutesByPath until the route tree is regenerated (dev/build).
 */
const handler = ({ request }: { request: Request }) => auth.handler(request);

export const ServerRoute = createServerFileRoute('/api/auth/$').methods({
  GET: handler,
  POST: handler,
});
