import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Defers mounting a heavy, below-the-fold subtree until it scrolls within
 * `rootMargin` of the viewport — so its React work (and any child component JS)
 * stays off the initial render/paint, helping INP on long pages.
 *
 * Renders nothing on the server / before intersection (reserving `minHeight` so the
 * scrollbar stays stable), then mounts `children` once and never unmounts.
 */
export function LazyMount({
  children,
  rootMargin = '600px 0px',
  minHeight = 200,
  className,
  placeholder,
}: {
  children: ReactNode;
  rootMargin?: string;
  /** Reserved space (px) before mount, so layout doesn't jump. */
  minHeight?: number;
  className?: string;
  /** Shown before mount; defaults to a subtle skeleton filling the reserved space. */
  placeholder?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, rootMargin]);

  return (
    <div ref={ref} className={className} style={inView ? undefined : { minHeight }}>
      {inView
        ? children
        : (placeholder ?? (
            <div
              className="h-full animate-pulse rounded-xl bg-muted/30"
              style={{ minHeight }}
              aria-hidden
            />
          ))}
    </div>
  );
}
