import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Schema, SchemaParser } from 'effect';
import { optionalWith } from '../schemaCompat.js';
import type { YearbookPage } from './yearbookText.js';
import { looksLikePersonName, normalizeCapsName } from '../staffScraper.js';
import { opencodeComplete } from '../staffAiExtract.js';

const execFile = promisify(execFileCb);

/**
 * DCI Yearbook profile-page extraction (M10, step 2-3).
 *
 * Corps profile pages list the full staff/design team under section headings, but
 * the PDF text carries design letter-spacing artifacts ("S TA F F", "Executive D
 * irector") that defeat naive regex. So we use the project's established AI-extract
 * pattern (mirrors sdk/src/staffAiExtract.ts: `claude -p`, `codex` fallback,
 * strict JSON, Effect Schema validation). The yearbook is a HIGH-AUTHORITY source,
 * so correctness matters more than shaving the per-page model cost.
 */

const CLI_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 12_000;

const optionalString = Schema.String.pipe(optionalWith({ nullable: true }));

const YearbookStaffMember = Schema.Struct({
  name: Schema.String,
  /** The section heading the person appears under (Design, Brass, Percussion, …). */
  section: optionalString,
  /** Parenthetical titles, e.g. ["Caption Head"], ["Composer", "Arranger"]. */
  roles: Schema.Array(Schema.String).pipe(optionalWith({ default: () => [] })),
});
export const YearbookProfileSchema = Schema.Struct({
  /** The corps website printed on the page (the join key to corps), e.g. bostoncrusaders.org. */
  website: optionalString,
  /** "City, ST" printed on the page. */
  location: optionalString,
  staff: Schema.Array(YearbookStaffMember),
});
export type YearbookProfile = typeof YearbookProfileSchema.Type;

const SECTION_HINTS =
  /(Executive|Corps Director|Drum Major|Design|Brass|Percussion|Color Guard|Visual|Front Ensemble|Additional Staff|Administrative)/i;
// "City, ST" — a US state abbreviation after a comma. Corps profiles carry one.
const CITY_STATE = /,\s*[A-Z]{2}\b/;
const DOMAIN = /\b[a-z0-9-]+\.(org|com|net)\b/i;

/**
 * Is this page a corps profile (vs. prose, editorial, DCI org pages)?
 * Actual profile pages have: a non-DCI website domain, a City/ST pair,
 * the "STAFF" keyword, and at least one section heading. Editorial pages
 * often match the domain+city check but lack STAFF.
 */
export const isProfilePage = (page: YearbookPage): boolean => {
  const t = page.text;
  // Too large = multi-page editorial, not a single corps profile
  if (t.length > 8000) return false;
  const domain = t.match(DOMAIN)?.[0]?.toLowerCase();
  if (!domain || domain.startsWith('dci.')) return false;
  // "STAFF/Staff" keyword is the strongest signal — all corps profiles have it.
  // Case-insensitive: OCR often renders it as "Staff" not "STAFF".
  const hasStaff = /STAFF/i.test(t.replace(/\s+/g, ''));
  if (!hasStaff) return false;
  // Exclude known non-profile content
  if (/\b(ISBN|SUBSCRIBE|advertisement|copyright|all rights reserved)\b/i.test(t)) return false;
  return CITY_STATE.test(t) && SECTION_HINTS.test(t);
};

/**
 * A staff-ROSTER page, with the website requirement RELAXED. In the 2013/2014 books the corps
 * spread is split — the domain+concept sit on the show page and the STAFF roster on the facing
 * page (no domain). `isProfilePage` (domain-required) misses those; the caller uses this to find
 * the roster pages, then resolves the website from the page itself or the adjacent show page.
 */
export const isStaffRosterPage = (page: YearbookPage): boolean => {
  const t = page.text;
  if (t.length > 8000) return false;
  if (!/STAFF/i.test(t.replace(/\s+/g, ""))) return false;
  if (/\b(ISBN|SUBSCRIBE|advertisement|copyright|all rights reserved)\b/i.test(t)) return false;
  // The split roster page often has NEITHER domain nor city (both are on the facing show page),
  // so require STAFF + ≥2 distinct caption sections — dense enough to be a roster, not editorial.
  const sections = new Set((t.match(/\b(Executive|Corps Director|Drum Major|Design|Brass|Percussion|Color\s*Guard|Visual|Front Ensemble|Additional Staff|Administrative)\b/gi) ?? []).map((s) => s.toLowerCase().replace(/\s+/g, "")));
  return sections.size >= 2;
};

