import * as cheerio from "cheerio";

/**
 * Parse a DCX photos room (`index.cfm?roomid=70x&view=photos&option=…`).
 *
 * Photo rooms render **photo groups** (not individual photos): a grid of
 * `.col-sm-3.well` cards, each an `<h4>` "<year> <span class=badge>N Photos</span>"
 * + a representative thumbnail + a `PhotoShowModal.cfm?PictureYear=&Photographer=&
 * corpsid=` link (the params that fetch the individual photos for that group).
 *
 * Per scope (no media bytes) we capture the group index — year, count, the
 * representative thumb URL, and the modal params — not every individual image.
 * Same shape as the corps tab-2 photo groups.
 */

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

const toIntOrNull = (s: string | null | undefined): number | null => {
  const m = /-?\d+/.exec(s ?? "");
  return m ? Number(m[0]) : null;
};

export interface DcxPhotoGroup {
  readonly year: number | null; // PictureYear (0 = unspecified)
  readonly photoCount: number | null;
  readonly thumbUrl: string | null;
  readonly corpsId: string | null;
  readonly photographer: string | null;
  readonly modalParams: string | null; // raw PhotoShowModal query string
}

export const parsePhotoRoom = (html: string): DcxPhotoGroup[] => {
  const $ = cheerio.load(html);
  const out: DcxPhotoGroup[] = [];
  const seen = new Set<string>();

  $("#PhotoDiv .col-sm-3.well, #PhotoDiv .col-sm-3").each((_i, el) => {
    const $el = $(el);
    const h4 = clean($el.find("h4").first().clone().children().remove().end().text());
    const badge = clean($el.find("h4 .badge").first().text());
    const year = toIntOrNull(h4);
    const photoCount = toIntOrNull(badge);
    const thumbUrl = $el.find("img").attr("src") || null;

    const modalHref = $el.find('a[href*="PhotoShowModal"]').attr("href") || "";
    const modalParams = modalHref.includes("?") ? modalHref.split("?")[1] : null;
    const corpsId = (/corpsid=(\d+)/i.exec(modalHref) || [])[1] ?? null;
    const photographer = decodeURIComponent((/Photographer=([^&]*)/i.exec(modalHref) || [])[1] ?? "") || null;

    if (year === null && photoCount === null && !thumbUrl) return;
    // Dedup by (year+photographer+corps) key.
    const key = `${year}|${photographer}|${corpsId}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ year, photoCount, thumbUrl, corpsId, photographer, modalParams });
  });

  return out;
};
