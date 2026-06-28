/**
 * Pure, client-safe parsing of YouTube / Vimeo URLs into a thumbnail + a
 * privacy-friendly embed URL, so pasted video links render as a play-facade
 * (thumbnail + play button → lightbox iframe) instead of a bare link.
 *
 * Only known video hosts produce an embed — never inject an arbitrary URL into
 * an <iframe>.
 */
export interface VideoEmbed {
  provider: 'youtube' | 'vimeo' | 'tiktok' | 'instagram';
  id: string;
  /** A static poster, or null when the provider needs an API call (Vimeo/TikTok/IG). */
  thumbnailUrl: string | null;
  /** Allow-listed embed origin (youtube-nocookie / player.vimeo / tiktok / instagram). */
  embedUrl: string;
  /** Vertical 9:16 content (TikTok / Instagram) — the lightbox uses a portrait frame. */
  portrait?: boolean;
}

const youtube = (id: string): VideoEmbed => ({
  provider: 'youtube',
  id,
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
});

export function parseVideo(url: string): VideoEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{6,}$/.test(id) ? youtube(id) : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const fromQuery = u.searchParams.get('v');
    const fromPath = u.pathname.match(/\/(?:embed|shorts|v)\/([\w-]{6,})/)?.[1];
    const id = fromQuery || fromPath || '';
    return /^[\w-]{6,}$/.test(id) ? youtube(id) : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.match(/(\d{6,})/)?.[1] ?? '';
    return id
      ? { provider: 'vimeo', id, thumbnailUrl: null, embedUrl: `https://player.vimeo.com/video/${id}` }
      : null;
  }
  if (host === 'tiktok.com' || host === 'm.tiktok.com') {
    // Long URLs only (/@user/video/<id>). Short vm.tiktok.com links can't be
    // resolved client-side, so they fall through to a plain link card.
    const id = u.pathname.match(/\/video\/(\d{6,})/)?.[1] ?? '';
    return id
      ? {
          provider: 'tiktok',
          id,
          thumbnailUrl: null,
          embedUrl: `https://www.tiktok.com/embed/v2/${id}`,
          portrait: true,
        }
      : null;
  }
  if (host === 'instagram.com') {
    const m = u.pathname.match(/\/(p|reel|reels|tv)\/([\w-]+)/);
    if (m) {
      const type = m[1] === 'reels' ? 'reel' : m[1];
      return {
        provider: 'instagram',
        id: m[2],
        thumbnailUrl: null,
        embedUrl: `https://www.instagram.com/${type}/${m[2]}/embed`,
        portrait: true,
      };
    }
    return null;
  }
  return null;
}
