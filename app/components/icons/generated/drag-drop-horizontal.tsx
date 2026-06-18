import type { SVGProps } from 'react';

export const DragDropHorizontalIcon = (
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
        d="M6 8a1 1 0 1 1 0 2a1 1 0 0 1 0-2m0 6a1 1 0 1 1 0 2a1 1 0 0 1 0-2m12-6a1 1 0 1 1 0 2a1 1 0 0 1 0-2m-6 0a1 1 0 1 1 0 2a1 1 0 0 1 0-2m6 6a1 1 0 1 1 0 2a1 1 0 0 1 0-2m-6 0a1 1 0 1 1 0 2a1 1 0 0 1 0-2"
      />
    </svg>
  );
};
