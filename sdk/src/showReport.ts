import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export interface ShowCoverageReport {
  readonly season: number;
  readonly totalShows: number;
  readonly realTitles: number;
  readonly placeholderTitles: number;
  readonly totalRepertoire: number;
  readonly totalDesigners: number;
  readonly totalMovements: number;
  readonly classBreakdown: Array<{
    class: string;
    total: number;
    withRealTitle: number;
    withPlaceholder: number;
    withRepertoire: number;
  }>;
  readonly topMissing: Array<{ corpsKey: string; corpsName: string; class: string }>;
  readonly recentlyUpdated: Array<{
    corpsKey: string;
    corpsName: string;
    title: string;
    source: string;
  }>;
}

export const buildShowReport = Effect.fn("ShowReport.build")(
  function* (season: number) {
    const sql = yield* SqlClient.SqlClient;

    // Overall stats
    const overallStats = yield* sql<{
      total_shows: number;
      real_titles: number;
      placeholder_titles: number;
      total_repertoire: number;
    }>`
      SELECT
        COUNT(*) as total_shows,
        COUNT(CASE WHEN title NOT LIKE '%Repertoire not available%' AND title NOT LIKE '%No title yet%' AND title != '.' AND title != '' THEN 1 END) as real_titles,
        COUNT(CASE WHEN title LIKE '%Repertoire not available%' OR title LIKE '%No title yet%' OR title = '.' OR title = '' THEN 1 END) as placeholder_titles,
        (SELECT COUNT(*) FROM corps_show_repertoire WHERE show_id LIKE ${'%_' + String(season)}) as total_repertoire
      FROM corps_shows
      WHERE season = ${String(season)}
    `;

    // Class breakdown
    const classBreakdown = yield* sql<{
      class: string;
      total: number;
      with_real_title: number;
      with_placeholder: number;
      with_repertoire: number;
    }>`
      SELECT
        COALESCE(c.division_name, 'Unknown') as class,
        COUNT(*) as total,
        COUNT(CASE WHEN cs.title NOT LIKE '%Repertoire not available%' AND cs.title NOT LIKE '%No title yet%' AND cs.title != '.' AND cs.title != '' THEN 1 END) as with_real_title,
        COUNT(CASE WHEN cs.title LIKE '%Repertoire not available%' OR cs.title LIKE '%No title yet%' OR cs.title = '.' OR cs.title = '' THEN 1 END) as with_placeholder,
        COUNT(DISTINCT CASE WHEN csr.entry_id IS NOT NULL THEN cs.corps_key END) as with_repertoire
      FROM corps_shows cs
      LEFT JOIN corps c ON c.corps_key = cs.corps_key
      LEFT JOIN corps_show_repertoire csr ON csr.show_id = cs.show_id
      WHERE cs.season = ${String(season)}
      GROUP BY c.division_name
      ORDER BY
        CASE c.division_name
          WHEN 'World' THEN 1
          WHEN 'Open' THEN 2
          WHEN 'All-Age' THEN 3
          ELSE 4
        END
    `;

    // Corps with placeholder titles (top missing)
    const topMissing = yield* sql<{
      corps_key: string;
      corps_name: string;
      division_name: string;
    }>`
      SELECT
        cs.corps_key,
        c.name as corps_name,
        c.division_name
      FROM corps_shows cs
      LEFT JOIN corps c ON c.corps_key = cs.corps_key
      WHERE cs.season = ${String(season)}
        AND (cs.title LIKE '%Repertoire not available%' OR cs.title LIKE '%No title yet%' OR cs.title = '.' OR cs.title = '')
      ORDER BY
        CASE c.division_name
          WHEN 'World' THEN 1
          WHEN 'Open' THEN 2
          WHEN 'All-Age' THEN 3
          ELSE 4
        END,
        c.name
    `;

    // Recently updated (shows with non-DCX sources and real titles)
    const recentlyUpdated = yield* sql<{
      corps_key: string;
      corps_name: string;
      title: string;
      source_url: string;
    }>`
      SELECT
        cs.corps_key,
        c.name as corps_name,
        cs.title,
        cs.source_url
      FROM corps_shows cs
      LEFT JOIN corps c ON c.corps_key = cs.corps_key
      WHERE cs.season = ${String(season)}
        AND cs.source_url IS NOT NULL
        AND cs.source_url NOT LIKE '%dcxmuseum%'
        AND cs.title NOT LIKE '%Repertoire not available%'
        AND cs.title NOT LIKE '%No title yet%'
        AND cs.title != '.'
      ORDER BY cs.corps_key
    `;

    const stats = overallStats[0];

    return {
      season,
      totalShows: stats.total_shows,
      realTitles: stats.real_titles,
      placeholderTitles: stats.placeholder_titles,
      totalRepertoire: stats.total_repertoire,
      totalDesigners: 0, // Will be populated if we query designers table
      totalMovements: 0,
      classBreakdown: classBreakdown.map((row) => ({
        class: row.class,
        total: row.total,
        withRealTitle: row.with_real_title,
        withPlaceholder: row.with_placeholder,
        withRepertoire: row.with_repertoire,
      })),
      topMissing: topMissing.map((row) => ({
        corpsKey: row.corps_key,
        corpsName: row.corps_name,
        class: row.division_name,
      })),
      recentlyUpdated: recentlyUpdated.map((row) => ({
        corpsKey: row.corps_key,
        corpsName: row.corps_name,
        title: row.title,
        source: row.source_url,
      })),
    } as ShowCoverageReport;
  }
);

// Pure: format report as console-printable text
export const formatReport = (report: ShowCoverageReport): string => {
  const lines: string[] = [];
  lines.push(`=== 2026 DCI Show Announcement Coverage Report ===`);
  lines.push("");
  lines.push(`Season: ${report.season}`);
  lines.push(`Total shows: ${report.totalShows}`);
  lines.push(`  Real titles: ${report.realTitles}`);
  lines.push(`  Placeholder titles: ${report.placeholderTitles}`);
  lines.push(`Total repertoire entries: ${report.totalRepertoire}`);
  lines.push("");

  lines.push("--- By Class ---");
  for (const cls of report.classBreakdown) {
    lines.push(
      `${(cls.class ?? "Unknown").padEnd(12)} | Total: ${String(cls.total).padStart(3)} | Real: ${String(cls.withRealTitle).padStart(3)} | Placeholder: ${String(cls.withPlaceholder).padStart(3)} | Repertoire: ${String(cls.withRepertoire).padStart(3)}`
    );
  }
  lines.push("");

  lines.push(`--- Top ${Math.min(15, report.topMissing.length)} Missing Show Titles ---`);
  for (const missing of report.topMissing.slice(0, 15)) {
    lines.push(
      `  ${(missing.class ?? "Unknown").padEnd(10)} | ${missing.corpsName}`
    );
  }
  if (report.topMissing.length > 15) {
    lines.push(`  ... and ${report.topMissing.length - 15} more`);
  }
  lines.push("");

  if (report.recentlyUpdated.length > 0) {
    lines.push("--- Recently Updated (non-DCX sources) ---");
    for (const upd of report.recentlyUpdated.slice(0, 10)) {
      lines.push(`  ${upd.corpsName}: "${upd.title}" (${upd.source})`);
    }
    lines.push("");
  }

  lines.push("=== End Report ===");
  return lines.join("\n");
};
