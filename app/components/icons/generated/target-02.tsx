import type { SVGProps } from 'react';

export const Target02Icon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5">
        <path d="M17 12a5 5 0 1 1-5-5" />
        <path d="M14 2.2q-.97-.198-2-.2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10q-.002-1.03-.2-2" />
        <path
          strokeLinejoin="round"
          d="m12.03 11.963l4.553-4.553m3.157-3.065l-.553-1.988a.48.48 0 0 0-.761-.24c-1.436 1.173-3 2.754-1.723 5.247c2.574 1.2 4.044-.418 5.17-1.779a.486.486 0 0 0-.248-.775z"
        />
      </g>
    </svg>
  );
};
