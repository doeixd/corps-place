/**
 * Pure parsers over archived dci.org corps HTML (M2+).
 *
 * These take raw HTML (from `corps_page_scrapes`) and return structured data —
 * no network, no DB — so parsers can be improved and re-run over the archive.
 */
import * as cheerio from 'cheerio';

// Canonicalize a directory class heading to the division spelling the `corps`
// table uses. The roster page headings are mostly canonical, except it labels
// the international section just "International" (canonical: "International Class").
const canonicalDivision = (heading: string): string => {
  const h = heading.trim();
  if (/^international$/i.test(h)) return 'International Class';
  return h;
};

/* ------------------------------------------------------------------ */
/*  Discovery helpers (lineup-discovery plan)                          */
/* ------------------------------------------------------------------ */

// A real corps profile (vs. a 404/thin shell) has the corps name in an <h1> and
// the about block (`.common-dis`). dci.org 404s are caught upstream by HTTP
// status; this is the secondary content guard so a 200 "soft 404" isn't ingested.
export const isCorpsProfile = (html: string): boolean => {
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().trim();
  return h1.length > 0 && $('.common-dis').length > 0;
};

// Extract the corps' competitive class from its *about* prose (`.common-dis`)
// only — NOT the whole page, which is littered with "Drum Corps International"
// (false "International" hits) and news headlines that mention other classes.
// SoundSport is checked first: affiliate corps (the ones this fallback runs for)
// describe themselves as part of the SoundSport program, and the user prefers
// that signal. Tiered classes require the literal word "Class" to avoid the org
// name. Returns a canonical division or null.
export const parseCorpsClassFromText = (html: string): string | null => {
  const $ = cheerio.load(html);
  const about = $('.common-dis')
    .map((_, el) => $(el).text())
    .get()
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!about) return null;
  if (/\bSoundSport\b/i.test(about)) return 'SoundSport';
  if (/\bWorld Class\b/i.test(about)) return 'World Class';
  if (/\bOpen Class\b/i.test(about)) return 'Open Class';
  if (/\bAll[-\s]?Age(?:\s+Class)?\b/i.test(about)) return 'All Age Class';
  if (/\bInternational Class\b/i.test(about)) return 'International Class';
  return null;
};

export interface DirectoryCorps {
  readonly slug: string;
  readonly name: string;
  /** Canonical division name (e.g. "World Class"), from the section heading. */
  readonly division: string;
  readonly logo: string | null;
}

export interface DirectoryRoster {
  /** Class section headings encountered, in document order. */
  readonly classes: readonly string[];
  readonly corps: readonly DirectoryCorps[];
}

// Parse the `/corps/` roster: corps are grouped under class-section headings
// (World Class, Open Class, All Age Class, International, SoundSport). Each corps
// is a logo anchor `…/corps/<slug>/` wrapping an `<img alt="Name" src="logo">`;
// it inherits the division of the nearest preceding heading.
export const parseCorpsDirectory = (html: string): DirectoryRoster => {
  const headingRe =
    /<(h[1-4])[^>]*>\s*((?:World|Open|All[- ]?Age|International|SoundSport)[^<]*?)\s*<\/\1>/gi;
  const headings: { pos: number; division: string }[] = [];
  for (let m = headingRe.exec(html); m; m = headingRe.exec(html)) {
    headings.push({ pos: m.index, division: canonicalDivision(m[2]) });
  }

  const boxRe =
    /href="https?:\/\/www\.dci\.org\/corps\/([a-z0-9-]+)\/"[^>]*>\s*<img\b[^>]*?\balt="([^"]*)"[^>]*>/gi;
  const corps: DirectoryCorps[] = [];
  const seen = new Set<string>();
  for (let m = boxRe.exec(html); m; m = boxRe.exec(html)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = m[2].trim();
    const logo = /\bsrc="([^"]*)"/.exec(m[0])?.[1] ?? null;
    // Division = nearest heading before this corps box.
    let division = '';
    for (const h of headings) {
      if (h.pos < m.index) division = h.division;
      else break;
    }
    corps.push({ slug, name, division, logo });
  }

  return { classes: headings.map((h) => h.division), corps };
};

/* ------------------------------------------------------------------ */
/*  Profile parser (M3)                                               */
/* ------------------------------------------------------------------ */

