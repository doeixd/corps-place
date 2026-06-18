

const scoresListPage = "https://www.dci.org/scores/?location=&season=&pageno=1"

const scoresListPageSelectors = {
  scoresListTable: ".score-tbl",
  scoresListTableRows: ".score-tbl .tbl-row",
  scoresListTableCells: ".score-tbl .tbl-row > div",
  scoresListTableCellTitle: ".score-tbl .tbl-row > div:first-child",
  scoresListTableCellDate: ".score-tbl .tbl-row > div:nth-child(2)",
  scoresListTableCellLocationCityState: ".score-tbl .tbl-row > div:nth-child(3)",
  scoresListTableCellLink: ".score-tbl .tbl-row > div:nth-child(4) a",
}


const recapPage = (slug: string) => `https://www.dci.org/scores/recap/${slug}`

const recapPageSelectors = {
  recapDate: '.core-date-location p:nth-child(1)',
  recapLocationCityState: '.core-date-location p:nth-child(2)',
  recapTitle: '.elementor-widget-theme-post-title h1',
  infoAndChiefJudge: 'body > div.elementor div.elementor-element > div > div.elementor-element > div.elementor-element.elementor-element-498cf4b.e-con-full.e-flex.e-con.e-child > div.elementor-element > div.elementor-element.elementor-widget.elementor-widget-post-info > div > ul > li > span'
  recapTable: ".score-tbl",
  recapTableRows: ".score-tbl .tbl-row",
  recapTableCells: ".score-tbl .tbl-row > div",
  recapTableCellTitle: ".score-tbl .tbl-row > div:first-child",
  recapTableCellDate: ".score-tbl .tbl-row > div:nth-child(2)",
  recapTableCellLocationCityState: ".score-tbl .tbl-row > div:nth-child(3)",
  recapTableCellLink: ".score-tbl .tbl-row > div:nth-child(4) a",
}

import * as cheerio from 'cheerio';
import { Effect, Schema, Option, pipe } from 'effect';

// =============================================================================
// 1. Domain Schema & Types
// =============================================================================

const ScoreResult = Schema.Struct({
  value: Schema.Number,
  rank: Schema.Option(Schema.Number),
});

const JudgeCaptionScore = Schema.Struct({
  judgeName: Schema.String,
  captionName: Schema.String,
  subCaptions: Schema.Record({ key: Schema.String, value: ScoreResult }),
  total: ScoreResult,
});

const CategoryResult = Schema.Struct({
  judges: Schema.Array(JudgeCaptionScore),
  total: ScoreResult,
});

const CorpsRecap = Schema.Struct({
  corpsName: Schema.String,
  generalEffect: CategoryResult,
  visual: CategoryResult,
  music: CategoryResult,
  subTotal: Schema.Number,
  penalties: Schema.Number,
  finalScore: Schema.Number,
  finalRank: Schema.Number,
});

const RecapMetadata = Schema.Struct({
  date: Schema.String,
  location: Schema.String,
  title: Schema.String,
  chiefJudge: Schema.String,
});

const FullRecapResult = Schema.Struct({
  meta: RecapMetadata,
  corps: Schema.Array(CorpsRecap),
});

export type FullRecapResult = Schema.Schema.Type<typeof FullRecapResult>;

// =============================================================================
// 2. Error Handling
// =============================================================================

class ParseError {
  readonly _tag = 'ParseError';
  constructor(readonly message: string, readonly originalError?: unknown) { }
}

// =============================================================================
// 3. Helper Functions
// =============================================================================

/** 
 * Extracts text and removes extra whitespace/newlines common in Elementor HTML.
 */
const cleanText = (text: string): string => {
  return text.replace(/\s\s+/g, ' ').trim();
};

/** 
 * Parses DCI number format. Returns 0 for "--" or empty.
 */
