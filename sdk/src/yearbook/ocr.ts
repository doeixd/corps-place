import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFile = promisify(execFileCb);

/**
 * On-demand per-page OCR for image-only yearbooks (M10 fallback).
 *
 * The 2013–2017 books carry embedded text (use `unpdf`). Image-only books — a
 * scanned/flipbook export with no text layer, e.g. the 2019 file — go through here:
 * render one page to a bitmap (poppler `pdftoppm`) and OCR it (`tesseract`). Done
 * per page (not whole-PDF) so we only pay for the corps pages we actually extract,
 * and never load a 400 MB book into memory. Output then feeds the same AI structured
 * extraction as the text path. Requires poppler + tesseract on the host.
 */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export const ocrPdfPage = async (
  pdfPath: string,
  pageNumber: number,
  dpi = 200
): Promise<string> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ybocr-'));
  const prefix = path.join(tmp, 'pg');
  try {
    // Render just this page to PNG. pdftoppm reads the PDF incrementally, so a
    // single page off a huge book is cheap.
    await execFile(
      'pdftoppm',
      ['-png', '-r', String(dpi), '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, prefix],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }
    );
    const png = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
    if (!png) return '';
    // psm 3 = automatic page segmentation (handles the multi-column staff layout).
    const { stdout } = await execFile('tesseract', [path.join(tmp, png), 'stdout', '--psm', '3'], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return norm(stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
