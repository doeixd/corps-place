import type { SVGProps } from 'react';

export const ArrowExpandIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 3.098s-3.966-.356-4.612.29S3.098 8 3.098 8M8 20.902s-3.966.356-4.612-.29S3.098 16 3.098 16M16 3.098s3.966-.356 4.612.29s.29 4.612.29 4.612M16 20.902s3.966.356 4.612-.29s.29-4.612.29-4.612M14.01 9.998l6.053-6.051M9.997 14.002L3.64 20.381m6.357-10.379L3.846 3.86M13.98 14.002l6.548 6.496"/>
    </svg>
  );
};
