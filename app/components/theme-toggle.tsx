import { useSelector } from '@xstate/react';
import { themeStore } from '@/stores/theme-store';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Moon02Icon, Sun01Icon } from '@/components/icons/generated';

/** Light/dark theme switch. Dumb component: reads the store, sends `toggle`. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  const isDark = theme === 'dark';

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      onClick={() => themeStore.send({ type: 'toggle' })}
      className={className}
    >
      <Icon icon={isDark ? Sun01Icon : Moon02Icon} size="sm" />
    </Button>
  );
}
