// Render a page and dump ALL <img> src + alt (optionally filtered by substring).
// For finding headshots on pages with non-standard image paths.
// Usage: npx tsx scripts/renderImgs.ts <url> [substringFilter]
import puppeteer from "puppeteer-core";

const EXE =
  process.env.CHROME_SHELL ??
  "C:\\Users\\Patrick\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe";

const url = process.argv[2]!;
const filter = (process.argv[3] ?? "").toLowerCase();

(async () => {
  const b = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
  try {
    const p = await b.newPage();
    await p.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2000));
    const imgs = await p.evaluate(() =>
      Array.from(document.querySelectorAll("img")).map((i) => ({ src: (i as HTMLImageElement).src, alt: i.alt ?? "" }))
    );
    for (const im of imgs) {
      if (!filter || im.src.toLowerCase().includes(filter) || im.alt.toLowerCase().includes(filter)) {
        console.log(im.src, "||", im.alt);
      }
    }
  } finally {
    await b.close();
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