// Map a URL to a known social platform, or null if it's not one we track. Note
// the corps contact card lists socials *and* the website together, so the
// website is whatever link in that block isn't a recognized social platform.
const socialPlatform = (
  url: string
): 'facebook' | 'twitter' | 'instagram' | 'youtube' | 'linkedIn' | null => {
  const u = url.toLowerCase();
  if (u.includes('facebook.com')) return 'facebook';
  if (u.includes('twitter.com') || /(^|\/\/)(www\.)?x\.com\//.test(u)) return 'twitter';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('linkedin.com')) return 'linkedIn';
  return null;
};

const cleanSocialUrl = (
  href: string,
  platform: 'facebook' | 'twitter' | 'instagram' | 'youtube' | 'linkedIn'
): string => {
  if (platform !== 'twitter') return href;
  return href.replace(
    /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i,
    'https://twitter.com/'
  );
};

export interface CorpsProfile {
  /** Name as shown on the page (Yoast title), best-effort; prefer the roster name. */
  readonly name: string | null;
  readonly website: string | null;
  readonly facebook: string | null;
  readonly twitter: string | null;
  readonly instagram: string | null;
  readonly youtube: string | null;
  readonly linkedIn: string | null;
  /** Hometown "City, ST" as shown in the contact card. */
  readonly hometown: string | null;
  readonly city: string | null;
  readonly state: string | null;
  /** Full street address from the contact card (SVG noise stripped). */
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  /** Corps "about" prose from the profile body. */
  readonly about: string | null;
  readonly logo: string | null;
  /** Wide banner image at the top of the profile (distinct from the logo). */
  readonly coverImage: string | null;
  readonly mmdlAudio: string | null;
  readonly mmdlVideo: string | null;
  readonly metaDescription: string | null;
  /**
   * Everything the contact card linked, plus notes — kept so nothing is lost and
   * future parsers can mine it. (DCI profile pages have no rich about / staff /
   * gallery as of 2026; this is the explore bucket.)
   */
  readonly raw: { readonly contactLinks: readonly string[] };
}

// Clean the visible text of the first match: drop inline SVG (which carries
// Sketch "title/desc" noise) and collapse whitespace.
const cleanText = ($: cheerio.CheerioAPI, selector: string): string => {
  const el = $(selector).first().clone();
  el.find('svg').remove();
  return el.text().replace(/\s+/g, ' ').trim();
};

export const parseCorpsProfile = (html: string): CorpsProfile => {
  const $ = cheerio.load(html);

  // Contact card: `.social` holds the corps' own social links + website (NOT
  // DCI's site-wide header/footer socials, which live in elementor widgets).
  const contactLinks = [
    ...new Set(
      $('.social a[href]')
        .map((_, a) => $(a).attr('href') ?? '')
        .get()
        .filter((h) => /^https?:\/\//i.test(h))
    ),
  ];
  const mmdlLinks = [
    ...new Set(
      $('a[href*="marchingmusicdownloads.com"]')
        .map((_, a) => $(a).attr('href') ?? '')
        .get()
        .filter((h) => /^https?:\/\//i.test(h))
    ),
  ];

  const social: Record<string, string | null> = {
    facebook: null,
    twitter: null,
    instagram: null,
    youtube: null,
    linkedIn: null,
  };
  let website: string | null = null;
  for (const href of contactLinks) {
    const platform = socialPlatform(href);
    if (platform) social[platform] ??= cleanSocialUrl(href, platform);
    else website ??= href; // first non-social link in the card = website
  }

  const address = cleanText($, '.address') || null;
  const hometown = cleanText($, '.location') || null;
  let city: string | null = null;
  let state: string | null = null;
  if (hometown) {
    const m = /^(.*?),\s*([A-Za-z]{2})\b/.exec(hometown);
    if (m) {
      city = m[1].trim();
      state = m[2].toUpperCase();
    }
  }

  // Phone / email live in the contact list; scope to it so DCI's site-wide
  // footer contacts aren't picked up.
  const stripScheme = (href: string | undefined, scheme: string) =>
    href ? href.replace(new RegExp(`^${scheme}:`, 'i'), '').trim() || null : null;
  const phone = stripScheme(
    $('.address-user-download a[href^="tel:"]').first().attr('href'),
    'tel'
  );
  const email = stripScheme(
    $('.address-user-download a[href^="mailto:"]').first().attr('href'),
    'mailto'
  );

  // About prose from the profile body.
  const about =
    $('.common-dis')
      .first()
      .find('p')
      .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .join('\n\n') || null;

  // The hero holds two corps images in a stable order: [0] = wide cover banner,
  // [1] = logo (verified to match the directory roster logo).
  const heroImages = [
    ...new Set(
      $('.hero-section img[alt], .inner-hero img[alt]')
        .map((_, im) => $(im).attr('src') ?? '')
        .get()
        .filter((s) => /production\.assets\.dci\.org/i.test(s))
    ),
  ];
  const coverImage = heroImages[0] ?? null;
  const logo = heroImages[1] ?? heroImages[0] ?? null;

  const title = $('title').first().text().trim();
  const name = title ? title.replace(/\s*Corp[:’'].*$/i, '').trim() || null : null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const mmdlAudio = mmdlLinks.find((href) => /audio(?:\+|%20|\s)?download/i.test(href)) ?? null;
  const mmdlVideo = mmdlLinks.find((href) => /video(?:\+|%20|\s)?download/i.test(href)) ?? null;

  return {
    name,
    website,
    facebook: social.facebook,
    twitter: social.twitter,
    instagram: social.instagram,
    youtube: social.youtube,
    linkedIn: social.linkedIn,
    hometown,
    city,
    state,
    address,
    phone,
    email,
    about,
    logo,
    coverImage,
    mmdlAudio,
    mmdlVideo,
    metaDescription,
    raw: { contactLinks },
  };
};
