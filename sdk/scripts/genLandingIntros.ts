// Generate unique intro copy for every pSEO landing page using the free
// opencode/deepseek-v4-flash-free model (no paid API key needed). Resumable:
// skips slugs already in landing-intros.generated.json and writes after each
// success, so it can be re-run to fill the rest or top up new defs.
//
// Run (Node 20 via vite-plus):  vp exec tsx sdk/scripts/genLandingIntros.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANDING_DEFS } from '../../app/lib/jobs/landing-taxonomy';

const OUT = fileURLToPath(new URL('../../app/lib/jobs/landing-intros.generated.json', import.meta.url));
const OPENCODE = '/home/patrick/.opencode/bin/opencode';
const MODEL = 'opencode/deepseek-v4-flash-free';

const intros: Record<string, string> = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8'))
  : {};

let made = 0;
let i = 0;
for (const def of LANDING_DEFS) {
  i++;
  if (intros[def.slug]) continue;
  const prompt =
    `Output ONLY two plain-text sentences (no preamble, no markdown, no quotes, do not name any website) ` +
    `for the intro of a job-board landing page titled "${def.h1}". Context: ${def.subhead} ` +
    `Be specific about what the role or discipline actually involves, and note that new openings are ` +
    `posted by programs, studios, gyms, ensembles, or organizations. Encourage browsing and applying.`;
  try {
    const out = execFileSync(OPENCODE, ['run', '--pure', '-m', MODEL, prompt], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1 << 20,
    });
    const clean = out.replace(/\s+/g, ' ').trim();
    if (clean.length > 40 && clean.includes('.')) {
      intros[def.slug] = clean;
      made++;
      writeFileSync(OUT, JSON.stringify(intros, null, 0)); // incremental → resumable
    } else {
      console.error(`  short/empty: ${def.slug} -> ${JSON.stringify(clean).slice(0, 60)}`);
    }
  } catch (e) {
    console.error(`  FAIL ${def.slug}: ${(e as Error).message.slice(0, 90)}`);
  }
  if (i % 10 === 0)
    console.error(`  ${i}/${LANDING_DEFS.length} processed · ${Object.keys(intros).length} stored`);
}
console.error(`DONE: ${Object.keys(intros).length}/${LANDING_DEFS.length} intros (${made} new this run)`);
