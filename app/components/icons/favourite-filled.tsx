import type { SVGProps } from 'react';

// Hand-maintained filled heart. Lives outside `generated/` so the icon
// preloader (which hardcodes `fill="none"` stroke icons) never clobbers it.
export const FavouriteIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
  const size = props.size === 'sm' ? 16 : props.size === 'lg' ? 24 : 20;
  const { size: _size, ...svgProps } = props;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...svgProps}
    >
      {/* Path data lives once in CustomIconSprite (custom-sprite.tsx). */}
      <use href="#cp-favourite-filled" />
    </svg>
  );
};
