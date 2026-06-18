import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Coerce a decoded search-param value to a non-empty string, or undefined.
 * Search values are typed `unknown` and numeric/boolean-looking ones decode as
 * number/boolean — this normalizes those primitives without stringifying objects.
 */
export function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
