import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { registerServiceWorker } from '@/lib/register-sw';
import { MotionConfig, REDUCED_MOTION } from '@/lib/motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { SiteNav } from '@/components/site-nav';
import { AnnouncementBanner } from '@/components/announcement-banner';
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
}: {
  children: ReactNode;
  theme: Theme | null;
  brand: Brand;
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
        {/* Favicon, apple-touch-icon and theme-color are rendered by head() below
            (HeadContent) from the favorite cookie, so SSR is correct and hydration
            doesn't reset them. No static <title> here either — head() manages it. */}
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
function NavigationProgressBar({ delayMs = 150 }: { delayMs?: number }) {
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isPending) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [isPending, delayMs]);

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="nav-progress"
          className="fixed inset-x-0 top-0 z-[100] h-0.5 origin-left bg-primary"
          initial={{ scaleX: 0, opacity: 1 }}
          animate={{ scaleX: 0.9, transition: { duration: 10, ease: 'easeOut' } }}
          exit={{ scaleX: 1, opacity: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
        />
      ) : null}
    </AnimatePresence>
  );
}

// Registers (or, when disabled, unregisters) the offline service worker on the
// client. No-op during SSR. Renders nothing.
function ServiceWorkerManager() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
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
    const { iconHref, themeColor } = loaderData?.favorite ?? {
      iconHref: '/logo.svg',
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
      links: [
        ...seo.links,
        { rel: 'icon', href: iconHref, type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: iconHref },
      ],
    };
  },
  component: RootComponent,
});

function RootComponent() {
  const { theme, brand } = Route.useLoaderData();
  return (
    <RootDocument theme={theme} brand={brand}>
      <ServiceWorkerManager />
      <MotionConfig reducedMotion={REDUCED_MOTION}>
        <TooltipProvider delay={150}>
          <NavigationProgressBar />
          <ThemeToggle className="fixed top-4 right-4 z-50" />
          <SiteNav />
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
