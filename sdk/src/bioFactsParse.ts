// S3.2 — Deterministic bio-facts parser (docs/staff-quality-plan.md).
//
// Turns staff bio PROSE into structured facts: performing history, education, current
// position, hometown, awards. Built from reading a real sampled corpus (see the plan's
// "look at many examples" method). PURE — string in, facts out — so it's unit-testable and
// has no DB/corps grounding here: it returns the raw GROUP / INSTITUTION spans it finds, and
// the ingest step grounds them (corps via mapCorps; schools/awards via known lists) and
// drops the unmatched (the anti-hallucination rule). An AI fallback (S3.3) handles the
// irregular bios this misses.
//
// What it does NOT extract: "taught DCI corps + seasons" — that already lives in
// corps_staff_assignments / rm_staff_detail. We only mine what assignments don't give.

export interface PerformedFact {
  /** Raw group name as written ("The Blue Devils", "Santa Clara Vanguard") — grounded later. */
  readonly group: string;
  readonly startYear: number | null;
  readonly endYear: number | null;
  /** The matched clause, for provenance / debugging. */
  readonly evidence: string;
}
export interface EducationFact {
  readonly degree: string | null;       // "Bachelor of Music Education", "M.M.", "Ph.D."
  readonly institution: string | null;  // "University of Oklahoma"
  readonly field: string | null;        // "Percussion Performance" when stated
  readonly year: number | null;
  readonly evidence: string;
}
export interface PositionFact {
  readonly title: string;                // "Color Guard Director", "Professor of Music"
  readonly org: string;                  // "Lebanon Trail High School"
}
export interface AwardFact {
  readonly name: string;                 // "DCI World Championship", "Jim Ott Award"
  readonly year: number | null;
}
export interface BioFacts {
  readonly performed: PerformedFact[];
  readonly education: EducationFact[];
  readonly currentPosition: PositionFact | null;
  readonly hometown: string | null;
  readonly awards: AwardFact[];
}

const YEAR = "(?:19|20)\\d{2}";
/** A year or year-range in parens or inline: "(2018-2023)", "2012", "in the early 1980s". */
const yearSpan = (s: string): { start: number | null; end: number | null } => {
  const range = s.match(new RegExp(`(${YEAR})\\s*[–—-]\\s*(${YEAR})`));
  if (range) return { start: Number(range[1]), end: Number(range[2]) };
  const single = s.match(new RegExp(`\\b(${YEAR})\\b`));
  return single ? { start: Number(single[1]), end: null } : { start: null, end: null };
};

/** Group-name tail tokens that mark a drum-corps / marching ensemble. */
const GROUP_TAIL = /(Drum (?:and|&) Bugle Corps|Drum Corps|Winter ?guard|Percussion|Cadets|Vanguard|Devils|Crusaders|Scouts|Regiment|Brass)\b/;
/** A capitalized multi-word group name, optionally "The ...". Greedy up to a corps tail. */
const GROUP =
  "(The\\s+)?(?:[A-Z][A-Za-z&'.-]+\\s+){0,4}(?:Drum (?:and|&) Bugle Corps|Drum Corps|Winter ?guard|Percussion|Cadets|Vanguard|Devils|Crusaders|Scouts|Regiment|Crown|Knights|Academy|Genesis|Cascades|Spartans|Crest|Surf|Raiders|Brigade|Pioneer|Stars|Bluecoats|Mandarins|Troopers|Crossmen|Colts|Cavaliers)";

const PERFORMED_VERB =
  /\b(?:marched(?: with| in| at)?|performed with|toured with|was a (?:member|colorgu?ard member|brass member|visual member|performing member)(?: of)?|been a (?:member|performing member)(?: of)?|member of|ag(?:ed|ing)\s+out(?: of| with)?|alumn\w+\s+of|joined)\b/gi;

/** Split a bio into sentence-ish clauses for local matching. */
const clauses = (bio: string): string[] =>
  bio.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|;\s+|\n+/).map((c) => c.trim()).filter(Boolean);

