// Read-model builders for the staff directory & per-person profile pages
// (docs/staff-scraping-plan.md §4.5). Mirrors builders/judges.ts. Keyed by
// `person_id` (the canonical-person grouping) — a person may span multiple
// `staff_id`s (one per corps) when merged in identity resolution.

import type { Client } from '@libsql/client';
import type { CaptionCount } from './judges.js';

export type StaffGroup = { corps_key: string; corps_name: string; corps_slug: string | null };

export type StaffSummary = {
  person_id: string;
  display_name: string;
  default_title: string | null;
  photo_url: string | null;
  /** Distinct corps this person has taught. */
  corps_count: number;
  seasons: readonly string[];
  /** Career assignment counts per normalized caption/section, for the card. */
  captionBreakdown?: readonly CaptionCount[];
  groups?: readonly StaffGroup[];
};

export type StaffAssignment = {
  corps_key: string;
  corps_name: string;
  corps_slug: string | null;
  season: string | null;
  title: string | null;
  role_type: string | null;
  start_year: number | null;
  end_year: number | null;
};

/** Structured facts mined from bio prose (S3) — what assignments don't already give. */
export type StaffBioFacts = {
  education: readonly { institution: string; degree: string | null; field: string | null; year: number | null }[];
  awards: readonly { name: string; year: number | null }[];
  performedOther: readonly { group: string; startYear: number | null; endYear: number | null }[];
  hometown: string | null;
  currentPosition: { title: string; org: string } | null;
};
/** A grounded performing-history link (corps the person MARCHED in, vs. taught). */
export type StaffPerformed = {
  corps_key: string;
  corps_name: string;
  corps_slug: string | null;
  since_season: string | null;
  through_season: string | null;
};

export type StaffProfile = {
  person_id: string;
  display_name: string;
  biography: string | null;
  photo_url: string | null;
  assignments: readonly StaffAssignment[];
  groups: readonly StaffGroup[];
  seasons: readonly string[];
  /** Grounded corps the person performed in (corps_staff_affiliations relation='performed'). */
  performed: readonly StaffPerformed[];
  /** Education / awards / current position / hometown / non-DCI groups (staff_bio_facts). */
  bioFacts: StaffBioFacts;
};

type StaffRow = {
  person_id: string;
  display_name: string | null;
  default_title: string | null;
  photo_url: string | null;
  biography: string | null;
};

/** Pick the representative identity for a person_id group: prefer a row with a photo,
 *  then a bio, then a title — so the directory/profile shows the richest available. */
const pickRepresentative = (rows: StaffRow[]): StaffRow => {
  const score = (r: StaffRow) => (r.photo_url ? 4 : 0) + (r.biography ? 2 : 0) + (r.default_title ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a))[0]!;
};

const EMPTY_FACTS: StaffBioFacts = { education: [], awards: [], performedOther: [], hometown: null, currentPosition: null };
const jp = (s: string | null | undefined): any => { try { return JSON.parse(s ?? "{}"); } catch { return {}; } };

/** Fetch mined facts + grounded performing links, grouped by person_id, for the given set
 *  (or ALL when personIds is null). Tables are optional — degrade to empty if not present. */
