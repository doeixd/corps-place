import type { Client } from '@libsql/client';

/**
 * Map a yearbook profile (website / location / corps name) to a corps_key (M10).
 *
 * Primary key is the website domain — the staff page prints the corps URL and the
 * corps table stores one. Falls back to a normalized name + city match for the
 * majority of corps that lack a stored website (only ~139/729 have one).
 */

/**
 * Reduce any URL to a bare registrable domain: strip protocol, an archive.org
 * wrapper, `www.`, and the path. `https://web.archive.org/web/2022…/http://www.scvanguard.org/`
 * → `scvanguard.org`; `bostoncrusaders.org` → `bostoncrusaders.org`.
 */
export const normalizeDomain = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  // Unwrap a Wayback URL: take the last embedded http(s):// target.
  const wb = s.lastIndexOf('http');
  if (wb > 0) s = s.slice(wb);
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const host = s.split(/[/?#]/)[0];
  return host && host.includes('.') ? host : null;
};

const normName = (s: string | null | undefined): string =>
  (s || '')
    .toLowerCase()
    .replace(/\b(drum\s*(?:and\s*|&\s*)?bugle\s*corps|drum\s*corps|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type CorpsMatchMethod = 'domain' | 'name+city' | 'name';
export interface CorpsMatch {
  corpsKey: string;
  method: CorpsMatchMethod;
}

interface CorpsRow {
  corps_key: string;
  name: string | null;
  display_city: string | null;
  website: string | null;
}

/** A reusable resolver, built once from the corps table (domain + name indexes). */
export const buildCorpsResolver = async (db: Client) => {
  const rows = (
    await db.execute('SELECT corps_key, name, display_city, website FROM corps')
  ).rows as unknown as CorpsRow[];

  const byDomain = new Map<string, string>();
  const byNameCity = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const r of rows) {
    const dom = normalizeDomain(r.website);
    if (dom && !byDomain.has(dom)) byDomain.set(dom, r.corps_key);
    const n = normName(r.name);
    if (n) {
      const city = (r.display_city || '').toLowerCase().trim();
      if (city && !byNameCity.has(`${n}|${city}`)) byNameCity.set(`${n}|${city}`, r.corps_key);
      // First name wins; ambiguous names are better disambiguated by city above.
      if (!byName.has(n)) byName.set(n, r.corps_key);
    }
  }

  return (input: {
    website?: string | null;
    location?: string | null;
    corpsName?: string | null;
  }): CorpsMatch | null => {
    const dom = normalizeDomain(input.website);
    if (dom && byDomain.has(dom)) return { corpsKey: byDomain.get(dom)!, method: 'domain' };

    // Try TLD variants: some corps use .net while the DB has .org (e.g. stentors.net → stentors.org)
    if (dom) {
      const altTld = dom.endsWith('.net') ? dom.replace(/\.net$/, '.org') : dom.endsWith('.org') ? dom.replace(/\.org$/, '.net') : null;
      if (altTld && byDomain.has(altTld)) return { corpsKey: byDomain.get(altTld)!, method: 'domain' };
    }

    // Known aliases: parent org domains that map to corps
    const KNOWN_ALIASES: Record<string, string> = {
      'yea.org': '001j000000i6kfgaan', // YEA → The Cadets
      'cadets.org': '001j000000i6kfgaan',
      'crown.org': '001j000000iwx91aad',  // Carolina Crown alias
    };
    if (dom && KNOWN_ALIASES[dom]) return { corpsKey: KNOWN_ALIASES[dom]!, method: 'domain' };

    const n = normName(input.corpsName);
    if (n) {
      const city = (input.location || '').toLowerCase().trim();
      if (city && byNameCity.has(`${n}|${city}`))
        return { corpsKey: byNameCity.get(`${n}|${city}`)!, method: 'name+city' };
      if (byName.has(n)) return { corpsKey: byName.get(n)!, method: 'name' };
    }

    // Domain didn't match — derive name from domain with more aggressive stripping
    if (dom) {
      const core = dom
        .replace(/\.(org|com|net|us|ca|uk)$/i, '')
        .replace(/(drumandbuglecorps|drumbuglecorps|drumcorps|dbc|performingarts|youtharts|youth|corps|alumni|arts|music)/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim();
      if (core.length >= 3) {
        for (const [name, key] of byName) {
          const nn = name.replace(/\s+/g, '');
          if (nn && (nn.includes(core.replace(/\s+/g, '')) || core.replace(/\s+/g, '').includes(nn)))
            return { corpsKey: key, method: 'name' };
        }
      }
    }
    return null;
  };
};

export type CorpsResolver = Awaited<ReturnType<typeof buildCorpsResolver>>;
