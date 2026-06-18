import type { SVGProps } from 'react';

/**
 * Inlined Hugeicons "Dices" glyph.
 *
 * Not present in `@iconify-json/hugeicons` (the set `~icons` pulls from), so we
 * render the SVG directly. The viewBox / stroke match the other Hugeicons, so it
 * works with the `<Icon>` wrapper (inherits size + `currentColor`).
 */
export function DicesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.17412 19.9742C1.5 18.9653 1.5 17.5609 1.5 14.752C1.5 11.943 1.5 10.5386 2.17412 9.52967C2.46596 9.09291 2.84096 8.71791 3.27772 8.42607C4.28661 7.75195 5.69108 7.75195 8.5 7.75195C11.3089 7.75195 12.7134 7.75195 13.7223 8.42607C14.159 8.71791 14.534 9.09291 14.8259 9.52967C15.5 10.5386 15.5 11.943 15.5 14.752C15.5 17.5609 15.5 18.9653 14.8259 19.9742C14.534 20.411 14.159 20.786 13.7223 21.0778C12.7134 21.752 11.3089 21.752 8.5 21.752C5.69108 21.752 4.28661 21.752 3.27772 21.0778C2.84096 20.786 2.46596 20.411 2.17412 19.9742Z" />
      <path d="M18.7488 13.752C19.7285 12.7137 20.2601 11.9852 20.4241 11.161C20.5253 10.6523 20.5253 10.1287 20.4241 9.61997C20.1903 8.44493 19.2094 7.46437 17.2476 5.50325C15.2858 3.54213 14.3048 2.56157 13.1294 2.32784C12.6205 2.22666 12.0967 2.22666 11.5878 2.32784C10.7644 2.49157 10.0365 3.02176 9 3.99875" />
      {/* Pips — enlarged slightly from the original r≈0.5 outline dots. */}
      <circle cx="6" cy="12.252" r="0.75" />
      <circle cx="11" cy="17.252" r="0.75" />
    </svg>
  );
}
