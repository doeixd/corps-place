import * as cheerio from "cheerio";

/**
 * Parse a DCX "shows by year" page
 * (`index.cfm?roomid=202&view=shows&option=byyear`).
 *
 * Each show is one `ul.list-group`:
 *   - `li.list-group-item.active`           → date  ("June 26, 2026")
 *   - `li … .alert-info`                    → event name
 *   - `li … .alert-warning a[onclick]`      → location + showId (setMainDIV(show.cfm?…ShowID=N))
 *   - subsequent `li a[onclick=showChangeYear(year,_,corpsId)]` → corps lineup
 *
 * Pure function over HTML — testable against the saved fixture.
 */

export interface DcxShowCorps {
  readonly corpsId: string | null;
  readonly corpsName: string;
}

export interface DcxShow {
  readonly showId: string | null;
  readonly date: string | null;
  readonly year: number | null;
  readonly eventName: string | null;
  readonly location: string | null;
  readonly corps: readonly DcxShowCorps[];
}

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

const yearFrom = (s: string): number | null => {
  const m = /\b(19\d{2}|20\d{2})\b/.exec(s);
  return m ? Number(m[1]) : null;
};

export const parseShowsByYear = (html: string): DcxShow[] => {
  const $ = cheerio.load(html);
  const shows: DcxShow[] = [];

  $("ul.list-group").each((_i, ul) => {
    const $ul = $(ul);
    const date = clean($ul.find("li.list-group-item.active").first().text()) || null;
    const eventName = clean($ul.find("li .alert-info").first().text()) || null;

    const locLink = $ul.find("li .alert-warning a[onclick]").first();
    const location = clean(locLink.text()) || null;
    const showIdM = /show\.cfm\?view=show&ShowID=(\d+)/.exec(locLink.attr("onclick") || "");
    const showId = showIdM ? showIdM[1] : null;

    const corps: DcxShowCorps[] = [];
    $ul.find('li a[onclick*="showChangeYear"]').each((_j, a) => {
      const name = clean($(a).text());
      if (!name) return;
      const m = /showChangeYear\(\d+,\s*-?\d+,\s*(\d+)\)/.exec($(a).attr("onclick") || "");
      corps.push({ corpsId: m ? m[1] : null, corpsName: name });
    });

    if (!date && !eventName && corps.length === 0) return;
    shows.push({
      showId,
      date,
      year: yearFrom(date ?? ""),
      eventName,
      location,
      corps,
    });
  });

  return shows;
};
