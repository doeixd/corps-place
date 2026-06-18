// Single source of truth for the "is this lineup row a real performing corps, or
// schedule/agenda noise?" heuristics.
//
// Background: event lineups are scraped from DCI event pages, where agenda items
// ("Reserved Seating Takes Effect", "Movie Theater Cinecast", "Competition
// Resumes", "DCI World Championships Semifinals Begins", …) sit in the same list
// as actual performers and sometimes get matched to bogus `corps` records. These
// pollute the corps directory.
//
// Design (see also active-corps.ts, which warns about the same drift): the
// heuristic *rules* live in the DB as data (the `domain_event_exclusion_patterns`
// table, `category = 'schedule_item'`), so adding a rule reclassifies everything
// with no code change. This module holds the canonical seed + a TS matcher that
// mirrors SQLite `LIKE` semantics, used by:
//   - the seeder/migration that loads patterns into the DB,
//   - the `season_performing_corps` view (which reads the table, not this list),
//   - the tests (golden include/exclude sets).
//
// IMPORTANT: this is deliberately ORTHOGONAL to `is_non_performance` /
// `is_exhibition`. Those drive the prediction model and its views and must not
// change here. `schedule_item` is purely "not a performer at all" — exhibition,
// alumni, and legacy corps are real performers and are NOT schedule items.

export type ExclusionCategory =
  | 'schedule_item'
  | 'not_a_corps'
  | 'alumni'
  | 'exhibition'
  | 'model';

// Categories whose entries are not a real standalone corps and must be excluded
// from the directory (and are candidates for hard-deletion of bogus corps rows):
// agenda/venue noise plus joint performances and show-segment "arcs".
export const NON_CORPS_CATEGORIES: readonly ExclusionCategory[] = ['schedule_item', 'not_a_corps'];

export type ExclusionPattern = {
  /** SQLite LIKE pattern, lowercase, matched against lower(unit_name). */
  pattern: string;
  category: ExclusionCategory;
  reason: string;
};

// Agenda / venue / ceremony rows that are not performances by any corps. These
// drive directory exclusion and the hard-delete of bogus corps records. Keep
// patterns specific enough not to collide with real ensemble names (avoid bare
// tokens like 'score' or 'change' that appear inside legitimate corps names).
export const SCHEDULE_ITEM_PATTERNS: readonly ExclusionPattern[] = [
  { pattern: '%gates open%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%doors open%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%will call%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%reserved seating%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%takes effect%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%club access%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%premium ticket%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%levels open%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%loge%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%terrace level%', category: 'schedule_item', reason: 'Venue/agenda item' },
  { pattern: '%cinecast%', category: 'schedule_item', reason: 'Broadcast/agenda item' },
  { pattern: '%movie theater%', category: 'schedule_item', reason: 'Broadcast/agenda item' },
  { pattern: '%intermission%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%joint performance%', category: 'schedule_item', reason: 'Agenda item (not a corps)' },
  { pattern: '%competition resumes%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%resumes%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%concludes%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%event ends%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%end of event%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%finals begins%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%semifinals begins%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%prelims begins%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%semifinals%', category: 'schedule_item', reason: 'Agenda phase marker' },
  { pattern: '%prelims%', category: 'schedule_item', reason: 'Agenda phase marker' },
  { pattern: '%scores announced%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%final scores%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%awards ceremony%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%retreat%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%age-out%', category: 'schedule_item', reason: 'Agenda item' },
  { pattern: '%age out%', category: 'schedule_item', reason: 'Agenda item' },
];

// Real performers that nonetheless do not compete in the scored/model divisions
// (exhibition, alumni, legacy, community, mini corps, etc.). Mirrored here so the
// DB patterns table can become the single source the model views read from in a
// later consolidation. NOT used to exclude from the directory — these ARE corps.
// Alumni / legacy corps — real performing organizations, kept in the directory
// but tagged so they can be filtered (see is_alumni in corps-directory.ts). Split
// out from the generic exhibition bucket so "Alumni" is its own facet.
export const ALUMNI_PATTERNS: readonly ExclusionPattern[] = [
  { pattern: '%alumni%', category: 'alumni', reason: 'Alumni corps' },
  { pattern: '%legacy%', category: 'alumni', reason: 'Legacy/alumni corps' },
];

