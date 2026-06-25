import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { registerServiceWorker } from '@/lib/register-sw';
import { MotionConfig, REDUCED_MOTION } from '@/lib/motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { SiteNav } from '@/components/site-nav';
import { AnnouncementBanner } from '@/components/announcement-banner';
import { ConsentGate } from '@/components/consent-gate';
import { Toaster } from '@/components/ui/sonner';
import { THEME_COOKIE, readThemeCookie } from '@/lib/theme-cookie';
import type { Theme } from '@/lib/theme-cookie';
import { FAVORITE_COOKIE, readFavoriteCookie } from '@/lib/favorite-cookie';
import { buildAppIconHref } from '@/lib/logo-recolor';
import { getBrand, BRAND_CONFIG, type Brand } from '@/lib/brand';
import { buildSeo } from '@/lib/seo';
import '@/app.css';

const DEFAULT_THEME_COLOR = '#0b0b0c';

// Favicon + browser-chrome color for the favorited corps, derived server-side
// from the cookie so the initial HTML is already correct (no first-paint flash,
// and the head() tags match on hydration instead of resetting to defaults).
function favoriteHead(): { iconHref: string; themeColor: string } {
  try {
    const raw = readFavoriteCookie();
    if (raw) {
      const fav = JSON.parse(raw) as { colorPrimary?: unknown; logoDark?: unknown };
      const colorPrimary = typeof fav.colorPrimary === 'string' ? fav.colorPrimary : null;
      const logoDark = typeof fav.logoDark === 'string' ? fav.logoDark : null;
      if (colorPrimary) {
        return { iconHref: buildAppIconHref(colorPrimary, logoDark), themeColor: colorPrimary };
      }
    }
  } catch {
    /* corrupt cookie — fall through to defaults */
  }
  return { iconHref: '/logo.svg', themeColor: DEFAULT_THEME_COLOR };
}

// Runs before paint to set `.dark` from storage / system preference, avoiding a
// flash of the wrong theme on first load. Kept inline + tiny so it ships in the
// initial HTML. The theme store re-syncs from this DOM state on the client.
//
// Also reads the favorite corps from its cookie and applies the accent palette
// (--primary, --primary-foreground, --logo-dark, data-fav-active) on <html> before
// paint — these can't be set server-side on <html>, so the script avoids an accent
// flash. The favicon + theme-color are rendered correctly by head() server-side,
// so they're not touched here. Ignores corrupt favorites (plan §No-Flash).
const noFlashThemeScript = `(function(){try{var tc=document.cookie.match('(?:^|; )${THEME_COOKIE}=([^;]*)');var t=tc?tc[1]:null;if(t!=='dark'&&t!=='light'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;r.classList.toggle('dark',t=='dark');r.style.colorScheme=t;var c=document.cookie.match('(?:^|; )${FAVORITE_COOKIE}=([^;]*)');if(c){var fav=JSON.parse(decodeURIComponent(c[1]));if(fav&&typeof fav.corpsKey==='string'&&typeof fav.darkPrimary==='string'&&typeof fav.lightPrimary==='string'){if(t=='dark'){r.style.setProperty('--primary',fav.darkPrimary);r.style.setProperty('--primary-foreground',fav.darkPrimaryForeground);}else{r.style.setProperty('--primary',fav.lightPrimary);r.style.setProperty('--primary-foreground',fav.lightPrimaryForeground);}if(fav.logoDark){r.style.setProperty('--logo-dark',fav.logoDark);}else{r.style.setProperty('--logo-dark','');}r.setAttribute('data-fav-active','');}}}catch(e){}})()`;

