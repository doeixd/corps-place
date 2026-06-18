import type { SVGProps } from 'react';

export const MusicNote03Icon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6.5" cy="18.5" r="3.5"/><circle cx="18" cy="16" r="3"/><path strokeLinecap="round" strokeLinejoin="round" d="M10 18.5V7c0-.923 0-1.385.264-1.672c.263-.287.754-.329 1.735-.413c4.023-.343 6.91-1.655 8.356-2.505c.296-.174.444-.26.544-.203s.101.225.101.559V16"/><path strokeLinecap="round" strokeLinejoin="round" d="M10 10c5.867 0 9.778-2.333 11-3"/></g>
    </svg>
  );
};
