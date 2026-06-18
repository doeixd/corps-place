// Pattern B (AI fallback) for staff extraction — docs/staff-scraping-plan.md §4.2 / M4.
//
// For client-rendered / irregular pages where the deterministic parser (Pattern A)
// finds nothing, render the page, REDUCE it to visible text with inline [IMG:url]
// markers, and hand it to a headless LLM CLI with a strict JSON contract. Output is
// schema-validated and confidence-gated to LOW (AI-derived, run-to-run variance).
//
// Engine ladder (each tried only if the prior FAILED): `claude -p` → `codex exec` →
// `opencode` (DeepSeek "flash" via the @opencode-ai/sdk one-shot session). All run
// NON-INTERACTIVELY; the opencode call uses the read-only `plan` agent so it completes
// instead of launching a tool loop. We never give the model web/file tools.
//
// PREFER Pattern A. This costs tokens, varies per run, and must be validated on one
// entity before any bulk use (the plan's M4 acceptance gate).

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createOpencode } from "@opencode-ai/sdk";
import * as cheerio from "cheerio";
import { Effect, Schema, SchemaParser } from "effect";
import { optionalWith } from "./schemaCompat.js";
import { normalizeCaption } from "./relational.js";
import { looksLikePersonName, type ExtractedStaff } from "./staffScraper.js";

const execFile = promisify(execFileCb);

const MAX_PROMPT_CHARS = 16000;
const CLI_TIMEOUT_MS = 150000;

/** Strip non-content, then serialize to visible text with inline `[IMG:absUrl]` markers
 *  so the model can associate a headshot with the nearby name. Returns the FULL reduced
 *  text (caller caps + logs truncation) so silent drops are observable (#5). */
export const reduceHtmlForLlm = (html: string, sourceUrl: string): string => {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,iframe,link,meta,head,nav,footer").remove();
  $("img").each((_, el) => {
    const raw = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
    let abs = "";
    try {
      if (raw && !raw.startsWith("data:")) abs = new URL(raw, sourceUrl).toString();
    } catch {
      /* skip unresolvable */
    }
    $(el).replaceWith(abs ? ` [IMG:${abs}] ` : " ");
  });
  return ($("body").text() || $.root().text())
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
};

const buildPrompt = (reduced: string, sourceUrl: string): string =>
  [
    "You extract staff/instructor records from a drum & bugle corps staff page.",
    "From the PAGE CONTENT below, list every real STAFF MEMBER (instructors, designers,",
    "directors, caption heads, techs). Skip section headers, sponsors, navigation, and",
    "anything that is not a person.",
    "",
    "Return ONLY a JSON array — no prose, no markdown code fences. Each element:",
    '{"name": string, "title": string|null, "bio": string|null, "photoUrl": string|null}',
    "- name: exactly as written on the page.",
    "- title: their verbatim role/title, or null.",
    "- bio: a short bio if the page has one for them, else null.",
    '- photoUrl: the [IMG:...] URL associated with this person (use the URL inside the',
    "  marker), absolute, or null if none is clearly theirs.",
    "If there are no staff members, return [].",
    "",
    `PAGE URL: ${sourceUrl}`,
    "PAGE CONTENT:",
    reduced,
  ].join("\n");

/** Prose-announcement prompt (A4). Announcement posts name staff in PROSE ("…led by Visual
 *  Caption Head Zac Chowning, joined by Assistant Nancy Fleming…") and on custom SPAs the body
 *  is mixed with nav/member-resource menus. This prompt extracts people named WITH a staff role,
 *  scoped to ONE corps, and explicitly rejects menu/nav/event text — the failure mode that made
 *  the deterministic passes emit "Travel Plans"/"What To Bring" as people. */
const buildAnnouncementPrompt = (reduced: string, sourceUrl: string, corpsName?: string): string =>
  [
    `You extract STAFF/INSTRUCTOR records from a drum & bugle corps news/announcement post${corpsName ? ` for "${corpsName}"` : ""}.`,
    "The post often names staff in PROSE sentences, e.g. \"the team is led by Brass Caption Head",
    "Jane Doe, joined by tech John Roe\". Extract EVERY real person named together with a staff",
    "role (caption head, instructor, designer, tech, coordinator, arranger, director, consultant).",
    "",
    "STRICT — do NOT include any of these (they are NOT staff):",
    "- navigation / menu / button labels (e.g. \"Travel Plans\", \"What To Bring\", \"Auditions\",",
    "  \"Camp Paperwork\", \"Membership Contracts\", \"Donate\", \"Tickets\")",
    "- event names, ensemble/corps names, sponsors, section headers",
    "- performers/members being announced as marching members (only INSTRUCTIONAL/admin staff)",
    corpsName ? `- people who belong to a DIFFERENT corps than "${corpsName}"` : "",
    "",
    "Return ONLY a JSON array — no prose, no code fences. Each element:",
    '{"name": string, "title": string|null, "bio": string|null, "photoUrl": string|null}',
    "- name: the person's real name exactly as written.",
    "- title: their verbatim staff role from the text, or null.",
    "- bio: a short bio if present, else null.",
    "- photoUrl: a [IMG:...] URL clearly theirs, else null.",
    "If the post names no staff, return [].",
    "",
    `PAGE URL: ${sourceUrl}`,
    "PAGE CONTENT:",
    reduced,
  ].filter(Boolean).join("\n");

