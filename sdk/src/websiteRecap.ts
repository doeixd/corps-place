import * as cheerio from "cheerio";
import { Effect } from "effect";

import * as Domain from "./domain.js";

export class WebsiteRecapParseError {
  readonly _tag = "WebsiteRecapParseError";

  constructor(readonly message: string, readonly originalError?: unknown) {}
}

const cleanText = (text: string | undefined | null): string =>
  (text ?? "").replace(/\s\s+/g, " ").trim();

const parseNumber = (text: string | undefined | null): number => {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned === "--") return 0;
  const num = Number.parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
};

const parseRank = (text: string | undefined | null): number | undefined => {
  const value = parseNumber(text);
  return value > 0 ? Math.floor(value) : undefined;
};

const normalizeKey = (value: string) =>
  cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const normalizeSubCaption = (text: string): string => {
  const key = normalizeKey(text).replace(/\s+/g, "");
  if (key.startsWith("rep")) return "repertoire";
  if (key.startsWith("perf")) return "performance";
  if (key.startsWith("cont")) return "content";
  if (key.startsWith("ach")) return "achievement";
  if (key.startsWith("comp")) return "composition";
  return key || normalizeKey(text);
};

const parseDciDateToIso = (value: string | undefined | null): string | null => {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0] ?? null;
  }
  const match = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!match) return null;
  const [month, day, year] = match.slice(1).map((part) => part.padStart(2, "0"));
  const normalizedYear = year.length === 2 ? `20${year}` : year;
  return `${normalizedYear}-${month}-${day}`;
};

const parseDciDate = (value: string | undefined | null): Date => {
  const iso = parseDciDateToIso(value);
  if (iso) {
    return new Date(`${iso}T00:00:00.000Z`);
  }
  return new Date();
};

const extractScoreCell = (
  $: cheerio.CheerioAPI,
  $cell: cheerio.Cheerio<any>
): Domain.WebsiteScoreResult => {
  const spans = $cell.find("span");
  if (spans.length >= 2) {
    return {
      value: parseNumber($(spans[0]).text()),
      rank: parseRank($(spans[1]).text())
    };
  }
  return {
    value: parseNumber($cell.text()),
    rank: parseRank($cell.text())
  };
};

const normalizeCaptionKey = (value: string) =>
  normalizeKey(value).replace(/\s+/g, "");

const captionDefinitions: Array<{
  keys: string[];
  name: string;
  initials: string;
}> = [
  { keys: ["ge1", "generalEffect1", "generaleffect1"], name: "General Effect 1", initials: "GE 1" },
  { keys: ["ge2", "generalEffect2", "generaleffect2"], name: "General Effect 2", initials: "GE 2" },
  { keys: ["visualproficiency", "visualperf", "vp"], name: "Visual Proficiency", initials: "VP" },
  { keys: ["visualanalysis", "va"], name: "Visual - Analysis", initials: "VA" },
  { keys: ["colorguard", "cg"], name: "Color Guard", initials: "CG" },
  { keys: ["musicbrass", "brass", "mb"], name: "Music - Brass", initials: "MB" },
  { keys: ["musicanalysis", "ma"], name: "Music - Analysis", initials: "MA" },
  { keys: ["musicpercussion", "percussion", "mp"], name: "Music - Percussion", initials: "MP" }
];

const resolveCaptionDefinition = (raw: string) => {
  const key = normalizeCaptionKey(raw);
  for (const def of captionDefinitions) {
    if (def.keys.some((entry) => key === entry)) {
      return def;
    }
  }
  return {
    name: cleanText(raw),
    initials: cleanText(raw) || "UNK"
  };
};

const resolveSubcaptionDefinition = (raw: string) => {
  const key = normalizeSubCaption(raw);
  switch (key) {
    case "content":
      return { name: "Content", initials: "Cont" };
    case "achievement":
      return { name: "Achievement", initials: "Achv" };
    case "repertoire":
      return { name: "Repertoire", initials: "Rep" };
    case "performance":
      return { name: "Performance", initials: "Perf" };
    case "composition":
      return { name: "Composition", initials: "Comp" };
    default:
      return { name: cleanText(raw), initials: cleanText(raw) || "UNK" };
  }
};