export const EXHIBITION_PATTERNS: readonly ExclusionPattern[] = [
  { pattern: '%brassworks%', category: 'exhibition', reason: 'Exhibition unit' },
  { pattern: '%bkxperience%', category: 'exhibition', reason: 'Exhibition unit' },
  { pattern: '%experience%', category: 'exhibition', reason: 'Exhibition unit' },
  { pattern: '%community%', category: 'exhibition', reason: 'Exhibition/community unit' },
  { pattern: '%exhibition%', category: 'exhibition', reason: 'Exhibition unit' },
];

// Entries that are not a standalone corps but also not pure agenda noise: joint
// performances ("Rhythm IN BLUE - Bluecoats") and show-segment "arcs" / ensembles
// ("Bluecoats Alumni Legacy Arc"). The ' - ' (space-hyphen-space) form is how the
// scraper renders a combined act; bare hyphens in real names (EN-CORPS) don't match.
export const NOT_A_CORPS_PATTERNS: readonly ExclusionPattern[] = [
  { pattern: '% - %', category: 'not_a_corps', reason: 'Joint/combined performance, not a single corps' },
  { pattern: '%legacy arc%', category: 'not_a_corps', reason: 'Show-segment arc, not a corps' },
];

export const ALL_EXCLUSION_PATTERNS: readonly ExclusionPattern[] = [
  ...SCHEDULE_ITEM_PATTERNS,
  ...NOT_A_CORPS_PATTERNS,
  ...ALUMNI_PATTERNS,
  ...EXHIBITION_PATTERNS,
];

// Mirror SQLite `lower(unit_name) LIKE p.pattern` EXACTLY: lowercase only, no
// dash/whitespace munging — otherwise the matcher and the SQL views disagree
// (e.g. a ' - ' joint pattern, or 'age-out' vs 'age out'). Dash/spacing variants
// are handled by shipping explicit patterns (both '%age-out%' and '%age out%').
// `%` = any run, `_` = any single char (faithful to the DB matcher).
const likeToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, 's');
};

const matchesCategory = (
  unitName: string | null | undefined,
  categories: readonly ExclusionCategory[],
  patterns: readonly ExclusionPattern[]
): boolean => {
  if (!unitName) return false;
  const haystack = unitName.toLowerCase();
  return patterns
    .filter((p) => categories.includes(p.category))
    .some((p) => likeToRegExp(p.pattern).test(haystack));
};

const categoryPriority = (category: ExclusionCategory): number => {
  switch (category) {
    case 'schedule_item':
      return 0;
    case 'not_a_corps':
      return 1;
    case 'alumni':
      return 2;
    case 'exhibition':
      return 3;
    case 'model':
      return 4;
  }
};

/**
 * Returns the highest-priority matching classification pattern for a lineup
 * label, using the same category priority as the SQL classified lineup view.
 */
export const firstExclusionMatch = (
  unitName: string | null | undefined,
  patterns: readonly ExclusionPattern[] = ALL_EXCLUSION_PATTERNS
): ExclusionPattern | undefined => {
  if (!unitName) return undefined;
  const haystack = unitName.toLowerCase();
  return patterns
    .filter((p) => likeToRegExp(p.pattern).test(haystack))
    .sort(
      (a, b) =>
        categoryPriority(a.category) - categoryPriority(b.category) ||
        b.pattern.length - a.pattern.length ||
        a.pattern.localeCompare(b.pattern)
    )[0];
};

/** True iff `unitName` matches any `schedule_item` pattern (agenda/venue noise). */
export const isScheduleItem = (
  unitName: string | null | undefined,
  patterns: readonly ExclusionPattern[] = ALL_EXCLUSION_PATTERNS
): boolean => matchesCategory(unitName, ['schedule_item'], patterns);

/**
 * True iff `unitName` is not a real standalone corps: agenda/venue noise, a joint
 * performance, or a show-segment arc. Drives directory exclusion and the
 * hard-delete of bogus corps rows. (Exhibition/alumni corps are NOT included —
 * they are real performers and remain in the directory.)
 */
export const isNonCorpsName = (
  unitName: string | null | undefined,
  patterns: readonly ExclusionPattern[] = ALL_EXCLUSION_PATTERNS
): boolean => matchesCategory(unitName, NON_CORPS_CATEGORIES, patterns);

/**
 * True iff `name` looks like an alumni / legacy corps. These are real performing
 * corps (kept in the directory) but get an "Alumni" facet for filtering. Callers
 * should gate on the corps not already having a real division (e.g. the
 * SoundSport "Legacy Drum & Bugle Corps" should not be tagged alumni).
 */
export const isAlumniName = (
  name: string | null | undefined,
  patterns: readonly ExclusionPattern[] = ALL_EXCLUSION_PATTERNS
): boolean => matchesCategory(name, ['alumni'], patterns);
