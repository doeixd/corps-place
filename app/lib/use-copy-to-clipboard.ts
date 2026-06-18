import { useEffect, useRef, useState } from 'react';

/**
 * Copy text to the clipboard with transient "copied" feedback: `copied` flips
 * true on success and resets after `resetMs`. SSR-safe (no-op without a
 * clipboard) and the reset timer is cleaned up on unmount.
 */
export function useCopyToClipboard(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = (text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      },
      () => {}
    );
  };
  return { copied, copy };
}
