// Test script to examine DCI website structure and API responses
// Usage: npx tsx scripts/testWebsiteStructure.ts

import * as cheerio from "cheerio";
import * as fs from "fs";

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

async function fetchHtml(url: string): Promise<string> {
  console.log(`Fetching: ${url}`);
  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function testRecapPageStructure(slug: string) {
  console.log("\n=== Testing Recap Page Structure ===");
  const url = `https://www.dci.org/scores/recap/${slug}`;
  const html = await fetchHtml(url);

  // Save raw HTML for inspection
  fs.writeFileSync(`test-recap-${slug}.html`, html);
  console.log(`Saved HTML to test-recap-${slug}.html`);

  const $ = cheerio.load(html);

  // Find all h2 headers that might indicate class sections
  console.log("\n--- Class Headers (h2) ---");
  const headers = $("h2").filter((_, el) => {
    const text = $(el).text().trim();
    return text.length > 0 && text.length < 100;
  });

  console.log(`Found ${headers.length} h2 headers:`);
  headers.each((i, el) => {
    const text = $(el).text().trim();
    const classes = $(el).attr("class") || "";
    console.log(`  ${i + 1}. "${text}" (classes: ${classes})`);
  });

  // Find all recap tables
  console.log("\n--- Recap Tables ---");
  const tables = $(".recap-tbl");
  console.log(`Found ${tables.length} .recap-tbl elements`);

  tables.each((i, tblDiv) => {
    console.log(`\nTable ${i + 1}:`);

    // Find the header before this table
    const $prev = $(tblDiv).prevAll("h2").first();
    const headerText = $prev.text().trim();
    console.log(`  Previous h2: "${headerText}"`);

    // Count corps in this table
    const dataRows = $(tblDiv).find("table > tbody > tr").not(".table-top");
    const corps = dataRows.map((_, row) => {
      return $(row).find(".sticky-td").text().trim();
    }).get().filter(Boolean);

    console.log(`  Corps count: ${corps.length}`);
    console.log(`  Corps: ${corps.slice(0, 3).join(", ")}${corps.length > 3 ? "..." : ""}`);
  });

  // Check page title
  console.log("\n--- Page Metadata ---");
  const pageTitle = $(".elementor-widget-theme-post-title h1").text().trim();
  console.log(`Page title: "${pageTitle}"`);

  const dateText = $(".score-date-location p").first().text().trim();
  console.log(`Date: "${dateText}"`);

  const locationText = $(".score-date-location p").eq(1).text().trim();
  console.log(`Location: "${locationText}"`);
}

async function testScoreListAjax(season: string) {
  console.log("\n=== Testing Score List AJAX API ===");

  // First, get the main scores page to extract config
  const pageUrl = `https://www.dci.org/scores/?location=&season=${season}&pageno=1`;
  const html = await fetchHtml(pageUrl);

  // Extract AJAX config
  const ajaxMatch = html.match(
    /scoreEventAjax\s*=\s*\{[^}]*"ajax_url":"([^"]+)","nonce":"([^"]+)"/
  );
  const wrapperMatch = html.match(
    /id="score-pagination-wrapper"[^>]*data-post-type="([^"]+)"[^>]*data-posts-per-page="([^"]+)"/
  );

  if (!ajaxMatch || !wrapperMatch) {
    console.error("Failed to extract AJAX config");
    return;
  }

  const [, ajaxUrl, nonce] = ajaxMatch;
  const [, postType, postsPerPage] = wrapperMatch;

  console.log(`AJAX URL: ${ajaxUrl}`);
  console.log(`Nonce: ${nonce}`);
  console.log(`Post Type: ${postType}`);
  console.log(`Posts Per Page: ${postsPerPage}`);

  // Make AJAX request
  const params = new URLSearchParams({
    action: "score_events",
    nonce,
    post_type: postType,
    posts_per_page: postsPerPage,
    paged: "1",
    filter_season: season,
    filter_location: ""
  });

  console.log("\n--- AJAX Request ---");
  console.log(`POST ${ajaxUrl}`);
  console.log(`Params: ${params.toString()}`);

  const response = await fetch(ajaxUrl, {
    method: "POST",
    headers: {
      ...requestHeaders,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`AJAX request failed: ${response.status}`);
  }

  const json = await response.json() as any;
  fs.writeFileSync("test-ajax-response.json", JSON.stringify(json, null, 2));
  console.log("Saved AJAX response to test-ajax-response.json");

  if (!json.success || !json.data) {
    console.error("AJAX response missing data");
    return;
  }

  console.log(`\nCurrent Page: ${json.data.current_page}`);
  console.log(`Total Pages: ${json.data.total_pages}`);

  // Parse the HTML content returned
  const $ = cheerio.load(json.data.content);
  const rows = $(".tbl-row").not(".poweredby-row");

  console.log(`\n--- Entries in AJAX Response ---`);
  console.log(`Found ${rows.length} entries:`);

  rows.each((i, row) => {
    const $row = $(row);
    const columns = $row.find(".row > div");
    const cells = columns.length > 0 ? columns : $row.find("> div");
    const title = cells.eq(0).text().trim();
    const date = cells.eq(1).text().trim();
    const location = cells.eq(2).text().trim();
    const linkEl = cells.eq(3).find("a");
    const href = linkEl.attr("href") || "";

    const slug = href.split("/").filter(Boolean).pop() || "";

    if (i < 10) {  // Show first 10
      console.log(`\n${i + 1}. ${title}`);
      console.log(`   Date: ${date}`);
      console.log(`   Location: ${location}`);
      console.log(`   Slug: ${slug}`);
    }
  });

  // Look for entries with similar names
  console.log("\n--- Looking for Multi-Division Events ---");
  const entries: Array<{ title: string; slug: string }> = [];
  rows.each((_, row) => {
    const $row = $(row);
    const columns = $row.find(".row > div");
    const cells = columns.length > 0 ? columns : $row.find("> div");
    const title = cells.eq(0).text().trim();
    const linkEl = cells.eq(3).find("a");
    const href = linkEl.attr("href") || "";
    const slug = href.split("/").filter(Boolean).pop() || "";
    if (title && slug) {
      entries.push({ title, slug });
    }
  });

  // Group by event name (before class designation)
  const eventGroups = new Map<string, typeof entries>();
  entries.forEach(entry => {
    // Extract base event name (remove class suffixes)
    const baseName = entry.title
      .replace(/\s*-\s*(Open Class|All[-\s]Age[^,]*|World Class|International Class|SoundSport).*$/i, "")
      .trim();

    if (!eventGroups.has(baseName)) {
      eventGroups.set(baseName, []);
    }
    eventGroups.get(baseName)!.push(entry);
  });

  // Show events with multiple divisions
  eventGroups.forEach((entries, baseName) => {
    if (entries.length > 1) {
      console.log(`\n"${baseName}" has ${entries.length} divisions:`);
      entries.forEach(e => {
        console.log(`  - ${e.title}`);
        console.log(`    Slug: ${e.slug}`);
      });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith("--season="))?.split("=")[1] || "2025";
  const slug = args.find(a => a.startsWith("--slug="))?.split("=")[1] || "2025-march-on";

  try {
    // Test the recap page structure
    await testRecapPageStructure(slug);

    // Test the AJAX API
    await testScoreListAjax(season);

    console.log("\n=== Test Complete ===");
    console.log("Review the output files:");
    console.log(`  - test-recap-${slug}.html`);
    console.log("  - test-ajax-response.json");
  } catch (error) {
    console.error("Test failed:", error);
    process.exitCode = 1;
  }
}

main();
