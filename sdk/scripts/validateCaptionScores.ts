/**
 * validateCaptionScores.ts
 *
 * Validates caption score data quality for ML training.
 * Detects contamination from non-standard competitions, score scale mismatches,
 * and other data quality issues.
 */

import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = "./dci-relational.db";
const OUTPUT_DIR = "./results";
const JSON_OUTPUT = path.join(OUTPUT_DIR, "caption_score_validation_issues.json");
const CSV_OUTPUT = path.join(OUTPUT_DIR, "flagged_scores_detail.csv");

// Valid caption names for World/Open Class 8-judge system
const VALID_CAPTION_NAMES = new Set([
  "General Effect 1", "General Effect 2", "GE1", "GE2",
  "Visual Proficiency", "Visual - Proficiency", "VP",
  "Visual Analysis", "Visual - Analysis", "VA",
  "Color Guard", "CG",
  "Brass", "Music - Brass", "MB",
  "Music Analysis", "Music - Analysis", "MA",
  "Percussion", "Music - Percussion", "MP"
]);

// Category names that should NOT appear as captions
const CATEGORY_NAMES = new Set(["Visual", "Music", "General Effect"]);

const VALID_DIVISIONS = new Set(["World Class", "Open Class"]);

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  type: string;
  description: string;
  competition_slug?: string;
  season?: string;
  event_name?: string;
  corps_key?: string;
  caption_name?: string;
  score?: number;
  count?: number;
}

interface ValidationReport {
  timestamp: string;
  total_records_checked: number;
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    by_type: Record<string, number>;
  };
}

