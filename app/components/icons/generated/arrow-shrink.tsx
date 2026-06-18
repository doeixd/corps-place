import type { SVGProps } from 'react';

export const ArrowShrinkIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M14.23 17.995c-.01-.75-.526-3.234 0-3.76c.527-.527 3.01-.01 3.76 0M21 20.999l-6.385-6.383M9.77 17.994c.01-.75.525-3.233-.001-3.76c-.527-.526-3.01-.01-3.76.001M3 20.998l6.386-6.384M6.007 9.761c.75.01 3.234.522 3.76-.005s.006-3.01-.006-3.76m-.384 3.371L3.002 3.002m14.99 6.759c-.75.01-3.234.522-3.76-.005s-.006-3.01.006-3.76m.384 3.371l6.375-6.365"/>
    </svg>
  );
};
