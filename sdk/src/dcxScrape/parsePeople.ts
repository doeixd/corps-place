import * as cheerio from "cheerio";

/**
 * Parse DCX "People" room pages (`index.cfm?roomid=80x&view=people&option=…`).
 *
 * Two shapes seen:
 *  - **biographies** (`option=biographies`): a grid of `.col-sm-3.well` cards,
 *    each a PDF document — `<a href="assets/<file>.pdf" title="<title>">` + a
 *    `<span id="Caption…">` with "… Contributed by <name>".
 *  - **halloffame** (`option=halloffame`): an *index* of links to the individual
 *    halls (`view=wdchof`, `view=dcihof`, `view=bughof`, …) — not people rows
 *    themselves; the member lists live on those sub-pages (followed separately).
 *
 * Pure functions over HTML — testable against saved fixtures.
 */

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

export interface DcxBiography {
  readonly title: string | null; // document title
  readonly docUrl: string; // assets/<file>.pdf
  readonly thumbUrl: string | null;
  readonly caption: string | null; // full caption text
  readonly contributor: string | null; // parsed from "Contributed by …"
}

export const parseBiographies = (html: string): DcxBiography[] => {
  const $ = cheerio.load(html);
  const out: DcxBiography[] = [];
  const seen = new Set<string>();

  $('a[href$=".pdf"], a[href*=".pdf"]').each((_i, a) => {
    const $a = $(a);
    const docUrl = $a.attr("href") || "";
    if (!/^assets\//i.test(docUrl)) return;
    if (seen.has(docUrl)) return;
    seen.add(docUrl);

    const title = clean($a.attr("title")) || null;
    const thumbUrl = $a.find("img").attr("src") || null;
    const caption =
      clean($a.parent().find('span[id^="Caption"]').first().text()) ||
      clean($a.nextAll('span[id^="Caption"]').first().text()) ||
      null;
    let contributor: string | null = null;
    const cm = /Contributed by\s+(.+?)\s*$/i.exec(caption ?? "");
    if (cm) contributor = clean(cm[1]) || null;

    out.push({ title, docUrl, thumbUrl, caption, contributor });
  });

  return out;
};

export interface DcxHofLink {
  readonly view: string; // e.g. "dcihof"
  readonly name: string; // link label
}

export interface DcxHofPage {
  readonly title: string | null;
  readonly bodyText: string | null;
}

/** Extract a Hall-of-Fame sub-page's article title + prose text. */
export const parseHofPage = (html: string): DcxHofPage => {
  const $ = cheerio.load(html);
  const article = $("article").first();
  const root = article.length > 0 ? article : $(".ibox-content").first();
  const title = clean(root.find("h1").first().text()) || clean($("h1").first().text()) || null;
  // Drop scripts/styles, then take the article's visible text.
  root.find("script,style").remove();
  const bodyText = clean(root.text()) || null;
  return { title, bodyText };
};

/** The halloffame index: links to each individual hall's sub-page. */
export const parseHallOfFameIndex = (html: string): DcxHofLink[] => {
  const $ = cheerio.load(html);
  const out: DcxHofLink[] = [];
  const seen = new Set<string>();
  $('a[href*="hof"]').each((_i, a) => {
    const href = $(a).attr("href") || "";
    const m = /view=([a-z0-9]*hof)/i.exec(href);
    if (!m) return;
    const view = m[1];
    if (seen.has(view)) return;
    seen.add(view);
    out.push({ view, name: clean($(a).text()) });
  });
  return out;
};
