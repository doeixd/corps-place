// Fetch a URL through Browserbase (bypasses Cloudflare / bot-protection) and
// print the response to stdout. A shell handle for corps research so blocked
// pages (social profiles, Cloudflare-fronted sites) are reachable from the CLI.
//
// Usage:
//   npx tsx scripts/fetchUrl.ts <url>            # print raw HTML/JSON
//   npx tsx scripts/fetchUrl.ts <url> --text     # crude tag-stripped text
//   npx tsx scripts/fetchUrl.ts <url> --max 8000 # cap output chars

import * as fs from 'node:fs';
import * as path from 'node:path';

const envPaths = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')];
for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  break;
}

import { Effect } from 'effect';
import { BrowserbaseServiceLive, BrowserbaseService } from '../src/browserbaseService.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const asText = args.includes('--text');
const maxArg = args.indexOf('--max');
const max = maxArg >= 0 ? Number(args[maxArg + 1]) : asText ? 12000 : 200000;

if (!url) {
  console.error('usage: tsx scripts/fetchUrl.ts <url> [--text] [--max N]');
  process.exit(2);
}

const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const program = Effect.gen(function* () {
  const bb = yield* (BrowserbaseService);
  const html = yield* (bb.fetchHtml(url));
  const out = asText ? stripHtml(html) : html;
  console.log(out.slice(0, max));
});

Effect.runPromise(program.pipe(Effect.provide(BrowserbaseServiceLive)))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[fetchUrl] ERROR', err?.message ?? err);
    process.exit(1);
  });