const parseNumber = (text: string): number => {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned === '--' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

/**
 * Extracts a Score+Rank pair from a standard DCI cell.
 * Structure: <td><span>9.800</span><span>1</span></td>
 */
const extractScoreCell = ($cell: cheerio.Cheerio<any>): Schema.Schema.Type<typeof ScoreResult> => {
  const spans = $cell.find('span');
  if (spans.length >= 2) {
    return {
      value: parseNumber($(spans[0]).text()),
      rank: Option.some(Math.floor(parseNumber($(spans[1]).text()))),
    };
  }
  // Fallback for totals that might just be text
  return {
    value: parseNumber($cell.text()),
    rank: Option.none(),
  };
};

/**
 * Normalize headers like "Cont", "Rep", "Perf" to full names.
 */
const normalizeSubCaption = (text: string): string => {
  const t = cleanText(text).toLowerCase().replace(/[^a-z]/g, '');
  if (t.startsWith('rep')) return 'repertoire';
  if (t.startsWith('perf')) return 'performance';
  if (t.startsWith('cont')) return 'content';
  if (t.startsWith('ach')) return 'achievement';
  if (t.startsWith('comp')) return 'composition';
  return t;
};

// =============================================================================
// 4. Core Parsing Logic
// =============================================================================

interface JudgeHeaderDef {
  caption: string;
  judge: string;
  subCols: string[];
}

interface RecapSchema {
  generalEffect: JudgeHeaderDef[];
  visual: JudgeHeaderDef[];
  music: JudgeHeaderDef[];
}

export const parseRecapHtml = (html: string) =>
  Effect.gen(function* () {
    // 1. Load Cheerio
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (e) => new ParseError('Failed to load HTML into Cheerio', e),
      })
    );

    // 2. Extract Metadata (UPDATED SELECTORS)
    const extractMeta = (): Schema.Schema.Type<typeof RecapMetadata> => {
      // Date and Location are in .score-date-location paragraphs
      // We use .last() or specific index because often SVGs add noise
      const dateText = $('.score-date-location p').first().text();
      const locationText = $('.score-date-location p').eq(1).text();

      // Chief judge is in post-info list item
      const chiefJudgeText = $('.elementor-post-info__item--type-custom').text();

      return {
        date: cleanText(dateText),
        location: cleanText(locationText),
        title: cleanText($('.elementor-widget-theme-post-title h1').text()),
        chiefJudge: cleanText(chiefJudgeText).replace(/^Chief Judge:\s*/i, ''),
      };
    };

    const meta = extractMeta();

    // 3. Build Schema from Header Row (tr.table-top)
    // Structure: Sticky(0) | GE(1) | Vis(2) | Mus(3) | Sub(4) | Pen(5) | Total(6)
    const headerRow = $('tr.table-top');

    const parseHeaderColumn = (columnIndex: number): JudgeHeaderDef[] => {
      const colTd = headerRow.find(`> td`).eq(columnIndex);
      const headers: JudgeHeaderDef[] = [];

      // Find individual judge tables within the header cell
      colTd.find('table.table-head').each((_, tbl) => {
        const $tbl = $(tbl);
        const caption = cleanText($tbl.find('tr:nth-child(1) td').text());
        const judge = cleanText($tbl.find('tr:nth-child(2) td').text());

        const subCols: string[] = [];
        $tbl.find('tr.head td').each((_, el) => {
          const txt = cleanText($(el).text());
          if (txt.toUpperCase() !== 'TOT') {
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
      music: parseHeaderColumn(3),
    };

    // 4. Parse Corps Rows
    // We select rows that are NOT the table-top header
    const dataRows = $('.recap-tbl > table > tbody > tr').not('.table-top');
    const corpsRecaps: Schema.Schema.Type<typeof CorpsRecap>[] = [];

    dataRows.each((_, row) => {
      const $r = $(row);
      const name = cleanText($r.find('.sticky-td').text());
      if (!name) return; // Skip empty/spacer rows

      const parseCategory = (colIndex: number, headerDefs: JudgeHeaderDef[]): Schema.Schema.Type<typeof CategoryResult> => {
        const catTd = $r.find('> td').eq(colIndex);

        // In DCI HTML, the judge scores are in 'table.data', 
        // but the category total is in a specific 'td.data-total' at the end of the row container
        const judgeTables = catTd.find('table.data');
        const judges: Schema.Schema.Type<typeof JudgeCaptionScore>[] = [];

        headerDefs.forEach((def, i) => {
          const $tbl = judgeTables.eq(i);
          const tds = $tbl.find('td');

          const subCaptions: Record<string, any> = {};
          def.subCols.forEach((subKey, k) => {
            subCaptions[subKey] = extractScoreCell(tds.eq(k));
          });

          judges.push({
            judgeName: def.judge,
            captionName: def.caption,
            subCaptions,
            total: extractScoreCell(tds.last()), // Last td in table.data is the judge total
          });
        });

        // The Total score for the Category is a TD with class 'data-total' 
        // It is a direct child of the row inside 'main-sec-table'
        const totalCell = catTd.find('.data-total').first();

        return {
          judges,
          total: extractScoreCell(totalCell),
        };
      };

      // Extract Sections
      const generalEffect = parseCategory(1, schema.generalEffect);
      const visual = parseCategory(2, schema.visual);
      const music = parseCategory(3, schema.music);

      // Extract Summaries
      // The columns after music are: Sub Total (4), Penalties (5), Final Total (6)
      const subTotalCell = $r.find('> td').eq(4);
      const penaltiesCell = $r.find('> td').eq(5); // Specifically usually .penalties-td
      const finalCell = $r.find('> td').last(); // Or eq(6)

      const finalScoreData = extractScoreCell(finalCell);

      corpsRecaps.push({
        corpsName: name,
        generalEffect,
        visual,
        music,
        subTotal: parseNumber(subTotalCell.text()),
        penalties: parseNumber(penaltiesCell.text()),
        finalScore: finalScoreData.value,
        finalRank: Option.getOrElse(finalScoreData.rank, () => 0),
      });
    });

    return {
      meta,
      corps: corpsRecaps,
    };
  });


import * as cheerio from 'cheerio';
import { Effect, Schema, Option, pipe } from 'effect';

// =============================================================================
// 1. Domain Schema & Types
// =============================================================================

// --- Recap Types ---
const ScoreResult = Schema.Struct({
  value: Schema.Number,
  rank: Schema.Option(Schema.Number),
});

const JudgeCaptionScore = Schema.Struct({
  judgeName: Schema.String,
  captionName: Schema.String,
  subCaptions: Schema.Record({ key: Schema.String, value: ScoreResult }),
  total: ScoreResult,
});

const CategoryResult = Schema.Struct({
  judges: Schema.Array(JudgeCaptionScore),
  total: ScoreResult,
});

const CorpsRecap = Schema.Struct({
  corpsName: Schema.String,
  generalEffect: CategoryResult,
  visual: CategoryResult,
  music: CategoryResult,
  subTotal: Schema.Number,
  penalties: Schema.Number,
  finalScore: Schema.Number,
  finalRank: Schema.Number,
});

const RecapMetadata = Schema.Struct({
  date: Schema.String,
  location: Schema.String,
  title: Schema.String,
  chiefJudge: Schema.String,
});

const FullRecapResult = Schema.Struct({
  kind: Schema.Literal('recap'),
  meta: RecapMetadata,
  corps: Schema.Array(CorpsRecap),
});

// --- Scores List Types ---
const ScoreListEntry = Schema.Struct({
  id: Schema.String, // The slug derived from the URL
  title: Schema.String,
  date: Schema.String,
  location: Schema.String,
  url: Schema.String,
});

const ScoresListResult = Schema.Struct({
  kind: Schema.Literal('list'),
  entries: Schema.Array(ScoreListEntry),
});

// --- Exports ---
export type FullRecapResult = Schema.Schema.Type<typeof FullRecapResult>;
export type ScoresListResult = Schema.Schema.Type<typeof ScoresListResult>;

// =============================================================================
// 2. Error Handling
// =============================================================================

class ParseError {
  readonly _tag = 'ParseError';
  constructor(readonly message: string, readonly originalError?: unknown) { }
}

// =============================================================================
// 3. Helper Functions
// =============================================================================

/** Removes extra whitespace, newlines, and specific text artifacts */
const cleanText = (text: string): string => {
  if (!text) return '';
  return text.replace(/\s\s+/g, ' ').trim();
};

/** Parses DCI number format. Returns 0 for "--" or empty. */
const parseNumber = (text: string): number => {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned === '--' || cleaned === '') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

/** Normalizes caption headers */
const normalizeSubCaption = (text: string): string => {
  const t = cleanText(text).toLowerCase().replace(/[^a-z]/g, '');
  if (t.startsWith('rep')) return 'repertoire';
  if (t.startsWith('perf')) return 'performance';
  if (t.startsWith('cont')) return 'content';
  if (t.startsWith('ach')) return 'achievement';
  if (t.startsWith('comp')) return 'composition';
  return t;
};

/** Extract slug from DCI Recap URL */
const extractSlug = (url: string): string => {
  const parts = url.split('/');
  return parts[parts.length - 1] || '';
};

// =============================================================================
// 4. Recap Parsing Logic
// =============================================================================

interface JudgeHeaderDef {
  caption: string;
  judge: string;
  subCols: string[];
}

interface RecapSchema {
  generalEffect: JudgeHeaderDef[];
  visual: JudgeHeaderDef[];
  music: JudgeHeaderDef[];
}

export const parseRecapHtml = (html: string) =>
  Effect.gen(function* () {
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (e) => new ParseError('Failed to load HTML into Cheerio', e),
      })
    );

    // -- Helpers tailored for Cheerio context --
    const extractScoreCell = ($cell: cheerio.Cheerio<any>) => {
      const spans = $cell.find('span');
      if (spans.length >= 2) {
        return {
          value: parseNumber($(spans[0]).text()),
          rank: Option.some(Math.floor(parseNumber($(spans[1]).text()))),
        };
      }
      return { value: parseNumber($cell.text()), rank: Option.none() };
    };

    // -- 1. Metadata Extraction --
    const extractMeta = (): Schema.Schema.Type<typeof RecapMetadata> => {
      // Logic adapted for the full HTML structure provided
      // SVGs are siblings to text nodes, so we select text only from the <p> tags
      const dateText = $('.score-date-location p').first().contents().filter((_, el) => el.type === 'text').text();
      const locationText = $('.score-date-location p').eq(1).contents().filter((_, el) => el.type === 'text').text();

      // Chief judge is typically in the elementor post info list
      const chiefJudgeText = $('.elementor-post-info__item--type-custom').text();

      return {
        date: cleanText(dateText),
        location: cleanText(locationText),
        title: cleanText($('.elementor-widget-theme-post-title h1').text()),
        chiefJudge: cleanText(chiefJudgeText).replace(/^Chief Judge:\s*/i, ''),
      };
    };

    const meta = extractMeta();

    // -- 2. Dynamic Schema Building --
    const headerRow = $('tr.table-top');

    const parseHeaderColumn = (columnIndex: number): JudgeHeaderDef[] => {
      const colTd = headerRow.find(`> td`).eq(columnIndex);
      const headers: JudgeHeaderDef[] = [];

      colTd.find('table.table-head').each((_, tbl) => {
        const $tbl = $(tbl);
        const caption = cleanText($tbl.find('tr:nth-child(1) td').text());
        const judge = cleanText($tbl.find('tr:nth-child(2) td').text());

        const subCols: string[] = [];
        $tbl.find('tr.head td').each((_, el) => {
          const txt = cleanText($(el).text());
          if (txt.toUpperCase() !== 'TOT') subCols.push(normalizeSubCaption(txt));
        });

        headers.push({ caption, judge, subCols });
      });
      return headers;
    };

    const schema: RecapSchema = {
      generalEffect: parseHeaderColumn(1),
      visual: parseHeaderColumn(2),
      music: parseHeaderColumn(3),
    };

    // -- 3. Corps Data Parsing --
    const dataRows = $('.recap-tbl > table > tbody > tr').not('.table-top');
    const corpsRecaps: Schema.Schema.Type<typeof CorpsRecap>[] = [];

    dataRows.each((_, row) => {
      const $r = $(row);
      const name = cleanText($r.find('.sticky-td').text());
      if (!name) return;

      const parseCategory = (colIndex: number, headerDefs: JudgeHeaderDef[]) => {
        const catTd = $r.find('> td').eq(colIndex);
        const judgeTables = catTd.find('table.data');
        const judges: Schema.Schema.Type<typeof JudgeCaptionScore>[] = [];

        headerDefs.forEach((def, i) => {
          const $tbl = judgeTables.eq(i);
          const tds = $tbl.find('td');
          const subCaptions: Record<string, any> = {};

          def.subCols.forEach((subKey, k) => {
            subCaptions[subKey] = extractScoreCell(tds.eq(k));
          });

          judges.push({
            judgeName: def.judge,
            captionName: def.caption,
            subCaptions,
            total: extractScoreCell(tds.last()),
          });
        });

        // The Category Total is inside a main-sec-table > tr > td.data-total
        const totalCell = catTd.find('.data-total').first();

        return { judges, total: extractScoreCell(totalCell) };
      };

      const finalCell = extractScoreCell($r.find('> td').last());

      corpsRecaps.push({
        corpsName: name,
        generalEffect: parseCategory(1, schema.generalEffect),
        visual: parseCategory(2, schema.visual),
        music: parseCategory(3, schema.music),
        subTotal: parseNumber($r.find('> td').eq(4).text()),
        penalties: parseNumber($r.find('> td.penalties-td').text()),
        finalScore: finalCell.value,
        finalRank: Option.getOrElse(finalCell.rank, () => 0),
      });
    });

    return {
      kind: 'recap' as const,
      meta,
      corps: corpsRecaps,
    };
  });