/** DCI roundup prompt (A4, multi-corps). A roundup page (dci.org/news/corps-news-and-
 *  announcements-YYYYMMDD) concatenates short blurbs for MANY corps. Extract (corps, person,
 *  role) tuples for STAFF/instructional announcements only — each tagged with the corps it
 *  belongs to so the caller can attribute correctly. */
const buildRoundupPrompt = (reduced: string, sourceUrl: string): string =>
  [
    "This is a Drum Corps International NEWS ROUNDUP with short announcements for MANY different corps.",
    "Extract every STAFF / INSTRUCTIONAL person announced (caption head/manager, instructor,",
    "designer, tech, arranger, coordinator, director, consultant), and TAG EACH with the corps",
    "they belong to (the corps whose blurb names them).",
    "",
    "Do NOT include: marching members/performers (e.g. a member announced as drum major or",
    "section leader for their performing role), event names, sponsors, or DCI staff.",
    "Attribute each person to the CORRECT corps — never mix people between corps blurbs.",
    "",
    "Return ONLY a JSON array — no prose, no code fences. Each element:",
    '{"corps": string, "name": string, "title": string|null, "bio": string|null}',
    "- corps: the corps name exactly as written in the blurb (e.g. \"Mandarins\", \"Boston Crusaders\").",
    "- name: the person's real name. title: their verbatim staff role, or null.",
    "If no staff are announced, return [].",
    "",
    `PAGE URL: ${sourceUrl}`,
    "PAGE CONTENT:",
    reduced,
  ].join("\n");

// ---- LLM output schema -------------------------------------------------------
const optionalString = Schema.String.pipe(optionalWith({ nullable: true }));
const AiStaffItem = Schema.Struct({
  name: Schema.String,
  title: optionalString,
  bio: optionalString,
  photoUrl: optionalString,
});
const AiStaffArray = Schema.Array(AiStaffItem);

/** Pull the first top-level JSON array out of a CLI response (tolerates code fences /
 *  surrounding prose that headless agents sometimes emit). */
const extractJsonArray = (raw: string): unknown | null => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
};
const splitName = (full: string) => {
  const tok = full.split(" ").filter(Boolean);
  return tok.length < 2 ? { given: null, family: null } : { given: tok[0]!, family: tok[tok.length - 1]! };
};

interface AiItem {
  readonly name: string;
  readonly title?: string | null;
  readonly bio?: string | null;
  readonly photoUrl?: string | null;
}

/** True when the name actually appears in the page text — the anti-hallucination guard.
 *  Accepts a full-name substring, or first AND last name each present as standalone words
 *  (handles reformatting like an added middle initial). */
const nameInSource = (name: string, sourceLc: string): boolean => {
  const lc = name.toLowerCase();
  if (sourceLc.includes(lc)) return true;
  const tok = name.split(/\s+/).filter((t) => t.length >= 3);
  if (tok.length < 2) return false;
  const first = tok[0]!.toLowerCase();
  const last = tok[tok.length - 1]!.toLowerCase();
  const word = (w: string) => new RegExp(`\\b${w.replace(/[^a-z]/gi, "")}\\b`, "i").test(sourceLc);
  return word(first) && word(last);
};

