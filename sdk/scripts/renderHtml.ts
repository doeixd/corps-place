// Render a JS page and save the full post-hydration HTML to a file.
// Usage: npx tsx scripts/renderHtml.ts <url> <outFile>
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const EXE =
  process.env.CHROME_SHELL ??
  "C:\\Users\\Patrick\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const url = process.argv[2]!;
const out = process.argv[3] ?? "./rendered.html";

(async () => {
  const b = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
  try {
    const p = await b.newPage();
    await p.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2500));
    const html = await p.content();
    writeFileSync(out, html);
    console.log("wrote", html.length, "chars to", out);
  } finally {
    await b.close();
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