// =============================================================================
// 5. Scores List Parsing Logic
// =============================================================================

export const parseScoresListHtml = (html: string) =>
  Effect.gen(function* () {
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (e) => new ParseError('Failed to load HTML into Cheerio', e),
      })
    );

    const entries: Schema.Schema.Type<typeof ScoreListEntry>[] = [];

    // Selectors provided by user
    const rows = $('.score-tbl .tbl-row');

    rows.each((_, el) => {
      const $row = $(el);
      // Children divs map to: Title, Date, Location, Link(View Recap)
      const title = cleanText($row.find('> div:first-child').text());
      const date = cleanText($row.find('> div:nth-child(2)').text());
      const location = cleanText($row.find('> div:nth-child(3)').text());

      const linkEl = $row.find('> div:nth-child(4) a');
      const href = linkEl.attr('href') || '';

      // Ensure we have a valid row (sometimes header rows persist in mobile views)
      if (title && href) {
        entries.push({
          id: extractSlug(href),
          title,
          date,
          location,
          url: href.startsWith('http') ? href : `https://www.dci.org${href}`
        });
      }
    });

    return {
      kind: 'list' as const,
      entries
    };
  });

  Here are three final, high - impact suggestions to improve the robustness and utility of the script, specifically addressing the nature of the DCI website(which is dynamic) and data integrity.

