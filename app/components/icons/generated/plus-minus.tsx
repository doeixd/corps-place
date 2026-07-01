import type { SVGProps } from 'react';

export const PlusMinusIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M11 16c0 1.87 0 2.804.402 3.5a3 3 0 0 0 1.098 1.098C13.196 21 14.13 21 16 21s2.804 0 3.5-.402a3 3 0 0 0 1.098-1.098C21 18.804 21 17.87 21 16s0-2.804-.402-3.5a3 3 0 0 0-1.098-1.098C18.804 11 17.87 11 16 11"/><path strokeLinejoin="round" d="M8 3c1.87 0 2.804 0 3.5.402A3 3 0 0 1 12.598 4.5C13 5.196 13 6.13 13 8s0 2.804-.402 3.5a3 3 0 0 1-1.098 1.098C10.804 13 9.87 13 8 13c-1.869 0-2.804 0-3.5-.402A3 3 0 0 1 3.402 11.5C3 10.804 3 9.87 3 8s0-2.804.402-3.5A3 3 0 0 1 4.5 3.402C5.196 3 6.131 3 8 3Z"/><path strokeLinecap="round" d="M8 6v4m2-2H6m12 8h-4"/></g>
    </svg>
  );
};
