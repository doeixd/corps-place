import { Icon } from '@/components/icon';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type MouseEvent } from 'react';
import { ArrowLeft02Icon } from '@/components/icons/generated';
import { installHistoryTrail, previousName, previousPathname } from '@/lib/history-trail';
import { cn } from '@/lib/utils';

type RouterHistory = ReturnType<typeof useRouter>['history'];
type SmartState = { back: boolean; name: string | null };

// Flips true after the first BackLink mounts (i.e. once we're past SSR
// hydration). From then on, BackLinks for client-side navigations compute their
// smart-back state synchronously on mount instead of after an effect, so the
// label no longer flickers from the parent fallback to "Back".
let appHydrated = false;

const computeSmart = (history: RouterHistory): SmartState => {
  const previous = previousPathname(history);
  const canBack = Boolean(
    history.canGoBack() && previous && previous !== history.location.pathname
  );
  return { back: canBack, name: canBack ? (previousName(history) ?? null) : null };
};

/**
 * Back control with smart history-back and a deterministic parent fallback.
 *
 * Renders a real `<Link to={to}>` so SSR / no-JS / direct loads / crawlers
 * always get a working href to the canonical parent. After hydration, if the
 * user arrived via an in-app navigation, a plain left-click pops history
 * instead (returning them to wherever they actually came from) and the label
 * reads "Back". When the previous entry is the *same* page (a duplicate entry),
 * it falls through to the parent link to avoid a no-op / ping-pong.
 */
export function BackLink({
  to,
  params,
  label = 'Back',
  className,
}: {
  to: string;
  /** Path params for the parent link (forwarded to TanStack Router's `Link`). */
  params?: Record<string, string>;
  /** Label for the parent fallback; smart history-back reads "Back" instead. */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  // Whether a plain click should pop history (the user arrived via an in-app
  // navigation to a different page), and the name that page registered for
  // itself, if any. With no in-app history we render the deterministic parent
  // link + `label` instead. The label only names a destination when the source
  // page registered one — a generic section guess would promise more than a
  // history-pop delivers.
  // On the first (SSR-hydrated) render we must match the server output, so start
  // with the parent fallback. Once hydrated, later navigations mount with the
  // correct smart state computed synchronously — no flicker.
  const [smart, setSmart] = useState<SmartState>(() =>
    appHydrated ? computeSmart(router.history) : { back: false, name: null }
  );
  useEffect(() => {
    installHistoryTrail(router.history);
    appHydrated = true;
    setSmart(computeSmart(router.history));
  }, [router]);
  const smartBack = smart.back;

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Respect modifier clicks (open in new tab) and let those follow the href.
    if (smartBack && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      router.history.back();
    }
  };

  return (
    <Link
      to={to}
      params={params}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 text-sm text-text-secondary transition-colors hover:text-text-primary',
        className
      )}
    >
      <Icon icon={ArrowLeft02Icon} size="sm" />
      {smartBack ? (smart.name ? `Back to ${smart.name}` : 'Back') : label}
    </Link>
  );
}
