import type { SVGProps } from 'react';

export const ArrowRight02Icon = (
  props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }
) => {
  const size = props.size === 'sm' ? 16 : props.size === 'lg' ? 24 : 20;
  const { size: _size, ...svgProps } = props;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...svgProps}
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        d="M18.5 12H5m8 6s6-4.419 6-6s-6-6-6-6"
      />
    </svg>
  );
};
