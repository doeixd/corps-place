// Derived navigation links for a repertoire work — pure, no network.
//
// Streaming services don't expose a stable per-track deep link without an API
// lookup, so we link to each service's public SEARCH page pre-filled with the
// work (+ composer, which sharpens the match). These are navigation aids, not
// citations (see ReferencesSection for sourced references).

export interface MusicSearchLinks {
  spotify: string;
  appleMusic: string;
  youtube: string;
}

const query = (workTitle: string, composer?: string | null): string =>
  encodeURIComponent([workTitle, composer].filter(Boolean).join(' ').trim());

export const musicSearchLinks = (workTitle: string, composer?: string | null): MusicSearchLinks => {
  const q = query(workTitle, composer);
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    appleMusic: `https://music.apple.com/us/search?term=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
};

// The DCX Museum's per-corps, per-season repertoire page (show title, composers,
// placement + score). Built from the corps' stored dcx_museum_url, which carries
// the numeric DCX corps id (e.g. `...?view=corpslist&CorpsID=1790`). Returns null
// when no id is parseable (many corps have no DCX link).
export const dcxRepYearUrl = (
  dcxMuseumUrl: string | null | undefined,
  season: string
): string | null => {
  if (!dcxMuseumUrl) return null;
  const id = dcxMuseumUrl.match(/corpsid=(\d+)/i)?.[1];
  const year = season.match(/\d{4}/)?.[0];
  if (!id || !year) return null;
  return `https://www.dcxmuseum.org/Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=${id}&CorpsYear=${year}`;
};