const toRecords = (items: ReadonlyArray<AiItem>, sourceUrl: string, sourceText: string): ExtractedStaff[] => {
  const out: ExtractedStaff[] = [];
  const seen = new Set<string>();
  const sourceLc = sourceText.toLowerCase();
  for (const it of items) {
    const name = clean(it.name);
    // (1) Same precision filter the deterministic parser uses (rejects titles/brands/
    //     section words). (2) GROUND the name in the page text — the LLM fabricates
    //     realistic-looking names to pad its answer (Boston: 125 records from a 4.5 KB
    //     page, ~110 hallucinated). A name absent from the source is a hallucination.
    if (!name || !looksLikePersonName(name) || !nameInSource(name, sourceLc)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const { given, family } = splitName(name);
    const title = clean(it.title);
    out.push({
      displayName: name,
      givenName: given,
      familyName: family,
      title,
      caption: normalizeCaption(title),
      biography: clean(it.bio),
      photoUrl: clean(it.photoUrl),
      sourceUrl,
      confidence: "LOW", // AI-derived
      via: "ai",
    });
  }
  return out;
};

type Engine = "claude" | "codex" | "opencode";

// opencode 3rd-tier (DeepSeek flash) via @opencode-ai/sdk. createOpencode spins a local server;
// lazily create ONE and reuse it (the tier is rarely hit — claude/codex usually succeed). Model
// is "provider/model" (env OPENCODE_MODEL); the read-only `plan` agent gives a plain completion.
let opencodeP: Promise<Awaited<ReturnType<typeof createOpencode>>> | null = null;
const getOpencode = () => { registerOpencodeCleanup(); return (opencodeP ??= createOpencode({ hostname: "127.0.0.1", port: 0 })); };
export const closeOpencode = () => { const p = opencodeP; opencodeP = null; if (p) void p.then((oc) => oc.server.close()).catch(() => {}); };
// Stop the in-process opencode server from ORPHANING (leaking ~80-200 MB each) when a long
// run exits or is terminated — observed accumulating across OOM-killed yearbook runs.
let opencodeCleanupRegistered = false;
const registerOpencodeCleanup = () => {
  if (opencodeCleanupRegistered) return;
  opencodeCleanupRegistered = true;
  process.once("exit", () => closeOpencode());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => { closeOpencode(); process.exit(); });
};
/** One-shot completion via the opencode SDK (DeepSeek flash). Exported so other extractors
 *  (e.g. the yearbook parser) can use it as a 3rd-tier fallback when claude/codex are out. */
export const opencodeComplete = async (prompt: string): Promise<string> => runOpencode(prompt);
const runOpencode = async (prompt: string): Promise<string> => {
  const spec = process.env.OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free";
  const slash = spec.indexOf("/");
  const providerID = spec.slice(0, slash), modelID = spec.slice(slash + 1);
  const { client } = await getOpencode();
  const sess: any = await client.session.create({ body: { title: "staff-extract" } });
  const id = sess.data?.id ?? sess.id;
  const res: any = await client.session.prompt({
    path: { id },
    body: { agent: "plan", model: { providerID, modelID }, parts: [{ type: "text", text: prompt }] },
  });
  const parts = res.data?.parts ?? res.parts ?? [];
  return parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("").trim();
};

const runEngine = (engine: Engine, prompt: string): Promise<string> => {
  if (engine === "opencode") return runOpencode(prompt);
  const claudeBin = process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? "claude";
  const codexBin = process.env.CODEX_CLI ?? "codex";
  const [cmd, args] =
    engine === "claude" ? [claudeBin, ["-p", prompt]] : [codexBin, ["exec", prompt]];
  return execFile(cmd, args as string[], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  }).then((r) => r.stdout.trim());
};

/** `ok` distinguishes "engine answered" (even with an empty list) from "engine
 *  failed / unparseable" so a genuinely staff-less page doesn't trigger a wasted
 *  fallback call (#7). */
type EngineResult = { ok: boolean; staff: ExtractedStaff[] };

const tryEngine = (engine: Engine, prompt: string, sourceUrl: string, sourceText: string): Effect.Effect<EngineResult> =>
  Effect.tryPromise(() => runEngine(engine, prompt)).pipe(
    Effect.flatMap((raw) => {
      const parsed = extractJsonArray(raw);
      if (parsed == null) return Effect.succeed({ ok: false, staff: [] }); // unparseable
      return SchemaParser.decodeUnknownEffect(AiStaffArray)(parsed).pipe(
        Effect.map((items) => ({ ok: true, staff: toRecords(items as ReadonlyArray<AiItem>, sourceUrl, sourceText) })),
        Effect.catch(() => Effect.succeed({ ok: false, staff: [] as ExtractedStaff[] })), // schema mismatch
      );
    }),
    Effect.catch(() => Effect.succeed({ ok: false, staff: [] as ExtractedStaff[] })), // CLI error
  );

/**
 * Pattern B extraction. Tries `claude -p`; falls back to `codex exec` ONLY when claude
 * actually failed (errored / unparseable) — a valid empty answer is accepted as-is, no
 * wasted second call. Never fails (returns [] when both engines come up empty).
 */
export const extractStaffWithAI = (
  html: string,
  sourceUrl: string,
): Effect.Effect<{ staff: ExtractedStaff[]; engine: Engine | null }> =>
  Effect.gen(function* () {
    const full = reduceHtmlForLlm(html, sourceUrl);
    if (full.length < 40) return { staff: [], engine: null };
    if (full.length > MAX_PROMPT_CHARS)
      yield* Effect.logWarning(
        `AI extract: page reduced to ${full.length} chars > cap ${MAX_PROMPT_CHARS}; ` +
          `truncating — staff past the cap may be missed for ${sourceUrl}`,
      );
    const prompt = buildPrompt(full.slice(0, MAX_PROMPT_CHARS), sourceUrl);

    const viaClaude = yield* tryEngine("claude", prompt, sourceUrl, full);
    if (viaClaude.ok) return { staff: viaClaude.staff, engine: "claude" };

    const viaCodex = yield* tryEngine("codex", prompt, sourceUrl, full);
    if (viaCodex.ok) return { staff: viaCodex.staff, engine: "codex" };

    const viaOpencode = yield* tryEngine("opencode", prompt, sourceUrl, full);
    return { staff: viaOpencode.staff, engine: viaOpencode.ok ? "opencode" : null };
  });

