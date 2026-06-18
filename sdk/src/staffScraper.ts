// Staff extraction — turn a corps staff page's HTML into structured staff records.
// Pattern A (deterministic) per docs/staff-scraping-plan.md §4.2: schema.org JSON-LD
// `Person` first, then a DOM "card grid" heuristic. The AI fallback (Pattern B) lives
// in M4 and only runs when this yields nothing usable.
//
// `extractStaffFromHtml` is PURE (html string in → records out) so it can be unit-tested
// against saved fixtures without any network. Fetch/discovery/render orchestration is M3.

import * as cheerio from "cheerio";
import { Effect, Option } from "effect";
import { normalizeCaption, type StaffCaption } from "./relational.js";
import { BrowserbaseService } from "./browserbaseService.js";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ExtractedStaff {
  /** Full name as displayed, e.g. "Jane Doe". */
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  /** Verbatim position title, e.g. "Director of Brass". */
  readonly title: string | null;
  /** Normalized section/caption derived from the title. */
  readonly caption: StaffCaption;
  readonly biography: string | null;
  /** Absolute photo URL (resolved against the page), or null. */
  readonly photoUrl: string | null;
  readonly sourceUrl: string;
  readonly confidence: Confidence;
  /** Which extractor produced this record (for debugging / dry-run reports). */
  readonly via: "json-ld" | "dom" | "ai" | "announcement";
}

const clean = (s: string | null | undefined): string | null => {
  // Strip leading/trailing separator punctuation left behind by roster normalization
  // (PASS3 turns <br> into " / " and splits on it, which can leak a leading "/ " onto a
  // name — e.g. "/ Kaysey Thompson", "/ Ian Lewis"). Also trims stray bullets/dashes/pipes.
  const t = (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s/|,·•–—-]+/, "")
    .replace(/[\s/|·•–—-]+$/, "")
    .trim();
  return t.length > 0 ? t : null;
};

/** Resolve a possibly-relative URL against the page; drop data: URIs and blanks. */
const absUrl = (src: string | null | undefined, base: string): string | null => {
  const s = clean(src);
  if (!s || s.startsWith("data:")) return null;
  try {
    return new URL(s, base).toString();
  } catch {
    return null;
  }
};

/** Role/section keywords — used both to validate that a node is a TITLE (so a card is a
 *  real person card) and to reject titles being mistaken for names. */
const ROLE_RE =
  /\b(director|exec|executive|ceo|cfo|president|founder|board|brass|horn|hornline|percussion|battery|front ensemble|pit|visual|drill|guard|colou?r\s?guard|caption|coordinator|instructor|arrang|compos|orchestrat|design|technician|\btech\b|manager|administrat|operations|drum\s?major|euphonium|tuba|mellophone|baritone|contra|snare|tenor|cymbal|mallet|choreograph|consultant|advisor|conductor|sound|electronic|movement|program|staff|faculty|coach|liaison|treasurer|secretary|chaperone|nurse|medic|volunteer|trustee|chair|chairman|chairwoman|chairperson|at[\s-]?large|vice[\s-]?president|member[\s-]?at[\s-]?large|parent|emeritus|quartermaster|seamstress|webmaster|registrar|adjutant|drum\s?major)\b/i;

/** Brand/non-person words that show up in logo/sponsor/funding/ensemble alt text,
 *  nav/UI terms, store names, and organization names. */
const NON_PERSON_RE =
  /\b(logo|sponsor|partner|inc|llc|corps|drum|bugle|academy|productions?|brand|fund|foundation|council|association|society|coalition|alliance|institute|university|college|school|orchestra|booster|company|group|chapter|department|fa[cç]ade|ensemble|soundsport|drumline|winter\s?guard|winterguard|percussion line|colorguard|color guard|bachelor(?:'s)?|master(?:'s)?|doctorate?|doctor\s+of|certif|kinesiology|physical\s+therapy|exercise\s+science|blood\s+flow|needling|registered\s+nurse|bls\b|atc\b|idn\b|cpr\b|acsm\b|nasm\b|provider|souvenir|merchandise|apparel|custom\s+apparel|advertising\s+club|advertising|mailing\s+address|older\s+entries|bands\s+of|she\/her|he\/him|they\/them|hall\s+of\s+fame|emmy\s+awards?|grammy\s+awards?|in\s+memoriam|recent\s+posts?)\b/i;

/** Known post-nominal credentials (handles multi-letter ones like "PharmD" that the
 *  single-letter pattern misses). */
const CREDENTIAL_RE =
  /^(ph\.?d|pharm\.?d|ed\.?[ds]|m\.?d|d\.?m\.?a|m\.?m\.?e?|m\.?b\.?a|d\.?d\.?s|d\.?o|esq\.?|cpa|rn|jd|lat|atc|bme|dma|mfa|bfa|aba|mph|msw|pmp)$/i;

/** Strip a trailing credential suffix: ", DO" / ", M.D." / ", Ph.D." / ", DMA" / ", PharmD"
 *  / ", MBA" — but never a real ", Lastname" (require the token to be a known credential
 *  or all-caps). */
const stripCredentials = (s: string): string => {
  const m = s.match(/^(.*?),\s*([A-Za-z.]{2,8})\s*$/);
  if (m && (CREDENTIAL_RE.test(m[2]!) || /^[A-Z][A-Z.]+$/.test(m[2]!))) return m[1]!.trim();
  return s.replace(/,\s*(?:[A-Za-z]\.?){1,5}\.?\s*$/, "").trim();
};

/** A plausible person name: 2–5 capitalized tokens, no digits, not a role title, not a
 *  brand/section heading. Filters "Our Staff", "Executive Director", "Blue Stars", logos.
 *  Exported so the AI extractor (Pattern B) applies the SAME precision filter. */
export const looksLikePersonName = (raw: string | null): boolean => {
  let s = clean(raw);
  if (!s) return false;
  s = stripCredentials(s);
  if (s.length < 4 || s.length > 50) return false;
  if (/\d/.test(s)) return false; // names don't contain digits
  if (/[:!?;]/.test(s)) return false; // bio-section labels / placeholders ("Where I've Marched:", "Bio Coming Soon!")
  if (/\.(jpe?g|png|webp|gif|svg|bmp|pdf|tiff?|avif)\b/i.test(s)) return false; // image filename, not a name
  if (ROLE_RE.test(s)) return false; // it's a title, not a name
  if (NON_PERSON_RE.test(s)) return false; // logo / org / sponsor
  // Nav/UI/label words. NOTE: words that are ALSO real surnames/first-names ("Hall", "Fame",
  // "Post", "Emmy", "Grammy") are intentionally NOT here — they'd reject real people ("Steven
  // Hall", "Michael Post", "Emmy Hedden"); their LABEL phrases ("Hall of Fame", "Recent Posts",
  // "Emmy Award") are caught by NON_PERSON_RE instead.
  if (/\b(meet|our|the|welcome|home|about|contact|view|read|more|email|phone|team|education|history|department|division|alumni|gallery|sponsors?|partners?|opportunit|employment|overview|members?|directory|admin|support|crew|management|office|youth|programs?|community|design|administration|operations?|marketing|audio|athletic|trainer|engineer|digital|business|technical|analyst|assistant|associate|services?|health|wellness|faculty|instructional|recent|follow|categories|archives?|tags?|subscribe|newsletter|comments?|reply|search|menu|nominee|share|click|here|memoriam|memory|obituary)\b/i.test(s))
    return false;
  const tokens = s.split(" ").filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  // Each token starts with a capital letter (allow hyphens, apostrophes, periods, accents).
  const nameToken = /^[A-ZÀ-Þ][A-Za-zÀ-ÿ'’.\-]*\.?$/;
  return tokens.filter((t) => nameToken.test(t)).length >= 2;
};

const splitName = (full: string): { given: string | null; family: string | null } => {
  const tokens = full.split(" ").filter(Boolean);
  if (tokens.length < 2) return { given: null, family: null };
  return { given: tokens[0]!, family: tokens[tokens.length - 1]! };
};

/** Strip a leading honorific so "Dr. Joseph Lyons" → "Joseph Lyons" (cleaner display +
 *  person_id). Conservative list; "Drew"/"Mrs Smith" handled (requires a following space). */
const HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|prof|professor|sir|dame|rev|fr|capt|sgt)\.?\s+/i;
const stripHonorific = (s: string): string => s.replace(HONORIFIC_RE, "").trim();

/** Strip parenthetical text — pronouns (she/her), nicknames (Denny), maiden names —
 *  from the display name so it's clean for viewing and stable for person_id.
 *  Only strips PAIRED straight/curly quotes surrounding a word — NOT apostrophes
 *  inside names (O'Neil, O'Toole, D'Ante). */
