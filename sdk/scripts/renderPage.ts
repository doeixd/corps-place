// Render a JS-heavy page with puppeteer-core (using the Playwright-installed
// chrome-headless-shell) and extract visible text + candidate judge images.
// Used for WGI judge pages whose bios are client-rendered.
//
// Usage: npx tsx scripts/renderPage.ts <url>

import puppeteer from "puppeteer-core";

const EXE =
  process.env.CHROME_SHELL ??
  "C:\\Users\\Patrick\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const url = process.argv[2]!;

(async () => {
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2500));
    const data = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"))
        .map((i) => (i as HTMLImageElement).src)
        .filter((s) => /upload|judge|headshot|s3/i.test(s) && !/web-gray|Logo|Ad\.png|Carousel|efocus|Sabres|Generic/i.test(s));
      const main = document.querySelector("main, article, .entry-content, #content, .judge-bio, .bio");
      const text = (main as HTMLElement | null)?.innerText ?? document.body.innerText;
      return { imgs: [...new Set(imgs)], text: text.replace(/\s+/g, " ").trim() };
    });
    console.log("IMAGES:", JSON.stringify(data.imgs, null, 2));
    console.log("\nTEXT:\n", data.text.slice(0, 2500));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
