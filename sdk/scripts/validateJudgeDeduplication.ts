import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";
import * as path from "path";

interface ValidationResult {
  name: string;
  passed: boolean;
  count: number;
  expected: number | string;
  details?: string;
}

const validateNoDuplicateIds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judges
        WHERE judge_id NOT LIKE '%-1' AND judge_id <> 'unknown'
      `
    );
    return {
      name: "No duplicate judge IDs (all end in -1 or are 'unknown')",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoOrphanedAssignments = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judge_assignments ja
        WHERE NOT EXISTS (
          SELECT 1 FROM judges j WHERE j.judge_id = ja.judge_id
        )
      `
    );
    return {
      name: "No orphaned judge_assignments",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoOrphanedScores = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judge_scores js
        WHERE NOT EXISTS (
          SELECT 1 FROM judges j WHERE j.judge_id = js.judge_id
        )
      `
    );
    return {
      name: "No orphaned judge_scores",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoOrphanedSubcaptions = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM subcaption_scores ss
        WHERE NOT EXISTS (
          SELECT 1 FROM judges j WHERE j.judge_id = ss.judge_id
        )
      `
    );
    return {
      name: "No orphaned subcaption_scores",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoOrphanedEloRatings = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judge_elo_ratings jer
        WHERE NOT EXISTS (
          SELECT 1 FROM judges j WHERE j.judge_id = jer.judge_id
        )
      `
    );
    return {
      name: "No orphaned judge_elo_ratings",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoOrphanedLinks = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judge_links jl
        WHERE NOT EXISTS (
          SELECT 1 FROM judges j WHERE j.judge_id = jl.judge_id
        )
      `
    );
    return {
      name: "No orphaned judge_links",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoDuplicateAssignments = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM (
          SELECT competition_slug, caption_name, judge_id, COUNT(*) as c
          FROM judge_assignments
          GROUP BY competition_slug, caption_name, judge_id
          HAVING c > 1
        )
      `
    );
    return {
      name: "No duplicate judge_assignments (violates PK)",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateNoDuplicateScores = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM (
          SELECT competition_slug, corps_key, caption_name, judge_id, COUNT(*) as c
          FROM judge_scores
          GROUP BY competition_slug, corps_key, caption_name, judge_id
          HAVING c > 1
        )
      `
    );
    return {
      name: "No duplicate judge_scores (violates PK)",
      passed: result[0].count === 0,
      count: result[0].count,
      expected: 0,
    };
  });

const validateJudgeCount = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`SELECT COUNT(*) as count FROM judges`
    );
    return {
      name: "Total judge count",
      passed: true,
      count: result[0].count,
      expected: "~315 post-migration, ~546 pre-migration",
    };
  });

const validateCanonicalIds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judges
        WHERE judge_id LIKE '%-1' OR judge_id = 'unknown'
      `
    );
    const total = yield* (
      sql<{ count: number }>`SELECT COUNT(*) as count FROM judges`
    );
    return {
      name: "All judges have canonical IDs",
      passed: result[0].count === total[0].count,
      count: result[0].count,
      expected: total[0].count,
      details: `${result[0].count} of ${total[0].count} judges have canonical IDs`,
    };
  });

const validateMetadataTracking = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM judges
        WHERE metadata_json IS NOT NULL
          AND metadata_json LIKE '%seenJudgeNumbers%'
      `
    );
    return {
      name: "Metadata tracking (seenJudgeNumbers present)",
      passed: true,
      count: result[0].count,
      expected: "Many judges (post-migration)",
      details: `${result[0].count} judges have metadata tracking`,
    };
  });

const validateSpecificJudge = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const result = yield* (
      sql<{ judge_id: string; metadata_json: string | null }>`
        SELECT judge_id, metadata_json
        FROM judges
        WHERE judge_id = 'al-dunn-1'
      `
    );

    if (result.length === 0) {
      return {
        name: "Specific judge check (al-dunn-1)",
        passed: true,
        count: 0,
        expected: "Judge not found",
        details: "al-dunn-1 doesn't exist in database",
      };
    }

    const metadata = result[0].metadata_json
      ? JSON.parse(result[0].metadata_json)
      : null;
    const seenNumbers = metadata?.seenJudgeNumbers ?? [];

    return {
      name: "Specific judge check (al-dunn-1)",
      passed: seenNumbers.length > 0,
      count: seenNumbers.length,
      expected: "Array with judge numbers",
      details: `al-dunn-1 has seenJudgeNumbers: [${seenNumbers.join(", ")}]`,
    };
  });