const stripParenthetical = (s: string): string =>
  s.replace(/[\u201C\u201D\u2018\u2019'"]\w+[\u201C\u201D\u2018\u2019'"]/g, " ")
   .replace(/\s*\([^)]+\)\s*/g, " ")
   .replace(/\s+/g, " ")
   .trim();

/** Tidy a title: drop the leftover separators a <br>→" / " normalization can leave at
 *  the edges (e.g. "/ Colts Director", "Director / "). Also split on " / " and remove
 *  any segment that itself looks like a person name OR an email address (catches
 *  <br>-separated name+role or role+mail-to-link pairs collapsed into one title
 *  field — e.g. "Anthony Paterno / Brass Intern", "President / john@heat-wave.org",
 *  "Brass@Crossmen.org"). */
const cleanTitle = (t: string | null): string | null => {
  const s = clean(t);
  if (!s) return null;
  const trimmed = s.replace(/^[\s/&,;|–-]+/, "").replace(/[\s/&,;|–-]+$/, "").trim();
  if (!trimmed) return null;
  // Strip nav/UI leakage: "Color Guard Tech More Info" → "Color Guard Tech"
  const withoutNav = trimmed.replace(/\s*(more|learn more|read more|click here|contact us|get in touch|download|subscribe)\s*$/i, "");
  const segs = withoutNav.split(/\s\/\s/).filter(Boolean);
  const filtered = segs.filter(
    (seg) => !looksLikePersonName(seg) && !looksLikeEmail(seg)
  );
  const joined = filtered.join(" / ");
  return joined.length > 0 ? joined : null;
};

/** A plausible email address: something@something.tld. Filters out mailto-style
 *  contamination like "admin@bluedevils.org" and "Brass@Crossmen.org" that the
 *  <br>→" / " normalization pastes into a title field. */
const looksLikeEmail = (s: string): boolean =>
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.test(s);

// ── Announcement-post support (docs/announcement-sources-plan.md) ───────────────────────

/** Title-case an ALL-CAPS announcement name ("MIKE DURBOROW" → "Mike Durborow") while
 *  preserving intra-word caps (McBride, O'Neil, MacLeod) and hyphenated parts. Leaves
 *  already-mixed-case strings untouched. */
export const normalizeCapsName = (s: string): string => {
  if (!/[A-Z]/.test(s) || /[a-z]/.test(s)) return s; // not all-caps → leave as-is
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/\b(Mc|Mac|O')([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())
    .replace(/-([a-z])/g, (_, c: string) => "-" + c.toUpperCase());
};

/** Season a staff-announcement post refers to. The season is NOT the publish date — a
 *  "2017 Brass Staff" post is published in fall 2016. Priority: a year in the TITLE → a year
 *  in the URL's last path segment → publish year + fall heuristic (Sep–Dec announces next
 *  season). Years are constrained to [2008, now+1]. Returns the season + which signal it came
 *  from, or null. PURE (now-year injectable for tests). */
export const seasonFromAnnouncement = (
  title: string,
  url: string,
  published?: { year: number; month?: number },
  nowYear: number = new Date().getFullYear(),
): { season: number; source: "title" | "url" | "published" } | null => {
  const maxYear = nowYear + 1;
  const inRange = (y: number) => y >= 2008 && y <= maxYear;
  const yearsIn = (s: string): number[] =>
    [...s.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])).filter(inRange);

  // 1) TITLE — if several years, prefer one adjacent to a season/staff/caption word.
  const titleYears = yearsIn(title);
  if (titleYears.length === 1) return { season: titleYears[0]!, source: "title" };
  if (titleYears.length > 1) {
    const near = titleYears.find((y) =>
      new RegExp(`${y}\\s+\\w*\\s*(season|staff|caption|brass|percussion|visual|guard|design|education|team)`, "i").test(title),
    );
    return { season: near ?? Math.max(...titleYears), source: "title" };
  }
  // 2) URL last path segment (e.g. ".../2017-brass-staff/"), NOT a /YYYY/ date directory.
  const tail = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
  const tailYears = yearsIn(tail);
  if (tailYears.length >= 1) return { season: Math.max(...tailYears), source: "url" };
  // 3) Publish date + fall heuristic.
  if (published && inRange(published.year)) {
    const season = (published.month ?? 1) >= 9 ? published.year + 1 : published.year;
    return inRange(season) ? { season, source: "published" } : null;
  }
  return null;
};

const mkRecord = (
  fields: {
    displayName: string;
    title: string | null;
    biography: string | null;
    photoUrl: string | null;
    confidence: Confidence;
    via: ExtractedStaff["via"];
  },
  sourceUrl: string,
): ExtractedStaff => {
  const displayName = stripParenthetical(stripHonorific(stripCredentials(clean(fields.displayName)!)));
  const { given, family } = splitName(displayName);
  const title = cleanTitle(fields.title);
  return {
    displayName,
    givenName: given,
    familyName: family,
    title,
    caption: normalizeCaption(title),
    biography: clean(fields.biography),
    photoUrl: fields.photoUrl,
    sourceUrl,
    confidence: fields.confidence,
    via: fields.via,
  };
};

// ---- Pattern A.1: schema.org JSON-LD `Person` -------------------------------

const walkJsonLd = (node: unknown, out: any[]): void => {
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, out);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "person")) {
      out.push(obj);
    }
    // Recurse into common containers (@graph, mainEntity, member, employee, etc.).
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walkJsonLd(v, out);
    }
  }
};

const jsonLdImage = (img: unknown, base: string): string | null => {
  if (typeof img === "string") return absUrl(img, base);
  if (Array.isArray(img)) return jsonLdImage(img[0], base);
  if (img && typeof img === "object") {
    const o = img as Record<string, unknown>;
    return absUrl((o["url"] ?? o["contentUrl"]) as string, base);
  }
  return null;
};

const extractFromJsonLd = (
  $: cheerio.CheerioAPI,
  sourceUrl: string,
): ExtractedStaff[] => {
  const persons: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      walkJsonLd(JSON.parse(raw), persons);
    } catch {
      /* malformed JSON-LD block — skip */
    }
  });
  const out: ExtractedStaff[] = [];
  for (const p of persons) {
    const name = clean(typeof p.name === "string" ? p.name : null);
    if (!name || !looksLikePersonName(name)) continue;
    const title = clean(
      typeof p.jobTitle === "string"
        ? p.jobTitle
        : Array.isArray(p.jobTitle)
          ? p.jobTitle.join(", ")
          : null,
    );
    out.push(
      mkRecord(
        {
          displayName: name,
          title,
          biography: clean(typeof p.description === "string" ? p.description : null),
          photoUrl: jsonLdImage(p.image, sourceUrl),
          confidence: "HIGH", // structured, machine-stated
          via: "json-ld",
        },
        sourceUrl,
      ),
    );
  }
  return out;
};

// ---- Pattern A.2: DOM heuristic (image-anchored) ----------------------------
// Staff sites vary wildly: the NAME may be a heading, a <strong>, OR (very common on
// Squarespace/Wix) only the headshot's `alt`, while the TITLE sits in a separate node
// (an <h2>, <em>, <p>…). The robust signal is: a headshot whose enclosing "card" also
// contains a role/caption keyword. Requiring a role keyword in the card filters out
// logos/sponsors. We anchor on each <img>, walk up to its smallest role-bearing card,
// then take the name from the alt or a name-like node, and the title from a role node.

const imgSrc = ($img: cheerio.Cheerio<any>, base: string): string | null =>
  absUrl($img.attr("src"), base) ??
  absUrl($img.attr("data-src"), base) ??
  absUrl($img.attr("data-image"), base) ??
  absUrl(($img.attr("srcset") ?? "").split(",")[0]?.trim().split(" ")[0], base);

