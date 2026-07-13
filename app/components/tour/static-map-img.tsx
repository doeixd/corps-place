// Static LQIP tour map: an <img> pointing at /api/tour-map, rendered in the
// SSR HTML (and until the interactive geometry chunk resolves) exactly where
// the interactive SVG will mount — same 975/610 aspect box, so no layout
// shift. Theme is handled by rendering both variants and letting the `dark`
// class pick one (the SVG is an image; Tailwind tokens can't reach inside it).
import { VIEW_W, VIEW_H } from './geometry';

export interface StaticTourMapImgProps {
  season: string;
  /** Focused corps slugs (initial loader state only — this is a placeholder). */
  corps?: readonly string[] | null;
  className?: string;
}

export function StaticTourMapImg({ season, corps, className }: StaticTourMapImgProps) {
  const qs = new URLSearchParams({ season });
  if (corps?.length) qs.set('corps', corps.join(','));
  const base = `/api/tour-map?${qs.toString()}`;
  const alt = `${season} DCI tour map`;
  return (
    <div className={className ?? 'w-full'} style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
      <img
        src={`${base}&theme=light`}
        alt={alt}
        width={VIEW_W}
        height={VIEW_H}
        decoding="async"
        className="h-full w-full dark:hidden"
      />
      <img
        src={`${base}&theme=dark`}
        alt={alt}
        width={VIEW_W}
        height={VIEW_H}
        decoding="async"
        className="hidden h-full w-full dark:block"
      />
    </div>
  );
}
