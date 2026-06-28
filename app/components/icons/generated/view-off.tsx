import type { SVGProps } from 'react';

export const ViewOffIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"><path d="M22 8s-4 6-10 6S2 8 2 8"/><path strokeLinejoin="round" d="m15 13.5l1.5 2.5m3.5-5l2 2M2 13l2-2m5 2.5L7.5 16"/></g>
    </svg>
  );
};
