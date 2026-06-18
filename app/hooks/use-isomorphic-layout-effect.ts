import { useEffect, useLayoutEffect } from 'react';

/**
 * `useLayoutEffect` on the client, `useEffect` on the server. React warns when
 * `useLayoutEffect` runs during SSR (it can't run layout effects on the server);
 * this picks the right one so layout-reading effects (e.g. positioning a scroll
 * container before paint) stay warning-free in our SSR routes.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;
