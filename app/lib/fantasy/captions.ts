/**
 * Caption keys and the score-DB string mapping (Fantasy DCI plan Appendix C.1).
 *
 * The 8 caption keys are the canonical strings stored in `fantasy_picks.caption`.
 * The read-only score DB (`dci-relational.db`, `caption_scores.caption_name`)
 * stores long names like "Music - Brass"; map them to keys for all score lookups.
 */

export const CAPTION_KEYS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type CaptionKey = (typeof CAPTION_KEYS)[number];

export const isCaptionKey = (s: string): s is CaptionKey =>
  (CAPTION_KEYS as readonly string[]).includes(s);

/** DB caption_name string → CaptionKey (Appendix C.1, authoritative for current-era data). */
export const CAPTION_NAME_TO_KEY: Record<string, CaptionKey> = {
  'General Effect 1': 'GE1',
  'General Effect 2': 'GE2',
  'Visual Proficiency': 'VP',
  'Visual - Analysis': 'VA',
  'Color Guard': 'CG',
  'Music - Brass': 'MB',
  'Music - Analysis': 'MA',
  'Music - Percussion': 'MP',
};

/** Reverse map, for building SQL IN-lists when querying by caption_name. */
export const KEY_TO_CAPTION_NAME: Record<CaptionKey, string> = Object.fromEntries(
  Object.entries(CAPTION_NAME_TO_KEY).map(([name, key]) => [key, name])
) as Record<CaptionKey, string>;

/** Which DCI category each caption rolls into. */
export const CAPTION_CATEGORY: Record<CaptionKey, 'ge' | 'visual' | 'music'> = {
  GE1: 'ge',
  GE2: 'ge',
  VP: 'visual',
  VA: 'visual',
  CG: 'visual',
  MB: 'music',
  MA: 'music',
  MP: 'music',
};
