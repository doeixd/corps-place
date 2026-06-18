import { cn } from '@/lib/utils';
import type { ComponentType, SVGProps } from 'react';

/**
 * Standardized icon wrapper.
 *
 * Icons are real SVG React components generated from the Iconify Hugeicons collection
 * into `app/components/icons/generated`.
 * This wrapper centralizes sizing (token scale `sm`/`md`/`lg`/`xl`) and color
 * inheritance so call sites never hardcode dimensions. Color is inherited from
 * the surrounding text color (`currentColor`) by default — pass Tailwind text
 * utilities to recolor (e.g. `className="text-primary"`). Stroke width is baked
 * into the generated Hugeicons SVGs (1.5).
 */
type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<IconSize, string> = {
  xs: 'size-3', // 0.75rem
  sm: 'size-4', // 1rem
  md: 'size-5', // 1.25rem
  lg: 'size-6', // 1.5rem
  xl: 'size-8', // 2rem
};

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  icon: IconComponent;
  size?: IconSize;
};

export function Icon({ icon: IconComp, size = 'md', className, ...props }: IconProps) {
  return <IconComp className={cn(SIZE_CLASS[size], 'shrink-0', className)} {...props} />;
}
