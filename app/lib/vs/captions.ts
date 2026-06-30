// VS caption taxonomy — the score dimension the whole comparison is scoped to
// (Total + 3 categories + 8 sub-captions). Mirrors the rankings metric list and
// the SDK's VS_CAPTION_KEYS. Client-safe (pure data). The keys match the read-
// model columns and the VsCaptionValues fields the resolver reads.

export const VS_CAPTIONS = [
  'total', 'ge', 'visual', 'music',
  'ge1', 'ge2', 'vp', 'va', 'cg', 'mb', 'ma', 'mp',
] as const;
export type VsCaption = (typeof VS_CAPTIONS)[number];

/** Pill / axis labels (friendly, rankings-style — not raw sheet names). */
export const VS_CAPTION_LABELS: Record<VsCaption, string> = {
  total: 'Total',
  ge: 'General Effect',
  visual: 'Visual',
  music: 'Music',
  ge1: 'GE 1',
  ge2: 'GE 2',
  vp: 'Visual Prof.',
  va: 'Visual Analysis',
  cg: 'Color Guard',
  mb: 'Brass',
  ma: 'Music Analysis',
  mp: 'Percussion',
};

/** Headline captions (Total + the 3 categories) — rendered first / emphasized. */
export const VS_CAPTION_HEADLINE: readonly VsCaption[] = ['total', 'ge', 'visual', 'music'];

/** Valid caption from a URL/search value, else `undefined` (→ default `total`). */
export const parseCaption = (v: unknown): VsCaption | undefined =>
  VS_CAPTIONS.includes(v as VsCaption) ? (v as VsCaption) : undefined;