const splitJudgeName = (value: string) => {
  const cleaned = cleanText(value);
  if (!cleaned || /^[.\-–—]+$/.test(cleaned)) {
    return { firstName: undefined, lastName: undefined };
  }
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) {
    return { firstName: undefined, lastName: undefined };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: undefined };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
};

const inferDivisionName = (title: string): Domain.DivisionName => {
  const key = normalizeKey(title);
  // Check "all age" first since strings like "All-Age - Open Class" should be classified as All Age
  if (key.includes("all age")) return "All Age Class";
  if (key.includes("soundsport")) return "SoundSport";
  if (key.includes("international")) return "International Class";
  if (key.includes("open class")) return "Open Class";
  if (key.includes("world class")) return "World Class";
  return "World Class";
};

const inferRound = (title: string) => {
  const key = normalizeKey(title);
  if (key.includes("final")) return "Finals";
  if (key.includes("semi")) return "Semifinals";
  if (key.includes("prelim")) return "Prelims";
  return "";
};

const inferSeason = (slug: string, dateText?: string) => {
  const dateIso = parseDciDateToIso(dateText);
  if (dateIso) {
    return dateIso.slice(0, 4);
  }
  const match = slug.match(/^(\d{4})-/);
  return match?.[1] ?? "";
};

export const scoresListUrl = (season?: string, page = 1) => {
  const params = new URLSearchParams({
    location: "",
    season: season ?? "",
    pageno: String(page)
  });
  return `https://www.dci.org/scores/?${params.toString()}`;
};

export const recapUrl = (slug: string) => `https://www.dci.org/scores/recap/${slug}`;

export const parseScoresListHtml = (html: string, season?: string) =>
  Effect.gen(function* () {
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (error) => new WebsiteRecapParseError("Failed to load score list HTML", error)
      })
    );

    const entries: Domain.WebsiteScoreListEntry[] = [];
    const rows = $("#score-container .tbl-row").not(".poweredby-row");
    const scoreTableRows = $(".score-tbl .tbl-row").not(".poweredby-row");
    const allRows = $(".tbl-row").not(".poweredby-row");
    const fallbackRows =
      rows.length > 0 ? rows : scoreTableRows.length > 0 ? scoreTableRows : allRows;

    fallbackRows.each((_, el) => {
      const $row = $(el);
      const columns = $row.find(".row > div");
      const cells = columns.length > 0 ? columns : $row.find("> div");
      const title = cleanText(cells.eq(0).text());
      const date = cleanText(cells.eq(1).text());
      const location = cleanText(cells.eq(2).text());
      const linkEl = cells.eq(3).find("a");
      const href = linkEl.attr("href") ?? "";
      if (!title || !href) return;

      const absoluteUrl = href.startsWith("http") ? href : `https://www.dci.org${href}`;
      const parsedUrl = new URL(absoluteUrl);
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      const recapIndex = pathParts.indexOf("recap");
      const slug = recapIndex >= 0 ? pathParts[recapIndex + 1] : pathParts[pathParts.length - 1];
      if (!slug) return;

      entries.push({
        id: slug,
        title,
        date,
        location,
        url: absoluteUrl
      });
    });

    return {
      kind: "list" as const,
      season: season ?? undefined,
      entries
    } satisfies Domain.WebsiteScoreList;
  });

interface JudgeHeaderDef {
  readonly caption: string;
  readonly judge: string;
  readonly subCols: string[];
}

interface RecapSchema {
  readonly generalEffect: JudgeHeaderDef[];
  readonly visual: JudgeHeaderDef[];
  readonly music: JudgeHeaderDef[];
}

