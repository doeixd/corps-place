import { useEffect, useState } from 'react';
import { useSelector } from '@xstate/react';
import { themeStore } from '@/stores/theme-store';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Moon02Icon, Sun01Icon } from '@/components/icons/generated';
import { track } from '@/lib/analytics/client';

/**
 * Light/dark theme switch. Dumb component: reads the store, sends `toggle`.
 *
 * `ssrTheme` (the server-resolved cookie theme) drives the FIRST client render:
 * with no cookie, the no-FOUC script resolves the OS preference before
 * hydration, so the store's theme can differ from what the server rendered.
 * That mismatch reached the ICON's <path d> (suppressHydrationWarning only
 * covers the element it sits on), threw React #423, and made React recreate
 * the entire tree client-side — resetting scroll positions and re-running
 * every mount. Render the server's value until mounted, then swap to the live
 * store (a post-hydration icon swap is a normal update, not a mismatch).
 */
export function ThemeToggle({ className, ssrTheme }: { className?: string; ssrTheme?: string }) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const shown = mounted ? theme : (ssrTheme ?? 'light');
  const isDark = shown === 'dark';

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      onClick={() => {
        track('theme_toggle', { to: isDark ? 'light' : 'dark' });
        themeStore.send({ type: 'toggle' });
      }}
      className={className}
    >
      <Icon icon={isDark ? Sun01Icon : Moon02Icon} size="sm" />
    </Button>
  );
}
