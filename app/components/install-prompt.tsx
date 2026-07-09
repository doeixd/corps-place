import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useBrand } from '@/lib/brand-context';
import { BRAND_CONFIG } from '@/lib/brand';

/**
 * Subtle "Add to Home Screen" (PWA install) prompt.
 *
 * Shows only after the visitor has viewed a few pages (engagement gate), only on
 * mobile, and never when the app is already installed or was recently dismissed.
 * Android/Chrome gets a one-tap install via the captured `beforeinstallprompt`;
 * iOS Safari (no such API) gets the manual Share → Add to Home Screen hint. Corps
 * brand only. Mounted once in the root layout.
 */

const SEEN_KEY = 'a2hs-seen'; // set once the banner is shown, dismissed, or installed
const COUNT_KEY = 'a2hs-pageviews';
const MIN_PAGES = 3;
/** Admin/test hook: dispatch this to force the banner (bypasses every gate). */
export const INSTALL_PROMPT_TEST_EVENT = 'a2hs:test-show';

/** Force-show the install banner right now (admin test button). */
export const showInstallPromptForTest = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(INSTALL_PROMPT_TEST_EVENT));
};

/** Clear the "seen/dismissed" + page-count state so the real prompt can recur. */
export const resetInstallPromptState = (): void => {
  try {
    localStorage.removeItem('a2hs-seen');
    sessionStorage.removeItem('a2hs-pageviews');
  } catch {
    /* ignore */
  }
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

const detectMobile = (): 'ios' | 'android' | null => {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream)
    return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
};

const hasSeen = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};

const markSeen = (): void => {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
};

export function InstallPrompt() {
  const brand = useBrand();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [forced, setForced] = useState(false); // admin/test force-show (bypasses gates)

  // Capture the install event (Android) as early as the component mounts, record
  // install, and listen for the admin test hook.
  useEffect(() => {
    setPlatform(detectMobile());
    const onBIP = (e: Event) => {
      e.preventDefault(); // stash it so we can trigger install from our own UI
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setShow(false);
      markSeen();
    };
    const onTest = () => {
      setForced(true);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener(INSTALL_PROMPT_TEST_EVENT, onTest);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener(INSTALL_PROMPT_TEST_EVENT, onTest);
    };
  }, []);

  // Count page views this session; reveal once engaged + eligible. Never when the
  // app is already installed (standalone) or the user has already seen/dismissed
  // it. (The admin test hook bypasses all of this.)
  useEffect(() => {
    if (brand !== 'corps') return; // the drum-corps app only
    let eligible = false;
    try {
      if (isStandalone() || hasSeen()) return;
      const p = detectMobile();
      if (!p) return; // mobile only
      const n = Number(sessionStorage.getItem(COUNT_KEY) || 0) + 1;
      sessionStorage.setItem(COUNT_KEY, String(n));
      eligible = n >= MIN_PAGES;
    } catch {
      return;
    }
    if (!eligible) return;
    // Android: only once we actually captured an install event; iOS: always (manual).
    if (detectMobile() === 'ios' || deferred) {
      markSeen(); // shown once → don't show again on a later visit
      setShow(true);
    }
  }, [pathname, brand, deferred]);

  // Normal flow needs a detected mobile platform; the forced test preview renders
  // even on desktop (falls back to the instructional variant).
  if (!show || (!platform && !forced)) return null;

  const name = BRAND_CONFIG[brand].name;
  const icon = brand === 'jobs' ? '/pwa-jobs-192.png' : '/pwa-192.png';

  const dismiss = () => {
    markSeen();
    setForced(false);
    setShow(false);
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* user dismissed or it errored */
    }
    setDeferred(null);
    setShow(false);
  };

  return (
    <div
      className="fixed inset-x-0 bottom-bottom-nav z-50 p-3"
      aria-label={`Install ${name}`}
    >
      <div className="mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
        <img
          src={icon}
          alt=""
          width={40}
          height={40}
          className="size-10 shrink-0 rounded-lg"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">Install {name}</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            {deferred ? (
              'Add it to your home screen for a faster, full-screen app.'
            ) : (
              <>
                Tap{' '}
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="inline-block size-3.5 -translate-y-px align-middle"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 15V3m0 0l-4 4m4-4l4 4" />
                  <path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7" />
                </svg>{' '}
                Share, then “Add to Home Screen”.
              </>
            )}
          </div>
        </div>
        {deferred ? (
          <button
            type="button"
            onClick={install}
            className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Install
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-text-secondary transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