async function main() {
  console.log("=== Caption Score Validation Script ===\n");

  const db = createClient({
    url: `file:${DB_PATH}`,
  });

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const issues: ValidationIssue[] = [];
  let totalRecords = 0;

  // 1. Check for non-standard caption names
  console.log("1. Checking for non-standard caption names...");
  const nonStandardCaptions = await db.execute(`
    SELECT caption_name,
           COUNT(*) as count,
           MIN(score) as min_score,
           MAX(score) as max_score,
           AVG(score) as avg_score
    FROM caption_scores
    WHERE caption_name NOT IN (${Array.from(VALID_CAPTION_NAMES).map(() => "?").join(",")})
    GROUP BY caption_name
    ORDER BY count DESC
  `, Array.from(VALID_CAPTION_NAMES));

  for (const row of nonStandardCaptions.rows) {
    issues.push({
      severity: "error",
      type: "non_standard_caption",
      description: `Non-standard caption name found: "${row.caption_name}"`,
      caption_name: row.caption_name as string,
      count: row.count as number,
      score: row.max_score as number,
    });
  }
  console.log(`   Found ${nonStandardCaptions.rows.length} non-standard caption names\n`);

  // 2. Check for category names appearing as captions
  console.log("2. Checking for category names as captions...");
  const categoryAsCaption = await db.execute(`
    SELECT c.slug, c.event_name, c.season, cs.corps_key, cs.caption_name, cs.score
    FROM caption_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE cs.caption_name IN (${Array.from(CATEGORY_NAMES).map(() => "?").join(",")})
    ORDER BY c.season DESC, cs.caption_name
  `, Array.from(CATEGORY_NAMES));

  for (const row of categoryAsCaption.rows) {
    issues.push({
      severity: "error",
      type: "category_as_caption",
      description: `Category name "${row.caption_name}" appearing as caption (should be in category_scores, not caption_scores)`,
      competition_slug: row.slug as string,
      event_name: row.event_name as string,
      season: row.season as string,
      corps_key: row.corps_key as string,
      caption_name: row.caption_name as string,
      score: row.score as number,
    });
  }
  console.log(`   Found ${categoryAsCaption.rows.length} category names as captions\n`);

  // 3. Check for score range anomalies (> 25pts indicates wrong scale)
  console.log("3. Checking for score range anomalies...");
  const scoreAnomalies = await db.execute(`
    SELECT cs.caption_name, cs.score, c.event_name, c.season, c.slug, corps.division_name, cs.corps_key
    FROM caption_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    JOIN corps_scores corps ON corps.competition_slug = cs.competition_slug
      AND corps.corps_key = cs.corps_key
    WHERE cs.score > 25
    ORDER BY cs.score DESC
  `);

  for (const row of scoreAnomalies.rows) {
    issues.push({
      severity: "error",
      type: "score_out_of_range",
      description: `Score ${row.score} exceeds normal 0-20pt range for caption "${row.caption_name}"`,
      competition_slug: row.slug as string,
      event_name: row.event_name as string,
      season: row.season as string,
      caption_name: row.caption_name as string,
      score: row.score as number,
    });
  }
  console.log(`   Found ${scoreAnomalies.rows.length} score range anomalies\n`);

  // 4. Check for Performers Showcase events (Solo & Ensemble)
  console.log("4. Checking for Performers Showcase events...");
  const performersShowcase = await db.execute(`
    SELECT DISTINCT c.slug, c.event_name, c.season, COUNT(*) as score_count
    FROM competitions c
    JOIN caption_scores cs ON cs.competition_slug = c.slug
    WHERE c.event_name LIKE '%Performers Showcase%'
    GROUP BY c.slug
    ORDER BY c.season DESC
  `);

  for (const row of performersShowcase.rows) {
    issues.push({
      severity: "warning",
      type: "performers_showcase",
      description: `Performers Showcase event found (Solo & Ensemble - should exclude from ML training)`,
      competition_slug: row.slug as string,
      event_name: row.event_name as string,
      season: row.season as string,
      count: row.score_count as number,
    });
  }
  console.log(`   Found ${performersShowcase.rows.length} Performers Showcase events\n`);

  // 5. Check for All-Age Class scores
  console.log("5. Checking for All-Age Class scores...");
  const allAgeScores = await db.execute(`
    SELECT DISTINCT c.season, c.event_name, corps.division_name,
           cs.caption_name, COUNT(*) as count
    FROM caption_scores cs
    JOIN corps_scores corps ON corps.competition_slug = cs.competition_slug
      AND corps.corps_key = cs.corps_key
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE corps.division_name = 'All Age Class'
    GROUP BY c.season, corps.division_name, cs.caption_name
    ORDER BY c.season DESC
  `);

  for (const row of allAgeScores.rows) {
    issues.push({
      severity: "warning",
      type: "all_age_class",
      description: `All-Age Class scores found (should exclude from World/Open Class ML training)`,
      season: row.season as string,
      event_name: row.event_name as string,
      caption_name: row.caption_name as string,
      count: row.count as number,
    });
  }
  console.log(`   Found ${allAgeScores.rows.length} All-Age Class caption patterns\n`);

  // 6. Get total record count
  const totalResult = await db.execute(`SELECT COUNT(*) as total FROM caption_scores`);
  totalRecords = totalResult.rows[0]?.total as number || 0;

  // Generate summary
  const summary = {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
    by_type: {} as Record<string, number>,
  };

  for (const issue of issues) {
    summary.by_type[issue.type] = (summary.by_type[issue.type] || 0) + 1;
  }

  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    total_records_checked: totalRecords,
    issues,
    summary,
  };

  // Write JSON report
  fs.writeFileSync(JSON_OUTPUT, JSON.stringify(report, null, 2));
  console.log(`\n=== Validation Complete ===`);
  console.log(`Total records checked: ${totalRecords.toLocaleString()}`);
  console.log(`Issues found: ${issues.length}`);
  console.log(`  - Errors: ${summary.errors}`);
  console.log(`  - Warnings: ${summary.warnings}`);
  console.log(`  - Info: ${summary.info}`);
  console.log(`\nIssues by type:`);
  for (const [type, count] of Object.entries(summary.by_type)) {
    console.log(`  - ${type}: ${count}`);
  }
  console.log(`\nReport saved to: ${JSON_OUTPUT}`);

  // Write CSV for easy review
  if (issues.length > 0) {
    const csvHeader = "severity,type,description,competition_slug,season,event_name,caption_name,score,count\n";
    const csvRows = issues.map((issue) =>
      [
        issue.severity,
        issue.type,
        `"${issue.description}"`,
        issue.competition_slug || "",
        issue.season || "",
        issue.event_name ? `"${issue.event_name}"` : "",
        issue.caption_name || "",
        issue.score || "",
        issue.count || "",
      ].join(",")
    );
    fs.writeFileSync(CSV_OUTPUT, csvHeader + csvRows.join("\n"));
    console.log(`CSV report saved to: ${CSV_OUTPUT}\n`);
  }

  await db.close();
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