### 1. Address the "Empty Table" Issue(Critical)

  ** The Problem:**
    In the HTML you provided, the`#event_results` and `.score-tbl` containers are present, but ** empty ** or containing loading placeholders.The DCI site loads the actual score list via JavaScript(AJAX) after the page loads.
*   ** Cheerio ** (used in this script) * cannot * execute JavaScript.It only sees the initial server response.
*   ** Result:** `parseScoresListHtml` will likely return 0 entries if you fetch the URL directly with `fetch`.

** The Fix:**
  You have two options.
1. ** Use Puppeteer / Playwright:** Render the page, wait for the table to load, * then * pass the HTML to this script.
2. ** Call the API Directly:** The HTML contains a script tag with `scoreEventAjax`.You can skip scraping the HTML and hit the endpoint they use.

** Implementation(Option 2 - The "Pro" Move):**
  Instead of scraping the list HTML, add a function to query their internal API.

```typescript
// Add this to your domain types
const DciApiScoreItem = Schema.Struct({
  ID: Schema.Number,
  post_title: Schema.String,
  Guid: Schema.String, // URL
  meta_value: Schema.String, // Date (e.g. "20240810")
  city: Schema.String,
  state: Schema.String
});

// Function to fetch data directly from DCI's backend (bypassing HTML scraping)
export const fetchScoresFromApi = (page: number = 1) => 
  Effect.tryPromise({
    try: async () => {
      const formData = new FormData();
      formData.append('action', 'score_event_ajax_search');
      formData.append('pageno', page.toString());
      formData.append('season', ''); // or '2024'
      formData.append('location', '');

      const response = await fetch('https://www.dci.org/wp-admin/admin-ajax.php', {
        method: 'POST',
        body: formData,
      });
      return response.json(); // Returns JSON data directly
    },
    catch: (e) => new ParseError('Failed to fetch DCI API', e)
  });
```