const cleanGroup = (g: string): string =>
  g.replace(/^The\s+/i, "").replace(/\s+/g, " ").trim();

/** Extract performing-history facts: a performed-verb followed (within the clause) by one or
 *  more capitalized group names, each with a nearby year/range. Lists ("X, Y, and Z") split. */
const extractPerformed = (bio: string): PerformedFact[] => {
  const out: PerformedFact[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(bio)) {
    PERFORMED_VERB.lastIndex = 0;
    if (!PERFORMED_VERB.test(clause)) continue;
    // Pull every group-name span in the clause (handles comma lists after one verb).
    const groupRe = new RegExp(GROUP, "g");
    let m: RegExpExecArray | null;
    while ((m = groupRe.exec(clause)) !== null) {
      const group = cleanGroup(m[0]);
      if (group.length < 4) continue;
      // Year nearest this group: look in a window after the match, else the whole clause.
      const after = clause.slice(m.index, m.index + m[0].length + 24);
      const span = yearSpan(after).start ? yearSpan(after) : yearSpan(clause);
      const key = `${group.toLowerCase()}|${span.start ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ group, startYear: span.start, endYear: span.end, evidence: clause.slice(0, 200) });
    }
  }
  // Merge same-group entries: a yearless mention is absorbed into a dated one; overlapping
  // dated mentions widen to the min-start/max-end span (e.g. "Blue Stars" + "Blue Stars 1994").
  const byGroup = new Map<string, PerformedFact>();
  for (const p of out) {
    const k = p.group.toLowerCase();
    const prev = byGroup.get(k);
    if (!prev) { byGroup.set(k, p); continue; }
    if (prev.startYear === null && p.startYear !== null) { byGroup.set(k, { ...p, evidence: prev.evidence }); continue; }
    if (p.startYear === null) continue;
    const years = [prev.startYear, prev.endYear, p.startYear, p.endYear].filter((y): y is number => y !== null);
    byGroup.set(k, { ...prev, startYear: Math.min(...years), endYear: Math.max(...years) === Math.min(...years) ? prev.endYear ?? p.endYear : Math.max(...years) });
  }
  return [...byGroup.values()];
};

const DEGREE =
  /\b(Bachelor(?:'s)?(?: of [A-Z][A-Za-z ]+)?|Master(?:'s)?(?: of [A-Z][A-Za-z ]+)?|Doctor(?:ate)?(?: of [A-Z][A-Za-z ]+)?|Associate(?:'s)?|B\.?M\.?E?\.?|M\.?M\.?(?:E\.?)?|B\.?A\.?|B\.?S\.?|M\.?A\.?|M\.?S\.?|D\.?M\.?A\.?|Ph\.?\s?D\.?)\b/;
// A NAMED institution: "University of X", "X University/College/…", or "X School of Music".
// Note: NO bare "University"/"Academy" (the latter is also a drum corps, "The Academy").
const INSTITUTION =
  /\b(University of [A-Z][A-Za-z ]+?(?=[,.]|\s+(?:in|where|with|and|as|\()|$)|(?:[A-Z][A-Za-z&'.-]+\s+){1,4}(?:University|College|Institute|Conservatory)|[A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){0,3}\s+School of Music)\b/;

const extractEducation = (bio: string): EducationFact[] => {
  const out: EducationFact[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(bio)) {
    const inst = clause.match(INSTITUTION);
    // Require a NAMED institution — a degree alone (no school) is too weak/noisy to keep.
    if (!inst) continue;
    const deg = clause.match(DEGREE);
    const field = clause.match(/\b(?:in|of)\s+([A-Z][A-Za-z ]+?(?:Performance|Education|Studies|Engineering|Composition|Conducting|Music|Arts))\b/);
    const institution = inst[1]!.replace(/^The\s+/i, "").replace(/\s+/g, " ").trim();
    const key = institution.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      degree: deg?.[1]?.replace(/\s+/g, " ").trim() ?? null,
      institution,
      field: field?.[1]?.trim() ?? null,
      year: yearSpan(clause).start,
      evidence: clause.slice(0, 200),
    });
  }
  return out;
};

// Title = optional rank + role keyword + optional "of <CapWords>" (bounded; stops at a
// lowercase connector like "at"/"for" so it doesn't swallow the org that follows).
const OF_CAPS = "(?: of (?:[A-Z][A-Za-z]+|and|the|&)(?:\\s+(?:[A-Z][A-Za-z]+|and|the|&)){0,4})?";
const POSITION_TITLE = new RegExp(
  `\\b((?:Associate |Assistant |Head |Lead |Senior )?(?:Director|Professor|Coordinator|Instructor|Teacher|Manager|Conductor|Dean|Chair)${OF_CAPS})\\b`,
);
// Org = "at|of|for <CapWords> <institution-suffix>". Each prefix token carries its trailing
// space so the required suffix isn't left with a dangling space (the prior bug).
const ORG_AT =
  /\b(?:at|of|for)\s+((?:[A-Z][A-Za-z&'.-]+\s+){0,5}(?:High School|Middle School|Elementary School|University|College|School of Music|School|Academy|Institute|Conservatory|District))\b/;

const extractPosition = (bio: string): PositionFact | null => {
  for (const clause of clauses(bio)) {
    // "currently" / "is" / "serves as" mark a present-tense role.
    if (!/\b(currently|is (?:the |a |an )?|serves? as|works? as|now serves)\b/i.test(clause)) continue;
    const title = clause.match(POSITION_TITLE);
    const org = clause.match(ORG_AT);
    if (title && org) return { title: title[1]!.replace(/\s+/g, " ").trim(), org: org[1]!.replace(/^The\s+/i, "").trim() };
  }
  return null;
};

const extractHometown = (bio: string): string | null => {
  for (const clause of clauses(bio)) {
    const m =
      // "from <City>, <State>" — require the City,State shape (a bare state is not a hometown).
      clause.match(/\b(?:from|grew up in|native of|hails from|based in|raised in)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*[A-Z][A-Za-z]+)/) ??
      clause.match(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+native\b/);
    if (m) {
      const place = m[1]!.replace(/\s+/g, " ").replace(/[.,\s]+$/, "").trim();
      // Reject a lone 2-letter state token ("VA") or empty.
      if (place.length >= 4 && !/^[A-Z]{2}$/.test(place)) return place;
    }
  }
  return null;
};

const AWARD =
  /\b(DCI World Champion(?:ship)?s?|WGI World Champion(?:ship)?s?|World Champion(?:ship)?s?|Jim Ott Award|Fred Sanford Award|Donald Angelica Award|Hall of Fame|George Zingali)\b/gi;

const extractAwards = (bio: string): AwardFact[] => {
  const out: AwardFact[] = [];
  const seen = new Set<string>();
  for (const clause of clauses(bio)) {
    AWARD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = AWARD.exec(clause)) !== null) {
      const name = m[1]!.replace(/\s+/g, " ").trim();
      const around = clause.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12);
      const year = yearSpan(around).start;
      const key = `${name.toLowerCase()}|${year ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, year });
    }
  }
  return out;
};

/** Parse structured facts from a bio. PURE. Grounding (corps/school/award lists) is the
 *  caller's job — this returns every candidate it can match. */
export const parseBioFacts = (bio: string | null | undefined): BioFacts => {
  const text = (bio ?? "").replace(/​/g, "").trim();
  if (text.length < 40) return { performed: [], education: [], currentPosition: null, hometown: null, awards: [] };
  return {
    performed: extractPerformed(text),
    education: extractEducation(text),
    currentPosition: extractPosition(text),
    hometown: extractHometown(text),
    awards: extractAwards(text),
  };
};
