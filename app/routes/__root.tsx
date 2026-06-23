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
import { THEME_STORAGE_KEY } from '@/stores/theme-store';
import { FAVORITE_STORAGE_KEY } from '@/stores/favorite-corps-store';
import { buildSeo } from '@/lib/seo';
import '@/app.css';

// Runs before paint to set `.dark` from storage / system preference, avoiding a
// flash of the wrong theme on first load. Kept inline + tiny so it ships in the
// initial HTML. The theme store re-syncs from this DOM state on the client.
//
// Also reads the favorite corps from localStorage and applies the complete
// palette (--primary, --primary-foreground, --logo-dark) + favicon before paint.
// Validates version + required fields; ignores corrupt favorites (plan §No-Flash).
const noFlashThemeScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;r.classList.toggle('dark',t=='dark');r.style.colorScheme=t;var f=localStorage.getItem('${FAVORITE_STORAGE_KEY}');if(f){var fav=JSON.parse(f);if(fav&&(!fav.version||fav.version>=1)&&typeof fav.corpsKey==='string'&&typeof fav.name==='string'&&typeof fav.darkPrimary==='string'&&typeof fav.lightPrimary==='string'){if(t=='dark'){r.style.setProperty('--primary',fav.darkPrimary);r.style.setProperty('--primary-foreground',fav.darkPrimaryForeground);}else{r.style.setProperty('--primary',fav.lightPrimary);r.style.setProperty('--primary-foreground',fav.lightPrimaryForeground);}if(fav.logoDark){r.style.setProperty('--logo-dark',fav.logoDark);}else{r.style.setProperty('--logo-dark','');}r.setAttribute('data-fav-active','');if(fav.faviconSvg){['icon','apple-touch-icon'].forEach(function(rel){var l=document.querySelector('link[rel="'+rel+'"][data-app-icon]');if(!l){l=document.createElement('link');l.rel=rel;if(rel=='icon')l.type='image/svg+xml';l.setAttribute('data-app-icon','true');document.head.appendChild(l);}l.href=fav.faviconSvg;});}if(fav.colorPrimary){var m=document.querySelector('meta[name="theme-color"][data-app-theme]');if(!m){m=document.createElement('meta');m.name='theme-color';m.setAttribute('data-app-theme','true');document.head.appendChild(m);}m.content=fav.colorPrimary;}}else{try{localStorage.removeItem('${FAVORITE_STORAGE_KEY}');}catch(e){}}}}catch(e){}})()`;

function RootDocument({ children }: { children: ReactNode }) {
  // suppressHydrationWarning on <html>: the no-flash theme script (below)
  // mutates its class + style.colorScheme before hydration, and browser
  // extensions inject data-* attrs here too — both intentionally differ from
  // the server HTML on this element only.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/logo.svg" type="image/svg+xml" data-app-icon="true" />
        <link rel="apple-touch-icon" href="/logo.svg" data-app-icon="true" />
        <meta name="theme-color" content="#0b0b0c" data-app-theme="true" />
        {/* No static <title> here — HeadContent renders the managed title from the
            root head() default below, which each route's head() overrides (a static
            JSX title would double up with the managed one). */}
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
  // Default title + meta for any route without its own head() (error boundaries,
  // redirect routes). Child route head()s override the title via HeadContent.
  head: () =>
    buildSeo({
      title: 'DrumCorps.app — DCI Drum Corps Scores, Schedules & Predictions',
      description:
        'Live DCI drum corps scores, competition schedules, AI score predictions, judge & staff profiles, show programs, and official corps merch.',
    }),
  component: () => (
    <RootDocument>
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
  ),
});