const extractFromDom = (
  $: cheerio.CheerioAPI,
  sourceUrl: string,
): ExtractedStaff[] => {
  // Strip site chrome so nav/header/footer role words ("Band Director Days") and logos
  // don't pollute the scan.
  $('script,style,noscript,svg,nav,header,footer,aside,form,[role="navigation"],[role="banner"],[role="contentinfo"]').remove();
  // Normalize <br> to a separator so a multi-line title node (e.g. "Youth Programs
  // Director<br>Colts Director") stays a TEXT leaf — otherwise the <br> child makes the
  // node non-leaf and the title/role passes skip it.
  $("br").replaceWith(" / ");
  // Insert a trailing space inside each block/inline element so adjacent texts don't
  // concatenate when a parent's .text() is read ("...Staff" + "Jay Wise" → "StaffJay
  // Wise", "Cody Schuster" + "Manager" → "SchusterManager"). cheerio's .text() has no
  // inter-node separator; this adds one.
  $("h1,h2,h3,h4,h5,h6,p,div,li,td,em,strong,b,span,a,figcaption").each((_, e) => {
    $(e).append(" ");
  });

  const out: ExtractedStaff[] = [];
  const seen = new Set<string>();
  const push = (name: string | null, title: string | null, photoUrl: string | null, bio: string | null) => {
    const nm = clean(name);
    if (!nm || !looksLikePersonName(nm)) return;
    const display = normalizeCapsName(stripHonorific(stripCredentials(nm)));
    const key = display.toLowerCase();
    if (!display || seen.has(key)) return;
    seen.add(key);
    out.push(mkRecord({ displayName: display, title, biography: bio, photoUrl, confidence: "MEDIUM", via: "dom" }, sourceUrl));
  };

  const longestPara = ($card: cheerio.Cheerio<any>, title: string | null): string | null => {
    let bio: string | null = null;
    $card.find("p,div").each((_, p) => {
      const txt = clean($(p).text());
      if (txt && txt.length > 80 && txt !== title && (!bio || txt.length > bio.length)) bio = txt;
    });
    return bio;
  };

  /** Distinct name-like texts inside a card (text nodes; alts excluded), original-case,
   *  deduped case-insensitively. Used to find the person's name and to reject section-
   *  level "cards" that contain many people. */
  const namesIn = ($card: cheerio.Cheerio<any>, exclude: string): string[] => {
    const byKey = new Map<string, string>();
    $card.find("h1,h2,h3,h4,h5,h6,strong,b,a,p,span,figcaption,[class*=name]").each((_, e) => {
      const t = clean($(e).text());
      if (t && t !== exclude && looksLikePersonName(t)) {
        const display = stripCredentials(t);
        const key = display.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, display);
      }
    });
    return [...byKey.values()];
  };

  /** A clean person name from an image alt, or null. Handles "Photo of Jane Doe." style
   *  alts and rejects junk/logo alts. Alt is a FALLBACK — a text-node name is preferred. */
  const altName = ($card: cheerio.Cheerio<any>): string | null => {
    let name: string | null = null;
    $card.find("img").each((_, im) => {
      if (name) return;
      const raw = clean($(im).attr("alt"));
      if (!raw) return;
      const stripped = raw.replace(/^(photo|image|picture|headshot|portrait|pic)\s+of\s+/i, "").replace(/\.$/, "").trim();
      if (looksLikePersonName(stripped)) name = stripped;
    });
    return name;
  };

  /** Extract a person name from an image filename when alt is empty — common in
   *  WordPress media-text blocks (e.g. "patrick-glenn-brass-683x1024.jpg" → "Patrick Glenn").
   *  Strips caption suffixes, size suffixes, digits, and common image-hosting tokens. */
  const filenameName = ($card: cheerio.Cheerio<any>): string | null => {
    let name: string | null = null;
    $card.find("img").each((_, im) => {
      if (name) return;
      const src = ($(im).attr("src") ?? $(im).attr("data-src") ?? "").trim();
      if (!src) return;
      let stem = "";
      try {
        stem = new URL(src).pathname.split("/").pop() ?? "";
      } catch {
        stem = src.split("/").pop() ?? "";
      }
      if (!stem) return;
      // Drop extension, size dimensions (w x h), caption tags like "brass", "percussion",
      // "guard", "visual", and digit suffixes — keep only the name portion.
      const base = stem
        .replace(/\.(jpe?g|png|webp|gif|svg|bmp|avif)$/i, "")
        .replace(/-\d+x\d+(-\w+)?/gi, "") // e.g. -819x1024, -683x1024-jpg
        .replace(/-(scaled|rotated|cropped|resized?)/gi, "")
        .replace(/-(brass|percussion|guard|visual|battery|pit|staff|headshot|photo|portrait|profile|pic|image)(-?\d*)?$/gi, "")
        .replace(/-[a-z]\d*(-?\d*)?$/i, "") // trailing junk like "-a1", "-jpg"
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!base || base.length < 4) return;
      // Prosaic/placeholder filenames (e.g. "headshot-placeholder", "default-profile")
      if (/^(headshot|placeholder|default|profile|avatar|image|photo|staff|member|person|user|blank|empty|anonymous)$/i.test(base)) return;
      // Title-case the name tokens for person-name check
      const titlecased = base.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
      if (looksLikePersonName(titlecased)) name = titlecased;
    });
    return name;
  };

  /** A "title" that is really a SECTION header ("Staff", "Administrative and Instructional
   *  Staff", "Education Team") rather than a person's role. It has a generic group word
   *  and NO specific role noun. Skipping these stops section labels being paired as people. */
  const isSectionTitle = (t: string): boolean =>
    /\b(staff|team|leadership|personnel|directory|administration|members?)\b/i.test(t) &&
    !/\b(director|coordinator|designer|tech|technician|arrang|compos|manager|head|caption|consultant|advisor|instructor|conductor|choreograph|coach|liaison|specialist|administrator|ceo|cfo|president|founder|treasurer|secretary)\b/i.test(t);

  // Collect role-leaf "title" nodes once (excluding section headers).
  const titleNodes: any[] = [];
  $("*").each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return; // leaf text only
    const t = clean($el.text());
    if (t && t.length <= 70 && ROLE_RE.test(t) && !looksLikePersonName(t) && !isSectionTitle(t)) titleNodes.push(el);
  });

  // PASS 1 — IMAGE-ANCHORED (precise, carries the photo): each headshot whose smallest
  // enclosing card also has a role title. Name prefers a text node, falls back to a
  // cleaned alt, then to a filename-derived name (WordPress media-text blocks often
  // have no alt text — e.g. cthurricanes.org/brass/).
  $("img").each((_, im) => {
    const $im = $(im);
    let $a = $im.parent();
    for (let i = 0; i < 5 && $a.length; i++, $a = $a.parent()) {
      let title: string | null = null;
      $a.find("*").each((_, el) => {
        if (title) return;
        const $el = $(el);
        if ($el.children().length > 0) return;
        const t = clean($el.text());
        if (t && t.length <= 70 && ROLE_RE.test(t) && !looksLikePersonName(t) && !isSectionTitle(t)) title = t;
      });
      if (!title) {
        // No role text nearby — try to get at least the name from alt/filename
        const name = altName($a) ?? filenameName($a);
        if (name) push(name, null, imgSrc($im, sourceUrl), longestPara($a, null));
        return;
      }
      const names = namesIn($a, title);
      if (names.length > 1) break; // multi-person container — let title-anchored handle
      const name = names[0] ?? altName($a) ?? filenameName($a);
      if (!name) return;
      push(name, title, imgSrc($im, sourceUrl), longestPara($a, title));
      return;
    }
  });

  // PASS 2 — TITLE-ANCHORED (fills people whose headshot was lazy-loaded / absent): for
  // each role-leaf, climb to the smallest single-person card and pair the title with its
  // one name. Already-seen names (with photos from PASS 1) are kept by dedup.
  for (const tn of titleNodes) {
    const $t = $(tn);
    const title = clean($t.text()) ?? "";
    let $a = $t.parent();
    for (let i = 0; i < 5 && $a.length; i++, $a = $a.parent()) {
      const textNames = namesIn($a, title);
      if (textNames.length > 1) break; // section-level block, not a single-person card
      const name = textNames.length === 1 ? textNames[0]! : altName($a) ?? filenameName($a);
      if (!name) continue; // no name at this level — climb
      const $im = $a.find("img").first();
      push(name, title, $im.length ? imgSrc($im, sourceUrl) : null, longestPara($a, title));
      break;
    }
  }

  // PASS 3 — SECTIONED LIST/GRID: staff grouped under caption section headers ("Brass
  // Staff", "Battery Staff", "2026 Percussion Team"). Under a section, a person may be:
  // a headshot `alt`, a bare name line, a "Name – Title" line (en/em-dash), or a "Name,
  // Title" line — the dominant shape for large instructional rosters (e.g. Boston's
  // EDUCATION TEAM: ~90 people in <ul><li> under caption headers). Walk in document order,
  // tracking the active section; a non-caption header ends it (so footers/sponsors don't
  // get swept in). Bare names inherit the section's caption as their title.
  const SECTION_CAPTION_RE =
    /\b(brass|hornline|horn|percussion|battery|front ensemble|pit|visual|drill|colou?r\s?guard|guard|drum\s?major|music|design|administrat|admin|operations?|leadership|management|instructional|ensemble|audio|sound|electronic|hornline)\b/i;
  const cleanAltName = (raw: string | null | undefined): string | null => {
    let s = clean(raw);
    if (!s) return null;
    s = s
      .replace(/\.(jpe?g|png|webp|gif|svg|bmp|avif)$/i, "") // alt is sometimes the filename ("Bill McClendon.jpg")
      .replace(/\b(headshot|portrait|photo|picture|profile|image|pic)\b/gi, "")
      .replace(/^\s*of\s+/i, "")
      .replace(/\s*[-–|:].*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    return looksLikePersonName(s) ? stripCredentials(s) : null;
  };
  const asSection = (t: string): string | null =>
    t.length <= 50 && SECTION_CAPTION_RE.test(t) && !looksLikePersonName(t)
      ? t.replace(/\b20\d\d\b/g, "").replace(/\b(team|staff|section)\b/gi, "").replace(/\s+/g, " ").trim() || t
      : null;
  const DASH = /\s[–—-]\s/; // en/em-dash or spaced hyphen between "Name – Title"
  // Words that begin a TITLE — used to split a no-delimiter "Name Role" entry (common in
  // Wix rich-text rosters: "Ryann White Assistant Brass Caption Head").
  const TITLE_START =
    /^(assistant|associate|senior|lead|head|co|deputy|interim|acting|director|coordinator|manager|instructor|caption|arranger|composer|designer|consultant|advisor|specialist|tech|technician|brass|hornline|percussion|battery|front|pit|visual|drill|guard|colou?r|drum|snare|tenor|bass|cymbal|mallet|music|sound|audio|electronic|program|operations?|admin|administrative|executive|chief|president|ceo|cfo|founder|tour|equipment|health|color)$/i;
  const splitNameRole = (line: string): { name: string; title: string } | null => {
    const tok = line.split(/\s+/).filter(Boolean);
    if (tok.length < 3 || tok.length > 8) return null;
    for (let i = 2; i <= Math.min(3, tok.length - 1); i++) {
      if (TITLE_START.test(tok[i]!)) {
        const name = tok.slice(0, i).join(" ");
        const title = tok.slice(i).join(" ");
        if (looksLikePersonName(name) && title.length <= 70) return { name, title };
      }
    }
    return null;
  };
  let section: string | null = null;
  // Try the person/section patterns on one line. `aggressive` enables the no-delimiter
  // "Name Role" split (only used for roster nodes, where false positives are unlikely).
  const handleLine = (line: string, aggressive: boolean): void => {
    const dm = line.split(DASH);
    if (dm.length === 2) {
      const nm = clean(dm[0]);
      const ti = clean(dm[1]);
      if (nm && ti && looksLikePersonName(nm) && ti.length <= 70 && !looksLikePersonName(ti)) {
        push(nm, ti, null, null);
        return;
      }
    }
    const cm = line.match(/^([^,]+?),\s*(.{2,70})$/);
    if (cm && looksLikePersonName(clean(cm[1])) && !looksLikePersonName(clean(cm[2]))) {
      push(clean(cm[1]), clean(cm[2]), null, null);
      return;
    }
    if (aggressive) {
      const nr = splitNameRole(line);
      if (nr) {
        push(nr.name, nr.title, null, null);
        return;
      }
    }
    const sec = asSection(line);
    if (sec) {
      section = sec;
      return;
    }
    if (section && looksLikePersonName(line)) push(line, section, null, null);
  };

  const segCount = (s: string): number => s.split(/\s\/\s/).map((x) => clean(x)).filter(Boolean).length;
  const NAME_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "li", "p", "figcaption"]);
  $("h1,h2,h3,h4,h5,h6,strong,b,em,i,li,p,figcaption,div,span,img").each((_, el) => {
    const tag = (el as any).tagName?.toLowerCase();
    if (tag === "img") {
      if (section) {
        const nm = cleanAltName($(el).attr("alt"));
        if (nm) push(nm, section, imgSrc($(el), sourceUrl), null);
      }
      return;
    }
    const $el = $(el);
    const t = clean($el.text());
    if (!t) return;
    // ROSTER BLOCK: ≥3 " / "-separated entries in one node (Wix/Weebly rich-text with
    // <br>, normalized to " / "). Process the INNERMOST such block (skip if a child is
    // itself a roster, to avoid double-extraction), splitting + handling each entry.
    const segs = t.split(/\s\/\s/).map((s) => clean(s)).filter((s): s is string => !!s);
    if (segs.length >= 3 && t.length < 5000) {
      let childIsRoster = false;
      $el.children().each((_, c) => {
        if (segCount($(c).text() ?? "") >= 3) childIsRoster = true;
      });
      if (childIsRoster) return; // a descendant holds the roster — let it handle
      for (const seg of segs) handleLine(seg, true);
      return;
    }
    // SINGLE LINE: only name-bearing tags, leaf nodes, short text.
    if (!NAME_TAGS.has(tag) || $el.children().length > 0 || t.length > 100) return;
    const heading = tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6";
    if (heading && !asSection(t) && !looksLikePersonName(t) && !DASH.test(t) && !t.includes(",")) {
      section = null;
      return;
    }
    handleLine(t, false);
  });

  // PASS 4 — "Name, Role" combined in a single node (older/text-list sites, often no
  // images, e.g. "Catherine Maniscalco, Health & Safety"). Split on the first comma;
  // accept when the left is a name and the right is a recognizable role (incl. support
  // roles). Avoids "Lastname, Firstname" pairs (right would be a name, not a role).
  const SUPPORT_ROLE_RE =
    /\b(health|safety|meal|food|medical|nurse|chaperone|parent|merchandise|fundrais|transport|volunteer|hydration|equipment|uniform|quartermaster|chef|cook|driver|seamstress|sewing|hospitality|logistics|chaplain|trainer|therapist)\b/i;
  $("p,li,td,span,div").each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 2) return; // mostly-text node (allow a stray <a>/<br>)
    const t = clean($el.text());
    if (!t || t.length > 90) return;
    const m = t.match(/^([^,]+?),\s*(.{2,70})$/);
    if (!m) return;
    const name = clean(m[1]);
    const role = clean(m[2]);
    if (!name || !role || !looksLikePersonName(name) || looksLikePersonName(role)) return;
    if (!ROLE_RE.test(role) && !SUPPORT_ROLE_RE.test(role)) return;
    push(name, role, null, null);
  });

  // FALLBACK: pure heading→following-role-line pairing for layouts all passes missed.
  if (out.length < 2) {
    $("h1,h2,h3,h4,h5,h6,strong,b").each((_, h) => {
      const $h = $(h);
      const name = clean($h.text());
      if (!name || !looksLikePersonName(name)) return;
      let title: string | null = null;
      let $n = $h.next();
      for (let i = 0; i < 3 && $n.length; i++, $n = $n.next()) {
        const t = clean($n.text());
        if (t && t.length <= 70 && ROLE_RE.test(t) && !looksLikePersonName(t)) {
          title = t;
          break;
        }
      }
      if (title) push(name, title, null, null);
    });
  }

  return out;
};

