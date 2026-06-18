import * as cheerio from "cheerio";
import { parseAssetGallery, type DcxAssetItem } from "./parseAssets.js";

/**
 * Parse a DCX corps-detail page (`index.cfm?view=corpslist&corpsid=N`).
 *
 * One fetch carries all 7 tabs inline (Repertoire / Photos / History / Scores /
 * Members / Collections / Links). These are pure functions over the HTML string —
 * no network — so they're unit-testable against saved fixtures.
 *
 * Robustness contract: every extractor tolerates missing tabs/cells/rows and
 * returns `null`/`[]` rather than throwing. A page with no tables yields an
 * entry with empty arrays, never an exception.
 */

export interface DcxCorpsRepEntry {
  readonly year: number | null;
  readonly songs: readonly string[];
}

export interface DcxCorpsScoreYear {
  readonly year: number | null;
  readonly scoreCount: number | null;
  readonly highScore: number | null;
  // The "final show in DCX archives" line summarized inline for the year.
  readonly finalEventText: string | null;
  readonly finalPlacement: number | null;
  readonly finalScore: number | null;
}

export interface DcxCorpsMember {
  readonly memberId: string | null;
  readonly name: string;
  readonly role: string | null;
  readonly years: string | null;
}

export interface DcxCorpsPhotoGroup {
  readonly year: number | null;
  readonly photoCount: number | null;
  readonly thumbUrl: string | null;
}

export interface DcxCorpsLink {
  readonly url: string;
  readonly label: string | null;
}

export interface DcxCorpsDetail {
  readonly dcxCorpsId: string | null;
  readonly name: string | null;
  readonly nickname: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly founded: string | null;
  readonly disbanded: string | null;
  readonly status: string | null; // Active / Inactive
  readonly division: string | null; // Junior / Senior / All Age …
  readonly corpsClass: string | null; // World Class / Open Class …
  readonly logoUrl: string | null;
  readonly historyText: string | null;
  readonly repertoire: readonly DcxCorpsRepEntry[];
  readonly scores: readonly DcxCorpsScoreYear[];
  readonly members: readonly DcxCorpsMember[];
  readonly photoGroups: readonly DcxCorpsPhotoGroup[];
  readonly links: readonly DcxCorpsLink[]; // tab-7 external links
  readonly assets: readonly DcxAssetItem[]; // tab-6 corps-owned memorabilia
}

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

const toIntOrNull = (s: string | null | undefined): number | null => {
  const m = /\d+/.exec(s ?? "");
  return m ? Number(m[0]) : null;
};

