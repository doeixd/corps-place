import type { SVGProps } from 'react';

export const Loading03Icon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
        strokeWidth="1.5"
        d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.364-6.363l-2.122 2.121m-8.484 8.484l-2.121 2.121m12.727.001l-2.122-2.122M7.758 7.758L5.637 5.637"
      />
    </svg>
  );
};
