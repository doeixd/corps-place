// Canonical merch category buckets + resolvers. Dependency-free on purpose:
// the app imports this server-side (legacy category-URL redirects in
// getShopCategory), so it must not drag merchCatalog's scraping deps (cheerio,
// Browserbase) into the app build.

// Fold a platform's freeform category/type/tag into a small canonical set for the
// catalog facet; unknown values pass through (trimmed) rather than being dropped.
export const CATEGORY_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  // Order matters: more specific buckets first, broad Apparel/Accessories after.
  [
    /tumbler|\bmugs?\b|drinkware|water bottle|\bcups?\b|\bcoffee\b|pint glass|shot glass|koozie/i,
    "Drinkware",
  ],
  [/\bhats?\b|\bcaps?\b|beanie|headwear|visor/i, "Headwear"],
  [
    /home (decor|items?|goods)|pillow|blanket|candle|ornament|magnet|poster|wall art|metal sign|license plate|\boffice\b|paper products?|puzzle|novelt|coaster/i,
    "Home & Office",
  ],
  [
    /instrument|drumstick|\bsticks?\b|mallet|\bgear\b|valve oil|slide (lubricant|cream|oil)|mouthpiece|equipment|\bprops?\b/i,
    "Instruments & Equipment",
  ],
  [/music|recording|audio|\bcd\b|\bdvd\b|vinyl|download|\bmedia\b/i, "Music & Media"],
  [/ticket|admission|\bevents?\b|show materials/i, "Tickets & Events"],
  [
    /t-?shirt|\btee\b|\bshirt|hoodie|sweatshirt|crewneck|apparel|clothing|outerwear|jacket|polo|shorts|pants|jersey|\btanks?\b|\btops?\b|pullover|v-?neck|long-?sleeve|flannel|workwear|bottoms|uniform|costume|all over print|kids clothes|\bwomen\b|\bshoes\b|sock|onesie|\bspod\b/i,
    "Apparel",
  ],
  [
    /pin\b|sticker|patch|lanyard|keychain|accessor|bag|towel|flag|decal|scarf|cinch|gift card|blank card|\bcards\b|umbrella|button|wristband|\bpets?\b/i,
    "Accessories",
  ],
  // After Apparel/Accessories so a "Supporter Tee" title buckets as Apparel, not a fee.
  [
    /donat|sponsor|support|fundrais|\bfunds?\b|\bfees?\b|tuition|audition|\bmembers?\b|registration/i,
    "Donations & Fees",
  ],
  [/merchandise|\bswag\b|souvenir|miscellaneous|\bother\b|lifestyle|\bcourse\b/i, "Other"],
];

export const normalizeCategory = (raw: string | null | undefined): string | null => {
  const t = (raw ?? "").trim();
  // Drop unusably short fragments (e.g. a truncated "sh") rather than facet them.
  if (t.length < 3) return null;
  for (const [re, label] of CATEGORY_SYNONYMS) if (re.test(t)) return label;
  return t.length > 40 ? t.slice(0, 40).trim() : t;
};

// Synonym-only category bucket (never echoes a raw title into the facet).
export const bucketCategory = (text: string): string | null => {
  for (const [re, label] of CATEGORY_SYNONYMS) if (re.test(text)) return label;
  return null;
};

// Preferred resolver: a synonym match on the platform's category wins; otherwise
// a synonym match on the TITLE beats an unknown raw label (stores often put
// collection names — "Pride Collection", "SPOD - CYO" — in the category field);
// a raw label only passes through when neither matches.
export const resolveCategory = (
  raw: string | null | undefined,
  title: string,
): string | null => {
  const t = (raw ?? "").trim();
  if (t.length >= 3)
    for (const [re, label] of CATEGORY_SYNONYMS) if (re.test(t)) return label;
  const fromTitle = bucketCategory(title);
  if (fromTitle) return fromTitle;
  if (t.length < 3) return null;
  return t.length > 40 ? t.slice(0, 40).trim() : t;
};
