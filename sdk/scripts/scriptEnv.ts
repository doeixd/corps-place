// Shared helper for the merch CLI scripts (scanMerch / ingestMerch /
// seedMerchStores). The Browserbase fallback is now a LAYER (BrowserbaseServiceLive),
// so the only thing left to share is .env loading.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load repo-root + sdk `.env` into process.env (first definition wins). */
export function loadRepoEnv(sdkDir: string): void {
  for (const path of [resolve(sdkDir, "..", ".env"), resolve(sdkDir, ".env")]) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]!])
          process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
    } catch {
      /* ignore missing .env */
    }
  }
}
