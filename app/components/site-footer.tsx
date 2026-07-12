import { Link } from '@tanstack/react-router';

/**
 * Site-wide footer (legal/help links). Rendered from __root under every page —
 * previously these links existed ONLY on the homepage, leaving terms/privacy/
 * contact unreachable from the rest of the site. Session actions (log out) live
 * on /account, not here, so this stays session-free and render-cheap.
 */
export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border px-4 py-6 text-center">
      <p className="text-xs text-text-muted">
        <Link to="/privacy-policy" className="transition-colors hover:text-text-secondary">
          Privacy Policy
        </Link>
        <span className="mx-2 text-border">·</span>
        <Link to="/terms-of-service" className="transition-colors hover:text-text-secondary">
          Terms of Service
        </Link>
        <span className="mx-2 text-border">·</span>
        <Link to="/faq" className="transition-colors hover:text-text-secondary">
          FAQ
        </Link>
        <span className="mx-2 text-border">·</span>
        <Link to="/contact" className="transition-colors hover:text-text-secondary">
          Contact
        </Link>
        <span className="mx-2 text-border">·</span>
        <Link to="/account" className="transition-colors hover:text-text-secondary">
          Account
        </Link>
      </p>
    </footer>
  );
}
