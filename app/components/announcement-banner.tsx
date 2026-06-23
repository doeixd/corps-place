import { useEffect, useState } from 'react';
import { getAnnouncement } from '@/lib/server-fns/admin';

/**
 * Site-wide announcement bar (ADMIN_PAGE_PLAN §8.2). Set by admins on /admin/system.
 * Client-only fetch on mount (no SSR/loader change → no hydration risk); renders
 * nothing until/unless a banner is set. Dismissible per-message for the session.
 */
export function AnnouncementBanner() {
  const [text, setText] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    getAnnouncement()
      .then((a) => {
        if (!alive || !a.text) return;
        // Re-show when the message changes (key by content).
        try {
          if (sessionStorage.getItem('dismissed-announcement') === a.text) setDismissed(true);
        } catch {
          /* sessionStorage unavailable — just show it */
        }
        setText(a.text);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!text || dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-accent px-4 py-2 text-sm text-text-primary">
      <span className="flex-1">{text}</span>
      <button
        type="button"
        aria-label="Dismiss announcement"
        className="text-text-secondary hover:text-text-primary"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem('dismissed-announcement', text);
          } catch {
            /* ignore */
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}
