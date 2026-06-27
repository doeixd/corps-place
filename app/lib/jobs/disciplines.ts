export const DISCIPLINES = [
  { value: 'drum-corps', label: 'Drum corps' },
  { value: 'marching-band', label: 'Marching band' },
  { value: 'winter-guard', label: 'Winter guard' },
  { value: 'color-guard', label: 'Color guard' },
  { value: 'indoor-percussion', label: 'Indoor percussion' },
  { value: 'concert', label: 'Concert / wind ensemble' },
  { value: 'other', label: 'Other' },
] as const;
export type DisciplineValue = (typeof DISCIPLINES)[number]['value'];
export const DISCIPLINE_LABEL: Record<string, string> = Object.fromEntries(
  DISCIPLINES.map((d) => [d.value, d.label])
);
