import { useEffect, useRef, useState } from 'react';

/**
 * Sticky score columns are only `position: sticky` (and thus on a text-blurring
 * compositing layer) while the table is scrolled horizontally. This returns a
 * handler to wire to the scroll container's wheel/touch/scroll events: it marks
 * the element `data-scrolled` on scroll *intent* and clears it shortly after the
 * table settles back at the left edge (where static and sticky positions
 * coincide, so the swap is invisible). The timer is cleaned up on unmount.
 */
export function useStickyScroll(idleMs = 250): (el: HTMLElement) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return (el: HTMLElement) => {
    el.setAttribute('data-scrolled', '');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (el.scrollLeft === 0) el.removeAttribute('data-scrolled');
    }, idleMs);
  };
}

/**
 * Returns `false` for the single render where `trigger` changes, then `true`
 * again on the next frame. Used to suppress Motion's `layout` animation for the
 * one render where toggling Ranges↔Scores resizes columns (which would animate a
 * horizontal shift / fight the scroll position), while keeping it on for genuine
 * row reorders.
 */
export function useSuppressLayoutOnce(trigger: unknown): boolean {
  const [animate, setAnimate] = useState(true);
  const prev = useRef(trigger);
  if (prev.current !== trigger) {
    prev.current = trigger;
    if (animate) setAnimate(false);
  }
  useEffect(() => {
    if (animate) return;
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [animate]);
  return animate;
}
