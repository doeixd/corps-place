import type { SVGProps } from 'react';
/**
 * The Corps Place logo — a drum-major figure that adapts its color palette
 * via CSS custom properties. These properties are derived from --primary
 * (set by the favorite corps store) using relative OKLCH syntax, so when a
 * user favorites a corps the entire logo shifts to that corps's brand hues
 * — adjusting only lightness and chroma, keeping the chosen hue.
 */
export function Logo(props: SVGProps<SVGSVGElement>) {
  // The artwork lives in /public/logo-mark.svg (fills are var(--logo-*) with the
  // brand defaults, so the favorite-corps recoloring still applies — CSS custom
  // properties cascade into <use> shadow content). Referencing it externally
  // keeps the ~34KB of path data out of the JS bundle AND out of every SSR'd
  // page; the browser caches it once. Version-bump the query alongside
  // APP_ICON_VERSION when the artwork changes.
  return (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <use href="/logo-mark.svg?v=4#m" />
    </svg>
  );
}
