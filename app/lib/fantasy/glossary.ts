/**
 * Plain-language definitions for the DCI / fantasy jargon scattered across the UI
 * (caption codes, "seeding", "recap", divisions). Surfaced via the <Explain>
 * primitive so a newcomer who's never heard of drum corps can hover/tap any term
 * (UI/UX plan §3, UX audit P0).
 */
export interface GlossaryEntry {
  label: string;
  description: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  // The eight judged captions (a corps' score is the sum across these).
  GE1: {
    label: 'General Effect 1',
    description: 'One of two general-effect judges — overall impact of the show.',
  },
  GE2: { label: 'General Effect 2', description: 'The second general-effect judge.' },
  VP: {
    label: 'Visual Proficiency',
    description: 'How cleanly the corps executes its drill and movement.',
  },
  VA: { label: 'Visual Analysis', description: 'The design and content of the visual program.' },
  CG: { label: 'Color Guard', description: 'The flags, rifles, and dance of the guard.' },
  MB: { label: 'Music Brass', description: 'The brass line — tone, technique, musicianship.' },
  MA: { label: 'Music Analysis', description: 'The design and content of the musical program.' },
  MP: { label: 'Music Percussion', description: 'The drumline and front ensemble (pit).' },

  // Concepts.
  seeding: {
    label: 'Draft seeding',
    description: 'Your draft order. Your quiz score sets it — higher scores pick earlier.',
  },
  recap: {
    label: 'Recap',
    description: "A competition's official caption-by-caption scores, published after the show.",
  },
  'world-class': {
    label: 'World Class',
    description: "DCI's top division — the corps you've seen on TV.",
  },
  'open-class': {
    label: 'Open Class',
    description: "DCI's second division, often smaller or regional corps.",
  },
  caption: {
    label: 'Caption',
    description: 'A judged category. You draft one corps per caption to build your lineup.',
  },
};
