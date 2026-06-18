// Load environment from the repo-root .env into process.env WITHOUT shelling out
// (`source .env` chokes on token values containing shell metacharacters). Only
// fills keys that aren't already set, so real env always wins. Idempotent.
import * as fs from "node:fs";
import * as path from "node:path";

export const loadEnv = (): void => {
  // scripts run from sdk/, so the repo-root .env is one level up; also try cwd.
  const candidates = [
    path.resolve(process.cwd(), "../.env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key] !== undefined) continue;
      // Strip surrounding quotes if present; values are taken verbatim otherwise.
      const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
      process.env[key] = value;
    }
  }
};