const fetchBioFactsByPerson = async (
  db: Client,
  personIds: string[] | null,
): Promise<{ facts: Map<string, StaffBioFacts>; performed: Map<string, StaffPerformed[]> }> => {
  const facts = new Map<string, StaffBioFacts>();
  const performed = new Map<string, StaffPerformed[]>();
  const inClause = personIds ? `AND person_id IN (${personIds.map(() => "?").join(",")})` : "";
  const get = (pid: string) => facts.get(pid) ?? facts.set(pid, { education: [], awards: [], performedOther: [], hometown: null, currentPosition: null }).get(pid)!;
  try {
    const fr = await db.execute({
      sql: `SELECT person_id, fact_type, value, detail_json FROM staff_bio_facts WHERE person_id IS NOT NULL ${inClause}`,
      args: personIds ?? [],
    });
    // A person can have the SAME fact on several staff_id rows (one per corps/season) — the
    // facts table is keyed per staff_id, so dedupe by (person, type, normalized value) here.
    const seenFact = new Set<string>();
    const fkey = (pid: string, type: string, v: string) => `${pid}|${type}|${v.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    for (const r of fr.rows as any[]) {
      const f = get(r.person_id), d = jp(r.detail_json);
      const k = fkey(r.person_id, r.fact_type, r.value);
      if (r.fact_type === "education") {
        if (seenFact.has(k)) continue; seenFact.add(k);
        f.education = [...f.education, { institution: r.value, degree: d.degree ?? null, field: d.field ?? null, year: d.year ?? null }];
      } else if (r.fact_type === "award") {
        if (seenFact.has(k)) continue; seenFact.add(k);
        f.awards = [...f.awards, { name: r.value, year: d.year ?? null }];
      } else if (r.fact_type === "performed") {
        if (seenFact.has(k)) continue; seenFact.add(k);
        f.performedOther = [...f.performedOther, { group: r.value, startYear: d.startYear ?? null, endYear: d.endYear ?? null }];
      } else if (r.fact_type === "hometown" && !f.hometown) f.hometown = r.value;
      else if (r.fact_type === "position" && !f.currentPosition) f.currentPosition = { title: d.title ?? r.value, org: d.org ?? "" };
    }
  } catch { /* table may not exist on an older DB — degrade */ }
  try {
    const pr = await db.execute({
      sql: `SELECT cs.person_id, aff.related_corps_key, COALESCE(c.name, aff.related_corps_key) corps_name, c.slug corps_slug,
                   aff.since_season, aff.through_season
              FROM corps_staff_affiliations aff
              JOIN corps_staff cs ON cs.staff_id = aff.staff_id
              LEFT JOIN corps c ON c.corps_key = aff.related_corps_key
             WHERE aff.relation_type='performed' AND cs.person_id IS NOT NULL ${inClause.replace("person_id", "cs.person_id")}`,
      args: personIds ?? [],
    });
    const seen = new Set<string>();
    for (const r of pr.rows as any[]) {
      const key = `${r.person_id}|${r.related_corps_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (performed.get(r.person_id) ?? performed.set(r.person_id, []).get(r.person_id)!).push({
        corps_key: r.related_corps_key, corps_name: r.corps_name, corps_slug: r.corps_slug,
        since_season: r.since_season ?? null, through_season: r.through_season ?? null,
      });
    }
  } catch { /* degrade */ }
  return { facts, performed };
};

const sortSeasonsDesc = (s: Iterable<string>) => [...new Set(s)].sort((a, b) => b.localeCompare(a));

export const buildStaffDirectory = async (db: Client): Promise<StaffSummary[]> => {
  const [identityRes, assignRes] = await Promise.all([
    db.execute({
      sql: `SELECT person_id, display_name, default_title, photo_url, biography
            FROM corps_staff WHERE person_id IS NOT NULL`,
      args: [],
    }),
    db.execute({
      sql: `SELECT cs.person_id, a.season, a.role_type, a.corps_key,
              COALESCE(c.name, a.corps_key) AS corps_name, c.slug AS corps_slug
            FROM corps_staff cs
            JOIN corps_staff_assignments a ON a.staff_id = cs.staff_id
            LEFT JOIN corps c ON c.corps_key = a.corps_key
            WHERE cs.person_id IS NOT NULL`,
      args: [],
    }),
  ]);

  const identityByPerson = new Map<string, StaffRow[]>();
  for (const r of identityRes.rows as unknown as StaffRow[]) {
    (identityByPerson.get(r.person_id) ?? identityByPerson.set(r.person_id, []).get(r.person_id)!).push(r);
  }

  const seasonsByPerson = new Map<string, Set<string>>();
  const captionsByPerson = new Map<string, Map<string, number>>();
  const groupsByPerson = new Map<string, Map<string, StaffGroup>>();
  for (const a of assignRes.rows as unknown as Array<{
    person_id: string; season: string | null; role_type: string | null;
    corps_key: string; corps_name: string; corps_slug: string | null;
  }>) {
    if (a.season) (seasonsByPerson.get(a.person_id) ?? seasonsByPerson.set(a.person_id, new Set()).get(a.person_id)!).add(a.season);
    if (a.role_type) {
      const m = captionsByPerson.get(a.person_id) ?? captionsByPerson.set(a.person_id, new Map()).get(a.person_id)!;
      m.set(a.role_type, (m.get(a.role_type) ?? 0) + 1);
    }
    const g = groupsByPerson.get(a.person_id) ?? groupsByPerson.set(a.person_id, new Map()).get(a.person_id)!;
    g.set(a.corps_key, { corps_key: a.corps_key, corps_name: a.corps_name, corps_slug: a.corps_slug });
  }

  const out: StaffSummary[] = [];
  for (const [personId, rows] of identityByPerson) {
    const rep = pickRepresentative(rows);
    const groups = [...(groupsByPerson.get(personId)?.values() ?? [])];
    out.push({
      person_id: personId,
      display_name: rep.display_name ?? personId,
      default_title: rep.default_title,
      photo_url: rep.photo_url,
      corps_count: groups.length,
      seasons: sortSeasonsDesc(seasonsByPerson.get(personId) ?? []),
      captionBreakdown: [...(captionsByPerson.get(personId)?.entries() ?? [])].map(([caption, count]) => ({ caption, count })),
      groups,
    });
  }
  out.sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));
  return out;
};

