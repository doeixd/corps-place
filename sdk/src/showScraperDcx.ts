import { Context, Effect, Layer } from "effect";
import * as cheerio from "cheerio";
import { DcxParseError } from "./showErrors.js";

export interface DcxRepertoireEntry {
  readonly dcxCorpsName: string;
  readonly showTitle: string | null;
  readonly songs: readonly string[];
  readonly dcxCorpsId: string | null;
  readonly divisionSection: string;
}

const DCX_REPERTOIRES_URL =
  "https://www.dcxmuseum.org/index.cfm?roomid=302&view=repertoires&option=current";

const fetchRepertoirePage = Effect.fn("DcxScraper.fetchRepertoirePage")(
  function* () {
    yield* Effect.log("Fetching DCX Museum repertoire list");
    const response = yield* Effect.tryPromise({
      try: () => fetch(DCX_REPERTOIRES_URL),
      catch: (e) =>
        new DcxParseError({
          message: `Failed to fetch DCX repertoires: ${String(e)}`,
        }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new DcxParseError({
          message: `DCX fetch returned HTTP ${response.status}`,
        })
      );
    }
    const html = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (e) =>
        new DcxParseError({
          message: `Failed to read DCX response body: ${String(e)}`,
        }),
    });
    return html;
  }
);

// Pure function: parse DCX repertoire HTML → typed entries
// Exported for unit testing (no side effects, no network).
export const parseDcxRepertoireHtml = (html: string): DcxRepertoireEntry[] => {
  const $ = cheerio.load(html);
  const entries: DcxRepertoireEntry[] = [];
  let currentDivision = "";

  $("table tr").each((_i, row) => {
    const $row = $(row);
    const cells = $row.find("td");
    if (cells.length === 0) {
      const headerText = $row.text().trim();
      if (
        headerText.includes("Junior") ||
        headerText.includes("All Age") ||
        headerText.includes("Alumni") ||
        headerText.includes("International") ||
        headerText.includes("Drumline") ||
        headerText.includes("Minicorps") ||
        headerText.includes("SoundSport")
      ) {
        currentDivision = headerText;
      }
      return;
    }

    const nameLink = cells.eq(0).find("a").first();
    const corpsName = nameLink.text().trim();
    if (!corpsName) return;

    const href = nameLink.attr("href") || "";
    const corpsIdMatch = /corpsid=(\d+)/.exec(href);
    const dcxCorpsId = corpsIdMatch ? corpsIdMatch[1] : null;

    const themeCell = cells.eq(cells.length - 1);
    const titleEl = themeCell.find("font[color=RED]").first();
    const rawTitle = titleEl.text().trim();

    const songLinks = themeCell.find("a");
    const songs: string[] = [];
    songLinks.each((_j, link) => {
      const songName = $(link).text().trim();
      if (songName && songName !== "") {
        songs.push(songName);
      }
    });

    // Normalize: collapse internal whitespace/newlines to single spaces
    const normalizedTitle = rawTitle.replace(/\s+/g, " ").trim();
    let showTitle: string | null = null;
    if (
      normalizedTitle &&
      normalizedTitle !== "." &&
      normalizedTitle !== ". -" &&
      normalizedTitle !== "(Repertoire not available)" &&
      !normalizedTitle.includes("Repertoire not available")
    ) {
      showTitle = normalizedTitle;
    }

    const hasRepertoire = songs.length > 0;

    entries.push({
      dcxCorpsName: corpsName,
      showTitle,
      songs: hasRepertoire ? songs : [],
      dcxCorpsId,
      divisionSection: currentDivision,
    });
  });

  return entries;
};

/* ------------------------------------------------------------------ */
/*  Historical per-corps/per-year repertoire (Corpslist_RepYear.cfm)   */
/* ------------------------------------------------------------------ */

export interface DcxRepYearSong {
  readonly workTitle: string;
  readonly composer: string | null;
}

export interface DcxRepYearResult {
  // false when DCX returns the "Repertoire unavailable" stub (corps did not
  // compete / no data for that year).
  readonly available: boolean;
  readonly title: string | null;
  readonly position: number | null; // final-championship placement, if present
  readonly score: number | null; // final score (0.000 placeholder → null)
  readonly repertoire: readonly DcxRepYearSong[];
}

export const DCX_REPYEAR_URL = (corpsId: string, year: number): string =>
  `https://www.dcxmuseum.org/Corpslist_RepYear.cfm?ReturnAll=Y&CorpsID=${corpsId}&CorpsYear=${year}`;