const buildPrompt = (pageText: string): string =>
  [
    'Extract the staff roster from this DCI drum corps yearbook profile page.',
    'The text comes from a PDF and may have stray spaces INSIDE words',
    '(e.g. "Executive D irector" = "Executive Director", "S TA F F" = "STAFF").',
    'Return ONLY a JSON object, no prose, of the form:',
    '{"website": string|null, "location": string|null,',
    ' "staff": [{"name": string, "section": string|null, "roles": string[]}]}',
    '- section = the heading the person is listed under (Executive, Design, Brass,',
    '  Percussion, Color Guard, Visual, Additional Staff, etc.).',
    '- roles = parenthetical titles after a name, e.g. "Gino Cipriani (Caption Head)"',
    '  -> {"name":"Gino Cipriani","roles":["Caption Head"]}. A person with no',
    '  parenthetical has roles: [].',
    '- Do NOT invent people; include only names printed on the page.',
    '',
    'PAGE TEXT:',
    pageText.slice(0, MAX_PROMPT_CHARS),
  ].join('\n');

// ── Show / repertoire pages (the even page facing each staff page) ───────────

const YearbookRepertoireEntry = Schema.Struct({
  title: Schema.String,
  composer: optionalString,
  arranger: optionalString,
});
export const YearbookShowSchema = Schema.Struct({
  /** The production title, e.g. "Wicked Games" (printed letter-spaced). */
  showTitle: optionalString,
  /** The concept/about narrative describing the show. */
  concept: optionalString,
  repertoire: Schema.Array(YearbookRepertoireEntry),
});
export type YearbookShow = typeof YearbookShowSchema.Type;

// De-spaced text contains "REPERTOIRE"; or it's a prose show page with a
// letter-spaced ALLCAPS title and a production narrative.
export const isShowPage = (page: YearbookPage): boolean => {
  const despaced = page.text.replace(/\s+/g, '');
  return /REPERTOIRE/i.test(despaced) || /\bproduction\b|\bshow\b/i.test(page.text);
};

const buildShowPrompt = (pageText: string): string =>
  [
    'Extract the show/program info from this DCI drum corps yearbook page.',
    'The PDF text may have stray spaces inside words, and TITLES are letter-spaced',
    '(e.g. "W I C K E D G A M E S" = "Wicked Games", "R E P E R T O I R E" = "REPERTOIRE").',
    'Return ONLY a JSON object:',
    '{"showTitle": string|null, "concept": string|null,',
    ' "repertoire": [{"title": string, "composer": string|null, "arranger": string|null}]}',
    '- showTitle = the production title (the big letter-spaced header).',
    '- concept = the production description paragraph (verbatim, de-spaced).',
    '- repertoire = the works listed under the REPERTOIRE heading, with composer/',
    '  arranger when given. Empty array if no repertoire is printed.',
    '- Do NOT invent works.',
    '',
    'PAGE TEXT:',
    pageText.slice(0, MAX_PROMPT_CHARS),
  ].join('\n');

type Engine = 'claude' | 'codex' | 'opencode' | 'deterministic';

const runEngine = (engine: Engine, prompt: string): Promise<string> => {
  // opencode (DeepSeek flash, via @opencode-ai/sdk) is the 3rd-tier fallback when claude AND
  // codex are out (e.g. credits exhausted on a long yearbook run).
  if (engine === 'opencode') return opencodeComplete(prompt);
  const claudeBin = process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? 'claude';
  const codexBin = process.env.CODEX_CLI ?? 'codex';
  const [cmd, args] =
    engine === 'claude' ? [claudeBin, ['-p', prompt]] : [codexBin, ['exec', prompt]];
  return execFile(cmd, args as string[], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  }).then((r) => r.stdout.trim());
};

/** Pull the first balanced JSON object out of a model response (handles ```json fences). */
const extractJsonObject = (raw: string): unknown => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
};

const decodeProfile = SchemaParser.decodeUnknownSync(YearbookProfileSchema);
const decodeShow = SchemaParser.decodeUnknownSync(YearbookShowSchema);

// Fallback engines. claude first (when credits available), codex as last resort.
// claude is out of credits as of 2026-06-16 — skip straight to codex.
const ATTEMPTS: Engine[] = ['claude', 'codex', 'opencode'];