const toFloatOrNull = (s: string | null | undefined): number | null => {
  const m = /\d+(?:\.\d+)?/.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

/** "Concord, CA United States" / "Founded: 1957" header block. */
const parseHeader = ($: cheerio.CheerioAPI) => {
  const name = clean($("h1").first().text()) || null;
  const headerP = clean($("h1").first().nextAll("p").first().text());

  let city: string | null = null;
  let state: string | null = null;
  let country: string | null = null;
  let founded: string | null = null;
  let disbanded: string | null = null;

  // Split off "Founded:"/"Disbanded:" annotations first.
  const foundedM = /Founded:\s*([0-9]{3,4})/i.exec(headerP);
  if (foundedM) founded = foundedM[1];
  const disbandedM = /Disbanded:\s*([0-9]{3,4})/i.exec(headerP);
  if (disbandedM) disbanded = disbandedM[1];

  const locLine = clean(headerP.replace(/Founded:.*$/i, "").replace(/Disbanded:.*$/i, ""));
  // "City, ST Country"  →  city / state / country
  const locM = /^(.*?),\s*([A-Za-z]{2,})\s*(.*)$/.exec(locLine);
  if (locM) {
    city = clean(locM[1]) || null;
    state = clean(locM[2]) || null;
    country = clean(locM[3]) || null;
  } else if (locLine) {
    country = locLine;
  }

  // Right-rail status/division/class block:  "Active Junior" <br> "World Class".
  const logoUrl = $('img[src*="corpslogos/"]').first().attr("src") || null;
  const statusBlock = $('img[src*="corpslogos/"]').closest(".col-sm-4").find('div[align="right"]');
  // Take the div that isn't the logo wrapper (has the text lines).
  let status: string | null = null;
  let division: string | null = null;
  let corpsClass: string | null = null;
  statusBlock.each((_i, el) => {
    const html = $(el).html() || "";
    if (!/corpslogos/.test(html) && /[A-Za-z]/.test($(el).text())) {
      const lines = html
        .split(/<br\s*\/?>/i)
        .map((l) => clean(cheerio.load(`<x>${l}</x>`)("x").text()))
        .filter((l) => l.length > 0);
      if (lines[0]) {
        // "Active Junior" → status + division
        const m = /^(Active|Inactive)\s*(.*)$/i.exec(lines[0]);
        if (m) {
          status = clean(m[1]) || null;
          division = clean(m[2]) || null;
        } else {
          division = lines[0];
        }
      }
      if (lines[1]) corpsClass = lines[1];
    }
  });

  return { name, city, state, country, founded, disbanded, status, division, corpsClass, logoUrl };
};

/** tab-7 Links: external links (home page, wiki, …). */
const parseLinks = ($: cheerio.CheerioAPI): DcxCorpsLink[] => {
  const out: DcxCorpsLink[] = [];
  const seen = new Set<string>();
  $('#tab-7 a[href^="http"]').each((_i, a) => {
    const url = $(a).attr("href") || "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: clean($(a).text()) || null });
  });
  return out;
};

/** tab-1 Repertoire table: Year | Position | Score | Theme/Songs. */
const parseRepertoire = ($: cheerio.CheerioAPI): DcxCorpsRepEntry[] => {
  const out: DcxCorpsRepEntry[] = [];
  $("#tab-1 #RepDiv table tbody tr, #RepDiv table tbody tr").each((_i, tr) => {
    const cells = $(tr).find("td");
    if (cells.length === 0) return;
    // Year is the onclick repDisplayYear(corps,YEAR) or the cell text.
    const yearCell = cells.eq(0);
    const onclick = yearCell.find("a").attr("onclick") || "";
    const yearM = /repDisplayYear\([^,]+,\s*(\d{3,4})\)/.exec(onclick);
    const year = yearM ? Number(yearM[1]) : toIntOrNull(clean(yearCell.text()));

    const songCell = cells.eq(cells.length - 1);
    const songs: string[] = [];
    songCell.find("a").each((_j, a) => {
      const t = clean($(a).text());
      if (t) songs.push(t);
    });
    if (year === null && songs.length === 0) return;
    out.push({ year, songs });
  });
  return out;
};

/** tab-4 Scores: ul.notes > li year-summaries. */
const parseScores = ($: cheerio.CheerioAPI): DcxCorpsScoreYear[] => {
  const out: DcxCorpsScoreYear[] = [];
  $("#tab-4 ul.notes > li, #ScoreDiv ul.notes > li").each((_i, li) => {
    const $li = $(li);
    const year = toIntOrNull(clean($li.find(".score-year").text()));
    const scoreCount = toIntOrNull(clean($li.find(".score-count").text()));
    const highScore = toFloatOrNull(clean($li.find(".high-score-footer").text()));
    const finalEventText = clean($li.find(".score-details").text()) || null;
    let finalPlacement: number | null = null;
    let finalScore: number | null = null;
    if (finalEventText) {
      const m = /placed\s+(\d+)\s+with a score of\s+([\d.]+)/i.exec(finalEventText);
      if (m) {
        finalPlacement = Number(m[1]);
        finalScore = toFloatOrNull(m[2]);
      }
    }
    if (year === null && scoreCount === null && !finalEventText) return;
    out.push({ year, scoreCount, highScore, finalEventText, finalPlacement, finalScore });
  });
  return out;
};

/** tab-5 Members footable: [icon] | Name(MemberID) | Role | Years. */
const parseMembers = ($: cheerio.CheerioAPI): DcxCorpsMember[] => {
  const out: DcxCorpsMember[] = [];
  $("#memberFoo tbody tr").each((_i, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;
    // The first cell is a sort/icon column; name is the cell with the modal link.
    const nameLink = $(tr).find('a[href*="modalmembers.cfm"]').first();
    const name = clean(nameLink.text());
    if (!name) return;
    const href = nameLink.attr("href") || "";
    const idM = /MemberID=(\d+)/i.exec(href);
    const memberId = idM ? idM[1] : null;
    // Role and years are the last two non-empty text cells.
    const texts = cells
      .toArray()
      .map((c) => clean($(c).text()))
      .filter((t) => t.length > 0 && t !== name);
    const role = texts.length >= 1 ? texts[texts.length - 2] ?? null : null;
    const years = texts.length >= 1 ? texts[texts.length - 1] ?? null : null;
    out.push({ memberId, name, role: role || null, years: years || null });
  });
  return out;
};

/** tab-2 Photos: year-grouped thumbnails. */
const parsePhotoGroups = ($: cheerio.CheerioAPI): DcxCorpsPhotoGroup[] => {
  const out: DcxCorpsPhotoGroup[] = [];
  $("#tab-2 #PhotoDiv .col-sm-3, #PhotoDiv .col-sm-3").each((_i, el) => {
    const $el = $(el);
    const h4 = clean($el.find("h4").first().text()); // "1970 1 Photos"
    const year = toIntOrNull(h4);
    const countM = /(\d+)\s+Photos?/i.exec(h4);
    const photoCount = countM ? Number(countM[1]) : null;
    const thumb = $el.find("img").attr("src") || null;
    if (year === null && photoCount === null && !thumb) return;
    out.push({ year, photoCount, thumbUrl: thumb });
  });
  return out;
};

/** tab-3 History narrative: concatenated paragraph text. */
const parseHistory = ($: cheerio.CheerioAPI): string | null => {
  const parts: string[] = [];
  $("#tab-3 .panel-body p").each((_i, p) => {
    const t = clean($(p).text());
    if (t) parts.push(t);
  });
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
};

export const parseCorpsDetail = (html: string, dcxCorpsId: string | null): DcxCorpsDetail => {
  const $ = cheerio.load(html);
  const header = parseHeader($);
  // tab-6 Collections is the same memorabilia gallery, scoped to this corps.
  const tab6 = $("#tab-6").html();
  const assets = tab6 ? parseAssetGallery(tab6) : [];
  return {
    dcxCorpsId,
    nickname: null,
    ...header,
    historyText: parseHistory($),
    repertoire: parseRepertoire($),
    scores: parseScores($),
    members: parseMembers($),
    photoGroups: parsePhotoGroups($),
    links: parseLinks($),
    assets,
  };
};
