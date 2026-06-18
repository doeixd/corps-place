import { useEffect, useState } from 'react';

/**
 * Returns `true` only after `active` has held for `delayMs`. Used to defer
 * showing a spinner so fast operations don't flash one (and resets instantly
 * when the operation finishes).
 */
export function useDelayedFlag(active: boolean, delayMs = 250): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return shown;
}