// Pure: parse a Corpslist_RepYear.cfm response → typed result.
// Exported for unit testing (no network). Markup (verified across 2013–2024):
//   - "Repertoire unavailable" text + no <tbody> rows  → unavailable.
//   - <div class="blue-bg"> first occurrence = show title.
//   - <li>Position: N</li> / <li>Score: NN.NNN</li> = final-championship result.
//   - <tbody> <tr><td><a Song>title</a> <strong>by</strong> <a Composer>name</a></td>
export const parseRepYearHtml = (html: string): DcxRepYearResult => {
  const $ = cheerio.load(html);

  const title = (() => {
    const t = $("div.blue-bg").first().text().replace(/\s+/g, " ").trim();
    return t.length > 0 ? t : null;
  })();

  const liText = (label: string): string | null => {
    let found: string | null = null;
    $("li").each((_i, el) => {
      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (found === null && txt.toLowerCase().startsWith(label.toLowerCase())) {
        found = txt.slice(label.length).replace(/^[:\s]+/, "").trim();
      }
    });
    return found;
  };

  const positionRaw = liText("Position");
  const position = positionRaw && /^\d+$/.test(positionRaw) ? Number(positionRaw) : null;

  const scoreRaw = liText("Score");
  const scoreNum = scoreRaw ? Number(scoreRaw) : NaN;
  const score = Number.isFinite(scoreNum) && scoreNum > 0 ? scoreNum : null;

  const repertoire: DcxRepYearSong[] = [];
  $("tbody tr td").each((_i, td) => {
    const $td = $(td);
    const links = $td.find("a");
    if (links.length === 0) return;
    const workTitle = links.first().text().replace(/\s+/g, " ").trim();
    if (!workTitle) return;
    let composer: string | null = null;
    links.each((_j, a) => {
      const href = $(a).attr("href") || "";
      if (composer === null && /Composer=/.test(href)) {
        const c = $(a).text().replace(/\s+/g, " ").trim();
        if (c) composer = c;
      }
    });
    repertoire.push({ workTitle, composer });
  });

  const available =
    title !== null || repertoire.length > 0 || !/Repertoire unavailable/i.test($("body").text());

  return { available, title, position, score, repertoire };
};

const parseRepertoirePage = Effect.fn("DcxScraper.parseRepertoirePage")(
  function* (html: string) {
    yield* Effect.log("Parsing DCX Museum repertoire list");
    const entries = parseDcxRepertoireHtml(html);

    if (entries.length === 0) {
      return yield* Effect.fail(
        new DcxParseError({
          message: "No corps entries found in DCX repertoire page",
          htmlSnippet: html.slice(0, 500),
        })
      );
    }

    yield* Effect.log("DCX parse complete", {
      entryCount: entries.length,
      withTitle: entries.filter((e) => e.showTitle && e.showTitle !== ".").length,
      withSongs: entries.filter((e) => e.songs.length > 0).length,
    });

    return entries;
  }
);

const makeDcxScraper = Effect.gen(function* () {
    const scrapeAll = Effect.fn("DcxScraper.scrapeAll")(function* () {
      const html = yield* fetchRepertoirePage();
      const entries = yield* parseRepertoirePage(html);
      return entries;
    });

    const scrapeCorpsDetail = Effect.fn("DcxScraper.scrapeCorpsDetail")(
      function* (corpsId: string, year: number) {
        yield* Effect.log("Fetching DCX corps detail", { corpsId, year });
        const url = `https://www.dcxmuseum.org/index.cfm?view=corpslist&corpsid=${corpsId}&corpsyear=${year}`;
        const response = yield* Effect.tryPromise({
          try: () => fetch(url),
          catch: (e) =>
            new DcxParseError({
              message: `Failed to fetch DCX corps detail: ${String(e)}`,
            }),
        });
        if (!response.ok) {
          return yield* Effect.fail(
            new DcxParseError({
              message: `DCX detail fetch returned HTTP ${response.status}`,
            })
          );
        }
        const html = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) =>
            new DcxParseError({
              message: `Failed to read DCX detail body: ${String(e)}`,
            }),
        });
        // TODO: parse detail page for additional enrichment
        return { html, corpsId, year };
      }
    );

    // Fetch + parse one corps' repertoire for a single historical year.
    // Returns the parsed result plus the raw HTML so callers can archive-first.
    const scrapeRepYear = Effect.fn("DcxScraper.scrapeRepYear")(
      function* (corpsId: string, year: number) {
        const url = DCX_REPYEAR_URL(corpsId, year);
        const response = yield* Effect.tryPromise({
          try: () => fetch(url),
          catch: (e) =>
            new DcxParseError({ message: `Failed to fetch DCX RepYear: ${String(e)}` }),
        });
        if (!response.ok) {
          return yield* Effect.fail(
            new DcxParseError({ message: `DCX RepYear fetch returned HTTP ${response.status}` })
          );
        }
        const html = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) =>
            new DcxParseError({ message: `Failed to read DCX RepYear body: ${String(e)}` }),
        });
        const result = parseRepYearHtml(html);
        return { url, html, httpStatus: response.status, result };
      }
    );

    return { scrapeAll, scrapeCorpsDetail, scrapeRepYear };
});

export class DcxScraper extends Context.Service<
  DcxScraper,
  Effect.Success<typeof makeDcxScraper>
>()("DcxScraper") {}

export const DcxScraperLive = Layer.effect(DcxScraper, makeDcxScraper);
