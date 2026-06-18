// Quick test of 2024 Brass Impact mixed division page
import * as cheerio from "cheerio";
import * as fs from "fs";

const url = "https://www.dci.org/scores/recap/2024-brass-impact";
const headers = { "User-Agent": "Mozilla/5.0" };

fetch(url, { headers })
  .then((r) => r.text())
  .then((html) => {
    fs.writeFileSync("test/fixtures/test-2024-brass-impact.html", html);
    console.log("Saved test-2024-brass-impact.html\n");

    const $ = cheerio.load(html);

    const sections = $("div > h2.h4").filter((_, el) => {
      const text = $(el).text().trim();
      return text.match(/^(Open Class|World Class|All-Age)/i);
    });

    console.log(`Class sections: ${sections.length}`);
    sections.each((i, el) => {
      console.log(`  ${i + 1}. "${$(el).text().trim()}"`);
    });

    const tables = $(".recap-tbl");
    console.log(`\nRecap tables: ${tables.length}`);

    tables.each((i, tbl) => {
      const $tbl = $(tbl);
      const rows = $tbl.find("> table > tbody > tr").not(".table-top");
      const sample = rows
        .slice(0, 5)
        .map((_, row) => $(row).find(".sticky-td").text().trim())
        .get();

      console.log(`\nTable ${i + 1}: ${rows.length} corps`);
      console.log(`  Sample: ${sample.join(", ")}`);
    });

    const title = $(".elementor-widget-theme-post-title h1").text().trim();
    console.log(`\nPage title: "${title}"`);
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exitCode = 1;
  });