/**
 * Extract staff records from a rendered/static HTML page. PURE — no network.
 * Tries JSON-LD first (HIGH confidence); if that yields nothing, falls back to the
 * DOM card-grid heuristic (MEDIUM). Returns [] when neither finds plausible people
 * (the caller then escalates to the Pattern B AI extractor in M4).
 */
/** Above this, building a DOM risks OOM (e.g. Blue Devils renders to ~62 MB of media-
 *  heavy markup). Such pages are skipped rather than crashing the batch. */
const MAX_HTML_BYTES = 6_000_000;

export const extractStaffFromHtml = (
  html: string,
  sourceUrl: string,
): ExtractedStaff[] => {
  if (!html || html.trim().length === 0 || html.length > MAX_HTML_BYTES) return [];
  const $ = cheerio.load(html);
  const fromJsonLd = extractFromJsonLd($, sourceUrl);
  if (fromJsonLd.length > 0) return fromJsonLd;
  return extractFromDom($, sourceUrl);
};

export interface PersonDetail {
  readonly displayName: string | null;
  readonly biography: string | null;
  readonly photoUrl: string | null;
}

/** Boilerplate paragraphs found on per-person pages that are NOT the bio. */
const NON_BIO_PARA_RE =
  /\b(donate|donation|support the campaign|cookie|privacy policy|subscribe|newsletter|all rights reserved|©|copyright|follow us|sign up|contact us|tax-deductible|501\(c\)|read more|learn more|click here|powered by)\b/i;

/**
 * Extract a bio + headshot from a SINGLE-PERSON detail page (the page a roster card links
 * to). Unlike `extractStaffFromHtml` (a grid parser) this expects ONE person: name from
 * `<h1>`/`og:title`/`<title>` ("Name | Corps"), photo from `og:image` (high-res), bio from
 * the long prose <p>s — boilerplate (donate/cookie/footer) dropped, and the bio is REQUIRED
 * to mention the person (surname) so we never attach a generic corps blurb. `expectedName`
 * (the roster name we followed the link for) gates the name+grounding. PURE.
 */
export const extractPersonDetail = (
  html: string,
  sourceUrl: string,
  expectedName?: string,
): PersonDetail => {
  if (!html || html.length > MAX_HTML_BYTES) return { displayName: null, biography: null, photoUrl: null };
  const $ = cheerio.load(html);
  const metaProp = (p: string) => clean($(`meta[property='${p}'], meta[name='${p}']`).first().attr("content"));

  // Name: h1 → og:title → <title>, each stripped of a "| Corps" / "- Corps" suffix.
  const stripSuffix = (s: string | null) => s ? s.split(/[|–—•·–—]|\s-\s/)[0]!.trim() : null;
  const nameCandidates = [clean($("h1").first().text()), stripSuffix(metaProp("og:title")), stripSuffix(clean($("title").first().text()))];
  let displayName = nameCandidates.find((n) => n && looksLikePersonName(n)) ?? null;
  if (displayName) displayName = stripHonorific(stripParenthetical(displayName));

  // Photo: og:image (corps detail pages use a high-res hero here), else the largest <img>.
  const photoUrl = absUrl(metaProp("og:image"), sourceUrl) ?? null;

  // Bio: prose <p>s, boilerplate removed. Anchor on a paragraph mentioning the person.
  const expectedKey = (expectedName ?? displayName ?? "").toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "");
  const surname = expectedKey.split(/\s+/).filter(Boolean).pop() ?? "";
  const paras = $("p")
    .map((_, e) => clean($(e).text()))
    .get()
    .filter((t): t is string => !!t && t.length >= 60 && !NON_BIO_PARA_RE.test(t));
  const startIdx = surname.length >= 3
    ? paras.findIndex((p) => p.toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "").includes(surname))
    : 0;
  let biography: string | null = null;
  if (startIdx >= 0) {
    const chosen: string[] = [];
    for (let i = startIdx; i < paras.length && chosen.join(" ").length < 2400; i++) chosen.push(paras[i]!);
    const text = chosen.join("\n\n").slice(0, 2600).trim();
    // Ground: require the person's surname somewhere in the assembled bio.
    const groundOk = surname.length < 3 || text.toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "").includes(surname);
    if (text.length >= 60 && groundOk) biography = text;
  }
  return { displayName, biography, photoUrl };
};

/** A caption word in a post title ("2017 Brass Staff" → "brass") used as the default caption
 *  for everyone announced in a single-caption post (titles are often woven into prose). */
const captionWordFromTitle = (title: string): string | null =>
  title.match(/\b(brass|hornline|percussion|battery|front[\s-]?ensemble|visual|drill|colou?r[\s-]?guard|guard|design|education|administrative|admin|leadership|drum[\s-]?major)\b/i)?.[0] ?? null;

/** Strip a WordPress image size suffix ("Stephen_Bentley-150x300.jpg" → "Stephen_Bentley") and
 *  tokenize the filename for name-matching. */
const fileNameTokens = (url: string | null): Set<string> => {
  if (!url) return new Set();
  try {
    const base = decodeURIComponent((url.split("/").pop() ?? "").split("?")[0]!)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/-\d{2,4}x\d{2,4}$/i, "");
    return new Set(base.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length > 2));
  } catch { return new Set(); }
};

/**
 * Extract staff from a NEWS/BLOG ANNOUNCEMENT post (docs/announcement-sources-plan.md §A3).
 * Archetype-aware and scoped to the article body so sidebars/"Related Posts" don't leak.
 * Three passes (union, deduped by name):
 *   1. Parenthetical list — "Paul Rennick (Percussion Caption Manager)" (SCV).
 *   2. Heading-delimited — name is an h2-h4; bio = following paragraphs (Boston).
 *   3. Caps/inline names — ALL-CAPS names in body, title from adjacent bold/em (Jersey Surf).
 * Each name is associated with the body <img> whose (size-stripped) filename matches it.
 * `defaultCaptionWord` (from the post title) backfills a title when prose hides the role.
 * PURE — html in → records out.
 */
