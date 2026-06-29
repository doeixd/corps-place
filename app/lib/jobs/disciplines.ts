// PageantryJobs covers the whole pageantry / performing-arts world, not just the
// marching arts. Existing values are append-only (postings reference them) — add
// new ones, never rename/remove. Marching arts first (the founding niche), then
// the broader performance + competition disciplines.
export const DISCIPLINES = [
  // Marching arts
  { value: 'drum-corps', label: 'Drum corps' },
  { value: 'marching-band', label: 'Marching band' },
  { value: 'winter-guard', label: 'Winter guard' },
  { value: 'color-guard', label: 'Color guard' },
  { value: 'indoor-percussion', label: 'Indoor percussion' },
  { value: 'concert', label: 'Concert / wind ensemble' },
  { value: 'baton-twirling', label: 'Baton twirling' },
  { value: 'drumline', label: 'Drumline' },
  // Pageantry & modeling
  { value: 'pageants', label: 'Pageants' },
  { value: 'modeling', label: 'Modeling' },
  { value: 'beauty', label: 'Beauty & glam (hair / makeup)' },
  // Dance & cheer
  { value: 'dance', label: 'Dance' },
  { value: 'cheer', label: 'Cheer & stunt' },
  { value: 'gymnastics', label: 'Gymnastics' },
  { value: 'figure-skating', label: 'Figure skating' },
  // Physique & fitness
  { value: 'bodybuilding', label: 'Bodybuilding & physique' },
  { value: 'fitness', label: 'Fitness & competition' },
  // Equestrian & animal
  { value: 'equestrian', label: 'Equestrian / horse showing' },
  { value: 'dog-showing', label: 'Dog & animal showing' },
  // Stage & screen
  { value: 'theater', label: 'Theater & musical theater' },
  { value: 'music', label: 'Music & vocal' },
  { value: 'circus', label: 'Circus & variety arts' },
  { value: 'production', label: 'Production / stage & event crew' },
  { value: 'judging', label: 'Judging & adjudication' },
  { value: 'other', label: 'Other' },
] as const;
export type DisciplineValue = (typeof DISCIPLINES)[number]['value'];
export const DISCIPLINE_LABEL: Record<string, string> = Object.fromEntries(
  DISCIPLINES.map((d) => [d.value, d.label])
);
