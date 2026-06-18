// Dry-run analysis of DETERMINISTIC cross-corps identity-merge tactics (no LLM).
// Tiers (high→low confidence), each EVIDENCE-based so we never merge on name alone:
//   T1  shared non-placeholder photo_url  (a photo used by exactly ONE name = a real
//       headshot uniquely identifying that person; placeholders/demos used by ≥2 names
//       are excluded — they'd wrongly fuse different people)
//   T2  high biography overlap (token Jaccard ≥ 0.6)
//   --  otherwise KEEP SPLIT (queued for human/LLM review) — common names w/o evidence
// Also flags JUNK names (policy/handbook/etc.) for deletion, not merging.
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
const db = createClient({ url: "file:./dci-relational.db" });
const cache = createClient({ url: "file:./media-cache.db" });

const corpsOf = (id: string) => id.split(":")[0] ?? id;

// --- T0 corps-key ALIASING: the same real corps appears under multiple corps keys (Bluecoats
//     = 4 keys, Blue Devils = 3, Mandarins = 2…). We detect aliases by the staff-page DOMAIN:
//     keys whose staff source URLs share a primary domain are the same corps, so a same-name
//     pair across them is the same person — merge regardless of surname commonness. ---
const domainOf = (u: unknown): string => {
  try {
    return (String(u).replace(/^https?:\/\/web\.archive\.org\/web\/[0-9a-z_]+\//i, "")
      .match(/^https?:\/\/(?:www\.)?([^\/:]+)/)?.[1] ?? "").toLowerCase();
  } catch { return ""; }
};
const keyDomainCount = new Map<string, Map<string, number>>();
for (const r of (await db.execute(
  "SELECT substr(cs.staff_id,1,instr(cs.staff_id,':')-1) k, json_extract(a.links_json,'$[0].url') u FROM corps_staff cs JOIN corps_staff_assignments a ON a.staff_id=cs.staff_id WHERE a.links_json IS NOT NULL",
)).rows as any[]) {
  const d = domainOf(r.u);
  if (d && d !== "web.archive.org") { const m = keyDomainCount.get(r.k) ?? keyDomainCount.set(r.k, new Map()).get(r.k)!; m.set(d, (m.get(d) ?? 0) + 1); }
}
const primaryDomain = (key: string): string => {
  const m = keyDomainCount.get(key);
  if (!m) return key;
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
};
const sameRealCorps = (L: string, R: string) => {
  const dl = primaryDomain(corpsOf(L)), dr = primaryDomain(corpsOf(R));
  return dl === dr && dl !== corpsOf(L); // share a real domain (not the fallback-to-key)
};
// a "name" that is entirely role/title words (mis-extracted label, not a person) → delete.
const TITLE_ONLY = /^(commercial|creative|video|scenic|executive|associate|assistant|senior|lead|head|program|design|visual|brass|percussion|guard|color|drill|music|production|technical|operations|administrative|general|tour|business|marketing|development|driver|producer|designer|coordinator|manager|director|technician|instructor|consultant|specialist|engineer|supervisor|staff|team|and|of|the|for|&)(\s+|$)/i;
const isTitleOnlyName = (n: string) => { let s = n.trim(); while (TITLE_ONLY.test(s)) s = s.replace(TITLE_ONLY, ""); return s.trim().length === 0; };

// --- photo-byte hash: same cached image bytes = same headshot = same person (definitive,
//     even across hosts/resizes that give different URLs). Cached so we hash each url once. ---
const hashCache = new Map<string, string | null>();
const photoHash = async (url: string | null): Promise<string | null> => {
  if (!url) return null;
  if (hashCache.has(url)) return hashCache.get(url)!;
  const row = (await cache.execute({ sql: "SELECT bytes FROM media_cache WHERE url=? LIMIT 1", args: [url] })).rows[0] as any;
  const h = row?.bytes ? createHash("sha1").update(Buffer.from(row.bytes as ArrayBuffer)).digest("hex") : null;
  hashCache.set(url, h);
  return h;
};

// --- filename-name match: a headshot whose stored filename embeds the person's name is a
//     genuine photo OF them. Two same-name records each backed by such a photo are the same
//     person — UNLESS the name is common (two different "John Smith"s would both qualify).
//     Guard with a distinctive-surname test computed from our own data. ---
const PLACEHOLDER_FILE = /tbh|hw[\s%]*sun|empty[\s-]*state|placeholder|demo|preloader|silhouette|default|coming[\s-]*soon/i;
const fileTokens = (url: string | null): Set<string> => {
  if (!url) return new Set();
  try {
    const last = decodeURIComponent(url.split("/").pop()!.split("?")[0]!).replace(/\.[a-z]+$/i, "");
    return new Set(last.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length > 2));
  } catch { return new Set(); }
};
const nameTokens = (n: string) => n.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((t) => t.length > 2);
const surnameOf = (n: string) => nameTokens(n).slice(-1)[0] ?? "";
const tokenize = (s: string | null) =>
  new Set((s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 3));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size < 4 || b.size < 4) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};
