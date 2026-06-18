// Usage: npx tsx scripts/recapAsciiPreview.ts --url https://www.dci.org/scores/recap/2013-the-thunder-of-drums/

import { Effect } from 'effect';
import * as cheerio from 'cheerio';
import type * as Domain from '../src/domain.js';
import { parseRecapHtml } from '../src/websiteRecap.js';

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const pad = (value: string, width: number) => {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
};

const formatScore = (value: number) =>
  Number.isFinite(value) ? value.toFixed(3).replace(/\.000$/, '') : '-';

const renderLine = (parts: string[]) => `| ${parts.join(' | ')} |`;

const divider = (widths: number[]) => `+-${widths.map((w) => '-'.repeat(w)).join('-+-')}-+`;

const program = Effect.gen(function* () {
  const url = getArg('--url');
  if (!url) {
    throw new Error('--url is required');
  }

  const fetchHtml = (requestUrl: string) =>
    Effect.tryPromise(() =>
      fetch(requestUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    ).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(new Error(`Failed to fetch ${requestUrl}: ${response.status}`));
        }
        return Effect.tryPromise(() => response.text());
      })
    );

  const fallbackUrls: string[] = [];
  if (url.includes('/scores/recap/')) {
    const slug = url.split('/scores/recap/')[1]?.replace(/\/+$/, '');
    if (slug) {
      fallbackUrls.push(`https://www.dci.org/scores/final-scores/${slug}/`);
      fallbackUrls.push(`https://www.dci.org/score/final-scores/${slug}/`);
    }
  }
  if (url.includes('/scores/final-scores/') || url.includes('/score/final-scores/')) {
    const slug = url.split('/final-scores/')[1]?.replace(/\/+$/, '');
    if (slug) {
      fallbackUrls.push(`https://www.dci.org/scores/recap/${slug}/`);
      fallbackUrls.push(`https://www.dci.org/score/recap/${slug}/`);
    }
  }

  let recap: Domain.WebsiteRecap | undefined;
  let lastError: unknown;

  const extractRecapLinkFromHtml = (html: string) => {
    const $ = cheerio.load(html);
    const direct = $("a[href*='/scores/recap/'], a[href*='/score/recap/']").first().attr('href');
    if (direct) return direct;
    const recapLink = $('a.arrow-btn')
      .toArray()
      .map((el) => $(el))
      .find((el) => el.text().toLowerCase().includes('recap'))
      ?.attr('href');
    return recapLink ?? undefined;
  };

  const requestUrls = [url, ...fallbackUrls];
  if (url.includes('/final-scores/')) {
    requestUrls.sort((a, b) => (a.includes('/recap/') ? -1 : 1) - (b.includes('/recap/') ? -1 : 1));
  }

  for (const requestUrl of requestUrls) {
    try {
      const html = yield* (fetchHtml(requestUrl));
      try {
        recap = yield* (parseRecapHtml(html));
        break;
      } catch (error) {
        const recapLink = extractRecapLinkFromHtml(html);
        if (recapLink) {
          console.log(`Fallback recap link: ${recapLink}`);
          const recapHtml = yield* (fetchHtml(recapLink));
          recap = yield* (parseRecapHtml(recapHtml));
          break;
        }
        throw error;
      }
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!recap) {
    throw lastError ?? new Error('Failed to parse recap HTML');
  }

  const renderTable = (rows: string[][]) => {
    const header = ['Rank', 'Corps', 'Total'];
    const widths = header.map((h, idx) =>
      Math.max(h.length, ...rows.map((row) => row[idx]?.length ?? 0))
    );

    return [
      divider(widths),
      renderLine(header.map((h, i) => pad(h, widths[i]!))),
      divider(widths),
      ...rows.map((row) => renderLine(row.map((cell, i) => pad(cell, widths[i]!)))),
      divider(widths),
    ].join('\n');
  };

  console.log('\n=== Recap Meta ===');
  console.log(`Title: ${recap.meta.title ?? '-'}`);
  console.log(`Date: ${recap.meta.date ?? '-'}`);
  console.log(`Location: ${recap.meta.location ?? '-'}`);
  console.log(`Chief Judge: ${recap.meta.chiefJudge ?? '-'}`);
  const corpsCount = recap.classes.reduce((acc, klass) => acc + klass.corps.length, 0);
  console.log(`Corps Count: ${corpsCount}`);

  for (const klass of recap.classes) {
    const rows = klass.corps.map((row) => {
      const total = formatScore(row.finalScore ?? Number.NaN);
      const rank = Number.isFinite(row.finalRank) ? String(row.finalRank) : '-';
      const name = row.corpsName ?? '-';
      return [rank, name, total];
    });
    console.log(`\n=== ${klass.className} ===`);
    console.log(renderTable(rows));
  }

  console.log('\n=== Parsed JSON ===');
  console.log(JSON.stringify(recap, null, 2));
});

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