function RootDocument({
  children,
  theme,
  brand,
  iconHref,
}: {
  children: ReactNode;
  theme: Theme | null;
  brand: Brand;
  iconHref: string;
}) {
  // suppressHydrationWarning on <html>: when there's no theme cookie the no-flash
  // script (below) resolves the OS preference and mutates the class + colorScheme
  // before hydration, and browser extensions inject data-* attrs here too — both
  // intentionally differ from the server HTML on this element only. When a cookie
  // IS present we render the matching class server-side, so there's nothing to fix.
  return (
    <html
      lang="en"
      className={
        [theme === 'dark' ? 'dark' : '', brand === 'jobs' ? 'brand-jobs' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      style={theme ? { colorScheme: theme } : undefined}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Favicon + apple-touch-icon live HERE (the persistent document <head>), not in
            head()/HeadContent. Rendering them via HeadContent meant they were reconciled
            on every route change AND on the fantasy pages' frequent live (SSE) re-renders,
            which makes Chrome drop the SVG favicon. As static elements on the root document
            they survive navigation; the per-corps `iconHref` (from the favorite cookie) is
            still honored and only changes when the favorite does. theme-color stays in
            head() below. No static <title> here either — head() manages it. */}
        <link rel="icon" href={iconHref} type="image/svg+xml" />
        <link rel="apple-touch-icon" href={iconHref} />
        <script dangerouslySetInnerHTML={{ __html: noFlashThemeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Scroll to top on real navigations (pathname changes) only — NOT on search-param
// updates within the same page. This replaces the router's global
// `scrollRestoration`, which also fired on in-place `replace` search updates (roll
// / likelihood window / filters on the prediction page) and scrolled the table out
// of view. Keying on pathname leaves those in-page updates' scroll position alone.
// Top-of-page navigation progress bar. Shows only after a short delay so fast
// (cached/preloaded) navigations don't flash it, then "trickles" toward 90% while
// the next route's loader runs and snaps to 100% + fades when it lands. Gives
// immediate feedback that a click registered and the page is loading.
// Pure-CSS progress bar (no framer-motion, so the animation engine stays out of the
// global chunk). Three phases driven by CSS transitions: idle (hidden) → loading
// (trickles scaleX 0→0.9 over 10s) → done (snaps to 1 and fades) → idle.
function NavigationProgressBar({ delayMs = 150 }: { delayMs?: number }) {
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');

  useEffect(() => {
    if (isPending) {
      const timer = setTimeout(() => setPhase('loading'), delayMs);
      return () => clearTimeout(timer);
    }
    // Navigation settled — snap to 100% + fade if we were showing, else stay idle.
    setPhase((p) => (p === 'loading' ? 'done' : 'idle'));
  }, [isPending, delayMs]);

  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(() => setPhase('idle'), 250);
    return () => clearTimeout(timer);
  }, [phase]);

  const style: CSSProperties =
    phase === 'loading'
      ? { transform: 'scaleX(0.9)', opacity: 1, transition: 'transform 10s ease-out' }
      : phase === 'done'
        ? {
            transform: 'scaleX(1)',
            opacity: 0,
            transition: 'transform 0.2s ease-out, opacity 0.2s ease-out',
          }
        : { transform: 'scaleX(0)', opacity: 0, transition: 'none' };

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 origin-left bg-primary"
      style={style}
    />
  );
}

// Registers (or, when disabled, unregisters) the offline service worker on the
// client. No-op during SSR. Renders nothing.
function ServiceWorkerManager() {
  useEffect(() => {
    registerServiceWorker();

    // Self-heal stale chunks after a deploy. A tab that was open before a deploy
    // still references the OLD content-hashed chunk URLs; those 404 on the new
    // container the moment a lazy route loads — which reads as "the site broke."
    // Vite fires `vite:preloadError` on that failure; reload once to pull fresh HTML
    // + new assets. Guarded by a timestamp so a genuinely-missing chunk can't loop.
    const onPreloadError = () => {
      let last = 0;
      try {
        last = Number(sessionStorage.getItem('chunkReloadAt') || '0');
      } catch {
        /* storage unavailable */
      }
      if (Date.now() - last > 10_000) {
        try {
          sessionStorage.setItem('chunkReloadAt', String(Date.now()));
        } catch {
          /* ignore */
        }
        window.location.reload();
      }
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, []);
  return null;
}

// Auto-update: polls the server's build id (/api/version) and, when it differs from
// this tab's compiled id (i.e. after a deploy), reloads to fresh code. To avoid
// interrupting work, it applies on the next navigation — a state-safe moment — and
// also surfaces a toast for an immediate refresh. Complements the reactive
// vite:preloadError reload above (which only fires once a stale chunk 404s).
function AutoUpdater() {
  const router = useRouter();
  useEffect(() => {
    // Compare the server's build id now against the one observed at page load — both
    // read from the same endpoint, so a client/server build-stamp skew can't trigger a
    // false positive. A change means the server was redeployed under us.
    let baseline: string | null = null;
    let stale = false;
    const check = async () => {
      if (stale) return;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { id } = (await res.json()) as { id?: string };
        if (!id) return;
        if (baseline === null) {
          baseline = id;
          return;
        }
        if (id !== baseline) {
          stale = true;
          toast('A new version is available', {
            description: 'It will apply on your next page change.',
            action: { label: 'Refresh now', onClick: () => window.location.reload() },
            duration: Infinity,
          });
        }
      } catch {
        /* offline / transient — retry on the next tick */
      }
    };
    // Poll periodically, and whenever the tab is brought back to the foreground.
    const interval = window.setInterval(check, 120_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Apply a pending update on the next resolved navigation — reloading there is safe
    // (the page is changing anyway) and lands the user on the new code.
    const unsub = router.subscribe('onResolved', () => {
      if (!stale) return;
      // Guard against a reload loop in the unlikely event ids never converge.
      let last = 0;
      try {
        last = Number(sessionStorage.getItem('verReloadAt') || '0');
      } catch {
        /* storage unavailable */
      }
      if (Date.now() - last < 30_000) return;
      try {
        sessionStorage.setItem('verReloadAt', String(Date.now()));
      } catch {
        /* ignore */
      }
      window.location.reload();
    });
    void check();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      unsub();
    };
  }, [router]);
  return null;
}

export const Route = createRootRoute({
  // Read the favorite cookie so head() can render the corps's favicon + theme-color
  // into the SSR HTML (correct first paint, no hydration reset).
  loader: ({ request }) => {
    const brand = getBrand(request ?? new Request('http://localhost:5173'));
    return { brand, favorite: favoriteHead(), theme: readThemeCookie() };
  },
  // Default title + meta for any route without its own head() (error boundaries,
  // redirect routes). Child route head()s override the title via HeadContent.
  head: ({ loaderData }) => {
    const { themeColor } = loaderData?.favorite ?? {
      themeColor: DEFAULT_THEME_COLOR,
    };
    const brand = loaderData?.brand ?? 'corps';
    const brandCfg = BRAND_CONFIG[brand];
    const seo = buildSeo({
      title: brandCfg.seo.title,
      description: brandCfg.seo.description,
    });
    return {
      ...seo,
      meta: [...seo.meta, { name: 'theme-color', content: themeColor }],
      // Favicon links are rendered statically in RootDocument's <head> (see note there),
      // not here — HeadContent reconciliation was dropping the SVG icon on the fantasy
      // pages' frequent live re-renders.
      links: [...seo.links],
    };
  },
  component: RootComponent,
});

function RootComponent() {
  const { theme, brand, favorite } = Route.useLoaderData();
  return (
    <RootDocument theme={theme} brand={brand} iconHref={favorite?.iconHref ?? '/logo.svg'}>
      <ServiceWorkerManager />
      <AutoUpdater />
      <MotionConfig reducedMotion={REDUCED_MOTION}>
        <TooltipProvider delay={150}>
          <NavigationProgressBar />
          <ThemeToggle className="fixed top-4 right-4 z-50" />
          <SiteNav />
          <ConsentGate />
          <Toaster theme={theme} />
          {/* Offsets mirror SiteNav via shared tokens: the sidebar width on md+/xl
              (`side-nav`) and the bottom-tab height incl. iOS safe area on mobile
              (`bottom-nav`). Both self-step across breakpoints, so no md:/xl: here. */}
          <main className="pb-bottom-nav pl-side-nav">
            <AnnouncementBanner />
            <Outlet />
          </main>
        </TooltipProvider>
      </MotionConfig>
    </RootDocument>
  );
}
