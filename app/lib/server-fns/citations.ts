import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { getContributionsDb } from '@/lib/contributions-db';
import { ensureShowPage } from '@/lib/contrib/store';
import { requireCapability, type PageLock } from '@/lib/authz';

/**
 * Citations / references (M11a, plan §18). Page-scoped, deduped bibliography.
 * Adding a citation auto-prefetches Open-Graph metadata (title/site) for low
 * friction. Reads are public; create is gated through `authorize()`.
 */

export interface Citation {
  citationId: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  type: string;
  quote: string | null;
  accessedAt: string | null;
}

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_)/i;

/** Dedupe key: host+path, www-stripped, tracking params dropped, sorted. */
const normalizeUrl = (raw: string): string => {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort();
    const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${host}${path}${q}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
};

const inferType = (host: string): string => {
  if (/instagram|tiktok|facebook|twitter|x\.com|threads/.test(host)) return 'social';
  if (/youtube|youtu\.be|vimeo/.test(host)) return 'video';
  if (/dci\.org|dcxmuseum/.test(host)) return 'official-announcement';
  return 'article';
};

// SSRF guard: only fetch public http(s) hosts for OG prefetch.
const PRIVATE =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$|172\.(1[6-9]|2\d|3[01])\.)/i;
const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

const fetchMeta = async (
  url: string
): Promise<{ title: string | null; publisher: string | null }> => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname))
      return { title: null, publisher: null };
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'corps.place-citation-bot/1.0' },
      redirect: 'follow',
    });
    const html = (await res.text()).slice(0, 512 * 1024);
    const og = (p: string) =>
      html.match(
        new RegExp(`<meta[^>]+(?:property|name)=["']og:${p}["'][^>]+content=["']([^"']+)`, 'i')
      )?.[1];
    const title = og('title') ?? html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ?? null;
    return {
      title: title ? decodeEntities(title) : null,
      publisher: og('site_name') ? decodeEntities(og('site_name')!) : null,
    };
  } catch {
    return { title: null, publisher: null };
  }
};

const resolvePageId = async (corpsKey: string, season: string): Promise<string | null> => {
  const db = await getContributionsDb();
  const r = await db.execute({
    sql: 'SELECT page_id FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
    args: [corpsKey, season],
  });
  return (r.rows[0]?.page_id as string) ?? null;
};

const rowToCitation = (r: Record<string, unknown>): Citation => ({
  citationId: String(r.citation_id),
  url: (r.url as string) ?? null,
  title: (r.title as string) ?? null,
  publisher: (r.publisher as string) ?? null,
  type: String(r.type),
  quote: (r.quote as string) ?? null,
  accessedAt: (r.accessed_at as string) ?? null,
});

export const listCitations = createServerFn({ method: 'GET' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }): Promise<Citation[]> => {
    const pageId = await resolvePageId(data.corpsKey, data.season);
    if (!pageId) return [];
    const db = await getContributionsDb();
    const r = await db.execute({
      sql: 'SELECT * FROM show_citations WHERE page_id = ? ORDER BY created_at',
      args: [pageId],
    });
    return (r.rows as unknown as Record<string, unknown>[]).map(rowToCitation);
  });

export const createCitation = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      corpsKey: string;
      season: string;
      url?: string;
      title?: string;
      type?: string;
      quote?: string;
    }) => data
  )
  .handler(async ({ data }): Promise<Citation> => {
    const db = await getContributionsDb();
    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;
    const actor = await requireCapability(getWebRequest(), 'edit', { lockLevel });

    const now = new Date().toISOString();
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, {
      authorId: actor.userId,
      actorRole: actor.role,
      now,
    });

    const url = data.url?.trim() || null;
    const normalized = url ? normalizeUrl(url) : null;

    // Dedupe: return the existing citation for this (page, normalized_url).
    if (normalized) {
      const dup = (
        await db.execute({
          sql: 'SELECT * FROM show_citations WHERE page_id = ? AND normalized_url = ? LIMIT 1',
          args: [pageId, normalized],
        })
      ).rows[0] as Record<string, unknown> | undefined;
      if (dup) return rowToCitation(dup);
    }

    // Best-effort OG prefetch when the user didn't supply a title.
    let title = data.title?.trim() || null;
    let publisher: string | null = null;
    let type = data.type || 'other';
    if (url) {
      const host = (() => {
        try {
          return new URL(url).host.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      if (host && !data.type) type = inferType(host);
      if (!title) {
        const meta = await fetchMeta(url);
        title = meta.title;
        publisher = meta.publisher ?? (host || null);
      }
    }

    const citationId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO show_citations
              (citation_id, page_id, url, normalized_url, title, publisher, type, quote, accessed_at, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        citationId,
        pageId,
        url,
        normalized,
        title,
        publisher,
        type,
        data.quote?.trim() || null,
        now,
        now,
        actor.userId,
      ],
    });
    return {
      citationId,
      url,
      title,
      publisher,
      type,
      quote: data.quote?.trim() || null,
      accessedAt: now,
    };
  });