### 2. Add "Schema Validation" Guardrails

  ** The Problem:**
    If DCI changes their table layout(e.g., renaming "General Effect" to "GE"), the script might silently return empty arrays for scores, making it look like a corps got a 0.

      ** The Fix:**
        Fail the Effect if the dynamic schema detection finds 0 judges.This ensures you know immediately if the parser is broken.

```typescript
// Inside parseRecapHtml, after building the schema:

const validateSchema = (schema: RecapSchema) => {
  const total Judges = schema.generalEffect.length + schema.visual.length + schema.music.length;
  if (totalJudges === 0) {
    return Effect.fail(new ParseError("Schema Detection Failed: No judges found in header row. The HTML structure may have changed."));
  }
  return Effect.succeed(schema);
};

// Usage in the pipeline:
// ... const schema = ...
yield* (validateSchema(schema));
```

### 3. Standardize Dates

  ** The Problem:**
    The parser returns`"August 10, 2024"`.While readable, this is hard to query in a database.

** The Fix:**
  Convert the date string to an ISO format(`YYYY-MM-DD`).

```typescript
const parseDciDate = (dateStr: string): string => {
  const date = new Date(cleanText(dateStr));
  if (isNaN(date.getTime())) return dateStr; // Fallback if parsing fails
  return date.toISOString().split('T')[0]; // Returns "2024-08-10"
};

// Update the extractMeta function:
return {
  date: parseDciDate(dateText), // Now returns ISO string
  // ...
};
```

