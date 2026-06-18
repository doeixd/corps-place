// Alias resolution shared by the read-model builders. A logical org can span
// several `corps` records — exact duplicates and program variants unified via
// the `corps_aliases` table (see the directory merge in the corps builder). The
// detail page should reflect ALL of an org's records consistently, so both its
// appearances and its season scores resolve the full set of related corps_keys
// rather than just the slug's own key.

import type { Client } from '@libsql/client';

// The single display identity an alias group collapses to. Picked as the MOST
// COMPLETE record in the group (has a slug, then a logo) — NOT the row's
// `canonical_name`, because the alias table's direction is unreliable: some orgs
// record the fleshed-out record as the *alias* (e.g. "Hurricanes" has the
// slug+logo while canonical "Connecticut Hurricanes" is bare) and a few have
// contradictory rows in both directions (Bushwackers). Choosing by completeness
// is direction-agnostic and gives the clickable, logo-bearing identity that both
// the lineup picture and judge-score grouping need.
export type CanonicalCorps = {
  corps_key: string;
  name: string;
  slug: string | null;
  corps_logo: string | null;
  corps_logo_dark: number | null;
  corps_logo_dark_url: string | null;
};

// Build `corps_key → canonical display identity` for every key that belongs to a
// multi-record alias group. Keys with no sibling are absent (they already are
// their own identity, so callers leave them untouched). Union-find over the
// alias name-graph groups records that span >1 hop; the representative is the
// most complete record, tie-broken by `corps_key` for determinism.
export const buildCorpsCanonicalMap = async (db: Client): Promise<Map<string, CanonicalCorps>> => {
  const [corpsRes, aliasRes] = await Promise.all([
    db.execute(
      `SELECT corps_key, name, slug, corps_logo, corps_logo_dark, corps_logo_dark_url FROM corps`
    ),
    db.execute(`SELECT alias_name, canonical_name FROM corps_aliases`),
  ]);
  const corps = corpsRes.rows as unknown as Array<{
    corps_key: string;
    name: string | null;
    slug: string | null;
    corps_logo: string | null;
    corps_logo_dark: number | null;
    corps_logo_dark_url: string | null;
  }>;
  const aliases = aliasRes.rows as unknown as Array<{
    alias_name: string | null;
    canonical_name: string | null;
  }>;

  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

  // Union-find over normalized corps names.
  const parent = new Map<string, string>();
  const ensure = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r !== x) {
      r = find(r);
      parent.set(x, r);
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const c of corps) {
    const n = norm(c.name);
    if (n) ensure(n);
  }
  for (const a of aliases) {
    const x = norm(a.alias_name);
    const y = norm(a.canonical_name);
    if (x && y) {
      ensure(x);
      ensure(y);
      union(x, y);
    }
  }

  // Bucket corps records by component root.
  const byRoot = new Map<string, CanonicalCorps[]>();
  for (const c of corps) {
    const n = norm(c.name);
    if (!n) continue;
    const root = find(n);
    const list = byRoot.get(root) ?? [];
    list.push({
      corps_key: c.corps_key,
      name: c.name ?? c.corps_key,
      slug: c.slug,
      corps_logo: c.corps_logo,
      corps_logo_dark: c.corps_logo_dark,
      corps_logo_dark_url: c.corps_logo_dark_url,
    });
    byRoot.set(root, list);
  }

  const completeness = (r: CanonicalCorps) => (r.slug ? 2 : 0) + (r.corps_logo ? 1 : 0);
  const map = new Map<string, CanonicalCorps>();
  for (const list of byRoot.values()) {
    if (list.length < 2) continue; // singleton: already its own identity
    const rep = [...list].sort(
      (a, b) => completeness(b) - completeness(a) || a.corps_key.localeCompare(b.corps_key)
    )[0];
    for (const r of list) map.set(r.corps_key, rep);
  }
  return map;
};

// Sibling CTEs resolving every `corps_key` belonging to the same org as a slug,
// following corps_aliases links in both directions (this corps as canonical, and
// this corps as an alias → its canonical + siblings). Binds a single `?` = the
// slug; that `?` must be the first bound parameter in the statement. Compose into
// a `WITH`: `WITH ${RELATED_CORPS_CTES}, other AS (...) SELECT … FROM related_corps`.
// Exposes the final CTE `related_corps(corps_key)`.
export const RELATED_CORPS_CTES = `target AS (SELECT name FROM corps WHERE slug = ?),
  related_names AS (
    SELECT name AS nm FROM target
    UNION SELECT a.alias_name FROM corps_aliases a JOIN target t ON a.canonical_name = t.name
    UNION SELECT a.canonical_name FROM corps_aliases a JOIN target t ON a.alias_name = t.name
    UNION SELECT a2.alias_name
      FROM corps_aliases a1
      JOIN target t ON a1.alias_name = t.name
      JOIN corps_aliases a2 ON a2.canonical_name = a1.canonical_name
  ),
  related_corps AS (SELECT corps_key FROM corps WHERE name IN (SELECT nm FROM related_names))`;
