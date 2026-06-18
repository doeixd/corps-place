import type { SVGProps } from 'react';

export const SentIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
        <path d="M21.048 3.053C18.87.707 2.486 6.453 2.5 8.55c.015 2.379 6.398 3.11 8.167 3.607c1.064.299 1.349.604 1.594 1.72c1.111 5.052 1.67 7.566 2.94 7.622c2.027.09 7.972-16.158 5.847-18.447Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 12.5L15 9" />
      </g>
    </svg>
  );
};
