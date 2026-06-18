import type { SVGProps } from 'react';

export const CheckmarkCircle02Icon = (
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
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12s4.477 10 10 10s10-4.477 10-10Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m8 12.5l2.5 2.5L16 9" />
      </g>
    </svg>
  );
};
