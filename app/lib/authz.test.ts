import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-scan invariants for the capability wiring. These are intentionally
// static-analysis (not runtime) so they can't be defeated by an import side
// effect, and they target the class of bug where a capability is added to the
// TS `Capability` type but NOT to a runtime validator — exactly what made
// /admin/profile-claims throw `ValiError: ... received "manageProfileClaims"`
// because `manageProfileClaims` was missing from the `ADMIN_CAPS` picklist.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

// `const ADMIN_CAPS = [ '...', ... ] as const` — the valibot picklist requireAdmin validates against.
const adminCaps = quoted(
  read('app/lib/server-fns/admin.ts').match(/const ADMIN_CAPS = \[([\s\S]*?)\]\s*as const/)?.[1] ?? ''
);

const authz = read('app/lib/authz.ts');
// `export type Capability = | 'a' | 'b' ... ;`
const capabilityType = quoted(authz.match(/export type Capability =([\s\S]*?);/)?.[1] ?? '');
// keys of `const MIN_ROLE: Record<Capability, Role> = { a: '...', ... }`
const minRoleKeys = [
  ...(authz.match(/MIN_ROLE: Record<Capability, Role> = \{([\s\S]*?)\n\s*\};/)?.[1] ?? '').matchAll(
    /^\s*(\w+)\s*:/gm
  ),
].map((m) => m[1]);

// Every capability an admin route loader gates on: `adminLoader('<cap>', ...)`.
const adminRouteCaps = (() => {
  const dir = resolve(process.cwd(), 'app/routes/admin');
  const caps = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tsx')) continue;
    for (const m of readFileSync(resolve(dir, f), 'utf8').matchAll(/adminLoader\(\s*'([^']+)'/g)) {
      caps.add(m[1]);
    }
  }
  return [...caps];
})();

describe('admin capability wiring', () => {
  it('parses the source lists (guards against a regex drift silently passing)', () => {
    expect(adminCaps.length).toBeGreaterThan(3);
    expect(capabilityType.length).toBeGreaterThan(3);
    expect(minRoleKeys.length).toBeGreaterThan(3);
    expect(adminRouteCaps.length).toBeGreaterThan(0);
  });

  it('every admin-route loader capability is registered in ADMIN_CAPS', () => {
    // THE regression guard: /admin/profile-claims gates on manageProfileClaims;
    // if it (or any future admin cap) is missing from the picklist, requireAdmin
    // throws ValiError and the page 500s.
    for (const cap of adminRouteCaps) expect(adminCaps).toContain(cap);
  });

  it('ADMIN_CAPS is a subset of the Capability type', () => {
    for (const cap of adminCaps) expect(capabilityType).toContain(cap);
  });

  it('MIN_ROLE covers every Capability (exhaustive role mapping)', () => {
    for (const cap of capabilityType) expect(minRoleKeys).toContain(cap);
  });

  it('profile-ownership caps are fully registered (regression: /admin/profile-claims 500)', () => {
    expect(capabilityType).toContain('manageProfileClaims');
    expect(minRoleKeys).toContain('manageProfileClaims');
    expect(adminCaps).toContain('manageProfileClaims');
    // claimProfile is a user cap checked via requireCapability (not the admin
    // picklist), so it must be in the type + MIN_ROLE but need NOT be in ADMIN_CAPS.
    expect(capabilityType).toContain('claimProfile');
    expect(minRoleKeys).toContain('claimProfile');
  });
});