export const parseRecapHtml = (html: string) =>
  Effect.gen(function* () {
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (error) => new WebsiteRecapParseError("Failed to load recap HTML", error)
      })
    );

    const extractMeta = (): Domain.WebsiteRecapMetadata => {
      const dateText = $(".score-date-location p").first().text();
      const locationText = $(".score-date-location p").eq(1).text();
      const chiefJudgeText = $(".elementor-post-info__item--type-custom").text();

      return {
        date: cleanText(dateText),
        location: cleanText(locationText),
        title: cleanText($(".elementor-widget-theme-post-title h1").text()),
        chiefJudge: cleanText(chiefJudgeText).replace(/^Chief Judge:\s*/i, "")
      };
    };

    const meta = extractMeta();

    // Find all class section headers
    const classSections = $("div > h2.h4").filter((_, el) => {
      const text = $(el).text().trim();
      return /^(Open Class|All-Age|World Class|International|SoundSport)/i.test(text);
    });

    const classes: Domain.WebsiteClassTable[] = [];

    // If no class headers found, try to parse as a single-table page (legacy format)
    if (classSections.length === 0) {
      const singleTable = $(".recap-tbl").first();
      if (singleTable.length === 0) {
        return yield* (
          Effect.fail(
            new WebsiteRecapParseError(`Invalid recap HTML: no recap table found for ${meta.title}`)
          )
        );
      }

      // Parse single table with inferred class name from page title
      const className = meta.title;
      const headerRow = singleTable.find("tr.table-top").first();

      const parseHeaderColumn = (columnIndex: number): JudgeHeaderDef[] => {
        const colTd = headerRow.find("> td").eq(columnIndex);
        const headers: JudgeHeaderDef[] = [];

        colTd.find("table.table-head").each((_, tbl) => {
          const $tbl = $(tbl);
          const caption = cleanText($tbl.find("tr:nth-child(1) td").text());
          const judge = cleanText($tbl.find("tr:nth-child(2) td").text());

          const subCols: string[] = [];
          $tbl.find("tr.head td").each((_, el) => {
            const txt = cleanText($(el).text());
            if (txt.toUpperCase() !== "TOT") {
              subCols.push(normalizeSubCaption(txt));
            }
          });

          headers.push({ caption, judge, subCols });
        });
        return headers;
      };

      const schema: RecapSchema = {
        generalEffect: parseHeaderColumn(1),
        visual: parseHeaderColumn(2),
        music: parseHeaderColumn(3)
      };

      if (
        schema.generalEffect.length === 0 &&
        schema.visual.length === 0 &&
        schema.music.length === 0
      ) {
        return yield* (
          Effect.fail(
            new WebsiteRecapParseError(`Invalid recap HTML: no score columns detected for ${meta.title}`)
          )
        );
      }

      const dataRows = singleTable.find("> table > tbody > tr").not(".table-top");
      const corpsRecaps: Domain.WebsiteCorpsRecap[] = [];

      dataRows.each((_, row) => {
        const $r = $(row);
        const name = cleanText($r.find(".sticky-td").text());
        if (!name) return;

        const parseCategory = (
          colIndex: number,
          headerDefs: JudgeHeaderDef[]
        ): Domain.WebsiteCategoryResult => {
          const catTd = $r.find("> td").eq(colIndex);
          const judgeTables = catTd.find("table.data");
          const judges: Domain.WebsiteJudgeCaption[] = [];

          headerDefs.forEach((def, i) => {
            const $tbl = judgeTables.eq(i);
            const tds = $tbl.find("td");

            const subCaptions: Record<string, Domain.WebsiteScoreResult> = {};
            def.subCols.forEach((subKey, k) => {
              subCaptions[subKey] = extractScoreCell($, tds.eq(k));
            });

            judges.push({
              judgeName: def.judge,
              captionName: def.caption,
              subCaptions,
              total: extractScoreCell($, tds.last())
            });
          });

          const totalCell = catTd.find(".data-total").first();

          return {
            judges,
            total: extractScoreCell($, totalCell)
          };
        };

        const finalCell = extractScoreCell($, $r.find("> td").last());

        corpsRecaps.push({
          corpsName: name,
          generalEffect: parseCategory(1, schema.generalEffect),
          visual: parseCategory(2, schema.visual),
          music: parseCategory(3, schema.music),
          subTotal: parseNumber($r.find("> td").eq(4).text()),
          penalties: parseNumber($r.find("> td.penalties-td").text()),
          finalScore: finalCell.value,
          finalRank: finalCell.rank ?? 0
        });
      });

      classes.push({
        className,
        corps: corpsRecaps
      });

      return {
        kind: "recap" as const,
        meta,
        classes
      } satisfies Domain.WebsiteRecap;
    }

    classSections.each((_, h2El) => {
      const $h2 = $(h2El);
      const className = cleanText($h2.text());

      // The recap table is in the next sibling div
      const $recapTbl = $h2.parent().next();

      if (!$recapTbl.hasClass("recap-tbl")) {
        return; // Skip if no recap table found
      }

      // Get the first header row to parse the schema for this table
      const headerRow = $recapTbl.find("tr.table-top").first();

      const parseHeaderColumn = (columnIndex: number): JudgeHeaderDef[] => {
        const colTd = headerRow.find("> td").eq(columnIndex);
        const headers: JudgeHeaderDef[] = [];

        colTd.find("table.table-head").each((_, tbl) => {
          const $tbl = $(tbl);
          const caption = cleanText($tbl.find("tr:nth-child(1) td").text());
          const judge = cleanText($tbl.find("tr:nth-child(2) td").text());

          const subCols: string[] = [];
          $tbl.find("tr.head td").each((_, el) => {
            const txt = cleanText($(el).text());
            if (txt.toUpperCase() !== "TOT") {
              subCols.push(normalizeSubCaption(txt));
            }
          });

          headers.push({ caption, judge, subCols });
        });
        return headers;
      };

      const schema: RecapSchema = {
        generalEffect: parseHeaderColumn(1),
        visual: parseHeaderColumn(2),
        music: parseHeaderColumn(3)
      };

      if (
        schema.generalEffect.length === 0 &&
        schema.visual.length === 0 &&
        schema.music.length === 0
      ) {
        return; // Skip tables with no valid schema
      }

      // Get data rows for this specific table only (use > for direct children)
      const dataRows = $recapTbl.find("> table > tbody > tr").not(".table-top");
      const corpsRecaps: Domain.WebsiteCorpsRecap[] = [];

      dataRows.each((_, row) => {
        const $r = $(row);
        const name = cleanText($r.find(".sticky-td").text());
        if (!name) return;

        const parseCategory = (
          colIndex: number,
          headerDefs: JudgeHeaderDef[]
        ): Domain.WebsiteCategoryResult => {
          const catTd = $r.find("> td").eq(colIndex);
          const judgeTables = catTd.find("table.data");
          const judges: Domain.WebsiteJudgeCaption[] = [];

          headerDefs.forEach((def, i) => {
            const $tbl = judgeTables.eq(i);
            const tds = $tbl.find("td");

            const subCaptions: Record<string, Domain.WebsiteScoreResult> = {};
            def.subCols.forEach((subKey, k) => {
              subCaptions[subKey] = extractScoreCell($, tds.eq(k));
            });

            judges.push({
              judgeName: def.judge,
              captionName: def.caption,
              subCaptions,
              total: extractScoreCell($, tds.last())
            });
          });

          const totalCell = catTd.find(".data-total").first();

          return {
            judges,
            total: extractScoreCell($, totalCell)
          };
        };

        const finalCell = extractScoreCell($, $r.find("> td").last());

        corpsRecaps.push({
          corpsName: name,
          generalEffect: parseCategory(1, schema.generalEffect),
          visual: parseCategory(2, schema.visual),
          music: parseCategory(3, schema.music),
          subTotal: parseNumber($r.find("> td").eq(4).text()),
          penalties: parseNumber($r.find("> td.penalties-td").text()),
          finalScore: finalCell.value,
          finalRank: finalCell.rank ?? 0
        });
      });

      classes.push({
        className,
        corps: corpsRecaps
      });
    });

    if (classes.length === 0) {
      return yield* (
        Effect.fail(
          new WebsiteRecapParseError(`Invalid recap HTML: no valid class tables parsed for ${meta.title}`)
        )
      );
    }

    return {
      kind: "recap" as const,
      meta,
      classes
    } satisfies Domain.WebsiteRecap;
  });

