import type { SVGProps } from 'react';

export const CircleIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
};