export const extractStaffFromAnnouncement = (
  html: string,
  sourceUrl: string,
  postTitle = "",
): ExtractedStaff[] => {
  if (!html || html.trim().length === 0 || html.length > MAX_HTML_BYTES) return [];
  const $ = cheerio.load(html);
  // Body-scope: prefer the article/entry-content container; drop nav/aside/footer + the
  // "Recent Posts / Related / Categories / Follow Us" blocks that pollute WordPress posts.
  $("nav,aside,footer,header,form,.sidebar,#secondary,.widget,.related,.related-posts,.recent-posts,.post-navigation,.nav-links,.share,.sharedaddy,.comments,#comments").remove();
  // Pick the first priority container that holds real content (≥500 chars) — skips empty
  // Wix/`article` wrappers whose text lives in `.single-post`/`body`. Sidebars/nav were already
  // removed above, so the `body` fallback is safe.
  let $body: cheerio.Cheerio<any> = $("body");
  for (const sel of [".entry-content", ".post-content", "article .elementor-widget-container", "article", "main", ".single-post"]) {
    const $el = $(sel).first();
    if ($el.length && ($el.text() ?? "").length >= 500) { $body = $el; break; }
  }
  const title = postTitle || clean($("h1").first().text()) || clean($("title").text()) || "";
  const defaultCaptionWord = captionWordFromTitle(title);

  // Collect body images once for name→photo association.
  const imgs: Array<{ url: string; tokens: Set<string> }> = [];
  $body.find("img").each((_, im) => {
    const u = imgSrc($(im), sourceUrl);
    if (u && !/logo|sponsor|footer|header|icon|placeholder/i.test(u)) imgs.push({ url: u, tokens: fileNameTokens(u) });
  });
  const photoFor = (name: string): string | null => {
    const nt = name.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((t) => t.length > 2);
    if (nt.length < 1) return null;
    // Prefer ≥2 matching name tokens; fall back to a surname match (filenames often use a
    // formal first name — "Stephen_Bentley" for "Steve Bentley" — so the surname is the anchor).
    const surname = nt.at(-1)!;
    return (
      imgs.find((im) => nt.filter((t) => im.tokens.has(t)).length >= 2)?.url ??
      imgs.find((im) => im.tokens.has(surname))?.url ??
      null
    );
  };

  const out: ExtractedStaff[] = [];
  const seen = new Set<string>();
  const push = (rawName: string, rawTitle: string | null, bio: string | null) => {
    // Strip a trailing possessive/punctuation ("DAVID DURHAM's" → "DAVID DURHAM") BEFORE
    // case-normalizing, so possessive mentions dedupe against the clean heading name.
    const stripped = (clean(rawName) ?? "").replace(/['’]s\b/i, "").replace(/[''’`.,;:]+$/, "").trim();
    const nm = normalizeCapsName(stripped);
    if (!looksLikePersonName(nm)) return;
    const display = stripHonorific(stripCredentials(nm));
    const key = display.toLowerCase();
    if (!display || seen.has(key)) return;
    seen.add(key);
    const title2 = cleanTitle(rawTitle) ?? (defaultCaptionWord ? `${defaultCaptionWord[0]!.toUpperCase()}${defaultCaptionWord.slice(1)} Staff` : null);
    out.push(mkRecord({ displayName: display, title: title2, biography: bio, photoUrl: photoFor(display), confidence: "MEDIUM", via: "announcement" }, sourceUrl));
  };

  // PASS 1 — parenthetical "Name (Title)".
  const bodyText = clean($body.text()) ?? "";
  const PAREN = /([A-Z][A-Za-zÀ-ÿ.''-]+(?:\s+[A-Z][A-Za-zÀ-ÿ.''-]+){1,3})\s*\(([^)]{3,45})\)/g;
  for (const m of bodyText.matchAll(PAREN)) {
    if (ROLE_RE.test(m[2]!) || /manager|coordinator|head|director|tech|consultant|instructor|designer|advisor/i.test(m[2]!)) push(m[1]!, m[2]!, null);
  }

  // PASS 2 — HEADING-delimited (Boston): name is an h2-h5; bio = following blocks until the
  // next heading. (Headings only — NOT strong/b, which over-match bolded text inside bios.)
  $body.find("h1,h2,h3,h4,h5").each((_, h) => {
    const name = clean($(h).text()) ?? "";
    if (!looksLikePersonName(normalizeCapsName(name.replace(/['’]s\b/i, "")))) return;
    let bio = "";
    let $n = $(h).next();
    for (let i = 0; i < 6 && $n.length; i++, $n = $n.next()) {
      if ($n.is("h1,h2,h3,h4,h5") || $n.find("h1,h2,h3,h4,h5").length) break;
      const t = clean($n.text());
      if (t && t.length > 40) bio += (bio ? " " : "") + t;
    }
    push(name, null, bio.length > 40 ? bio : null);
  });

  // PASS 3 — CAPS/inline names (Jersey Surf): an ALL-CAPS run that looks like a name, marking a
  // person block; title from the adjacent italic/bold, bio from the following paragraph(s).
  $body.find("p,strong,b,span").each((_, el) => {
    const $el = $(el);
    const raw = (clean($el.text()) ?? "").replace(/['’]s\b/i, "");
    // shouty = ≥2 fully-uppercase word tokens (a caps name like "MIKE DURBOROW").
    const shouty = raw.split(/\s+/).filter((t) => t.length >= 2 && /^[A-ZÀ-Þ.'’-]+$/.test(t)).length >= 2;
    if (!shouty || !looksLikePersonName(normalizeCapsName(raw))) return;
    const $em = $el.find("em,i").first();
    const title2 = $em.length ? clean($em.text()) : null;
    let bio = "";
    let $n = $el.is("p") ? $el.next() : $el.parent().next();
    for (let i = 0; i < 5 && $n.length; i++, $n = $n.next()) {
      const t = clean($n.text());
      if (t && /^[A-ZÀ-Þ.'’\s-]+$/.test(t.split(/\s+/).slice(0, 2).join(" "))) break; // next caps name
      if (t && t.length > 40) bio += (bio ? " " : "") + t;
    }
    push(raw, title2, bio.length > 40 ? bio : null);
  });

  // Intra-post dedup: two records sharing a headshot are one person announced under a nickname
  // and a formal name ("Mike Lynch" header + "D. Michael Lynch" in the bio, same Lynch.jpg).
  // Keep the FIRST (the header — carries the photo/title), backfill its bio from the duplicate.
  const byPhoto = new Map<string, number>();
  const deduped: ExtractedStaff[] = [];
  for (const r of out) {
    const j = r.photoUrl ? byPhoto.get(r.photoUrl) : undefined;
    if (j !== undefined) {
      const k = deduped[j]!;
      deduped[j] = {
        ...k,
        biography: k.biography ?? r.biography,
        title: k.title && !/ Staff$/.test(k.title) ? k.title : r.title && !/ Staff$/.test(r.title) ? r.title : k.title,
      };
      continue;
    }
    if (r.photoUrl) byPhoto.set(r.photoUrl, deduped.length);
    deduped.push(r);
  }
  return deduped;
};

// ============================================================================
// Network / discovery / Wayback (M3). Effect-based so the render fallback can be
// read opportunistically from BrowserbaseService (local Chromium → cloud), exactly
// like merchCatalog. No API key needed for the local-render path.
// ============================================================================

// A full desktop-Chrome UA + Accept-Language — bare "Mozilla/5.0" gets 403/406'd by common
// WAFs (Cloudflare etc.) that gate WP-REST/sitemaps on active corps (e.g. Pacific Crest).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml";
const DEFAULT_TIMEOUT_MS = 20000;
/** Candidate staff-page slugs, most-common first (M0: `/staff` dominates). */
export const STAFF_SLUGS = [
  "staff",
  "about/staff",
  "education/staff",
  "team",
  "our-team",
  "people",
  "leadership",
  "instructors",
] as const;
/** A page must yield at least this many plausible people to count as a staff page. */
const MIN_RECORDS = 2;

interface FetchResult {
  readonly status: number;
  readonly html: string;
}

/** Plain node fetch; never throws — a failure/timeout surfaces as status 0, "". */
const nodeFetch = (url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Effect.Effect<FetchResult> =>
  Effect.tryPromise(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: HTML_ACCEPT, "Accept-Language": ACCEPT_LANGUAGE },
        redirect: "follow",
        signal: controller.signal,
      });
      const html = res.ok ? await res.text() : "";
      return { status: res.status, html };
    } finally {
      clearTimeout(timer);
    }
  }).pipe(Effect.orElseSucceed(() => ({ status: 0, html: "" })));

/** Render via BrowserbaseService if it's provided; "" otherwise. Never fails. */
const render = (url: string): Effect.Effect<string> =>
  Effect.serviceOption(BrowserbaseService).pipe(
    Effect.flatMap((opt) =>
      Option.isSome(opt)
        ? opt.value.fetchHtml(url).pipe(Effect.orElseSucceed(() => ""))
        : Effect.succeed(""),
    ),
  );

/**
 * Fetch a URL's staff records via the ladder: node fetch first; if the response
 * is blocked (403/406/0), empty, or carries too few records (client-rendered),
 * escalate to a render. Returns the best (most records) of the two.
 */
export const fetchAndExtract = (
  url: string,
  opts: { noRender?: boolean } = {},
): Effect.Effect<{ url: string; html: string; staff: ExtractedStaff[]; rendered: boolean }> =>
  Effect.gen(function* () {
    const direct = yield* nodeFetch(url);
    const directStaff = extractStaffFromHtml(direct.html, url);
    const blocked = direct.status === 0 || direct.status === 403 || direct.status === 406;
    if (opts.noRender || (!blocked && directStaff.length >= MIN_RECORDS)) {
      return { url, html: direct.html, staff: directStaff, rendered: false };
    }
    // Escalate: blocked by a WAF, or a non-empty shell that didn't parse (SPA).
    const renderedHtml = yield* render(url);
    const renderedStaff = extractStaffFromHtml(renderedHtml, url);
    if (renderedStaff.length >= directStaff.length && renderedStaff.length > 0) {
      return { url, html: renderedHtml, staff: renderedStaff, rendered: true };
    }
    return { url, html: direct.html, staff: directStaff, rendered: false };
  });

const withScheme = (website: string): string =>
  /^https?:\/\//i.test(website) ? website : `https://${website}`;
const baseUrlOf = (website: string): string => withScheme(website).replace(/\/+$/, "");
const originOf = (website: string): string => {
  try {
    return new URL(withScheme(website)).origin;
  } catch {
    return baseUrlOf(website);
  }
};
/** A URL whose path already looks like a staff page (so it's safe to render it as one). */
const STAFFISH_PATH = /\/(staff|team|our-?team|people|leadership|instructors?|faculty|coaches|personnel|directors?)\b/i;
const STAFF_LINK_RE = /\b(staff|faculty|instructors?|our[\s-]?team|leadership|personnel|coaches|directors?|administration|design[\s-]?team)\b/i;
const NON_STAFF_LINK_RE = /\b(news|shop|store|donate|sponsor|camp|tickets?|schedule|results|history|policy|policies|contact|login|account|alumni|home|gallery|merch|calendar|events?)\b/i;

/**
 * From a homepage's HTML, find candidate staff-page URLs by scanning anchors whose link
 * TEXT or href looks staff-related (text is the stronger signal). Same-host only, anchors/
 * mailto excluded, ranked text-match → href-match. PURE — exported for testing.
 */
export const findStaffLinks = (html: string, baseUrl: string): string[] => {
  if (!html) return [];
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    /* keep host empty → skip host check */
  }
  // Regex anchor scan (NOT cheerio) so a pathologically large homepage — Blue Devils
  // serves a 56 MB page — can be link-scanned without building a DOM (which would OOM).
  const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  const scored = new Map<string, number>();
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = ANCHOR_RE.exec(html)) !== null && scanned < 8000) {
    scanned++;
    const href = (m[1] ?? m[2] ?? "").trim();
    const text = clean((m[3] ?? "").replace(/<[^>]*>/g, " ")) ?? "";
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    try {
      if (host && new URL(abs).host !== host) continue; // same-site only
    } catch {
      continue;
    }
    const textHit = STAFF_LINK_RE.test(text);
    const hrefHit = STAFF_LINK_RE.test(href);
    if (!textHit && !hrefHit) continue;
    if (NON_STAFF_LINK_RE.test(text) && !textHit) continue;
    // Rank: explicit "staff"/"faculty" text is strongest; then other team words; then href-only.
    const score = /\b(staff|faculty)\b/i.test(text) ? 3 : textHit ? 2 : 1;
    scored.set(abs, Math.max(scored.get(abs) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
};

interface DiscoveryHit {
  url: string;
  html: string;
  staff: ExtractedStaff[];
  rendered: boolean;
}

/**
 * Find a corps' current staff page. Tries the website URL AS-IS first (the DB value is
 * sometimes already a `/staff` page), then standard slugs against the ORIGIN. Render-
 * frugal: probe all candidates with cheap node fetches, accept the best server-rendered
 * hit; only escalate to a SINGLE render of a staff-ish candidate (a 200 SPA shell, else a
 * WAF-blocked one) — never render the bare homepage as if it were the staff page.
 */
/** Matches a link to a staff SUB-page split off the main staff page: a board page, or a
 *  per-caption/section page ("Brass Staff", "Design Team", "Board of Directors"). Many
 *  corps split their roster across these (The Academy: /staff/2026-brass-staff/ … ; Blue
 *  Devils: /about/bod/). The link TEXT is often generic ("Click Here") so the HREF is the
 *  real signal. */
const STAFF_SUBPAGE_RE =
  /\b(board|bod|trustees?|design[\s-]?team|leadership|administration|instructional|caption[\s-]?heads?|(brass|visual|colou?r[\s-]?guard|guard|percussion|battery|front[\s-]?ensemble|pit|audio|management|admin|education|hornline)[\s-]?(staff|team|heads?))\b/i;

/** A BARE caption-section page — the whole URL path segment (or exact link text) is just a
 *  caption name, with no "staff/team" suffix: `/brass/`, `/percussion/`, `/color-guard/`,
 *  `/visual/` (CT Hurricanes & others split instructional staff this way). Matched on the
 *  final path segment / exact text so generic nav words don't false-positive. */
const CAPTION_PAGE_RE =
  /^(brass|hornline|low[\s-]?brass|high[\s-]?brass|visual|drill|colou?r[\s-]?guard|guard|percussion|battery|front[\s-]?ensemble|pit|drum[\s-]?majors?|electronics|sound|audio)$/i;
const lastSegment = (path: string) => path.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";

/** Find staff sub-page URLs linked from a primary staff page: same-site links whose href
 *  is UNDER the staff path, or whose href/text names a section/board. Excludes the page
 *  itself, query/anchor links, and obvious non-staff (news/contact). PURE. */
export const findStaffSubpages = (html: string, primaryUrl: string): string[] => {
  if (!html || html.length > MAX_HTML_BYTES) return [];
  let host = "";
  let primaryPath = "/";
  try {
    const u = new URL(primaryUrl);
    host = u.host;
    primaryPath = u.pathname.replace(/\/+$/, "");
  } catch {
    return [];
  }
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    const text = clean($(a).text()) ?? "";
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    let abs: string, path: string;
    try {
      const u = new URL(href, primaryUrl);
      if (u.host !== host || u.search) return; // same-site, no query-param/season links
      abs = u.toString().replace(/\/+$/, "");
      path = u.pathname.replace(/\/+$/, "");
    } catch {
      return;
    }
    if (path === primaryPath) return; // the page itself
    if (NON_STAFF_LINK_RE.test(text) || /\/(news|blog|20\d\d|press|article)\b/i.test(path)) return;
    const underStaff = primaryPath.length > 1 && (path.startsWith(primaryPath + "/") || abs.startsWith(primaryUrl.replace(/\/+$/, "") + "/"));
    const bareCaption = CAPTION_PAGE_RE.test(lastSegment(path).replace(/-/g, "-")) || CAPTION_PAGE_RE.test(text);
    if (STAFF_SUBPAGE_RE.test(href) || STAFF_SUBPAGE_RE.test(text) || bareCaption || underStaff) out.add(abs);
  });
  return [...out];
};

/** The PARENT path segment of a person-detail URL names a roster ("staff", "team", …).
 *  Tested with word boundaries so a hyphen-joined segment counts too: "drum-corps-staff"
 *  (Mandarins), "our-team", "meet-the-staff". So /drum-corps-staff/<name>, /team/<name>,
 *  /people/<name>, /profile/<name>, /bios/<name>, WP /author/<name> all qualify. */
const PERSON_PARENT_RE = /\b(staff|team|people|person|profiles?|bios?|members?|instructors?|faculty|coaches|leadership|roster|directory|author)\b/i;
/** Is the SECOND-TO-LAST path segment roster-ish? (the segment a person slug hangs under) */
const underPersonParent = (path: string): boolean => {
  const segs = path.split("/").filter(Boolean);
  return segs.length >= 2 && PERSON_PARENT_RE.test(segs[segs.length - 2]!);
};

/** Turn a URL slug ("dr-marvin-reed", "jane_doe") into a candidate display name, or null
 *  if it doesn't look like a 2–4-token person name. Strips honorifics; rejects caption
 *  words. PURE — exported for the detail-page pairing in scrapeStaffDetail. */
export const slugToName = (slug: string): string | null => {
  const seg = decodeURIComponent(slug).replace(/\.(html?|php|aspx?)$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9'’.\-_]*$/.test(seg)) return null;
  if (CAPTION_PAGE_RE.test(seg.replace(/[-_]/g, ""))) return null; // /brass, /percussion …
  // Drop a leading/trailing season year (Squarespace "/staff-1/2025-greg-power") — it's a
  // date marker, not part of the name. Other digit tokens (ids) still disqualify the slug.
  const tokens = seg.split(/[-_]+/).filter((t) => !/^(19|20)\d{2}$/.test(t));
  if (tokens.length < 2 || tokens.length > 5) return null;
  if (tokens.some((t) => /\d/.test(t) || t.length > 20)) return null; // id slugs, not names
  const name = tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join(" ");
  const stripped = stripHonorific(name);
  return looksLikePersonName(stripped) ? stripped : null;
};

/** Pull a 4-digit season year from a slug ("2025-greg-power" → "2025"), if present — used
 *  as the candidate's source_date so an older snapshot doesn't override a newer one. */
export const seasonFromSlug = (slug: string): string | null =>
  decodeURIComponent(slug).match(/\b(19|20)\d{2}\b/)?.[0] ?? null;

/** Normalize a name for loose matching (lowercase, strip honorific/punctuation/accents). */
const nameKey = (s: string): string =>
  stripHonorific(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

/** Find per-PERSON detail-page URLs linked from a roster page: same-site anchors whose
 *  href slug is a person-name (under a /staff|/team|… parent) OR whose link TEXT is a
 *  person name pointing at a deeper page. Each result is paired to a roster name when one
 *  is supplied (by text match, then slug match). Excludes the page itself, section/board
 *  subpages, news/blog, and query links. PURE — sibling of `findStaffSubpages`. */
export const findPersonDetailLinks = (
  html: string,
  primaryUrl: string,
  rosterNames: readonly string[] = [],
): Array<{ url: string; name: string }> => {
  if (!html || html.length > MAX_HTML_BYTES) return [];
  let host = "";
  let primaryPath = "/";
  try {
    const u = new URL(primaryUrl);
    host = u.host;
    primaryPath = u.pathname.replace(/\/+$/, "");
  } catch {
    return [];
  }
  const rosterByKey = new Map<string, string>(); // nameKey → roster displayName
  for (const n of rosterNames) rosterByKey.set(nameKey(n), n);
  const $ = cheerio.load(html);
  const out = new Map<string, { url: string; name: string }>(); // abs url → pair
  $("a[href]").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    const text = clean($(a).text()) ?? "";
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    let abs: string, path: string;
    try {
      const u = new URL(href, primaryUrl);
      if (u.host !== host || u.search) return;
      abs = u.toString().replace(/\/+$/, "");
      path = u.pathname.replace(/\/+$/, "");
    } catch {
      return;
    }
    if (path === primaryPath || path === "/") return; // the page itself / homepage
    // Skip news/blog/commerce, and date-archive paths where a year is its OWN segment
    // ("/2024/", "/blog/2024/") — but NOT a year glued to a person slug ("/2020-jim-doe").
    if (NON_STAFF_LINK_RE.test(text) || /\/(news|blog|press|article|shop|store|event)\b/i.test(path) || /\/(19|20)\d\d(?:\/|$)/.test(path)) return;
    if (STAFF_SUBPAGE_RE.test(path) || CAPTION_PAGE_RE.test(lastSegment(path).replace(/-/g, ""))) return; // board/section, not a person
    const slugName = slugToName(lastSegment(path));
    const textIsName = looksLikePersonName(text);
    // The link MUST hang under a roster parent segment ("/staff-1/<name>", "/drum-corps-
    // staff/<name>", "/team/<name>", "/author/<name>"). This is the key guard against
    // top-level nav junk that happens to look name-shaped ("/membership-interest-form",
    // "/mission-statement") — those have no roster parent and are dropped.
    if (!underPersonParent(path)) return;
    // …and it must resolve to a person name (from the slug or the link text).
    if (!slugName && !textIsName) return;
    // Pair to a roster name: prefer link text, then slug.
    const textHit = textIsName ? rosterByKey.get(nameKey(text)) : undefined;
    const slugHit = slugName ? rosterByKey.get(nameKey(slugName)) : undefined;
    const name = textHit ?? slugHit ?? (textIsName ? text : slugName);
    if (!name) return;
    // If a roster was supplied, only keep links that match a known roster member.
    if (rosterNames.length > 0 && !textHit && !slugHit) return;
    if (!out.has(abs)) out.set(abs, { url: abs, name });
  });
  return [...out.values()];
};

export const discoverStaffPage = (
  website: string,
): Effect.Effect<DiscoveryHit | null> =>
  Effect.gen(function* () {
    const asIs = baseUrlOf(website);
    const origin = originOf(website);

    // Merge staff from linked sub-pages (board, per-caption pages) into a primary hit,
    // deduped by name. Bounded to a few sub-pages. Many corps split the roster this way.
    const withSubpages = (hit: DiscoveryHit): Effect.Effect<DiscoveryHit> =>
      Effect.gen(function* () {
        const subs = findStaffSubpages(hit.html, hit.url).slice(0, 8);
        if (subs.length === 0) return hit;
        const merged = [...hit.staff];
        const byName = new Map<string, number>(); // lowercased name → index in merged
        merged.forEach((s, i) => byName.set(s.displayName.toLowerCase(), i));
        for (const sub of subs) {
          const r = yield* fetchAndExtract(sub);
          for (const s of r.staff) {
            const k = s.displayName.toLowerCase();
            const idx = byName.get(k);
            if (idx === undefined) {
              byName.set(k, merged.length);
              merged.push(s);
            } else {
              // Enrich the existing entry — subpages often carry extra fields (photo, bio)
              // that the parent directory page omits. Never downgrade: non-null wins.
              const existing = merged[idx]!;
              if (!existing.photoUrl && s.photoUrl) merged[idx] = { ...existing, photoUrl: s.photoUrl };
              if (!existing.biography && s.biography) merged[idx] = { ...merged[idx]!, biography: s.biography };
              if (!existing.title && s.title) merged[idx] = { ...merged[idx]!, title: s.title };
            }
          }
        }
        return { ...hit, staff: merged };
      });
    // Ordered, de-duplicated candidate URLs: the website itself, then origin + slugs.
    const candidates = [...new Set([asIs, ...STAFF_SLUGS.map((s) => `${origin}/${s}`)])];

    let best: DiscoveryHit | null = null;
    let renderCandidate: string | null = null; // staff-ish 200 shell, parsed empty (SPA)
    let blockedCandidate: string | null = null; // staff-ish 403/406 WAF

    for (const url of candidates) {
      const r = yield* nodeFetch(url);
      const staff = extractStaffFromHtml(r.html, url);
      if (staff.length >= MIN_RECORDS && (!best || staff.length > best.staff.length)) {
        best = { url, html: r.html, staff, rendered: false };
        if (best.staff.length >= 5) return yield* withSubpages(best); // strong hit — done
      }
      const staffish = STAFFISH_PATH.test(url);
      if (staffish && !renderCandidate && r.status === 200 && r.html.trim().length > 0) renderCandidate = url;
      if (staffish && !blockedCandidate && (r.status === 403 || r.status === 406 || r.status === 0)) blockedCandidate = url;
    }
    if (best) return yield* withSubpages(best);

    // NAV-LINK DISCOVERY: standard slugs found nothing. Find staff links from the
    // homepage nav — this catches non-standard paths (Blue Devils' "Contact and Staff"
    // → /about/contact/, Carolina Crown's /drum-corps/staff) and SPA client routes that
    // 404 on a direct slug fetch.
    //   1) Plain-fetch the homepage and regex-scan its links first (cheap, and safe even
    //      on Blue Devils' 56 MB homepage — no DOM built).
    //   2) Only if that finds nothing, render the homepage (for client-rendered navs like
    //      Carolina Crown) — but NEVER render a pathologically huge page (OOM risk).
    const homePlain = yield* nodeFetch(origin);
    let links = findStaffLinks(homePlain.html, origin);
    if (links.length === 0 && homePlain.html.length < MAX_HTML_BYTES) {
      const rendered = yield* render(origin);
      links = findStaffLinks(rendered, origin);
    }
    for (const link of links.slice(0, 4)) {
      const r = yield* fetchAndExtract(link);
      if (r.staff.length >= MIN_RECORDS) return yield* withSubpages(r);
      if (!renderCandidate && STAFFISH_PATH.test(link)) renderCandidate = link;
    }

    // Last resort — render a staff-ish candidate even if Pattern A found nothing
    // (staff: []), so the caller can hand the HTML to the Pattern B AI extractor (M4).
    const candidate = renderCandidate ?? blockedCandidate;
    if (!candidate) return null;
    const r = yield* fetchAndExtract(candidate); // will render since plain fetch was empty/blocked
    return r.html.trim().length > 0 ? yield* withSubpages(r) : null;
  });

/** Render-FREE per-person detail-link discovery. Plain-fetches the website + standard staff
 *  slugs (and one level of staff sub-pages), scanning each for detail links paired to the
 *  roster. Squarespace/Wix/WordPress staff pages are server-rendered, so no Chromium is
 *  needed — critical on the 4 GB box where the render path leaks browsers and OOMs. Returns
 *  the union of detail links plus the staff page that yielded the most. */
export const discoverDetailLinksNoRender = (
  website: string,
  rosterNames: readonly string[],
): Effect.Effect<{ staffPageUrl: string | null; links: Array<{ url: string; name: string }> }> =>
  Effect.gen(function* () {
    const origin = originOf(website);
    const candidates = [...new Set([baseUrlOf(website), ...STAFF_SLUGS.map((s) => `${origin}/${s}`)])];
    const byUrl = new Map<string, { url: string; name: string }>();
    let staffPageUrl: string | null = null;
    let bestCount = -1;
    for (const url of candidates) {
      const r = yield* nodeFetch(url);
      if (!r.html || r.html.length > MAX_HTML_BYTES) continue;
      const links = findPersonDetailLinks(r.html, url, rosterNames);
      for (const l of links) if (!byUrl.has(l.url)) byUrl.set(l.url, l);
      // One level of staff sub-pages (per-caption / board pages) often hold more detail links.
      for (const sub of findStaffSubpages(r.html, url).slice(0, 6)) {
        const sr = yield* nodeFetch(sub);
        if (!sr.html || sr.html.length > MAX_HTML_BYTES) continue;
        for (const l of findPersonDetailLinks(sr.html, sub, rosterNames)) if (!byUrl.has(l.url)) byUrl.set(l.url, l);
      }
      if (links.length > bestCount) { bestCount = links.length; staffPageUrl = url; }
    }
    return { staffPageUrl, links: [...byUrl.values()] };
  });

// ── Announcement-post DISCOVERY (docs/announcement-sources-plan.md §A2) ──────────────────
// A staff announcement is found by title/slug: a caption/staff word + a trigger (a year, or an
// announce-verb like joins/welcomes/announces). The A3 extractor + the orchestrator's
// "≥N people or drop" rule filter false positives (e.g. "staff retreat").
const CAPTION_WORD_RE =
  /\b(staff|caption|brass|percussion|visual|colou?r[\s-]?guard|guard|design|education|front[\s-]?ensemble|drum[\s-]?major|hornline|team|instructors?|techs?)\b/i;
const ANNOUNCE_TRIGGER_RE =
  /\b((19|20)\d{2}|joins?|rejoins?|welcomes?|announces?|announced|headlines?|introduc\w*|appoint\w*|update|adds?|hir\w*|names?|returning|takes?\b)\b/i;
const isAnnouncementTitle = (s: string): boolean => CAPTION_WORD_RE.test(s) && ANNOUNCE_TRIGGER_RE.test(s);
const decodeEntities = (s: string): string =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/gi, " ");

/** A discovered announcement post. `html` is populated when the source gave it for free
 *  (WordPress REST `content.rendered`); otherwise the caller fetches/renders the `url`. */
export interface AnnouncementPost {
  readonly url: string;
  readonly title: string;
  readonly publishedDate: string | null;
  readonly html: string | null;
}

const WP_SEARCH_TERMS = ["staff", "caption", "brass", "percussion", "visual", "guard", "design"] as const;

/**
 * Discover staff-announcement posts for a corps (§A2). Two tiers:
 *   1. WordPress REST API — `/wp-json/wp/v2/posts?search=<term>` (title+date+body in one call,
 *      reaches site inception). Tried first; the cheapest and richest.
 *   2. Sitemap fallback — `sitemap_index.xml` → post/staff sub-sitemaps → URLs whose SLUG looks
 *      like an announcement (covers non-WP sites like Wix, and WP sites with REST disabled).
 * Deduped by URL, title-filtered, capped. PURE-ish (network only; no DB). Wayback CDX for
 * DELETED posts is a future add — live REST/sitemap already reach historical posts.
 */
export const discoverAnnouncementPosts = (
  website: string,
  opts: { max?: number } = {},
): Effect.Effect<AnnouncementPost[]> =>
  Effect.gen(function* () {
    const origin = originOf(website);
    const max = opts.max ?? 80;
    const byUrl = new Map<string, AnnouncementPost>();

    // Tier 1 — WordPress REST.
    for (const term of WP_SEARCH_TERMS) {
      if (byUrl.size >= max) break;
      const api = `${origin}/wp-json/wp/v2/posts?per_page=50&search=${term}&_fields=title,date,link,content`;
      const res: unknown = yield* Effect.tryPromise({
        try: () => fetch(api, { headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*;q=0.8", "Accept-Language": ACCEPT_LANGUAGE }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }).then((r) => (r.ok && /json/i.test(r.headers.get("content-type") ?? "") ? r.json() : null)),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      if (!Array.isArray(res)) continue;
      for (const p of res as any[]) {
        const title = decodeEntities(String(p?.title?.rendered ?? "")).replace(/\s+/g, " ").trim();
        const link = typeof p?.link === "string" ? p.link.replace(/\/+$/, "") : null;
        if (!link || !title || byUrl.has(link) || !isAnnouncementTitle(title)) continue;
        byUrl.set(link, { url: link, title, publishedDate: typeof p?.date === "string" ? p.date : null, html: typeof p?.content?.rendered === "string" ? p.content.rendered : null });
      }
    }

    // Tier 2 — sitemap fallback (covers non-WP + REST-off). Handles nested sitemaps: a site's
    // top file is often an INDEX pointing to sub-sitemaps. Wix names its index "sitemap.xml"
    // (not "_index"), so we seed BOTH names and recurse ONE level into post/blog/staff/news
    // sub-sitemaps before treating <loc>s as actual post URLs.
    if (byUrl.size < 5) {
      const locsOf = (html: string) => [...(html ?? "").matchAll(/<loc>\s*([^<]+)<\/loc>/gi)].map((m) => m[1]!.trim());
      const isSubSitemap = (u: string) => /sitemap[^/]*\.xml|\.xml(\?|$)/i.test(u);
      const wanted = /(post|staff|news|blog|dynamic|article)/i;
      const postMaps = new Set<string>();
      const postUrls = new Set<string>();
      for (const seed of [`${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`, `${origin}/wp-sitemap.xml`]) {
        const sm = yield* nodeFetch(seed);
        for (const u of locsOf(sm.html)) {
          if (isSubSitemap(u)) { if (wanted.test(u)) postMaps.add(u); }
          else postUrls.add(u);
        }
      }
      for (const map of [...postMaps].slice(0, 8)) {
        const sm = yield* nodeFetch(map);
        for (const u of locsOf(sm.html)) if (!isSubSitemap(u)) postUrls.add(u);
      }
      for (const u0 of postUrls) {
        if (byUrl.size >= max) break;
        const u = u0.replace(/\/+$/, "");
        const slug = (u.split("/").pop() ?? "").replace(/[-_]+/g, " ");
        if (!byUrl.has(u) && isAnnouncementTitle(slug)) byUrl.set(u, { url: u, title: slug, publishedDate: null, html: null });
      }
    }

    // Tier 3 — HTML news-index scan (no REST/sitemap; e.g. Colts' `/news/YYYY_NNN` pages, which
    // have no sitemap entry). Fetch common news/blog index pages and keep same-site links whose
    // ANCHOR TEXT or href matches the announcement pattern. Renders an index if the plain fetch
    // looks like an empty SPA shell.
    if (byUrl.size < 5) {
      let host = "";
      try { host = new URL(origin).host; } catch { /* ignore */ }
      const scanLinks = (html: string, idxUrl: string): number => {
        if (!html || html.length > MAX_HTML_BYTES) return 0;
        const $ = cheerio.load(html);
        let added = 0;
        $("a[href]").each((_, a) => {
          const href = ($(a).attr("href") ?? "").trim();
          const text = clean($(a).text()) ?? "";
          if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
          let u: string;
          try { const url = new URL(href, idxUrl); if (url.host !== host) return; u = url.toString().replace(/[?#].*$/, "").replace(/\/+$/, ""); } catch { return; }
          const slug = (u.split("/").pop() ?? "").replace(/[-_]+/g, " ");
          if (!byUrl.has(u) && u !== idxUrl.replace(/\/+$/, "") && (isAnnouncementTitle(text) || isAnnouncementTitle(slug))) {
            byUrl.set(u, { url: u, title: text || slug, publishedDate: null, html: null });
            added++;
          }
        });
        return added;
      };
      const indexes = ["news", "blog", "press", "announcements", "news-events", "category/news", "category/staff", ""];
      for (const path of indexes) {
        if (byUrl.size >= max) break;
        const idxUrl = path ? `${origin}/${path}` : origin;
        const res = yield* nodeFetch(idxUrl);
        if (res.status === 0 || res.status === 404) continue;
        // Scan the plain HTML; if it surfaced nothing, the news list is likely JS-rendered —
        // render once and re-scan (many corps hydrate the post list client-side).
        if (scanLinks(res.html, idxUrl) === 0) {
          const rendered = yield* render(idxUrl);
          if (rendered && rendered !== res.html) scanLinks(rendered, idxUrl);
        }
      }
    }

    return [...byUrl.values()].slice(0, max);
  });

/**
 * Result of a Wayback lookup. We distinguish three outcomes so the caller can treat
 * them differently (a transient fetch error must NOT be cached as a permanent gap):
 *  - `found`  — a usable snapshot within ±tolerance years; carries its ACTUAL year.
 *  - `absent` — the API answered but has no in-tolerance snapshot (a genuine gap).
 *  - `error`  — the availability fetch/parse failed (transient; retry next run).
 */
export type WaybackResult =
  | { status: "found"; snapshotUrl: string; snapshotYear: number }
  | { status: "absent" }
  | { status: "error" };

/**
 * Resolve a Wayback snapshot of `url` near a given season, BOUNDED by year proximity
 * (M0: the API's unbounded `closest` can be a decade off the requested timestamp).
 * Returns the snapshot's ACTUAL year so the caller can label the roster by the year it
 * was really captured (not the requested season) and dedupe a snapshot shared by
 * adjacent seasons.
 */
export const waybackSnapshot = (
  url: string,
  season: string,
  toleranceYears = 1,
): Effect.Effect<WaybackResult> =>
  Effect.gen(function* () {
    // The `available` API is fast (sub-second) and returns the closest *available*
    // capture WITH a `status` field; it already prefers 200s, but we double-check.
    // (CDX gives full history in one call but is slow/flaky — 11-20s + timeouts — so it
    // loses at 139-corps scale; the per-season `available` call is the robust choice.)
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${season}0801`;
    const res = yield* nodeFetch(api);
    // status 0 = network/timeout failure; non-200 = rate-limit/error → transient (retry).
    if (res.status === 0 || res.status >= 400 || !res.html) return { status: "error" };
    try {
      const parsed = JSON.parse(res.html) as {
        archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string; status?: string } };
      };
      const snap = parsed.archived_snapshots?.closest;
      if (!snap?.available || !snap.url || !snap.timestamp) return { status: "absent" };
      // Reject non-200 captures (302 redirects / error pages yield no staff).
      if (snap.status && snap.status !== "200") return { status: "absent" };
      const snapYear = Number(snap.timestamp.slice(0, 4));
      if (!Number.isFinite(snapYear)) return { status: "absent" };
      if (Math.abs(snapYear - Number(season)) > toleranceYears) return { status: "absent" };
      // Use the raw archived page (`id_`) — no Wayback toolbar/nav injection to parse around.
      const snapshotUrl = snap.url.replace(/\/web\/(\d+)\//, "/web/$1id_/");
      return { status: "found", snapshotUrl, snapshotYear: snapYear };
    } catch {
      // Parse failure on a non-empty body is ambiguous; treat as transient so we retry.
      return { status: "error" };
    }
  });
