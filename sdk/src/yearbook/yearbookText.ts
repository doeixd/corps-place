import { extractText, getDocumentProxy } from 'unpdf';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * DCI Yearbook text extraction (Show Detail Wiki, M10 — high-authority source).
 *
 * DCI's official season yearbooks (PDFs committed under data/yearbook/) are the
 * most authoritative source for a season's show data — full staff rosters,
 * design/arranging credits, repertoire, concept copy. The 2013–2017 books carry
 * EMBEDDED TEXT (verified: ~105–135 of ~148 pages), so we extract directly with
 * unpdf — no OCR, no vision-LLM, no captcha. Image-only books (e.g. the current
 * 2019 export, 0 text pages) fall back to the vision path (plan §17, not here).
 *
 * Downstream (next M10 steps): per-page text → AI/structured extraction → map to
 * (corps_key, season) → ingest into the scraped show tables with source='yearbook',
 * source_authority=100.
 */

// Resolve relative to this module (sdk/src/yearbook/ → repo root → data/yearbook),
// not process.cwd(), so it works whether invoked from the repo root or sdk/.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const YEARBOOK_DIR =
  process.env.YEARBOOK_DIR ?? path.resolve(MODULE_DIR, '..', '..', '..', 'data', 'yearbook');

export interface YearbookFile {
  season: string;
  file: string;
  fullPath: string;
  /** Duplicate of an already-listed season (e.g. "2017 Yearbook (1).pdf"). */
  duplicate: boolean;
}

/**
 * List the available whole-PDF yearbooks, season parsed from the filename. Split
 * `.partNNN` files are ignored (run scripts/reassembleYearbooks.mjs first). The
 * first file seen for a season wins; later same-season files are flagged duplicate.
 */
export const listYearbooks = (): YearbookFile[] => {
  if (!fs.existsSync(YEARBOOK_DIR)) return [];
  const seen = new Set<string>();
  const out: YearbookFile[] = [];
  for (const file of fs.readdirSync(YEARBOOK_DIR).sort()) {
    if (!file.toLowerCase().endsWith('.pdf')) continue; // skip .partNNN
    const season = file.match(/\b(19|20)\d{2}\b/)?.[0];
    if (!season) continue;
    const duplicate = seen.has(season);
    seen.add(season);
    out.push({ season, file, fullPath: path.join(YEARBOOK_DIR, file), duplicate });
  }
  return out;
};

export interface YearbookPage {
  pageNumber: number; // 1-based
  text: string; // whitespace-normalized
}
export interface YearbookExtract {
  season: string;
  file: string;
  totalPages: number;
  textPages: number; // pages with meaningful embedded text
  pages: YearbookPage[];
}

const MIN_TEXT_CHARS = 40;
const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

/** Big PDFs (the 100+ MB 2012/2015 books, OCR'd 2019) OOM unpdf, which loads the whole file into
 *  one Uint8Array + pdf.js. Above this size, extract with `mutool` instead — it streams page text
 *  to disk at ~35 MB RSS. */
const MUTOOL_SIZE_THRESHOLD = 60 * 1024 * 1024;

/** Memory-light per-page text via `mutool draw -F txt` (one .txt per page in a temp dir). */
const extractYearbookMutool = (fullPath: string, season: string): YearbookExtract => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-'));
  try {
    execFileSync('mutool', ['draw', '-F', 'txt', '-o', path.join(dir, 'p%d.txt'), fullPath], {
      stdio: 'ignore',
      maxBuffer: 64 * 1024 * 1024,
    });
    const pages = fs
      .readdirSync(dir)
      .map((f) => ({ f, n: Number(f.match(/^p(\d+)\.txt$/)?.[1]) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n)
      .map((x) => ({ pageNumber: x.n, text: norm(fs.readFileSync(path.join(dir, x.f), 'utf8')) }));
    return {
      season,
      file: path.basename(fullPath),
      totalPages: pages.length,
      textPages: pages.filter((p) => p.text.length > MIN_TEXT_CHARS).length,
      pages,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Extract per-page embedded text from one yearbook PDF (mutool for big files, unpdf otherwise). */
export const extractYearbook = async (fullPath: string, season: string): Promise<YearbookExtract> => {
  if (fs.statSync(fullPath).size > MUTOOL_SIZE_THRESHOLD) return extractYearbookMutool(fullPath, season);
  const buf = fs.readFileSync(fullPath);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => ({ pageNumber: i + 1, text: norm(t) }));
  return {
    season,
    file: path.basename(fullPath),
    totalPages,
    textPages: pages.filter((p) => p.text.length > MIN_TEXT_CHARS).length,
    pages,
  };
};

/** Convenience: extract by season using the filename mapping (skips duplicates). */
export const extractYearbookForSeason = async (season: string): Promise<YearbookExtract | null> => {
  const match = listYearbooks().find((y) => y.season === season && !y.duplicate);
  return match ? extractYearbook(match.fullPath, match.season) : null;
};

/** True when a book has enough embedded text for direct extraction (else: OCR). */
export const hasEmbeddedText = (extract: YearbookExtract): boolean =>
  extract.totalPages > 0 && extract.textPages / extract.totalPages >= 0.4;

/**
 * Text for one page, transparently: the embedded text if present, else OCR the
 * rendered page (`ocr.ts`). The unified entry point the ingest/batch step uses, so
 * it doesn't care whether a book has a text layer.
 */
export const resolvePageText = async (
  book: YearbookFile,
  page: YearbookPage
): Promise<{ text: string; source: 'embedded' | 'ocr' }> => {
  if (page.text.length > MIN_TEXT_CHARS) return { text: page.text, source: 'embedded' };
  const { ocrPdfPage } = await import('./ocr.js');
  return { text: await ocrPdfPage(book.fullPath, page.pageNumber), source: 'ocr' };
};