/**
 * A4 — Pattern B extraction tuned for PROSE announcement posts (single corps). Same engine
 * ladder + anti-hallucination grounding as `extractStaffWithAI`, but a prose/role-aware prompt
 * that rejects nav/menu/event text and (when `corpsName` is given) other corps. Used as the
 * fallback when the deterministic announcement extractor under-yields on prose/SPA pages.
 */
export const extractAnnouncementWithAI = (
  html: string,
  sourceUrl: string,
  corpsName?: string,
): Effect.Effect<{ staff: ExtractedStaff[]; engine: Engine | null }> =>
  Effect.gen(function* () {
    const full = reduceHtmlForLlm(html, sourceUrl);
    if (full.length < 40) return { staff: [], engine: null };
    const prompt = buildAnnouncementPrompt(full.slice(0, MAX_PROMPT_CHARS), sourceUrl, corpsName);
    const viaClaude = yield* tryEngine("claude", prompt, sourceUrl, full);
    if (viaClaude.ok) return { staff: viaClaude.staff, engine: "claude" };
    const viaCodex = yield* tryEngine("codex", prompt, sourceUrl, full);
    if (viaCodex.ok) return { staff: viaCodex.staff, engine: "codex" };
    const viaOpencodeA = yield* tryEngine("opencode", prompt, sourceUrl, full);
    return { staff: viaOpencodeA.staff, engine: viaOpencodeA.ok ? "opencode" : null };
  });

// ---- DCI roundup (multi-corps) ----------------------------------------------
export interface RoundupItem { readonly corps: string; readonly name: string; readonly title: string | null; readonly bio: string | null; }
const AiRoundupArray = Schema.Array(
  Schema.Struct({ corps: Schema.String, name: Schema.String, title: optionalString, bio: optionalString }),
);
const toRoundupItems = (items: ReadonlyArray<{ corps: string; name: string; title?: string | null; bio?: string | null }>, sourceText: string): RoundupItem[] => {
  const out: RoundupItem[] = [];
  const seen = new Set<string>();
  const sourceLc = sourceText.toLowerCase();
  for (const it of items) {
    const name = clean(it.name), corps = clean(it.corps);
    // Same precision + anti-hallucination grounding as single-corps; both name AND corps must
    // appear in the page text (guards fabricated tuples and mis-attribution).
    if (!name || !corps || !looksLikePersonName(name) || !nameInSource(name, sourceLc) || !sourceLc.includes(corps.toLowerCase())) continue;
    const key = `${corps.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ corps, name, title: clean(it.title), bio: clean(it.bio) });
  }
  return out;
};
const tryRoundup = (engine: Engine, prompt: string, sourceText: string): Effect.Effect<{ ok: boolean; items: RoundupItem[] }> =>
  Effect.tryPromise(() => runEngine(engine, prompt)).pipe(
    Effect.flatMap((raw) => {
      const parsed = extractJsonArray(raw);
      if (parsed == null) return Effect.succeed({ ok: false, items: [] });
      return SchemaParser.decodeUnknownEffect(AiRoundupArray)(parsed).pipe(
        Effect.map((items) => ({ ok: true, items: toRoundupItems(items as any, sourceText) })),
        Effect.catch(() => Effect.succeed({ ok: false, items: [] as RoundupItem[] })),
      );
    }),
    Effect.catch(() => Effect.succeed({ ok: false, items: [] as RoundupItem[] })),
  );

/**
 * A4 — extract (corps, name, title, bio) tuples from a DCI multi-corps news roundup. Same
 * claude→codex→opencode ladder + grounding; the caller maps `corps` names to corps_keys.
 */
export const extractDciRoundupWithAI = (
  html: string,
  sourceUrl: string,
): Effect.Effect<{ items: RoundupItem[]; engine: Engine | null }> =>
  Effect.gen(function* () {
    const full = reduceHtmlForLlm(html, sourceUrl);
    if (full.length < 40) return { items: [], engine: null };
    const prompt = buildRoundupPrompt(full.slice(0, MAX_PROMPT_CHARS), sourceUrl);
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const r = yield* tryRoundup(engine, prompt, full);
      if (r.ok) return { items: r.items, engine };
    }
    return { items: [], engine: null };
  });
