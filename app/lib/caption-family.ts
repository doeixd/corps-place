// Maps a DCI caption name to one of the three scoring families (General Effect,
// Visual, Music) so the UI can color/group captions consistently. Caption names
// in the data are clean and prefixed by family ("General Effect 1", "Visual -
// Analysis", "Music - Brass", "Color Guard", "Visual Proficiency").

import { ViewIcon, MusicNote03Icon, Sun01Icon } from '@/components/icons/generated';

export type CaptionFamily = 'ge' | 'visual' | 'music';

export type CaptionFamilyMeta = {
  family: CaptionFamily;
  label: string;
  icon: typeof ViewIcon;
  /** Display order: GE, then Visual, then Music (recap convention). */
  order: number;
  /** Static Tailwind classes (arbitrary vars — the default palette is wiped). */
  chipClass: string;
  /** Just the text/icon color, for inline use (e.g. table cells). */
  textClass: string;
  /** A raw CSS color string (the saturated `-fg` hue) for non-Tailwind
   *  consumers like recharts `<Cell fill>`, where a class won't work. */
  swatchVar: string;
};

type FamilyBase = {
  family: CaptionFamily;
  label: string;
  icon: typeof ViewIcon;
  order: number;
  /** Fallback vars used when the specific subcaption isn't recognized. */
  fallbackVar: string;
};

const FAMILY: Record<CaptionFamily, FamilyBase> = {
  ge: {
    family: 'ge',
    label: 'General Effect',
    icon: Sun01Icon,
    order: 0,
    fallbackVar: 'caption-ge',
  },
  visual: {
    family: 'visual',
    label: 'Visual',
    icon: ViewIcon,
    order: 1,
    fallbackVar: 'caption-visual',
  },
  music: {
    family: 'music',
    label: 'Music',
    icon: MusicNote03Icon,
    order: 2,
    fallbackVar: 'caption-music',
  },
};

/** Classify a caption name into its family (keyword-based, case-insensitive). */
export function captionFamily(caption: string): CaptionFamily {
  const c = caption.toLowerCase();
  if (c.includes('general effect') || /\bge\b/.test(c)) return 'ge';
  if (c.includes('visual') || c.includes('color guard') || c.includes('guard')) return 'visual';
  if (c.includes('music') || c.includes('brass') || c.includes('percussion')) return 'music';
  // Default unknown captions to GE (the catch-all "effect" bucket).
  return 'ge';
}

// Color classes per variant. Kept as *literal* strings (not template-built) so
// Tailwind's static scanner emits the arbitrary `bg-[var(--…)]` utilities.
type ChipColors = { chipClass: string; textClass: string };

const COLORS = {
  'cap-ge1': {
    chipClass: 'bg-[var(--cap-ge1-bg)] text-[var(--cap-ge1-fg)]',
    textClass: 'text-[var(--cap-ge1-fg)]',
  },
  'cap-ge2': {
    chipClass: 'bg-[var(--cap-ge2-bg)] text-[var(--cap-ge2-fg)]',
    textClass: 'text-[var(--cap-ge2-fg)]',
  },
  'cap-visual-analysis': {
    chipClass: 'bg-[var(--cap-visual-analysis-bg)] text-[var(--cap-visual-analysis-fg)]',
    textClass: 'text-[var(--cap-visual-analysis-fg)]',
  },
  'cap-visual-proficiency': {
    chipClass: 'bg-[var(--cap-visual-proficiency-bg)] text-[var(--cap-visual-proficiency-fg)]',
    textClass: 'text-[var(--cap-visual-proficiency-fg)]',
  },
  'cap-color-guard': {
    chipClass: 'bg-[var(--cap-color-guard-bg)] text-[var(--cap-color-guard-fg)]',
    textClass: 'text-[var(--cap-color-guard-fg)]',
  },
  'cap-music-analysis': {
    chipClass: 'bg-[var(--cap-music-analysis-bg)] text-[var(--cap-music-analysis-fg)]',
    textClass: 'text-[var(--cap-music-analysis-fg)]',
  },
  'cap-music-brass': {
    chipClass: 'bg-[var(--cap-music-brass-bg)] text-[var(--cap-music-brass-fg)]',
    textClass: 'text-[var(--cap-music-brass-fg)]',
  },
  'cap-music-percussion': {
    chipClass: 'bg-[var(--cap-music-percussion-bg)] text-[var(--cap-music-percussion-fg)]',
    textClass: 'text-[var(--cap-music-percussion-fg)]',
  },
  // Family fallbacks for unrecognized captions.
  'caption-ge': {
    chipClass: 'bg-[var(--caption-ge-bg)] text-[var(--caption-ge-fg)]',
    textClass: 'text-[var(--caption-ge-fg)]',
  },
  'caption-visual': {
    chipClass: 'bg-[var(--caption-visual-bg)] text-[var(--caption-visual-fg)]',
    textClass: 'text-[var(--caption-visual-fg)]',
  },
  'caption-music': {
    chipClass: 'bg-[var(--caption-music-bg)] text-[var(--caption-music-fg)]',
    textClass: 'text-[var(--caption-music-fg)]',
  },
} satisfies Record<string, ChipColors>;

type ColorKey = keyof typeof COLORS;

// Each known subcaption maps to its own color key (distinct hue within family).
// Unknown captions fall back to the family key. Keyword-based to tolerate minor
// name variations.
const SUBCAPTION_VARS: { match: (c: string) => boolean; key: ColorKey }[] = [
  { match: (c) => c.includes('general effect') && c.includes('2'), key: 'cap-ge2' },
  { match: (c) => c.includes('general effect'), key: 'cap-ge1' },
  {
    match: (c) => c.includes('color guard') || (c.includes('guard') && !c.includes('visual')),
    key: 'cap-color-guard',
  },
  { match: (c) => c.includes('visual') && c.includes('proficien'), key: 'cap-visual-proficiency' },
  { match: (c) => c.includes('visual'), key: 'cap-visual-analysis' },
  { match: (c) => c.includes('brass'), key: 'cap-music-brass' },
  { match: (c) => c.includes('percussion'), key: 'cap-music-percussion' },
  { match: (c) => c.includes('music'), key: 'cap-music-analysis' },
];

const colorKey = (caption: string, family: CaptionFamily): ColorKey => {
  const c = caption.toLowerCase();
  return SUBCAPTION_VARS.find((s) => s.match(c))?.key ?? (FAMILY[family].fallbackVar as ColorKey);
};

export const captionFamilyMeta = (caption: string): CaptionFamilyMeta => {
  const family = captionFamily(caption);
  const base = FAMILY[family];
  const key = colorKey(caption, family);
  const colors = COLORS[key];
  return {
    family,
    label: base.label,
    icon: base.icon,
    order: base.order,
    chipClass: colors.chipClass,
    textClass: colors.textClass,
    // Every color key has a matching `--<key>-solid` CSS var (vivid fill hue).
    swatchVar: `var(--${key}-solid)`,
  };
};

/** Raw CSS color string for a caption's saturated hue — for recharts etc. */
export const captionSwatchVar = (caption: string): string => captionFamilyMeta(caption).swatchVar;

/** Sort comparator: order captions GE → Visual → Music, then alphabetically. */
export const byCaptionFamily = (a: string, b: string): number =>
  captionFamilyMeta(a).order - captionFamilyMeta(b).order || a.localeCompare(b);
