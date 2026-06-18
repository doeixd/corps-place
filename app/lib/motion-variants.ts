import type { Variants } from 'motion/react';

/**
 * Shared Motion animation variants. Keep all reusable enter/exit/stagger
 * choreography here so pages stay declarative. Durations/eases align with the
 * design-token transition scale in `app.css`.
 */

export const fadeIn: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: [0.34, 1.56, 0.64, 1] } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.15 } },
};

/** Parent container that staggers its children's `fadeIn`/`scaleIn` entrances. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
  exit: {},
};

/** A single child within a `staggerContainer`. */
export const staggerItem: Variants = fadeIn;
