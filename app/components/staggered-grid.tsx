import type { ReactNode, RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { useGridColumns } from '@/hooks/use-grid-columns';
import { useIsBackNavigation } from '@/hooks/use-back-navigation';

/**
 * The responsive grid layouts our card lists use. Each entry couples the literal
 * Tailwind column classes (so Tailwind's scanner sees them) with the breakpoints
 * {@link useGridColumns} watches — keeping the two from drifting apart.
 */
const GRID_VARIANTS = {
  'sm-lg': { cols: 'sm:grid-cols-2 lg:grid-cols-3', two: 'sm', three: 'lg' },
  'md-lg': { cols: 'md:grid-cols-2 lg:grid-cols-3', two: 'md', three: 'lg' },
} as const;

const DEFAULT_LAYOUT_ANIMATION_LIMIT = 40;

export function shouldAnimateGridLayout(
  animateLayout: boolean,
  itemCount: number,
  limit = DEFAULT_LAYOUT_ANIMATION_LIMIT
): boolean {
  return animateLayout && itemCount <= limit;
}

export type GridVariant = keyof typeof GRID_VARIANTS;

type StaggeredGridProps<T> = {
  items: readonly T[];
  /** Stable React key per item. */
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Responsive column layout (default `sm-lg`). */
  variant?: GridVariant;
  /** Grid gap utility (default `gap-4`). */
  gap?: string;
  /** Per-step entrance delay in seconds (default 0.11). */
  step?: number;
  /**
   * Enable filter-list choreography: `layout` rearrange of survivors + `exit`
   * fade of removed cards via `AnimatePresence`. Leave off for static lists.
   */
  animateLayout?: boolean;
  /** Disable JS-driven FLIP above this item count (default 40). */
  layoutAnimationLimit?: number;
  /** Change to remount the grid and replay the entrance (e.g. active filter/sort). */
  animationKey?: string;
  /**
   * Key of the card the entrance wave should originate from. For pre-scrolled
   * lists (events aligned to the next upcoming show): without this, every
   * far-index card gets the same clamped max delay, so the first visible rows
   * all wait the full delay and pop in together instead of cascading at once.
   */
  staggerOriginKey?: string | null;
  /**
   * Scrollable ancestor to use as the `whileInView` IntersectionObserver root.
   * Pass this when the grid lives inside an `overflow` container — otherwise the
   * observer watches the browser viewport and cards clipped by the container
   * mis-trigger their entrance. Omit for the normal page-scroll case.
   */
  viewportRoot?: RefObject<Element | null>;
  className?: string;
};

/**
 * Responsive card grid with a row-aware staggered fade-in. Cards animate in via
 * `whileInView`, so cards sharing a viewport need an index-based delay to
 * cascade in order; the delay window follows the *actual* column count, so a
 * 1-column phone gets a small vertical wave instead of every card sharing
 * delay 0 (which makes the first screenful pop in together). The delay is
 * clamped (not cycled) past the first wave so a card lower on the page never
 * animates before one above it; later cards stagger naturally as they scroll
 * into view. Children get
 * `min-w-0` so a long unbroken title can't blow the grid track wider than the
 * viewport.
 */
export function StaggeredGrid<T>({
  items,
  getKey,
  renderItem,
  variant = 'sm-lg',
  gap = 'gap-4',
  step = 0.06,
  animateLayout = false,
  layoutAnimationLimit = DEFAULT_LAYOUT_ANIMATION_LIMIT,
  animationKey,
  staggerOriginKey,
  viewportRoot,
  className,
}: StaggeredGridProps<T>) {
  const v = GRID_VARIANTS[variant];
  const columns = useGridColumns(v.two, v.three);
  const wave = columns === 1 ? 5 : columns;
  // Index the wave counts from — the scroll-target card when given, else the top.
  const originIndex = staggerOriginKey
    ? Math.max(
        0,
        items.findIndex((item) => getKey(item) === staggerOriginKey)
      )
    : 0;
  const layoutEnabled = shouldAnimateGridLayout(animateLayout, items.length, layoutAnimationLimit);
  // When the user arrived here via Back, the page was already seen — render the
  // cards in their final state instead of replaying the staggered entrance.
  const skipEntrance = useIsBackNavigation();

  const cards = items.map((item, i) => (
    <motion.div
      key={getKey(item)}
      data-grid-key={getKey(item)}
      layout={layoutEnabled}
      className="collection-card h-full min-w-0"
      initial={skipEntrance ? false : { opacity: 0, y: 12 }}
      whileInView={
        skipEntrance
          ? undefined
          : {
              opacity: 1,
              y: 0,
              transition: {
                duration: 0.28,
                ease: 'easeOut',
                delay: Math.min(Math.max(i - originIndex, 0), wave - 1) * step,
              },
            }
      }
      viewport={{ once: true, amount: 0.15, root: viewportRoot }}
      exit={layoutEnabled ? { opacity: 0, scale: 0.92 } : undefined}
      transition={{
        duration: 0.2,
        ease: 'easeOut',
        layout: { duration: 0.25, ease: 'easeOut' },
      }}
    >
      {renderItem(item)}
    </motion.div>
  ));

  return (
    <div key={animationKey} className={cn('grid', gap, v.cols, className)}>
      {layoutEnabled ? <AnimatePresence mode="popLayout">{cards}</AnimatePresence> : cards}
    </div>
  );
}
