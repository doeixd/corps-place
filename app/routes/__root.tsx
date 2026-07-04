import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
// sonner is imported dynamically (see Toaster/toast call sites) — a static
// import here would put the ~31KB toast library in the critical main chunk.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { registerServiceWorker } from '@/lib/register-sw';
import { trackBackNavigation } from '@/hooks/use-back-navigation';
import { MotionConfig, REDUCED_MOTION } from '@/lib/motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { SiteNav } from '@/components/site-nav';
import { AnnouncementBanner } from '@/components/announcement-banner';
import { ConsentGate } from '@/components/consent-gate';
import { AnalyticsTracker } from '@/components/analytics-tracker';
import { lazy, Suspense } from 'react';
// Lazy: the toast host isn't needed for first paint, and a static import drags
// sonner (~31KB) into the critical main chunk. SSR renders nothing for it.
const Toaster = lazy(() =>
  import('@/components/ui/sonner').then((m) => ({ default: m.Toaster }))
);
import { THEME_COOKIE, readThemeCookie } from '@/lib/theme-cookie';
import type { Theme } from '@/lib/theme-cookie';
import { FAVORITE_COOKIE, readFavoriteCookie } from '@/lib/favorite-cookie';
import {
  DEFAULT_APP_ICON_HREF,
  JOBS_APP_ICON_HREF,
  JOBS_THEME_COLOR,
  buildAppIconHref,
} from '@/lib/logo-recolor';
import {
  themeChromeColor,
  useFavoriteIconHref,
  useFavoriteThemeColor,
} from '@/stores/favorite-corps-store';
import { themeStore } from '@/stores/theme-store';
import { normalizeHex } from '@sdk/src/corpsColors.js';
import { IconSprite } from '@/components/icons/generated';
import { CustomIconSprite } from '@/components/icons/custom-sprite';
import { readBrand, BRAND_CONFIG, type Brand } from '@/lib/brand';
import { BrandProvider } from '@/lib/brand-context';
import { buildSeo, jsonLdScript } from '@/lib/seo';
import '@/app.css';

const subscribeTheme = (onChange: () => void) => {
  const sub = themeStore.subscribe(onChange);
  return () => sub.unsubscribe();
};

// Favicon + browser-chrome color for the favorited corps, derived server-side
// from the cookie so the initial HTML is already correct (no first-paint flash,
// and the head() tags match on hydration instead of resetting to defaults).
function favoriteHead(theme: Theme | null, brand: Brand): { iconHref: string; themeColor: string } {
  // PageantryJobs uses its own mark + chrome color and ignores the favorite-corps
  // accent entirely — the corps favicon must never appear on the jobs site.
  if (brand === 'jobs') {
    return { iconHref: JOBS_APP_ICON_HREF, themeColor: JOBS_THEME_COLOR };
  }
  try {
    const raw = readFavoriteCookie();
    if (raw) {
      const fav = JSON.parse(raw) as { colorPrimary?: unknown };
      const colorPrimary =
        typeof fav.colorPrimary === 'string' ? normalizeHex(fav.colorPrimary) : null;
      if (colorPrimary) {
        return { iconHref: buildAppIconHref(colorPrimary), themeColor: colorPrimary };
      }
    }
  } catch {
    /* corrupt cookie — fall through to defaults */
  }
  return {
    iconHref: DEFAULT_APP_ICON_HREF,
    themeColor: themeChromeColor(theme ?? 'light'),
  };
}

