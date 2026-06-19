#!/usr/bin/env node
// Detect and optionally split staff entries whose display_name contains two or
// more people concatenated together. Handles these patterns:
//
//   1. Separator-based: "Jeff Mitchell / Kurt Jull", "Mady Barker & Brittany Giles"
//   2. Embedded known names: "Aaron Christianson Chris Langton"
//   3. Role-suffix leaks: "Rob Hardy – Lead Chef" → strip role, keep person
//
// Also finds entries with / or & separators that should be split.
//
// Usage (from sdk/):
//   npx tsx scripts/detectSplitCandidates.ts [--apply] [--verbose]
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { looksLikePersonName } from "../src/staffScraper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const log = (msg: string) => console.log(`[detect-splits] ${msg}`);

// Words that indicate a role/title, not a person name.
const ROLE_WORDS = new Set(
  "coordinator director manager assistant intern driver designer design consultant specialist " +
  "staff admin administrative board member technician tech instructor wardrobe fleet equipment tour " +
  "operations medical nurse chaplain announcer webmaster photographer videographer producer " +
  "arranger composer conductor leadership development event events battery brass percussion visual guard " +
  "volunteer hospitality merchandise merch sales sound audio electronics major caption program creative " +
  "music business logistics production supervisor lead chef surgical technologist relations donor " +
  "president vice president vp coo cfo ceo cto mayor".split(/\s+/)
);
const isRoleWord = (w: string) => ROLE_WORDS.has(w.toLowerCase().replace(/[,.&;:()/\\-]/g, ""));

type StaffRow = { staff_id: string; person_id: string; display_name: string };

async function main() {
  if (APPLY) await db.execute("PRAGMA busy_timeout=15000");

  const allStaff = (await db.execute(
    "SELECT staff_id, person_id, display_name FROM corps_staff WHERE display_name IS NOT NULL"
  )).rows as unknown as StaffRow[];

  // Build lookup: lowercase name → person_id
  const nameToPid = new Map<string, string>();
  for (const s of allStaff) nameToPid.set(s.display_name.toLowerCase(), s.person_id);

  // Build set of known 2-word name pairs for substring matching
  const knownNamePairs = new Set<string>();
  for (const s of allStaff) {
    const words = s.display_name.split(/\s+/).filter(w => !isRoleWord(w));
    for (let i = 0; i <= words.length - 2; i++) {
      const pair = words.slice(i, i + 2).join(" ").toLowerCase();
      if (pair.split(" ").every(w => w.length > 1 && /^[A-Z]/.test(w))) {
        knownNamePairs.add(pair);
      }
    }
  }

  interface Finding {
    personId: string;
    displayName: string;
    kind: "separator" | "embedded-names" | "role-suffix";
    parts: string[];
    existingMatches: string[];
  }

  const findings: Finding[] = [];

  for (const s of allStaff) {
    const name = s.display_name;

    // Pattern 1: explicit separators → definitely two (or more) people
    const sepMatch = name.match(/^(.+?)\s*[/&]\s*(.+)$/);
    if (sepMatch) {
      const left = sepMatch[1].trim();
      const right = sepMatch[2].trim();
      // Only if both sides look like person names
      if (looksLikePersonName(left) && looksLikePersonName(right)) {
        const parts = [left, right].filter(p => p.length > 2 && looksLikePersonName(p));
        if (parts.length >= 2) {
          findings.push({
            personId: s.person_id, displayName: name, kind: "separator",
            parts, existingMatches: parts.map(p => nameToPid.get(p.toLowerCase()) ?? "").filter(Boolean),
          });
        }
      }
      continue;
    }

    // Pattern 2: role suffix after separator (em-dash, comma)
    const roleMatch = name.match(/^(.+?)\s*[,–—-]\s*(.+)$/);
    if (roleMatch) {
      const person = roleMatch[1].trim();
      const role = roleMatch[2].trim();
      const roleWords = role.split(/\s+/);
      const roleRatio = roleWords.filter(isRoleWord).length / Math.max(1, roleWords.length);
      if (looksLikePersonName(person) && roleRatio > 0.5) {
        findings.push({
          personId: s.person_id, displayName: name, kind: "role-suffix",
          parts: [person],
          existingMatches: [nameToPid.get(person.toLowerCase()) ?? ""].filter(Boolean),
        });
      }
      continue;
    }

    // Pattern 3: embedded known names (for multi-person concatenations)
    const words = name.split(/\s+/);
    if (words.length >= 4) {
      const matched: string[] = [];
      for (let i = 0; i <= words.length - 2; i++) {
        const pair = words.slice(i, i + 2).join(" ").toLowerCase();
        if (knownNamePairs.has(pair) && pair !== name.toLowerCase()) {
          matched.push(words.slice(i, i + 2).join(" "));
        }
      }
      // Only report if we found distinct non-overlapping pairs
      const unique = [...new Set(matched)];
      if (unique.length >= 2) {
        findings.push({
          personId: s.person_id, displayName: name, kind: "embedded-names",
          parts: unique, existingMatches: unique.map(p => nameToPid.get(p.toLowerCase()) ?? "").filter(Boolean),
        });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  log(`found ${findings.length} candidates:`);

  let separators = 0, embedded = 0, roles = 0;
  for (const f of findings) {
    const marker = f.kind === "separator" ? "[/&]" : f.kind === "embedded-names" ? "[concat]" : "[role]";
    console.log(`  ${marker} ${f.personId}: "${f.displayName}"`);
    for (const part of f.parts) {
      const existing = f.existingMatches.includes(nameToPid.get(part.toLowerCase()) ?? "") ? " (exists)" : " (new)";
      console.log(`    → "${part}"${existing}`);
    }
    if (f.kind === "separator") separators++;
    else if (f.kind === "embedded-names") embedded++;
    else roles++;
  }

  console.log(`\nSummary: ${separators} separator, ${embedded} embedded, ${roles} role-suffix`);

  if (!APPLY) {
    log("DRY RUN — use --apply to process. Add confirmed splits to repairStaffData.ts merges[].");
    log("  For role-suffix entries: run cleanStaffNames.ts --apply first, then mergeByNameDefault.ts.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