const extractWith = async <T>(
  prompt: string,
  decode: (u: unknown) => T
): Promise<{ value: T | null; engine: Engine | null }> => {
  for (const engine of ATTEMPTS) {
    try {
      const raw = await runEngine(engine, prompt);
      const parsed = extractJsonObject(raw);
      if (parsed == null) continue;
      return { value: decode(parsed), engine };
    } catch {
      // CLI error or schema mismatch → next attempt
    }
  }
  return { value: null, engine: null };
};

export interface ProfileExtractResult {
  profile: YearbookProfile | null;
  engine: Engine | null;
}

/** De-space + alphanumeric-only key, for grounding names against PDF text whose letter-spacing
 *  ("M a r k") and stray gaps ("Mark Richard son") defeat normal substring checks. */
const despace = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * GROUND the AI's staff list against the page text: keep only names whose de-spaced form
 * actually appears on the page, deduped. Without this the model pads a 1.6 KB roster to 60-70
 * plausible-but-fabricated names (no grounding = hallucination, as in staffAiExtract).
 */
const groundStaff = (profile: YearbookProfile, pageText: string): YearbookProfile => {
  const src = despace(pageText);
  const seen = new Set<string>();
  const staff = profile.staff.filter((m) => {
    const dn = despace(m.name);
    if (dn.length < 4 || !src.includes(dn) || seen.has(dn)) return false;
    seen.add(dn);
    return true;
  });
  return { ...profile, staff };
};

// ── Deterministic profile parser ──────────────────────────────────────────

const STAFF_SECTION_HEADINGS = [
  "Executive Director", "Corps Director", "Program Director",
  "Business Manager", "Treasurer", "Secretary",
  "Drum Majors", "Drum Major",
  "Design", "Design Team",
  "Brass", "Brass Staff", "Hornline", "High Brass", "Low Brass",
  "Percussion", "Battery", "Front Ensemble", "Pit", "Percussion Staff",
  "Color Guard", "Colorguard", "Guard", "ColorGuard",
  "Visual", "Visual Staff", "Drill",
  "Leadership", "Administration", "Additional Staff", "Administrative",
  "Audio", "Sound", "Electronic", "Electronics", "Movement",
  "Choreographer", "Choreographers",
  "Health", "Wellness", "Medical",
  "Instructional", "Education",
  // Single-word section names often appear standalone in malformed OCR
  "Brass", "Percussion", "Visual", "Guard", "Audio",
];

/** De-spaces text only when letter-spacing artifacts are detected (single
 *  uppercase letters surrounded by spaces — common in pre-OCR yearbooks).
 *  Leaves clean OCR text (like 2019's ocrmypdf output) untouched. */
const despacedText = (t: string): string => {
  const normalized = t.replace(/\s+/g, " ").trim();
  // Detect artifacts: look for isolated uppercase single letters.
  // Use lookbehind so overlapping singles (e.g. second "F" in "S TA F F") are found.
  const singles = normalized.match(/(?:^|(?<=\s))([A-Z])\s/g);
  if (!singles || singles.length < 3) return normalized;

  // Has letter-spacing — apply targeted merging
  let prev = normalized;
  for (let pass = 0; pass < 4; pass++) {
    const tokens = prev.split(" ");
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      const next = tokens[i + 1];
      const prevOut = out.length > 0 ? out[out.length - 1]! : null;

      if (next) {
        // Single uppercase letter → always merge with next (artifact)
        if (tok.length === 1 && tok === tok.toUpperCase() && /^[A-Za-z]/.test(next)) {
          out.push(tok + next);
          i += 2;
          continue;
        }
        // Two-char uppercase + single uppercase = "TA"+"F"→"TAF" (part of acronym)
        if (tok.length === 2 && tok === tok.toUpperCase() && next.length === 1 && next === next.toUpperCase()) {
          out.push(tok + next);
          i += 2;
          continue;
        }
        // Two-char TitleCase + lowercase next = "E" already handled above
        // Two-char uppercase + two-char uppercase = "FF"+"ER"→"FFER" (acronym chain)
        if (tok.length === 2 && tok === tok.toUpperCase() && next.length === 2 && next === next.toUpperCase()) {
          out.push(tok + next);
          i += 2;
          continue;
        }
        // Multi-char uppercase-starting + two-char uppercase = "STA"+"FF"→"STAFF"
        if (tok.length >= 3 && /^[A-Z]/.test(tok) && tok[tok.length-1] >= "A" && tok[tok.length-1] <= "Z" && next.length === 2 && next === next.toUpperCase()) {
          out.push(tok + next);
          i += 2;
          continue;
        }
        // Reverse: single lowercase trailing → "Dru"+"m"→"Drum"
        if (tok.length >= 3 && /[a-z].$/.test(tok) && next.length === 1 && next === next.toLowerCase() && /[bcdfghjklmnpqrstvwxyz]$/.test(tok)) {
          out.push(tok + next);
          i += 2;
          continue;
        }
      }
      out.push(tok);
      i++;
    }
    // Single-pass dedup: remove the nonsense "AZE" by splitting known-abbreviation + single letter
    const result = [];
    for (let j = 0; j < out.length; j++) {
      const t = out[j]!;
      const m = t.match(/^([A-Z]{2})([A-Z])$/);
      if (m && ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'].includes(m[1]!)) {
        result.push(m[1]!, m[2]!);
        continue;
      }
      // Split state abbreviation + CapitalWord: "SCExecutive" → "SC" "Executive"
      const m2 = t.match(/^([A-Z]{2})([A-Z][a-z]{2,})$/);
      if (m2 && ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WV','WI','WY'].includes(m2[1]!)) {
        result.push(m2[1]!, m2[2]!);
        continue;
      }
      result.push(t);
    }
    const nextStr = result.join(" ");
    if (nextStr === prev) break;
    prev = nextStr;
  }
  return prev;
};

