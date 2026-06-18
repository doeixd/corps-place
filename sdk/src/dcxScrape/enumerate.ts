import * as cheerio from "cheerio";

/**
 * Enumerators: list pages → entity-id lists. Pure functions over HTML so they're
 * testable; the orchestrator fetches the list page then enqueues a detail task
 * per id.
 */

const BASE = "https://www.dcxmuseum.org/index.cfm";

export const CORPS_LIST_URL = (option: string): string =>
  `${BASE}?roomid=101&view=corps&option=${option}`;

export const CORPS_DETAIL_URL = (corpsId: string): string =>
  `${BASE}?view=corpslist&corpsid=${corpsId}`;

export const SHOWS_BYYEAR_URL = `${BASE}?roomid=202&view=shows&option=byyear`;
export const BIOGRAPHIES_URL = `${BASE}?roomid=804&view=people&option=biographies`;
export const HOF_INDEX_URL = `${BASE}?roomid=802&view=people&option=halloffame`;
export const HOF_PAGE_URL = (view: string): string => `${BASE}?view=${view}`;

/** Memorabilia + publication asset rooms: { roomid, option } → category=option. */
export const ASSET_ROOMS: ReadonlyArray<{ roomid: number; option: string }> = [
  // 900/1200 memorabilia
  { roomid: 1201, option: "jackets" },
  { roomid: 1202, option: "hats" },
  { roomid: 1203, option: "buttons" },
  { roomid: 1204, option: "pennants" },
  { roomid: 1205, option: "flags" },
  { roomid: 1206, option: "pins" },
  { roomid: 1207, option: "tshirts" },
  { roomid: 1208, option: "programbooks" },
  { roomid: 1209, option: "publicitybrochures" },
  { roomid: 1210, option: "posters" },
  { roomid: 1211, option: "yearbooks" },
  { roomid: 1212, option: "miscellaneous" },
  { roomid: 1213, option: "BumperStickers" },
  { roomid: 1214, option: "decals" },
  { roomid: 1215, option: "patches" },
  { roomid: 1216, option: "WayneHillerPaintings" },
  { roomid: 1217, option: "mugs" },
  { roomid: 1219, option: "Souvenirs" },
  { roomid: 1220, option: "covers" },
  { roomid: 1222, option: "dccollect" },
  // 1000 instruments
  { roomid: 1001, option: "guard" },
  { roomid: 1002, option: "percussion" },
  { roomid: 1003, option: "brass" },
  // 1100 publications
  { roomid: 1101, option: "dcw" },
  { roomid: 1103, option: "dcn" },
  { roomid: 1102, option: "historybooks" },
];

export const ASSET_ROOM_URL = (roomid: number, option: string): string =>
  `${BASE}?roomid=${roomid}&view=assets&option=${option}`;

// The gallery's real (paginated) endpoints. `assets.cfm` embeds the AssetPage[]
// id chunks; `assets_display.cfm` returns one page's cards for a chunk.
// NOTE: assets_display.cfm 500s without roomid+option context.
export const ASSET_ROOM_CFM_URL = (roomid: number, option: string): string =>
  `https://www.dcxmuseum.org/assets.cfm?roomid=${roomid}&option=${option}`;

export const ASSET_DISPLAY_URL = (roomid: number, option: string, assetlist: string): string =>
  `https://www.dcxmuseum.org/assets_display.cfm?roomid=${roomid}&option=${option}&assetlist=${assetlist}`;

/** Room-700 photo galleries (render photo *groups* inline; no pagination). */
export const PHOTO_ROOMS: ReadonlyArray<{ roomid: number; option: string }> = [
  { roomid: 701, option: "recent" },
  { roomid: 702, option: "photographer" },
  { roomid: 703, option: "historical" },
  { roomid: 704, option: "current" },
  { roomid: 705, option: "season" },
];

export const PHOTO_ROOM_URL = (roomid: number, option: string): string =>
  `${BASE}?roomid=${roomid}&view=photos&option=${option}`;

/** Extract distinct corps ids from any corps list page. */
export const parseCorpsIds = (html: string): string[] => {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $('a[href*="corpsid="], a[href*="CorpsID="]').each((_i, a) => {
    const href = $(a).attr("href") || "";
    const m = /corpsid=(\d+)/i.exec(href);
    if (m) ids.add(m[1]);
  });
  return Array.from(ids);
};
