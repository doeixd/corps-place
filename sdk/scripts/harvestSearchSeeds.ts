// Search-tier seed harvester (docs/announcement-sources-plan.md §A2 search tier).
//
// Google/DDG block this datacenter IP, but browser-tools.ts drives a real browser on a HOME
// machine over a Tailscale reverse tunnel (residential IP) — so we can SCRIPT searches here.
// For each corps we search "<name> staff announcement"/etc., keep result URLs that look like
// staff announcements on a trustworthy host, and write them to `announcement_seeds`. The
// announcement pipeline (`scrapeAnnouncements --ai`) then renders + extracts them. This recovers
// holdout corps whose announcements live off their main domain (e.g. Madison Scouts →
// forwardperformingarts.org) or on HTML-only/blocked sites (Colts /news, etc.).
//
// Usage (from sdk/, with the tunnel up — verify: scripts/browser-tunnel.sh --check):
//   npx tsx scripts/harvestSearchSeeds.ts --corps 001j... --dry-run
//   npx tsx scripts/harvestSearchSeeds.ts --corps 001j... --apply
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SDK_DIR, "..");
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const getOpt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");
const corpsFilter = getOpt("--corps");
const perQuery = Number(getOpt("--n") ?? 8);
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const db = createClient({ url: DB_URL });

// Trust a result URL if its host is the corps' own domain, a known multi-corps org host, or
// dci.org — and it looks like an announcement/news/staff page. Excludes social (hard to extract).
const ORG_HOSTS = /(forwardperformingarts|ascendperformingarts|dci)\.org/i;
const BAD_HOST = /(facebook|instagram|twitter|x\.com|youtube|tiktok|reddit|wikipedia|linkedin)\./i;
const ANN_HINT = /(staff|caption|brass|percussion|visual|guard|design|education|news|announce|team|leadership|instructor)/i;

const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const domainCore = (host: string) => host.replace(/\.(org|com|net)$/i, "").split(".").pop() ?? host;

/** Run one browser-tools search over the tunnel; return {title,link} pairs (parsed from stdout). */
const search = async (query: string): Promise<{ title: string; link: string }[]> => {
  try {
    const { stdout } = await execFile("npx", ["tsx", "scripts/browser-tools.ts", "search", query, "-n", String(perQuery)], {
      cwd: REPO_DIR, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    const out: { title: string; link: string }[] = [];
    let title = "";
    for (const line of stdout.split("\n")) {
      const t = line.match(/^Title:\s*(.+)/); if (t) { title = t[1]!.trim(); continue; }
      const l = line.match(/^Link:\s*(\S+)/); if (l) out.push({ title, link: l[1]!.trim() });
    }
    return out;
  } catch { return []; }
};

const main = async () => {
  const rows = (await db.execute(
    corpsFilter
      ? `SELECT corps_key, name, website FROM corps WHERE corps_key='${corpsFilter.replace(/'/g, "")}'`
      : `SELECT corps_key, name, website FROM corps WHERE website IS NOT NULL AND TRIM(website)!='' ORDER BY name`,
  )).rows as any[];
  await db.execute(`CREATE TABLE IF NOT EXISTS announcement_seeds (corps_key TEXT NOT NULL, url TEXT NOT NULL, title TEXT, published TEXT, source TEXT DEFAULT 'agent-search', added_at TEXT, PRIMARY KEY (corps_key, url))`);

  let totalSeeds = 0;
  for (const c of rows) {
    const name = String(c.name);
    const ownDomain = c.website ? domainCore(hostOf(c.website.startsWith("http") ? c.website : `https://${c.website}`)) : "";
    const queries = [`"${name}" staff announcement`, `"${name}" caption head OR brass OR percussion OR visual staff`, `"${name}" drum corps 2024 staff`];
    const found = new Map<string, string>();
    for (const q of queries) {
      for (const { title, link } of await search(q)) {
        const host = hostOf(link);
        if (!host || BAD_HOST.test(host)) continue;
        const onOwn = ownDomain && host.includes(ownDomain);
        const trusted = onOwn || ORG_HOSTS.test(host);
        if (!trusted) continue;
        if (!(ANN_HINT.test(link) || ANN_HINT.test(title))) continue;
        found.set(link.replace(/\/+$/, ""), title);
      }
    }
    if (found.size === 0) { console.log(`· ${name}: no seed URLs`); continue; }
    console.log(`✓ ${name}: ${found.size} seed URLs`);
    for (const [url, title] of found) {
      console.log(`    ${url}  «${title.slice(0, 50)}»`);
      if (apply) await db.execute({ sql: `INSERT OR IGNORE INTO announcement_seeds (corps_key,url,title,source,added_at) VALUES (?,?,?,'tunnel-search',?)`, args: [c.corps_key, url, title, new Date().toISOString()] });
    }
    totalSeeds += found.size;
  }
  console.log(`\n${apply ? "APPLIED" : "dry-run"}: ${totalSeeds} seed URLs across ${rows.length} corps.`);
  process.exit(0);
};
main();