/**
 * Deterministic yearbook profile parser. Splits text at "STAFF" into
 * show-content and roster, then walks known section headings to produce
 * structured staff members.
 */
export const parseProfileDeterministic = (pageText: string): YearbookProfile | null => {
  const clean = despacedText(pageText);

  // Website / location anchor the roster (format: "domain.org City, ST <roster>").
  const websiteMatch = clean.match(/\b([a-z0-9][a-z0-9-]*\.(org|com|net))\b/i);
  const website = websiteMatch ? websiteMatch[1]!.toLowerCase() : null;
  const locMatch = clean.match(/([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2}),\s*([A-Z]{2})\b/);
  const location = locMatch ? `${locMatch[1]!.trim()}, ${locMatch[2]}` : null;

  // Isolate the staff roster. Prefer the "STAFF" marker, but OCR sometimes mangles it
  // ("STAFF" → "stare" on the Colts page), which would drop the whole roster. Fall back to
  // anchoring after the website (then the location), so a garbled marker doesn't lose the page.
  // The roster header is a STANDALONE "STAFF" — NOT "Additional/Support/Administrative Staff"
  // (those are mid-roster sections). Pick the first STAFF not preceded by such a qualifier.
  const staffMatch = [...clean.matchAll(/\bSTAFF\b/gi)].find(
    (m) => !/(additional|support|instructional|education|administrative|color|brass|percussion|visual|guard)\s*$/i.test(clean.slice(Math.max(0, m.index! - 16), m.index!)),
  );
  const staffIdx = staffMatch ? staffMatch.index! : -1;
  let tail: string;
  if (staffIdx >= 0) tail = clean.slice(staffIdx);
  else if (website && clean.toLowerCase().indexOf(website) >= 0) tail = clean.slice(clean.toLowerCase().indexOf(website) + website.length);
  else if (locMatch && locMatch.index !== undefined) tail = clean.slice(locMatch.index + locMatch[0].length);
  else return null;

  // Split by known section headings. The format is:
  // "... STAFF <heading1> <person1>, <person2>, ... <heading2> <person3> ..."
  // Build a regex that anchors on the known headings.
  
  // First, strip everything after the last location/page-info (corps name + page #)
  const endIdx = tail.search(/\d{1,3}\s+20\d\d\s+DCI\s+Souvenir\s+Yearbook$/i);
  const rosterText = endIdx > 0 ? tail.slice(0, endIdx) : tail;

  // Build a list of section ranges by finding heading positions
  interface Section { heading: string; start: number; }
  const sections: Section[] = [];
  const lowerRoster = rosterText.toLowerCase();

  const insideParens = (idx: number): boolean => {
    const before = rosterText.slice(0, idx);
    return (before.split("(").length - 1) > (before.split(")").length - 1);
  };
  for (const rawHeading of STAFF_SECTION_HEADINGS) {
    // Find the first VALID occurrence: a real section header is NOT inside a role
    // parenthetical ("(Percussion Arranger)") and IS immediately followed by a person
    // name (a capital letter). Skipping in-paren matches stops single-word headings
    // (Brass/Percussion/Visual/Guard) from carving a bogus boundary mid-list.
    const re = new RegExp(`\\b${rawHeading.replace(/\s+/g, "\\s*")}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(rosterText)) !== null) {
      if (insideParens(m.index)) continue;
      const after = rosterText.slice(m.index + m[0].length).replace(/^[\s:]+/, "");
      if (!/^[A-ZÀ-Þ]/.test(after)) continue; // a name must follow the heading
      // A real roster heading is followed by a PERSON NAME, not a role/title word.
      // "Color Guard Captain Kimmy Kinden" (in a show description) is NOT the roster's
      // Color Guard heading — taking it (then break) drops the real heading later and
      // dumps that whole section into the previous one. Skip and keep scanning.
      if (/^(Captain|Caption|Tech|Technician|Staff|Team|Section|Coordinator|Director|Instructor|Manager|Supervisor|Consultant|Arranger|Composer|Designer|Lead|Head|Assistant|Associate|Specialist|Advisor|Of|And|The|Coach)\b/i.test(after)) continue;
      const start = m.index + m[0].length;
      if (!sections.some(s => s.start === start)) sections.push({ heading: rawHeading, start });
      break;
    }
  }

  // Sort by position so we know where each section's content ends
  sections.sort((a, b) => a.start - b.start);

  // Parse each section's content (from its start to the next heading's start).
  // Only filter out sections that appear BEFORE the roster body. For 2017 format,
  // the website comes right after STAFF (before section headings), so we skip
  // anything before the website. For 2016 format, the website is at the very end
  // (after all sections), so we don't filter at all.
  const domainLocIdx = website
    ? rosterText.toLowerCase().indexOf(website.toLowerCase())
    : -1;
  // Only use rosterStart if the domain appears BEFORE the first real section
  // (i.e. 2017 format). If the domain is near the end (2016 format), don't filter.
  const firstSection = sections.length > 0 ? sections[0]!.start : 0;
  const rosterStart = (domainLocIdx >= 0 && domainLocIdx < firstSection + 200)
    ? domainLocIdx + website!.length
    : 0;

  const staff: Array<{ name: string; section: string | null; roles: string[] }> = [];
  const isSectionLabel = (label: string): boolean =>
    STAFF_SECTION_HEADINGS.some(h => h.toLowerCase() === label.toLowerCase());

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    // Skip headings that appear before the roster body (in show description)
    if (sec.start < rosterStart) continue;
    const end = i + 1 < sections.length ? sections[i + 1]!.start : rosterText.length;
    let segment = rosterText.slice(sec.start, end).trim();

    // Strip any trailing section-label text that leaked
    const tailLabel = isSectionLabel(segment);
    if (tailLabel) continue;

    // Naively split on commas + "and" to get individual entries
    // But don't split on commas in parentheticals
    const entries = segment
      .replace(/\band\b/gi, ",")
      .split(/,(?![^(]*\))/)
      .map(s => s.trim())
      .filter(Boolean);

    for (const entry of entries) {
      // Try to split into "Name (Role)" or just "Name"
      const nameRoleMatch = entry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (nameRoleMatch) {
        const name = nameRoleMatch[1]!.trim();
        const roleText = nameRoleMatch[2]!.trim();
        // The role might itself be a comma-separated list
        const roles = roleText.split(/\s*,\s*/).filter(r => !isSectionLabel(r) && r.length > 1);
        if (looksLikePersonName(name)) {
          staff.push({ name, section: sec.heading, roles });
        }
      } else {
        const name = entry.trim();
        if (looksLikePersonName(name)) {
          staff.push({ name, section: sec.heading, roles: [] });
        }
      }
    }
  }

  if (staff.length < 1) return null;
  return { website, location, staff };
};

// ── Deterministic show extraction ─────────────────────────────────────────

/** Extract show title, concept, and works from the REPERTOIRE text.
 *  Format: "REPERTOIRE <concept> Work1 by Composer1 ... SHOWTITLE"
 *  The show title is the final 1-5 words, not preceded by "by". */
export const parseShowDeterministic = (beforeStaff: string): YearbookShow | null => {
  if (!beforeStaff || beforeStaff.trim().length < 20) return null;
  const t = beforeStaff.replace(/\s+/g, " ").trim();

  const repStart = t.search(/\bREPERTOIRE\b/i);
  if (repStart < 0) return null;
  const body = t.slice(repStart + 10).trim();

  // Extract works: "WorkTitle by Composer". Only match capitalized work titles.
  const repertoire: Array<{ title: string; composer: string | null; arranger: string | null }> = [];
  const re = /([A-Z0-9"'][A-Za-zÀ-ÿ0-9\s"'’,.\-&/]+?)\s+by\s+([A-Z][A-Za-zÀ-ÿ]+(?:\s[A-Z][A-Za-zÀ-ÿ]+){1,3})/gm;
  let m;
  let lastByEnd = 0;
  let lastComposerWords = 0;
  while ((m = re.exec(t)) !== null) {
    const work = m[1]!.trim();
    const composer = m[2]!.trim();
    if (work.length > 4 && work.length < 300 && !/^\d+$/.test(work) && !/\b(the|a|an|this|that|their|his|her)\b/i.test(work.substring(0, 20))) {
      repertoire.push({ title: work, composer, arranger: null });
      lastByEnd = m.index + m[0].length;
      lastComposerWords = composer.split(/\s+/).length;
    }
  }

  // Concept: between REPERTOIRE and first work
  const firstBy = body.search(/\s+by\s+[A-Z]/);
  const conceptRaw = firstBy > 0 ? body.slice(0, firstBy).trim() : null;
  const concept = conceptRaw && conceptRaw.length > 15 ? conceptRaw : null;

  // Show title: text AFTER the last matched "by Composer" block
  let showTitle: string | null = null;
  if (lastByEnd > 0) {
    const after = body.slice(lastByEnd).trim().split(/\s+/);
    // Skip composer name words, take remaining (up to 3)
    showTitle = after.slice(lastComposerWords, lastComposerWords + 3).join(" ") || null;
  }

  return { showTitle, concept, repertoire };
};

// ── End show extraction ───────────────────────────────────────────────────

/** Extract one staff/profile page → structured staff JSON. Deterministic parser only
 *  (AI is too slow/unreliable — the yearbook text is regular enough after OCR). */
export const extractProfile = async (pageText: string): Promise<ProfileExtractResult> => {
  const det = parseProfileDeterministic(pageText);
  // Estimate how many people the page lists: distinct capitalized name candidates ("First Last").
  // If the deterministic parse captured most of them, trust it (fast/free). Otherwise the parser
  // hit a layout it mis-handles (OCR-mangled marker, exec "Title Name" blocks, admin lists) →
  // fall back to AI, which is layout-robust. Cheap on the ~70% of clean pages; accurate on hard ones.
  const expected = new Set(
    (pageText.match(/\b[A-Z][a-zà-ÿ'’.-]+(?:\s+[A-Z][a-zà-ÿ'’.-]+){1,2}\b/g) ?? []).map((s) => s.toLowerCase().replace(/[^a-z]/g, "")),
  ).size;
  // Don't trust a deterministic parse that clearly dropped the leading exec/director block —
  // the parser absorbs "Title Name Title Name" exec runs into one un-splittable chunk, losing
  // corps directors/managers. If the page names a director but the parse captured none, fall back.
  const pageHasExec = /\b(Executive Director|Corps Director|Director of|Corps Manager)\b/i.test(pageText);
  const detHasExec = !!det && det.staff.some((s) => /director|executive|manager|administrat/i.test(`${s.section ?? ""} ${(s.roles ?? []).join(" ")}`));
  if (det && det.staff.length >= 20 && det.staff.length >= 0.6 * expected && !(pageHasExec && !detHasExec)) {
    return { profile: det, engine: "deterministic" };
  }
  const { value, engine } = await extractWith(buildPrompt(pageText), decodeProfile);
  const ai = value ? groundStaff(value, pageText) : null;
  // Keep whichever recovered more people (AI usually wins on the pages that triggered fallback).
  if (ai && (!det || ai.staff.length > det.staff.length)) return { profile: ai, engine };
  return det ? { profile: det, engine: "deterministic" } : { profile: ai, engine };
};

export interface ShowExtractResult {
  show: YearbookShow | null;
  engine: Engine | null;
}

/** Extract one show page → title + concept + repertoire. claude first, codex fallback. */
export const extractShow = async (pageText: string): Promise<ShowExtractResult> => {
  const { value, engine } = await extractWith(buildShowPrompt(pageText), decodeShow);
  return { show: value, engine };
};
