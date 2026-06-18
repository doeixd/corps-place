// S2 Tier B — staff bio research on the FREE tier (opencode / deepseek-v4-flash-free).
//
// deepseek has no web access, so THIS script is its toolbelt: it searches (DuckDuckGo HTML,
// no API key), fetches the top result pages, strips them to text, and hands that to
// opencodeComplete() with a strict-JSON grounding prompt. The model only synthesizes from
// the provided text; we then RE-GROUND in code (the person's surname AND a known corps token
// must appear) before trusting it. Output matches the Tier-A shape so the SAME ingest
// (applyStaffResearch.ts) consumes it. Cuts Claude cost; hand-held + orchestrated.
//
// Usage:  npx tsx scripts/researchStaffViaOpencode.ts --input results/staff-research/_input-0.json \
//                 --out results/staff-research/batch-oc-0.json [--limit N]
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadRepoEnv } from "./scriptEnv.js";
import { opencodeComplete, closeOpencode } from "../src/staffAiExtract.js";

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(SDK_DIR, "..");
loadRepoEnv(SDK_DIR);
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const inputPath = resolve(SDK_DIR, arg("--input") ?? "results/staff-research/_input-0.json");
const outPath = resolve(SDK_DIR, arg("--out") ?? "results/staff-research/batch-oc.json");
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;

interface Target { person_id: string; display_name: string; corps_names: string[]; roles: string[]; hasphoto: boolean }
interface SearchHit { title: string; link: string; snippet: string; content: string }

// Search + readable-content via browser-tools on the HOME machine over the Tailscale tunnel
// (residential IP — Google doesn't block it; the datacenter IP would be CAPTCHA'd).
const browserSearch = async (q: string, n = 4): Promise<SearchHit[]> => {
  try {
    const { stdout } = await execFile(
      "npx", ["tsx", "scripts/browser-tools.ts", "search", q, "--content", "-n", String(n), "--timeout", "12"],
      { cwd: REPO_ROOT, timeout: 120000, maxBuffer: 8 << 20 },
    );
    const hits: SearchHit[] = [];
    for (const block of stdout.split(/--- Result \d+ ---/).slice(1)) {
      const title = block.match(/Title:\s*(.*)/)?.[1]?.trim() ?? "";
      const link = block.match(/Link:\s*(.*)/)?.[1]?.trim() ?? "";
      const snippet = block.match(/Snippet:\s*(.*)/)?.[1]?.trim() ?? "";
      const content = (block.split(/\nContent:\n/)[1] ?? "").trim().slice(0, 4000);
      if (link) hits.push({ title, link, snippet, content });
    }
    return hits;
  } catch { return []; }
};

const extractJson = (s: string): any => {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "");

const research = async (t: Target) => {
  const corps0 = t.corps_names[0] ?? "drum corps";
  const role = t.roles.find((r) => r !== "other") ?? "";
  const hits = (await browserSearch(`${t.display_name} drum corps ${corps0} ${role} biography`))
    .filter((h) => (h.content?.length ?? 0) > 150)
    .slice(0, 3);
  if (hits.length === 0) return { person_id: t.person_id, display_name: t.display_name, bio: null, photo_url: null, sources: [], confidence: "LOW" };

  const pages = hits.map((h) => ({ url: h.link }));
  const sourceBlock = hits.map((h, i) => `SOURCE ${i + 1} (${h.link}):\n${h.content}`).join("\n\n");
  const prompt =
`You write a factual drum-corps staff biography ONLY from the provided sources. Person: "${t.display_name}". ` +
`Known drum corps they worked with: ${t.corps_names.join(", ")}. Known roles: ${t.roles.join(", ")}.\n\n` +
`RULES: Use only facts present in the sources. The sources must clearly be the SAME person — they must mention the marching arts/drum corps AND at least one known corps or role. ` +
`If you cannot confirm it is the same person, return confidence "LOW" and bio null. Do NOT invent anything.\n\n` +
`Return ONLY minified JSON: {"bio": "2-4 factual sentences or null", "photo_url": "one [image:] URL that is this person's headshot, or null", "confidence": "HIGH|MEDIUM|LOW", "sources": ["url",...]}\n\n` +
sourceBlock.slice(0, 12000);

  let raw = "";
  try { raw = await opencodeComplete(prompt); } catch { /* leave empty */ }
  const j = extractJson(raw);
  if (!j) return { person_id: t.person_id, display_name: t.display_name, bio: null, photo_url: null, sources: pages.map((p) => p.url), confidence: "LOW" };

  // Code-side RE-GROUND: surname + a known corps token must appear in the bio (anti-wrong-person).
  const bio = typeof j.bio === "string" ? j.bio.trim() : "";
  const surname = norm(t.display_name).split(" ").filter(Boolean).pop() ?? "";
  const nbio = norm(bio);
  const corpsHit = t.corps_names.some((c) => { const tok = norm(c).split(" ").filter((w) => w.length > 3)[0]; return tok && nbio.includes(tok); });
  let confidence = String(j.confidence ?? "LOW").toUpperCase();
  if (bio.length < 40 || !surname || !nbio.includes(surname)) confidence = "LOW";
  else if (!corpsHit && confidence === "HIGH") confidence = "MEDIUM"; // bio doesn't name a known corps → soften
  return {
    person_id: t.person_id, display_name: t.display_name,
    bio: confidence === "LOW" ? null : bio,
    photo_url: typeof j.photo_url === "string" && /^https?:\/\//.test(j.photo_url) ? j.photo_url : null,
    sources: Array.isArray(j.sources) && j.sources.length ? j.sources : pages.map((p) => p.url),
    confidence,
  };
};

const main = async () => {
  const targets: Target[] = JSON.parse(readFileSync(inputPath, "utf8"));
  const slice = limit ? targets.slice(0, limit) : targets;
  const out: any[] = [];
  let h = 0, m = 0, l = 0, ph = 0;
  for (const t of slice) {
    const r = await research(t);
    out.push(r);
    if (r.confidence === "HIGH") h++; else if (r.confidence === "MEDIUM") m++; else l++;
    if (r.photo_url) ph++;
    console.log(`${r.confidence[0]} ${r.photo_url ? "📷" : "  "} ${t.display_name}`);
    writeFileSync(outPath, JSON.stringify(out, null, 1)); // checkpoint each person
  }
  closeOpencode(); // fire-and-forget (returns void; closes the in-proc opencode server)
  console.log(`\nDone: ${h} HIGH, ${m} MEDIUM, ${l} LOW; ${ph} photos → ${outPath}`);
  process.exit(0);
};
main();
