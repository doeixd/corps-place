/**
 * Sanitize a user-authored link href for the free-form editor.
 *
 * SECURITY: contributor content is untrusted (invariant I-14). Only http(s) and
 * mailto links are allowed; `javascript:`, `data:`, `vbscript:`, and anything
 * else return null (dropped / not linkified). A bare `example.com/x` is upgraded
 * to https. Used both to validate links at authoring time (LinkPlugin) and to
 * sanitize at render time (renderLexicalDoc) as defense-in-depth.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (/^(https?:\/\/|mailto:)/i.test(t)) return t;
  // Bare domain (no scheme) → assume https. Rejects "javascript:…" etc. since
  // they don't match a domain-first pattern.
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/i.test(t)) return `https://${t}`;
  return null;
}

/** True when `raw` is a link we're willing to create/store. */
export const isSafeHref = (raw: string | null | undefined): boolean => safeHref(raw) !== null;
