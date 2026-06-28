import type { SVGProps } from 'react';

export const ArrowLeft03Icon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"><path d="M4 6v12"/><path strokeLinejoin="round" d="M8 12h12m-8-4s-4 2.946-4 4s4 4 4 4"/></g>
    </svg>
  );
};
