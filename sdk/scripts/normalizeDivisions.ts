// Normalize split all-age division labels in dci-relational.db (idempotent).
// Usage: vp exec tsx scripts/normalizeDivisions.ts
// See src/normalizeDivisions.ts for the rationale (DCA corps shown twice in
// division-grouped rankings, e.g. Connecticut Hurricanes).

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { normalizeIngestedData } from "../src/normalizeDivisions.js";

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(normalizeIngestedData.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log("[normalize-divisions] all-age division labels + lineup aliases normalized.");
  })
  .catch((err) => {
    console.error("[normalize-divisions] failed:", err);
    process.exitCode = 1;
  });