function FavoriteHeadBranding({
  brand,
  initialIconHref,
  initialThemeColor,
}: {
  brand: Brand;
  initialIconHref: string;
  initialThemeColor: string;
}) {
  // Hooks must run unconditionally; on the jobs brand we ignore the favorite-corps
  // store so it can never repaint the corps favicon over the PageantryJobs mark.
  const dynamicIconHref = useFavoriteIconHref(initialIconHref);
  const dynamicThemeColor = useFavoriteThemeColor(initialThemeColor);
  // Render the SERVER values through hydration: with no theme cookie the
  // no-FOUC script resolves the OS preference before hydration, so the store's
  // theme-color (e.g. dark #0b0b0c) differs from the SSR'd one (#ffffff). That
  // mismatch on <meta theme-color> killed hydration outright on OS-dark
  // devices under redact (and was a silent full-tree client re-render under
  // react). Post-mount the live values take over — a normal update.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const live = brand !== 'jobs' && mounted;
  const iconHref = live ? dynamicIconHref : initialIconHref;
  const themeColor = live ? dynamicThemeColor : initialThemeColor;
  return (
    <>
      <link rel="icon" href={iconHref} type="image/svg+xml" data-app-icon="true" suppressHydrationWarning />
      {/* Static PNG: iOS doesn't render SVG touch icons, and pointing this at the
          same SVG as rel=icon made Chromium download the 33KB artwork twice. Not
          recolored per favorite — it's the home-screen icon, not browser chrome. */}
      <link
        rel="apple-touch-icon"
        href={brand === 'jobs' ? initialIconHref : '/apple-touch-icon.png'}
        data-app-icon="true"
      />
      <meta name="theme-color" content={themeColor} suppressHydrationWarning />
    </>
  );
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
  favorite,
}: {
  children: ReactNode;
  theme: Theme | null;
  brand: Brand;
  favorite: { iconHref: string; themeColor: string };
}) {
  const resolvedTheme = useSyncExternalStore(
    subscribeTheme,
    () => themeStore.getSnapshot().context.theme,
    () => theme ?? 'light'
  );
  // suppressHydrationWarning on <html>: when there's no theme cookie the no-flash
  // script (below) resolves the OS preference and mutates the class + colorScheme
  // before hydration, and browser extensions inject data-* attrs here too — both
  // intentionally differ from the server HTML on this element only. When a cookie
  // IS present we render the matching class server-side, so there's nothing to fix.
  return (
    <html
      lang="en"
      className={
        [resolvedTheme === 'dark' ? 'dark' : '', brand === 'jobs' ? 'brand-jobs' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      style={{ colorScheme: resolvedTheme }}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Keep favorite branding in the persistent document head, outside
            HeadContent. Route reconciliation and live updates can otherwise
            restore stale loader values or briefly remove the favicon. */}
        <FavoriteHeadBranding
          brand={brand}
          initialIconHref={favorite.iconHref}
          initialThemeColor={favorite.themeColor}
        />
        {/* Two redact (react-replacement) hydration workarounds, both upstream bugs:
            - explicit `type`: head hydration keys scripts on [src, type]; a
              typeless inline script skips its own node and mis-claims the first
              JSON-LD script, corrupting head hydration.
            - suppressHydrationWarning: the innerHTML probe round-trips script
              text through div.innerHTML, entity-escaping `&&` and false-failing
              the comparison (content is verified byte-identical). */}
        <script
          type="text/javascript"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: noFlashThemeScript }}
        />
        {/* Client error beacon: report the first JS error / unhandled rejection /
            failure-to-boot to /api/collect — it's the only visibility we have into
            devices we can't reproduce on (caught the OS-dark hydration fatal no
            probe could reach). Rate-limited at 5 per pageload and 12 per session
            so a reload loop can't flood analytics. Inline + first so it runs even
            when every chunk fails. */}
        <script
          type="text/javascript"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){var sent=0;function send(n,p){if(sent++>4)return;var k='cp-beacon-n',c=0;try{c=+(sessionStorage.getItem(k)||0);if(c>=12)return;sessionStorage.setItem(k,String(c+1));}catch(e){}try{p.ua=navigator.userAgent.slice(0,120);navigator.sendBeacon('/api/collect',JSON.stringify({type:'event',name:n,path:location.pathname,props:p}));}catch(e){}}window.addEventListener('error',function(e){if(e.target&&e.target.tagName){send('client_asset_error',{tag:e.target.tagName,src:String(e.target.src||e.target.href||'').slice(-80)});}else{send('client_js_error',{m:String(e.message).slice(0,180),src:String(e.filename||'').slice(-60),ln:e.lineno});}},true);window.addEventListener('unhandledrejection',function(e){send('client_rejection',{m:String((e.reason&&e.reason.message)||e.reason).slice(0,180)});});setTimeout(function(){if(!window.__cp_booted){send('client_no_boot',{});}},8000);})()`,
          }}
        />
        {/* Entry-load watchdog: a page served during a deploy rollout can
            reference asset hashes that no longer exist — the entry module 404s,
            no JS ever runs, and the page is permanently dead (the in-app
            vite:preloadError reload can't help; it lives in the JS that failed).
            This inline capture-phase handler reloads once to pull fresh HTML. */}
        <script
          type="text/javascript"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `window.addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='SCRIPT'&&t.src&&t.src.indexOf('/assets/')!==-1&&!sessionStorage.getItem('cp-entry-reload')){sessionStorage.setItem('cp-entry-reload','1');location.reload();}},true);window.addEventListener('load',function(){sessionStorage.removeItem('cp-entry-reload');});`,
          }}
        />
        <HeadContent />
      </head>
      <body>
        {/* Shared icon sprite: every generated icon renders a <use> against these
            symbols, so repeated cards don't re-inline identical path data. */}
        <IconSprite />
        <CustomIconSprite />
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
  // Persistent history subscription so Back/Forward is observed regardless of
  // which page is mounted (see use-back-navigation). Root is always mounted, so
  // this catches the BACK action even when leaving a page that has no consumer.
  useEffect(() => trackBackNavigation(router.history), [router]);
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
          const { toast } = await import('sonner');
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
  loader: () => {
    const brand = readBrand();
    const theme = readThemeCookie();
    return { brand, favorite: favoriteHead(theme, brand), theme };
  },
  // Default title + meta for any route without its own head() (error boundaries,
  // redirect routes). Child route head()s override the title via HeadContent.
  head: ({ loaderData }) => {
    const brand = loaderData?.brand ?? 'corps';
    const brandCfg = BRAND_CONFIG[brand];
    const seo = buildSeo({
      title: brandCfg.seo.title,
      description: brandCfg.seo.description,
    });
    // Site-wide structured data (every page): Organization (knowledge panel /
    // logo) + WebSite (site name in results). Brand-aware so each host describes
    // itself. No SearchAction yet — there's no /search results route to target.
    const siteUrl = brand === 'jobs' ? 'https://pageantryjobs.com' : 'https://drumcorps.app';
    const orgLd = {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: brandCfg.name,
      url: siteUrl,
      logo: `${siteUrl}/app-icon.svg`,
    };
    const webSiteLd = {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: brandCfg.name,
      url: siteUrl,
    };
    return {
      ...seo,
      meta: [...seo.meta],
      links: [...seo.links],
      scripts: [jsonLdScript(orgLd), jsonLdScript(webSiteLd)],
    };
  },
  component: RootComponent,
});

// Mounts the toast host only in the browser, after hydration: it renders
// nothing at first paint, so there's no SSR markup to mismatch and the lazy
// sonner chunk loads off the critical path.
function DeferredToaster({ theme }: { theme: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <Toaster theme={theme} />
    </Suspense>
  );
}

function RootComponent() {
  const { theme, brand, favorite } = Route.useLoaderData();
  // Debug-beacon boot marker (see the inline script in RootDocument's head).
  useEffect(() => {
    (window as unknown as { __cp_booted?: number }).__cp_booted = 1;
  }, []);
  return (
    <RootDocument theme={theme} brand={brand} favorite={favorite}>
      <BrandProvider brand={brand}>
        <ServiceWorkerManager />
        <AutoUpdater />
        <AnalyticsTracker />
        <MotionConfig reducedMotion={REDUCED_MOTION}>
          <TooltipProvider delay={150}>
            <NavigationProgressBar />
            <ThemeToggle className="fixed top-4 right-4 z-50" ssrTheme={theme ?? undefined} />
            <SiteNav />
            <ConsentGate />
            <DeferredToaster theme={theme ?? 'system'} />
            {/* Offsets mirror SiteNav via shared tokens: the sidebar width on md+/xl
                (`side-nav`) and the bottom-tab height incl. iOS safe area on mobile
                (`bottom-nav`). Both self-step across breakpoints, so no md:/xl: here. */}
            <main className="pb-bottom-nav pl-side-nav">
              <AnnouncementBanner />
              <Outlet />
            </main>
          </TooltipProvider>
        </MotionConfig>
      </BrandProvider>
    </RootDocument>
  );
}
