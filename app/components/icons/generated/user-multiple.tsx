import type { SVGProps } from 'react';

export const UserMultipleIcon = (
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
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <path d="M13 11a4 4 0 1 0-8 0a4 4 0 0 0 8 0" />
        <path d="M11.039 7.558a4 4 0 1 1 1.923 2.885M15 21a6 6 0 0 0-12 0" />
        <path d="M21 17a6 6 0 0 0-6-6" />
      </g>
    </svg>
  );
};
