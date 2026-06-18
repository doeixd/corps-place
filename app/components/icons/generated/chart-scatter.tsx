import type { SVGProps } from 'react';

export const ChartScatterIcon = (
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
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <path d="M12.75 10.5h-.25m.5 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m1.75-6h-.25m.5 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m3.75 7h-.25m.5 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m-9.25 5H9.5m.5 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0m-2.25-8H7.5m.5 0a.5.5 0 1 1-1 0a.5.5 0 0 1 1 0" />
        <path d="M21 21H10c-3.3 0-4.95 0-5.975-1.025S3 17.3 3 14V3" />
      </g>
    </svg>
  );
};
