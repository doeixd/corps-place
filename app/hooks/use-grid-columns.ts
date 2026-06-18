import { useEffect, useState } from 'react';

// Tailwind's default breakpoint min-widths (px).
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;
type Breakpoint = keyof typeof BREAKPOINTS;

/**
 * Reports the active column count for the responsive card grids, which go
 * `grid-cols-1 {two}:grid-cols-2 {three}:grid-cols-3`. Drives row-aware stagger
 * delays so cards cascade in visual order regardless of viewport (a hardcoded
 * `i % 3` makes every card on a 1-column phone share delay 0 and pop in
 * together).
 *
 * Pass the breakpoints the grid actually uses — corps uses `sm`/`lg`, the event
 * grid uses `md`/`lg`. SSR starts at 1 column to match the mobile-first markup.
 */
export function useGridColumns(twoColAt: Breakpoint = 'sm', threeColAt: Breakpoint = 'lg'): number {
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const two = window.matchMedia(`(min-width: ${BREAKPOINTS[twoColAt]}px)`);
    const three = window.matchMedia(`(min-width: ${BREAKPOINTS[threeColAt]}px)`);
    const update = () => setColumns(three.matches ? 3 : two.matches ? 2 : 1);
    update();
    two.addEventListener('change', update);
    three.addEventListener('change', update);
    return () => {
      two.removeEventListener('change', update);
      three.removeEventListener('change', update);
    };
  }, [twoColAt, threeColAt]);

  return columns;
}
