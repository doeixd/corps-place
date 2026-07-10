import { createServerFileRoute } from '@tanstack/react-start/server';
import { getStaffDirectory } from '@/lib/server-fns/hybrid';
import { urlsetResponse } from '@/lib/sitemap-shared';

// Staff profile sitemap — ~9k thin-ish profile pages, isolated from the core
// sitemap so they can't dilute how search engines judge the rankable content.
// The /staff index doesn't server-render its links, so this file is how these
// pages get discovered at all.

export const ServerRoute = createServerFileRoute('/sitemap-staff.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;
    const paths = new Set<string>(['/staff']);
    const staff = await getStaffDirectory().catch(() => []);
    for (const s of staff) if (s.person_id) paths.add(`/staff/${s.person_id}`);
    return urlsetResponse(origin, paths);
  },
});
