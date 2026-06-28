import type { SVGProps } from 'react';

export const GroupItemsIcon = (props: SVGProps<SVGSVGElement> & { size?: 'sm' | 'md' | 'lg' }) => {
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
      <g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 4a2 2 0 1 1-4 0a2 2 0 0 1 4 0Zm16 0a2 2 0 1 1-4 0a2 2 0 0 1 4 0Zm0 16a2 2 0 1 1-4 0a2 2 0 0 1 4 0ZM6 20a2 2 0 1 1-4 0a2 2 0 0 1 4 0Z"/><path strokeLinecap="round" strokeLinejoin="round" d="M20 6v12m-2 2H6M18 4H6M4 6v12m12.5-9c0-.466 0-.699-.076-.883a1 1 0 0 0-.541-.54C15.699 7.5 15.466 7.5 15 7.5H9c-.466 0-.699 0-.883.076a1 1 0 0 0-.54.541C7.5 8.301 7.5 8.534 7.5 9s0 .699.076.883a1 1 0 0 0 .541.54c.184.077.417.077.883.077h6c.466 0 .699 0 .883-.076a1 1 0 0 0 .54-.541c.077-.184.077-.417.077-.883m0 6c0-.466 0-.699-.076-.883a1 1 0 0 0-.541-.54c-.184-.077-.417-.077-.883-.077H9c-.466 0-.699 0-.883.076a1 1 0 0 0-.54.541c-.077.184-.077.417-.077.883s0 .699.076.883a1 1 0 0 0 .541.54c.184.077.417.077.883.077h6c.466 0 .699 0 .883-.076a1 1 0 0 0 .54-.541c.077-.184.077-.417.077-.883"/></g>
    </svg>
  );
};
