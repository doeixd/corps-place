import { createContext, useContext, type ReactNode } from 'react';
import type { Brand } from './brand';

/**
 * Single source of truth for the active brand. Resolved ONCE in the root route
 * loader (`readBrand()` → loaderData), provided here, and read everywhere via
 * `useBrand()`. Components must not call `readBrand()` themselves — doing so
 * re-detects per component and can disagree with the root (e.g. the corps nav
 * flashing back on the jobs site). The value comes from SSR loaderData, so it is
 * identical on the server and after hydration.
 */
const BrandContext = createContext<Brand>('corps');

export function BrandProvider({ brand, children }: { brand: Brand; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
