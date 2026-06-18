// Test the 2024 World Championship Prelims page with mixed divisions
import * as cheerio from "cheerio";
import * as fs from "fs";

const url = "https://www.dci.org/scores/recap/2024-dci-world-championship-prelims/";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
};

fetch(url, { headers })
  .then((r) => r.text())
  .then((html) => {
    fs.writeFileSync("test-2024-prelims-mixed.html", html);
    console.log("Saved test-2024-prelims-mixed.html\n");

    const $ = cheerio.load(html);

    // Check class sections
    const sections = $("div > h2.h4").filter((_, el) => {
      const text = $(el).text().trim();
      return text.match(/^(Open Class|World Class|All-Age)/i);
    });

    console.log(`Class section headers: ${sections.length}`);
    sections.each((i, el) => {
      console.log(`  ${i + 1}. "${$(el).text().trim()}"`);
    });

    // Check the first table
    const firstTable = $(".recap-tbl").first();
    if (firstTable.length > 0) {
      const rows = firstTable.find("> table > tbody > tr").not(".table-top");
      console.log(`\nFirst table corps: ${rows.length}`);

      // Show ALL corps names to find 7th Regiment
      console.log("\nAll corps in first table:");
      rows.each((i, row) => {
        const name = $(row).find(".sticky-td").text().trim();
        const rank = $(row).find("> td").last().find("span").eq(1).text().trim();
        console.log(`  ${rank}. ${name}`);
      });
    }

    // Check the database for what divisions these corps should be
    console.log("\n=== Need to check: What division is '7th Regiment' actually in? ===");
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exitCode = 1;
  });
