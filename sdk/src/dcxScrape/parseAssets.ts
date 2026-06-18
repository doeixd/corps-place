import * as cheerio from "cheerio";

/**
 * Parse a DCX memorabilia/publication gallery page
 * (`index.cfm?roomid=<R>&view=assets&option=<category>`).
 *
 * Both the ~25 memorabilia rooms (jackets, hats, pennants, …) and the publication
 * rooms (DCW, DCN, …) render the same gallery: a grid of `.col-sm-3.well` cards,
 * each a swipebox `<a href="assets/<file>" title="<title>"><img
 * src="assets/thumbnail/<file>"></a>` plus a `<span id="Caption…">` full caption.
 *
 * Pure function over HTML — testable against saved fixtures. Per scope we capture
 * metadata + image URLs only (no bytes).
 */

export interface DcxAssetItem {
  readonly assetCode: string; // derived from the image filename (e.g. JA0001)
  readonly title: string | null; // the <a title="…">
  readonly caption: string | null; // the full <span id="Caption…"> text
  readonly imageUrl: string; // assets/<file>
  readonly thumbUrl: string | null; // assets/thumbnail/<file>
  readonly year: number | null; // parsed from caption/title if present
  readonly collection: string | null; // "from the <X> Collection"
  readonly contributor: string | null; // "Contributed by <Y>"
  readonly corpsId: string | null; // owning corps, from the card's corpslist link
  readonly corpsName: string | null;
}

/** Pull "from the <X> Collection" + "Contributed by <Y>" out of a caption. */
export const parseProvenance = (
  caption: string | null,
): { collection: string | null; contributor: string | null } => {
  if (!caption) return { collection: null, contributor: null };
  const collM = /from the\s+(.+?)\s+Collection\b/i.exec(caption);
  const contribM = /Contributed by\s+(.+?)\s*$/i.exec(caption);
  return {
    collection: collM ? collM[1].trim() : null,
    contributor: contribM ? contribM[1].trim() : null,
  };
};

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// "assets/JA0001--2.jpg" → "JA0001"; "assets/1974 DCW Christmas Cover-04072.jpg"
// → "1974 DCW Christmas Cover". Strip the path, the trailing "-NNNN"/"--N" id
// suffix, and the extension.
const codeFromUrl = (url: string): string => {
  const file = url.replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "");
  return file
    .replace(/--\d+$/, "") // duplicate-view suffix "--2"
    .replace(/-\d{3,}$/, "") // numeric asset id suffix "-04057"
    .replace(/-+$/, "")
    .trim();
};

const yearFrom = (s: string): number | null => {
  const m = /\b(19\d{2}|20\d{2})\b/.exec(s);
  return m ? Number(m[1]) : null;
};

export const parseAssetGallery = (html: string): DcxAssetItem[] => {
  const $ = cheerio.load(html);
  const items: DcxAssetItem[] = [];
  const seen = new Set<string>();

  $("a.swipebox").each((_i, a) => {
    const $a = $(a);
    const imageUrl = $a.attr("href") || "";
    if (!/^assets\//i.test(imageUrl)) return;
    const thumbUrl = $a.find("img").attr("src") || null;
    const title = clean($a.attr("title")) || null;
    // The caption span is the next sibling-ish span with id^=Caption.
    const caption =
      clean($a.parent().find('span[id^="Caption"]').first().text()) ||
      clean($a.nextAll('span[id^="Caption"]').first().text()) ||
      null;
    const assetCode = codeFromUrl(imageUrl);

    // Dedup the duplicate "--2" alternate-view rows onto the same asset code,
    // keeping the first (primary) image.
    if (seen.has(assetCode)) return;
    seen.add(assetCode);

    const year = yearFrom(caption ?? "") ?? yearFrom(title ?? "");
    const { collection, contributor } = parseProvenance(caption);
    // Each card may link to the owning corps: <a href="…corpslist&CorpsID=N">name</a>.
    const corpsLink = $a.closest(".well").find('a[href*="orpslist"]').first();
    const corpsHref = corpsLink.attr("href") || "";
    const corpsIdM = /corpsid=(\d+)/i.exec(corpsHref);
    const corpsId = corpsIdM ? corpsIdM[1] : null;
    const corpsName = clean(corpsLink.text()) || null;
    items.push({
      assetCode,
      title,
      caption,
      imageUrl,
      thumbUrl,
      year,
      collection,
      contributor,
      corpsId,
      corpsName,
    });
  });

  return items;
};

/**
 * Extract the per-page asset-id chunks from a room's `assets.cfm` response.
 * The page embeds `var AssetPage = []; AssetPage[AssetPage.length] = '2829,2830,…';`
 * one element per gallery page (20 ids each). Each chunk is fed to
 * `assets_display.cfm?…&assetlist=<chunk>` to fetch that page's cards.
 */
export const parseAssetPageChunks = (html: string): string[] => {
  const chunks: string[] = [];
  const re = /AssetPage\[AssetPage\.length\]\s*=\s*'([0-9,]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    chunks.push(m[1]);
  }
  return chunks;
};