### Finalized, "Bulletproof" File Structure

If I were deploying this today, I would organize the `dci-parser.ts` exports like this:

1. ** `parseRecap(html)` **: (Cheerio) For the detailed score sheets.
2. ** `fetchScoreList(page)` **: (Fetch / API) For the list of shows, avoiding HTML scraping entirely for that part.
3. ** `parseScoreList(html)` **: (Cheerio) Kept as a fallback, but likely only useful if using Puppeteer.

Here is the ** Validation Guardrail ** added to your existing logic to make it final:

```typescript
// ... inside parseRecapHtml ...

    // 3. Build Schema
    // ... (existing parseHeaderColumn logic) ...

    const schema: RecapSchema = {
      generalEffect: parseHeaderColumn(1),
      visual: parseHeaderColumn(2),
      music: parseHeaderColumn(3),
    };

    // *** IMPROVEMENT: FAIL FAST IF SCHEMA IS EMPTY ***
    if (schema.generalEffect.length === 0 && schema.visual.length === 0 && schema.music.length === 0) {
       // Check if this is actually a "Recap" page or maybe a "Cancelled Event" page
       const pageTitle = cleanText($('.elementor-widget-theme-post-title h1').text());
       return yield* (Effect.fail(new ParseError(`Invalid Recap HTML: No score columns detected for ${ pageTitle }`)));
    }

    // 4. Parse Corps Rows
    // ... (rest of logic)
```


You are correct to provide this new HTML.The structure of the ** Scores List ** page is indeed different from the ** Recap ** page, and notably, the list items are wrapped inside a Bootstrap grid(`.row` > `.col-md-*`), which breaks the previous logic that assumed direct children.

Here is the ** adjusted`parseScoresListHtml` function** (and the necessary types) to handle this specific HTML structure.

### Key Changes Required:
1. ** Nesting **: The data isn't immediate children of `.tbl-row`. It is inside `.tbl-row > .row`.
2. ** Garbage Rows **: There is a "Powered by Competition Suite" row(`.poweredby-row`) at the bottom which needs to be ignored.
3. ** Links **: The links point to`/scores/final-scores/slug`, which is a slightly different URL pattern to normalize.

