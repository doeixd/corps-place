import type { ReactNode } from 'react';
import { PageShell } from '@/components/page-shell';
import { AdminNav } from '@/components/admin/admin-nav';

/**
 * Layout chrome for every `/admin/*` page (ADMIN_PAGE_PLAN §1 option A — a shared
 * component, since the repo has no `route.tsx` layout routes). Renders the
 * role-filtered admin sub-nav alongside the section content. Each admin route wraps
 * its body in `<AdminShell role={actor.role}>…</AdminShell>` after its loader gate.
 */
export function AdminShell({ role, children }: { role: string; children: ReactNode }) {
  return (
    <PageShell>
      <div className="flex flex-col gap-5 md:flex-row md:gap-8">
        <AdminNav role={role} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageShell>
  );
}