const validateMLIndexMap = () =>
  Effect.gen(function* () {
    const indexMapPath = path.join(
      process.cwd(),
      "src/training/judgeIndexMap.json"
    );

    if (!fs.existsSync(indexMapPath)) {
      return {
        name: "ML judge index map exists",
        passed: false,
        count: 0,
        expected: "File exists",
        details: "judgeIndexMap.json not found",
      };
    }

    const indexMap = JSON.parse(fs.readFileSync(indexMapPath, "utf-8"));
    const judgeIds = Object.keys(indexMap);
    const nonCanonical = judgeIds.filter(
      (id) => id !== "unknown" && !id.endsWith("-1")
    );

    return {
      name: "ML index map has no non-canonical IDs",
      passed: nonCanonical.length === 0,
      count: judgeIds.length,
      expected: "All IDs end in -1 or are 'unknown'",
      details: nonCanonical.length > 0
        ? `Found ${nonCanonical.length} non-canonical: ${nonCanonical.slice(0, 5).join(", ")}...`
        : `All ${judgeIds.length} entries are canonical`,
    };
  });

const runValidation = (mode: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Judge Deduplication Validation - ${mode.toUpperCase()}`);
    console.log(`${"=".repeat(60)}\n`);

    const validations: ValidationResult[] = [];

    // Run database validations
    validations.push(yield* (validateJudgeCount(sql)));
    validations.push(yield* (validateNoDuplicateIds(sql)));
    validations.push(yield* (validateCanonicalIds(sql)));
    validations.push(yield* (validateNoOrphanedAssignments(sql)));
    validations.push(yield* (validateNoOrphanedScores(sql)));
    validations.push(yield* (validateNoOrphanedSubcaptions(sql)));
    validations.push(yield* (validateNoOrphanedEloRatings(sql)));
    validations.push(yield* (validateNoOrphanedLinks(sql)));
    validations.push(yield* (validateNoDuplicateAssignments(sql)));
    validations.push(yield* (validateNoDuplicateScores(sql)));

    if (mode === "post-migration" || mode === "check-ml-indices") {
      validations.push(yield* (validateMetadataTracking(sql)));
      validations.push(yield* (validateSpecificJudge(sql)));
      validations.push(yield* (validateMLIndexMap()));
    }

    // Print results
    let allPassed = true;
    for (const result of validations) {
      const status = result.passed ? "✓" : "✗";
      const statusColor = result.passed ? "" : "";
      console.log(`${statusColor}${status} ${result.name}`);
      console.log(
        `  Result: ${result.count} | Expected: ${result.expected}`
      );
      if (result.details) {
        console.log(`  Details: ${result.details}`);
      }
      if (!result.passed) {
        allPassed = false;
      }
      console.log();
    }

    console.log(`${"=".repeat(60)}`);
    if (allPassed) {
      console.log("✓ ALL VALIDATIONS PASSED");
    } else {
      console.log("✗ SOME VALIDATIONS FAILED");
    }
    console.log(`${"=".repeat(60)}\n`);

    return allPassed;
  });

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "post-migration";

  if (!["pre-migration", "post-migration", "check-ml-indices"].includes(mode)) {
    console.error(
      "Usage: npx tsx validateJudgeDeduplication.ts [pre-migration|post-migration|check-ml-indices]"
    );
    process.exit(1);
  }

  const passed = yield* (runValidation(mode));

  if (!passed) {
    process.exit(1);
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(Effect.provide(SqlLayer));

Effect.runPromise(program)
  .then(() => {
    console.log("Validation complete!");
  })
  .catch((err) => {
    console.error("Validation failed:", err);
    process.exitCode = 1;
  });