/** Batched version: builds ALL staff profiles in 2 queries instead of N+1.
 *  For each person_id, fetches identity + all assignments (grouped in JS),
 *  which replaces the per-person loop in the emit script. */
export const buildAllStaffProfiles = async (db: Client): Promise<StaffProfile[]> => {
  const [identityRes, assignRes] = await Promise.all([
    db.execute({
      sql: `SELECT person_id, display_name, default_title, photo_url, biography
            FROM corps_staff WHERE person_id IS NOT NULL`,
      args: [],
    }),
    db.execute({
      sql: `SELECT cs.person_id, a.corps_key,
              COALESCE(c.name, a.corps_key) AS corps_name, c.slug AS corps_slug,
              a.season, a.title, a.role_type, a.start_year, a.end_year
            FROM corps_staff cs
            JOIN corps_staff_assignments a ON a.staff_id = cs.staff_id
            LEFT JOIN corps c ON c.corps_key = a.corps_key
            WHERE cs.person_id IS NOT NULL
            ORDER BY a.season DESC, corps_name COLLATE NOCASE ASC, a.title ASC`,
      args: [],
    }),
  ]);

  // Group identities by person_id (same as buildStaffDirectory).
  const identityByPerson = new Map<string, StaffRow[]>();
  for (const r of identityRes.rows as unknown as StaffRow[]) {
    (identityByPerson.get(r.person_id) ?? identityByPerson.set(r.person_id, []).get(r.person_id)!).push(r);
  }

  // Group assignments by person_id.
  const assignmentsByPerson = new Map<string, StaffAssignment[]>();
  for (const a of assignRes.rows as unknown as Array<StaffAssignment & { person_id: string }>) {
    const list = assignmentsByPerson.get(a.person_id) ?? [];
    list.push(a);
    assignmentsByPerson.set(a.person_id, list);
  }

  const { facts, performed } = await fetchBioFactsByPerson(db, null);

  const out: StaffProfile[] = [];
  for (const [personId, rows] of identityByPerson) {
    const rep = pickRepresentative(rows);
    const assignments = assignmentsByPerson.get(personId) ?? [];
    const groupMap = new Map<string, StaffGroup>();
    const seasonSet = new Set<string>();
    for (const a of assignments) {
      groupMap.set(a.corps_key, { corps_key: a.corps_key, corps_name: a.corps_name, corps_slug: a.corps_slug });
      if (a.season) seasonSet.add(a.season);
    }
    out.push({
      person_id: personId,
      display_name: rep.display_name ?? personId,
      biography: rep.biography,
      photo_url: rep.photo_url,
      assignments,
      groups: [...groupMap.values()],
      seasons: sortSeasonsDesc(seasonSet),
      performed: performed.get(personId) ?? [],
      bioFacts: facts.get(personId) ?? EMPTY_FACTS,
    });
  }
  return out;
};

export const buildStaffProfile = async (db: Client, personId: string): Promise<StaffProfile | null> => {
  const identityRes = await db.execute({
    sql: `SELECT person_id, display_name, default_title, photo_url, biography
          FROM corps_staff WHERE person_id = ?`,
    args: [personId],
  });
  const rows = identityRes.rows as unknown as StaffRow[];
  if (rows.length === 0) return null;
  const rep = pickRepresentative(rows);

  const assignRes = await db.execute({
    sql: `SELECT a.corps_key,
            COALESCE(c.name, a.corps_key) AS corps_name,
            c.slug AS corps_slug,
            a.season, a.title, a.role_type, a.start_year, a.end_year
          FROM corps_staff cs
          JOIN corps_staff_assignments a ON a.staff_id = cs.staff_id
          LEFT JOIN corps c ON c.corps_key = a.corps_key
          WHERE cs.person_id = ?
          ORDER BY a.season DESC, corps_name COLLATE NOCASE ASC, a.title ASC`,
    args: [personId],
  });
  const assignments = assignRes.rows as unknown as StaffAssignment[];

  const groupMap = new Map<string, StaffGroup>();
  const seasonSet = new Set<string>();
  for (const a of assignments) {
    groupMap.set(a.corps_key, { corps_key: a.corps_key, corps_name: a.corps_name, corps_slug: a.corps_slug });
    if (a.season) seasonSet.add(a.season);
  }

  const { facts, performed } = await fetchBioFactsByPerson(db, [personId]);

  return {
    person_id: personId,
    display_name: rep.display_name ?? personId,
    biography: rep.biography,
    photo_url: rep.photo_url,
    assignments,
    groups: [...groupMap.values()],
    seasons: sortSeasonsDesc(seasonSet),
    performed: performed.get(personId) ?? [],
    bioFacts: facts.get(personId) ?? EMPTY_FACTS,
  };
};
