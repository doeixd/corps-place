import type { SVGProps } from 'react';

export const Megaphone01Icon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M14.926 2.911L8.274 6.105a2.43 2.43 0 0 1-1.617.182a8 8 0 0 0-.695-.14C4.137 5.94 3 7.384 3 9.045v.912c0 1.66 1.137 3.105 2.962 2.896a7 7 0 0 0 .695-.139a2.43 2.43 0 0 1 1.617.183l6.652 3.193c1.527.733 2.291 1.1 3.142.814c.852-.286 1.144-.899 1.728-2.125a12.17 12.17 0 0 0 0-10.556c-.584-1.226-.876-1.84-1.728-2.125c-.851-.286-1.615.08-3.142.814"/><path d="M11.458 20.77L9.967 22c-3.362-2.666-2.951-3.937-2.951-9H8.15c.46 2.86 1.545 4.216 3.043 5.197c.922.604 1.112 1.876.265 2.574M7.5 12.5v-6"/></g>
    </svg>
  );
};