### Updated Script Section

Replace the `parseScoresListHtml` section in your`dci-parser.ts` file with this:

```typescript
// =============================================================================
// 5. Scores List Parsing Logic (Updated for List Page HTML)
// =============================================================================

export const parseScoresListHtml = (html: string) =>
  Effect.gen(function* () {
    const $ = yield* (
      Effect.try({
        try: () => cheerio.load(html),
        catch: (e) => new ParseError('Failed to load HTML into Cheerio', e),
      })
    );

    const entries: Schema.Schema.Type<typeof ScoreListEntry>[] = [];
    
    // Select specific rows, excluding the "Powered by" footer row
    const rows = $('#score-container .tbl-row').not('.poweredby-row');

    rows.each((_, el) => {
      const $row = $(el);
      
      // Structure: .tbl-row > .row > [Event Name, Date, Location, Link]
      // We look inside the internal .row to find the columns
      const columns = $row.find('.row > div');

      // 1. Title is in the first column (col-md-4) inside a <p> or <h6>
      const title = cleanText(columns.eq(0).text());
      
      // 2. Date is in the second column (col-md-2)
      // Format in HTML is typically "8/9/2025" with lots of whitespace
      const dateRaw = cleanText(columns.eq(1).text());
      
      // 3. Location is in the third column (col-md-3)
      const location = cleanText(columns.eq(2).text());
      
      // 4. Link is in the fourth column (col-md-3), inside an <a> tag
      const linkEl = columns.eq(3).find('a');
      const href = linkEl.attr('href') || '';
      
      // Guard: Ensure we have a title and a link before adding
      if (title && href) {
        // Extract the slug from "/scores/final-scores/slug/" or full URL
        // Remove trailing slash if present before splitting
        const cleanHref = href.replace(/\/$/, '');
        const slug = cleanHref.split('/').pop() || '';

        entries.push({
          id: slug,
          title,
          date: dateRaw, // You can pipe this through a date parser if needed
          location,
          url: href.startsWith('http') ? href : `https://www.dci.org${href}`
        });
      }
    });

return {
  kind: 'list' as const,
  entries
};
  });
```

### Robustness Improvements for this Specific HTML

If you want to be extra safe with the **Date Parsing** (since `8 / 9 / 2025` is US format), add this helper to the top of your file and use it:

```typescript
/**
 * Converts "8/9/2025" to ISO "2025-08-09"
 */
const parseUSDateToISO = (dateStr: string): string => {
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const [month, day, year] = parts;
    // Pad with leading zeros
    const mm = month.padStart(2, '0');
    const dd = day.padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  return dateStr; // Return original if format doesn't match
};

// Usage inside the loop:
// date: parseUSDateToISO(dateRaw),
```

### How to Test This Update

1.  Save the HTML you provided above into a file named `scores - list.html`.
2.  Run this test script:

```typescript
import { parseScoresListHtml } from './dci-parser.js'; // or .ts
import { Effect, Console } from 'effect';
import * as fs from 'node:fs';

const test = Effect.gen(function* () {
  const html = fs.readFileSync('scores-list.html', 'utf-8');
  const result = yield* (parseScoresListHtml(html));

  yield* (Console.log(`Successfully parsed ${result.entries.length} events.`));

  // Print first 3 to verify
  result.entries.slice(0, 3).forEach(e => {
    console.log(`[${e.date}] ${e.title} (${e.location}) -> ID: ${e.id}`);
  });
});

Effect.runPromise(test).catch(console.error);
```

**Expected Output based on your HTML:**
```text
Successfully parsed 10 events.
[8 / 9 / 2025] DCI All - Age World Championship(Indianapolis, IN) -> ID: 2025 - dci - all - age - world - championship
[8 / 9 / 2025] DCI World Championship Finals(Indianapolis, IN) -> ID: 2025 - dci - world - championship - finals
[8 / 8 / 2025] DCI All - Age Class Championships(Indianapolis, IN) -> ID: 2025 - dci - all - age - class- championships
  ```