const JUNK = /\b(policy|handbook|safe place|code of conduct|mission|vision|values|faq|terms)\b/i;

// 1. placeholder photo_urls: used by ≥2 DISTINCT names (a real personal headshot = 1 name)
const phRows = (await db.execute(
  "SELECT photo_url, count(DISTINCT lower(display_name)) dn FROM corps_staff WHERE photo_url IS NOT NULL GROUP BY photo_url",
)).rows as any[];
const placeholder = new Set(phRows.filter((r) => r.dn >= 2).map((r) => r.photo_url));
console.log(`placeholder/demo photo_urls (shared by ≥2 names): ${placeholder.size}`);

// 2. load staff + each one's source URL (the staff page it was extracted from). Strip the
//    Wayback timestamp so the SAME logical page across seasons compares equal.
const srcOf = new Map<string, string>();
for (const r of (await db.execute(
  "SELECT cs.staff_id sid, json_extract(a.links_json,'$[0].url') u FROM corps_staff cs JOIN corps_staff_assignments a ON a.staff_id=cs.staff_id WHERE a.links_json IS NOT NULL GROUP BY cs.staff_id",
)).rows as any[]) {
  if (r.u) srcOf.set(r.sid, String(r.u).replace(/web\.archive\.org\/web\/\d+id_\//, ""));
}
// common-surname guard for T5: a surname used by ≥3 DISTINCT first names across the whole
// dataset is "common" (Smith/Lopez/Lin) — two different people could share the full name, so
// we hold those. An uncommon surname (≤2 first names) makes a same-name collision implausible.
const tok = (n: string) => n.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter((t) => t.length > 1);
const surnameFirstNames = new Map<string, Set<string>>();
for (const r of (await db.execute("SELECT DISTINCT display_name FROM corps_staff")).rows as any[]) {
  const t = tok(r.display_name); if (t.length < 2) continue;
  (surnameFirstNames.get(t.at(-1)!) ?? surnameFirstNames.set(t.at(-1)!, new Set()).get(t.at(-1)!)!).add(t[0]!);
}
const uncommonSurname = (n: string) => { const t = tok(n); return t.length >= 2 && (surnameFirstNames.get(t.at(-1)!)?.size ?? 1) <= 2; };

const staff = new Map<string, { name: string; photo: string | null; bio: string | null }>();
const surnameFullNames = new Map<string, Set<string>>(); // surname -> distinct full names using it
for (const r of (await db.execute("SELECT staff_id, display_name, photo_url, biography FROM corps_staff")).rows as any[]) {
  staff.set(r.staff_id, { name: r.display_name, photo: r.photo_url, bio: r.biography });
  const sn = surnameOf(r.display_name);
  if (sn) (surnameFullNames.get(sn) ?? surnameFullNames.set(sn, new Set()).get(sn)!).add(r.display_name.toLowerCase().trim());
}
// distinctive surname = used by exactly one full name in the whole dataset (rare → safe to
// merge same-name records on a name-matching photo; common surnames are excluded).
const distinctiveSurname = (n: string) => (surnameFullNames.get(surnameOf(n))?.size ?? 99) === 1;

// shared evidence between a pair, beyond photo_url/source/bio: identical photo bytes, OR a
// name-matching headshot on both sides with a distinctive surname.
const photoCorroborates = async (l: { name: string; photo: string | null }, r: { name: string; photo: string | null }): Promise<"byte" | "fname" | null> => {
  if (!l.photo || !r.photo || PLACEHOLDER_FILE.test(l.photo) || PLACEHOLDER_FILE.test(r.photo)) return null;
  const [hl, hr] = [await photoHash(l.photo), await photoHash(r.photo)];
  if (hl && hl === hr) return "byte";
  const nm = nameTokens(l.name), lf = fileTokens(l.photo), rf = fileTokens(r.photo);
  if (distinctiveSurname(l.name) && nm.some((t) => lf.has(t)) && nm.some((t) => rf.has(t))) return "fname";
  return null;
};

// 3. evaluate each queued review pair
const pairs = (await db.execute(
  "SELECT DISTINCT left_staff_id L, right_staff_id R FROM corps_staff_review WHERE resolved=0",
)).rows as any[];
// T5 (uncommon-surname same-name merge) is OPT-IN — it merges on name-rarity rather than
// corroborating evidence, so it's gated behind --names. Without it we stay conservative.
const T5 = process.argv.includes("--names");
let t0 = 0, t1 = 0, tsrc = 0, t2 = 0, tbyte = 0, tfname = 0, t5 = 0, split = 0, junk = 0;
const samples: Record<string, string[]> = { T0: [], T1: [], TSRC: [], T2: [], TBYTE: [], TFNAME: [], T5: [], SPLIT: [], JUNK: [] };
for (const p of pairs) {
  const l = staff.get(p.L), r = staff.get(p.R);
  if (!l || !r) continue;
  if (corpsOf(p.L) === corpsOf(p.R)) continue;
  const log = (b: string[]) => { if (b.length < 6) b.push(`${l.name}  [${corpsOf(p.L)} ~ ${corpsOf(p.R)}]`); };
  if (JUNK.test(l.name) || isTitleOnlyName(l.name)) { junk++; log(samples.JUNK!); continue; }
  if (sameRealCorps(p.L, p.R)) { t0++; log(samples.T0!); continue; } // same real corps, aliased key
  if (l.photo && l.photo === r.photo && !placeholder.has(l.photo)) { t1++; log(samples.T1!); continue; }
  const ls = srcOf.get(p.L), rs = srcOf.get(p.R);
  if (ls && ls === rs) { tsrc++; log(samples.TSRC!); continue; } // same staff page = same person
  if (jaccard(tokenize(l.bio), tokenize(r.bio)) >= 0.6) { t2++; log(samples.T2!); continue; }
  const corr = await photoCorroborates(l, r);
  if (corr === "byte") { tbyte++; log(samples.TBYTE!); continue; }
  if (corr === "fname") { tfname++; log(samples.TFNAME!); continue; }
  if (T5 && uncommonSurname(l.name)) { t5++; log(samples.T5!); continue; }
  split++; log(samples.SPLIT!);
}
console.log(`\nof ${pairs.length} pairs:`);
console.log(`  T0  same real corps (aliased key) → MERGE : ${t0}`);
console.log(`  T1  shared-real-photo  → MERGE : ${t1}`);
console.log(`  T1c identical-source   → MERGE : ${tsrc}`);
console.log(`  T2  bio-overlap≥0.6    → MERGE : ${t2}`);
console.log(`  T3  identical photo bytes → MERGE : ${tbyte}`);
console.log(`  T4  name-matching headshot + distinctive surname → MERGE : ${tfname}`);
console.log(`  T5  uncommon-surname same-name (--names) → MERGE : ${t5}`);
console.log(`  JUNK (delete)                  : ${junk}`);
console.log(`  keep SPLIT (review)            : ${split}`);
console.log(`  >> total auto-merge: ${t0 + t1 + tsrc + t2 + tbyte + tfname + t5} / ${pairs.length}`);

if (!process.argv.includes("--apply")) {
  for (const k of ["T0", "T1", "TSRC", "T2", "TBYTE", "TFNAME", "T5", "JUNK", "SPLIT"]) console.log(`\n  ${k} samples:`, samples[k]);
  console.log("\n(dry-run; pass --apply to execute)");
  process.exit(0);
}

// ---- APPLY: union-find merge clusters + junk delete ----
const base = (pid: string) => pid.replace(/-\d+$/, "");
const parent = new Map<string, string>();
const find = (x: string): string => { while (parent.get(x) && parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return parent.get(x) ?? x; };
const union = (a: string, b: string) => { parent.set(a, parent.get(a) ?? a); parent.set(b, parent.get(b) ?? b); parent.set(find(a), find(b)); };
const mergeIds: Array<[string, string]> = [];
const junkIds = new Set<string>();
for (const p of pairs) {
  const l = staff.get(p.L), r = staff.get(p.R);
  if (!l || !r || corpsOf(p.L) === corpsOf(p.R)) continue;
  if (JUNK.test(l.name) || isTitleOnlyName(l.name)) {
    if (isTitleOnlyName(l.name)) junkIds.add(p.L);
    if (isTitleOnlyName(r.name)) junkIds.add(p.R);
    if (JUNK.test(l.name)) { junkIds.add(p.L); junkIds.add(p.R); }
    continue;
  }
  if (sameRealCorps(p.L, p.R)) { union(p.L, p.R); mergeIds.push([p.L, p.R]); continue; }
  const sharePhoto = l.photo && l.photo === r.photo && !placeholder.has(l.photo);
  const ls = srcOf.get(p.L), rs = srcOf.get(p.R);
  const shareSrc = !!ls && ls === rs;
  const shareBio = jaccard(tokenize(l.bio), tokenize(r.bio)) >= 0.6;
  const corr = await photoCorroborates(l, r);
  const nameMerge = T5 && uncommonSurname(l.name);
  if (sharePhoto || shareSrc || shareBio || corr || nameMerge) { union(p.L, p.R); mergeIds.push([p.L, p.R]); }
}
// assign one canonical person_id per cluster (the base slug)
const clusters = new Map<string, string[]>();
for (const id of new Set(mergeIds.flat())) { const root = find(id); (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(id); }
let merged = 0, people = 0;
for (const members of clusters.values()) {
  // Canonical = the cluster's OWN smallest existing person_id (NOT base(slug) — stripping
  // the suffix would collide two distinct same-name clusters, e.g. two "Marvin Reed"s).
  const pids: string[] = [];
  for (const m of members) {
    const p = (await db.execute({ sql: "SELECT person_id FROM corps_staff WHERE staff_id=? LIMIT 1", args: [m] })).rows[0]?.person_id as string | undefined;
    if (p) pids.push(p);
  }
  const canonical = pids.sort()[0] ?? members[0]!; // "marvin-reed" sorts before "marvin-reed-2"
  for (const m of members) { await db.execute({ sql: "UPDATE corps_staff SET person_id=? WHERE staff_id=?", args: [canonical, m] }); merged++; }
  people++;
}
// resolve merged review rows
for (const [L, R] of mergeIds) {
  const id = L <= R ? `${L}::${R}` : `${R}::${L}`;
  await db.execute({ sql: "UPDATE corps_staff_review SET resolved=1, action='merge', decided_by='deterministic' WHERE review_id=?", args: [id] });
}
// delete junk staff across tables (FK enforcement is off → delete children explicitly)
let jdel = 0;
for (const id of junkIds) {
  for (const t of ["corps_staff_assignments", "corps_staff_links", "corps_staff_affiliations"])
    await db.execute({ sql: `DELETE FROM ${t} WHERE staff_id=?`, args: [id] });
  await db.execute({ sql: "DELETE FROM media_assets WHERE owner_type='staff' AND owner_id=?", args: [id] });
  await db.execute({ sql: "DELETE FROM corps_staff WHERE staff_id=?", args: [id] });
  await db.execute({ sql: "UPDATE corps_staff_review SET resolved=1, action='deleted-junk' WHERE left_staff_id=? OR right_staff_id=?", args: [id, id] });
  jdel++;
}
console.log(`\nAPPLIED: merged ${merged} records into ${people} canonical people; deleted ${jdel} junk staff rows.`);
process.exit(0);
