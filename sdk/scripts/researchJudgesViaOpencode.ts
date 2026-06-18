// Judge bio research on the FREE tier (opencode/deepseek) — mirror of researchStaffViaOpencode,
// adapted for JUDGES (adjudicators aren't tied to one corps, so we ground on the surname + a
// marching-arts/judging term instead of a corps name). Search via browser-tools over the Tailscale
// tunnel (residential IP). Output → applyJudgeResearch.ts.
// Usage: npx tsx scripts/researchJudgesViaOpencode.ts --input results/staff-research/_judges-input.json --out results/staff-research/batch-judges.json [--limit N]
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
const inputPath = resolve(SDK_DIR, arg("--input") ?? "results/staff-research/_judges-input.json");
const outPath = resolve(SDK_DIR, arg("--out") ?? "results/staff-research/batch-judges.json");
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;

interface Target { judge_id: string; display_name: string; captions: string[] }
interface SearchHit { title: string; link: string; snippet: string; content: string }
const MARCHING = /\b(judge|judg(?:ing|ed)|adjudicat\w+|DCI|WGI|drum\s*corps|marching|caption|color\s*guard|percussion|brass|visual|general\s*effect|band)\b/i;

const browserSearch = async (q: string, n = 4): Promise<SearchHit[]> => {
  try {
    const { stdout } = await execFile("npx", ["tsx", "scripts/browser-tools.ts", "search", q, "--content", "-n", String(n), "--timeout", "12"], { cwd: REPO_ROOT, timeout: 120000, maxBuffer: 8 << 20 });
    const hits: SearchHit[] = [];
    for (const block of stdout.split(/--- Result \d+ ---/).slice(1)) {
      const link = block.match(/Link:\s*(.*)/)?.[1]?.trim() ?? "";
      const content = (block.split(/\nContent:\n/)[1] ?? "").trim().slice(0, 4000);
      if (link) hits.push({ title: block.match(/Title:\s*(.*)/)?.[1]?.trim() ?? "", link, snippet: block.match(/Snippet:\s*(.*)/)?.[1]?.trim() ?? "", content });
    }
    return hits;
  } catch { return []; }
};
const extractJson = (s: string): any => { const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } };
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "");

const research = async (t: Target) => {
  const hits = (await browserSearch(`${t.display_name} DCI drum corps judge adjudicator`)).filter((h) => (h.content?.length ?? 0) > 150).slice(0, 3);
  if (hits.length === 0) return { judge_id: t.judge_id, display_name: t.display_name, bio: null, photo_url: null, sources: [], confidence: "LOW" };
  const sourceBlock = hits.map((h, i) => `SOURCE ${i + 1} (${h.link}):\n${h.content}`).join("\n\n");
  const prompt =
`You write a factual biography of a DRUM CORPS / marching-arts JUDGE (adjudicator) ONLY from the provided sources. Person: "${t.display_name}".\n\n` +
`RULES: Use only facts in the sources. The sources must clearly be the SAME person AND involve the marching arts / judging / DCI / WGI / band education. If you cannot confirm, return confidence "LOW" and bio null. Do NOT invent anything.\n\n` +
`Return ONLY minified JSON: {"bio":"2-4 factual sentences or null","photo_url":"a headshot URL if present, else null","confidence":"HIGH|MEDIUM|LOW","sources":["url",...]}\n\n` +
sourceBlock.slice(0, 12000);
  let raw = ""; try { raw = await opencodeComplete(prompt); } catch { /* */ }
  const j = extractJson(raw);
  if (!j) return { judge_id: t.judge_id, display_name: t.display_name, bio: null, photo_url: null, sources: hits.map((h) => h.link), confidence: "LOW" };
  const bio = typeof j.bio === "string" ? j.bio.trim() : "";
  const surname = norm(t.display_name).split(" ").filter(Boolean).pop() ?? "";
  const nbio = norm(bio);
  let confidence = String(j.confidence ?? "LOW").toUpperCase();
  // Ground: surname present AND a marching-arts/judging term in the bio (anti-wrong-person).
  if (bio.length < 40 || !surname || !nbio.includes(surname) || !MARCHING.test(bio)) confidence = "LOW";
  return {
    judge_id: t.judge_id, display_name: t.display_name,
    bio: confidence === "LOW" ? null : bio,
    photo_url: typeof j.photo_url === "string" && /^https?:\/\//.test(j.photo_url) ? j.photo_url : null,
    sources: Array.isArray(j.sources) && j.sources.length ? j.sources : hits.map((h) => h.link),
    confidence,
  };
};

const main = async () => {
  const targets: Target[] = JSON.parse(readFileSync(inputPath, "utf8"));
  const slice = limit ? targets.slice(0, limit) : targets;
  const out: any[] = []; let h = 0, m = 0, l = 0, ph = 0;
  for (const t of slice) {
    const r = await research(t); out.push(r);
    if (r.confidence === "HIGH") h++; else if (r.confidence === "MEDIUM") m++; else l++;
    if (r.photo_url) ph++;
    console.log(`${r.confidence[0]} ${r.photo_url ? "📷" : "  "} ${t.display_name}`);
    writeFileSync(outPath, JSON.stringify(out, null, 1));
  }
  closeOpencode();
  console.log(`\nDone: ${h} HIGH, ${m} MEDIUM, ${l} LOW; ${ph} photos → ${outPath}`);
  process.exit(0);
};
main();
