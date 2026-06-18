import { readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { BrowserbaseService, BrowserbaseServiceLive } from "../src/browserbaseService.js";
for (const p of ["../.env", ".env"]) {
  try {
    for (const l of readFileSync(p, "utf8").split("\n")) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
}
const url = process.argv[2]!;
const out = process.argv[3] ?? "./bb-page.html";
Effect.runPromise(
  Effect.gen(function* () {
    const bb = yield* (BrowserbaseService);
    const html = yield* (bb.fetchHtml(url));
    writeFileSync(out, html);
    console.log("wrote", html.length, "chars to", out);
  }).pipe(Effect.provide(BrowserbaseServiceLive))
).catch((e) => { console.error(String(e)); process.exit(1); });