export const buildCompetitionFromWebsiteRecap = (
  slug: string,
  recap: Domain.WebsiteRecap,
  entry?: Domain.WebsiteScoreListEntry
): Domain.Competition => {
  const season = inferSeason(slug, entry?.date ?? recap.meta.date);
  const title = entry?.title ?? recap.meta.title;
  const location = entry?.location ?? recap.meta.location;
  const dateText = entry?.date ?? recap.meta.date;
  // Many small early-season recaps (notably 2013–2015) only publish totals +
  // penalties with no GE/Visual/Music caption breakdown. Derive the caption
  // flag from what we actually parsed instead of optimistically claiming true,
  // so the UI/ML can tell "no breakdown published" apart from "scrape pending".
  const hasCaptionBreakdown = recap.classes.some((cls) =>
    cls.corps.some(
      (corps) =>
        corps.generalEffect.judges.length > 0 ||
        corps.visual.judges.length > 0 ||
        corps.music.judges.length > 0
    )
  );
  return {
    slug,
    eventName: title,
    competitionGUID: "",
    competitionLevel: 0,
    location,
    date: parseDciDate(dateText),
    chiefJudge: recap.meta.chiefJudge,
    scoresReleased: true,
    recapReleased: true,
    categoryRecapReleased: hasCaptionBreakdown,
    seasonGUID: "",
    seasonName: season,
    groupTypes: []
  };
};

