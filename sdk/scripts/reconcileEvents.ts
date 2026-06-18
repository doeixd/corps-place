// Read-only, EVENT_ID-AWARE reconciliation plan for the slug→prefixed migration.
// (Replaces the earlier slug-based reconcileEventSlugs.ts, which wrongly assumed
//  events.slug is unique — it is not; the PK is event_id. See docs §CORRECTION.)
//
// For every events row it computes the canonical season-prefixed slug and an
// action: keep | rename | dedupe | review. Synthetic slugs (verified 404 on DCI,
// from event-slug-verification-cache.json) are flagged 'review', never migrated.
//
// NO WRITES. Emits event-migration-plan.json for review before the migration.
//
// Usage (from sdk/):  npx tsx scripts/reconcileEvents.ts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });
const isPrefixed = (s: string) => /^\d{4}-/.test(s);

async function main() {
  const events = (
    await db.execute(
      `SELECT event_id, slug, season, year, start_date, COALESCE(event_name, name) AS name FROM events`
    )
  ).rows as unknown as Array<{
    event_id: string;
    slug: string;
    season: string | null;
    year: string | null;
    start_date: string | null;
    name: string | null;
  }>;
  const dayOf = new Map(events.map((e) => [e.event_id, (e.start_date ?? '').slice(0, 10)]));

  // Synthetic (404) canonical slugs from the Browserbase verification cache.
  const cachePath = path.resolve(process.cwd(), 'event-slug-verification-cache.json');
  const synthetic = new Set<string>();
  if (existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { status: string }>;
    for (const [slug, v] of Object.entries(cache)) if (v.status === '404') synthetic.add(slug);
  }

  // Child-row weight per slug — used to pick the survivor in a dedupe group.
  const childCount = new Map<string, number>();
  for (const t of ['event_lineup_entries', 'event_participants', 'event_page_scrapes']) {
    for (const r of (await db.execute(`SELECT event_slug, COUNT(*) n FROM ${t} GROUP BY event_slug`))
      .rows as unknown as Array<{ event_slug: string; n: number }>) {
      childCount.set(r.event_slug, (childCount.get(r.event_slug) ?? 0) + Number(r.n));
    }
  }

  type Plan = {
    event_id: string;
    slug: string;
    season: string | null;
    canonical: string | null;
    action: 'keep' | 'rename' | 'dedupe' | 'review';
    survivorEventId?: string;
    note?: string;
  };

  // First pass: compute canonical + season.
  const rows: Plan[] = events.map((e) => {
    const season = e.season ?? e.year ?? ((e.start_date ?? '').slice(0, 4) || null);
    let canonical: string | null = isPrefixed(e.slug) ? e.slug : season ? `${season}-${e.slug}` : null;
    if (canonical && synthetic.has(canonical))
      return { event_id: e.event_id, slug: e.slug, season, canonical, action: 'review', note: 'synthetic 404 target' };
    if (!canonical)
      return { event_id: e.event_id, slug: e.slug, season, canonical, action: 'review', note: 'no season → no canonical' };
    return { event_id: e.event_id, slug: e.slug, season, canonical, action: 'keep' };
  });

  // Group by canonical to find collisions (→ dedupe). Survivor = the row whose
  // slug already equals canonical (existing prefixed), else most child rows,
  // else lowest event_id.
  const byCanonical = new Map<string, Plan[]>();
  for (const r of rows) {
    if (r.action === 'review' || !r.canonical) continue;
    (byCanonical.get(r.canonical) ?? byCanonical.set(r.canonical, []).get(r.canonical)!).push(r);
  }
  for (const [canonical, group] of byCanonical) {
    if (group.length === 1) {
      const r = group[0];
      r.action = r.slug === canonical ? 'keep' : 'rename';
      continue;
    }
    const survivor = [...group].sort(
      (a, b) =>
        Number(b.slug === canonical) - Number(a.slug === canonical) ||
        (childCount.get(b.slug) ?? 0) - (childCount.get(a.slug) ?? 0) ||
        a.event_id.localeCompare(b.event_id)
    )[0];
    const survivorDay = dayOf.get(survivor.event_id) ?? '';
    for (const r of group) {
      if (r.event_id === survivor.event_id) {
        r.action = r.slug === canonical ? 'keep' : 'rename';
      } else if ((dayOf.get(r.event_id) ?? '') !== survivorDay) {
        // Same name+season but a DIFFERENT calendar day — almost always a distinct
        // multi-day event sharing a slug. Never auto-merge; flag for review.
        r.action = 'review';
        r.note = `distinct date (${dayOf.get(r.event_id)}) vs survivor (${survivorDay}) — multi-day?`;
      } else {
        r.action = 'dedupe';
        r.survivorEventId = survivor.event_id;
      }
    }
  }

  const tally = (key: (p: Plan) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return Object.fromEntries([...m].sort());
  };

  console.log('=========== EVENT MIGRATION PLAN (read-only, event_id-aware) ===========\n');
  console.log(`events: ${rows.length}`);
  console.log('by action:', tally((r) => r.action));
  console.log('');
  for (const action of ['rename', 'dedupe', 'review'] as const) {
    const sample = rows.filter((r) => r.action === action).slice(0, 8);
    console.log(`--- ${action} (${rows.filter((r) => r.action === action).length}) ---`);
    for (const r of sample)
      console.log(
        `  ${r.slug}  →  ${r.canonical}` +
          (r.survivorEventId ? `   (merge ${r.event_id} → ${r.survivorEventId})` : '') +
          (r.note ? `   [${r.note}]` : '')
      );
    console.log('');
  }

  writeFileSync(
    path.resolve(process.cwd(), 'event-migration-plan.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), by_action: tally((r) => r.action), rows }, null, 2)
  );
  console.log('Full plan written to event-migration-plan.json (no DB changes).');
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('reconcile failed:', e);
    db.close();
    process.exit(1);
  });