const buildCategoryScores = (
  categoryName: string,
  result: Domain.WebsiteCategoryResult
): Domain.CategoryScore => {
  const captions: Domain.JudgeCaption[] = result.judges.map((judge, index) => {
    const captionDef = resolveCaptionDefinition(judge.captionName);
    const judgeNames = splitJudgeName(judge.judgeName);
    const subcaptions = Object.entries(judge.subCaptions).map(([key, score]) => {
      const subDef = resolveSubcaptionDefinition(key);
      return {
        Name: subDef.name,
        Initials: subDef.initials,
        Score: score.value,
        Rank: score.rank ?? 0
      };
    });

    return {
      Name: captionDef.name,
      Initials: captionDef.initials,
      Judge: index + 1,
      JudgeFirstName: judgeNames.firstName,
      JudgeLastName: judgeNames.lastName,
      Score: judge.total.value,
      Rank: judge.total.rank ?? 0,
      Subcaptions: subcaptions
    };
  });

  return {
    Name: categoryName,
    Initials: undefined,
    Score: result.total.value,
    Rank: result.total.rank ?? 0,
    Captions: captions
  };
};

export interface CorpsDivisionMap {
  readonly [corpsName: string]: Domain.DivisionName;
}

export const buildCorpsScoresFromWebsiteRecap = (
  competition: Domain.Competition,
  recap: Domain.WebsiteRecap,
  corpsDivisionMap?: CorpsDivisionMap
): Domain.CorpsScore[] => {
  const round = inferRound(recap.meta.title);
  const allScores: Domain.CorpsScore[] = [];

  // Iterate through all class tables
  for (const classTable of recap.classes) {
    // Infer division name from the class table's className
    const tableDivisionName = inferDivisionName(classTable.className);

    const classScores = classTable.corps.map((corp) => {
      // First try to look up the corps' actual division from the map
      // This handles mixed-division tables where the header is misleading
      const normalizedCorpsName = normalizeKey(corp.corpsName);
      let divisionName = tableDivisionName;

      if (corpsDivisionMap && normalizedCorpsName) {
        // Try exact match first
        const lookupDivision = corpsDivisionMap[normalizedCorpsName];
        if (lookupDivision) {
          divisionName = lookupDivision;
        } else {
          // Try case-insensitive match
          const lcName = corp.corpsName.toLowerCase();
          for (const [key, value] of Object.entries(corpsDivisionMap)) {
            if (key.toLowerCase() === lcName) {
              divisionName = value;
              break;
            }
          }
        }
      }

      return {
        groupName: corp.corpsName,
        divisionName,
        orgGroupIdentifier: "",
        active: true,
        isOtherType: false,
        totalScore: corp.finalScore,
        subtotalScore: corp.subTotal,
        subtotalRank: undefined,
        round,
        rank: corp.finalRank,
        categories: [
          buildCategoryScores("General Effect", corp.generalEffect),
          buildCategoryScores("Visual", corp.visual),
          buildCategoryScores("Music", corp.music)
        ],
        competition
      };
    });

    allScores.push(...classScores);
  }

  return allScores;
};
