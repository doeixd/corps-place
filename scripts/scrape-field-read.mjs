#!/usr/bin/env node
// Scrape the external benchmark "Field Read" (https://field-read-3a5b8259d1ce.herokuapp.com)
// - /record      : graded shows, per-corps day-of PREDICTED / ACTUAL / OFF BY tables
// - /predictions : per-show model forecasts (expandable ▸ sections), incl. not-yet-graded shows
//
// Client-rendered React app -> render with puppeteer-core + system chromium, then extract
// structured rows in-page (page.evaluate) off stable class hooks (section.board / board-class /
// board-meta / table). UPSERTs into external_benchmark_predictions in the prod relational DB.
//
// Idempotent: one PRIMARY KEY per (source, page_source, show_date, show_name_raw, corps_name_raw).
// GENTLE: one page load per endpoint per run. Intended for a single daily cron.
//
// Usage: node scripts/scrape-field-read.mjs
//   env: DCI_RELATIONAL_DB_URL (optional) overrides the DB file url.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BASE = 'https://field-read-3a5b8259d1ce.herokuapp.com';
const SOURCE = 'field-read';

// ---------- DB ----------
function dbUrl() {
  if (process.env.DCI_RELATIONAL_DB_URL) return process.env.DCI_RELATIONAL_DB_URL;
  const p = path.join(REPO_ROOT, 'sdk', 'dci-relational.db');
  return 'file:' + p;
}
const db = createClient({ url: dbUrl() });

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS external_benchmark_predictions (
      source          TEXT NOT NULL,
      page_source     TEXT NOT NULL,          -- 'record' | 'predictions'
      show_date       TEXT NOT NULL,          -- YYYY-MM-DD (their listed date)
      show_name_raw   TEXT NOT NULL,          -- their show label, verbatim
      corps_name_raw  TEXT NOT NULL,          -- their corps label, verbatim
      event_slug      TEXT,                   -- matched to our events.slug (nullable)
      show_name_norm  TEXT,                   -- normalized show label used for matching
      corps_name      TEXT,                   -- our canonical corps name (nullable)
      corps_key       TEXT,                   -- our corps_key (nullable)
      predicted_total REAL,                   -- their model prediction
      actual_total    REAL,                   -- their listed actual (record page; nullable)
      interval_pm     REAL,                   -- their "give or take" ± (predictions page; nullable)
      in_range        INTEGER,                -- 1/0 (record page; nullable)
      status          TEXT,                   -- 'graded' | 'awaiting' | null
      first_seen_at   TEXT NOT NULL,
      scraped_at      TEXT NOT NULL,
      PRIMARY KEY (source, page_source, show_date, show_name_raw, corps_name_raw)
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_ext_bench_event ON external_benchmark_predictions (event_slug, corps_key)`,
  );
}

// ---------- name normalization / matching ----------
function normCorps(s) {
  return String(s || '').trim().toLowerCase();
}

// build the same canon map the read-model uses (corps_aliases + corps_scores)
async function loadCorpsCanon() {
  const { rows } = await db.execute(`
    SELECT a.alias_name AS lookup, a.canonical_name AS name,
           (SELECT cs.corps_key FROM corps_scores cs
            WHERE cs.corps_name = a.canonical_name AND cs.corps_key IS NOT NULL LIMIT 1) AS corps_key
    FROM corps_aliases a
    UNION ALL
    SELECT corps_name AS lookup, corps_name AS name, corps_key
    FROM (SELECT corps_name, corps_key FROM corps_scores
          WHERE corps_name IS NOT NULL AND corps_key IS NOT NULL GROUP BY corps_name)
  `);
  const map = new Map();
  for (const r of rows) {
    const key = normCorps(r.lookup);
    if (!key || map.has(key)) continue; // first-write-wins, like the builder
    map.set(key, { name: r.name, corps_key: r.corps_key });
  }
  return map;
}

const STOP = new Set(['dci', 'the', 'of', 'a', 'and', 'presents', 'drum', 'corps', 'international']);
function showTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}
function normShow(s) {
  return showTokens(s).join(' ');
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// events keyed by date -> [{slug,name,tokens}]
async function loadEventsByDate() {
  const { rows } = await db.execute(
    `SELECT slug, name, substr(start_date,1,10) AS d FROM events WHERE start_date IS NOT NULL`,
  );
  const byDate = new Map();
  for (const r of rows) {
    if (!r.slug || !r.d) continue;
    if (!byDate.has(r.d)) byDate.set(r.d, []);
    byDate.get(r.d).push({ slug: r.slug, name: r.name, tokens: showTokens(r.name) });
  }
  return byDate;
}
function matchEvent(eventsByDate, date, showName) {
  const cands = eventsByDate.get(date) || [];
  if (cands.length === 0) return null;
  const toks = showTokens(showName);
  let best = null, bestScore = 0;
  for (const c of cands) {
    const s = jaccard(toks, c.tokens);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (cands.length === 1 && bestScore >= 0.15) return best.slug; // strong date anchor
  if (bestScore >= 0.34) return best.slug;
  return null;
}

// ---------- puppeteer render ----------
async function launchBrowser() {
  const puppeteer = await import(
    require.resolve('puppeteer-core', { paths: [path.join(REPO_ROOT, 'node_modules')] })
  ).then((m) => m.default ?? m);
  const CHROME = ['/usr/lib/chromium/chromium', '/usr/bin/chromium'].find((b) => {
    try { fs.accessSync(b, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (!CHROME) throw new Error('No chromium binary found (/usr/lib/chromium/chromium | /usr/bin/chromium)');
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

function parseMeta(metaText) {
  // "2026-07-22 · avg off 0.38 pts · ..."  OR  "2026-07-22 · show graded" / "awaiting results"
  const date = (metaText.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;
  let status = null;
  if (/awaiting results/i.test(metaText)) status = 'awaiting';
  else if (/graded/i.test(metaText)) status = 'graded';
  return { date, status };
}
function num(x) {
  if (x == null) return null;
  const m = String(x).replace(/[+]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function scrapeRecord(page) {
  await page.goto(BASE + '/record', { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('section.board table', { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  // extract structured boards
  return page.evaluate(() => {
    const out = [];
    for (const board of document.querySelectorAll('section.board')) {
      const nameEl = board.querySelector('.board-class');
      const metaEl = board.querySelector('.board-meta');
      if (!nameEl) continue;
      // board-class may contain the meta span; strip it
      const clone = nameEl.cloneNode(true);
      clone.querySelectorAll('.board-meta').forEach((n) => n.remove());
      const showName = clone.innerText.trim();
      const meta = metaEl ? metaEl.innerText.trim() : '';
      const rows = [];
      for (const tr of board.querySelectorAll('table tbody tr')) {
        const td = tr.querySelectorAll('td');
        if (td.length < 4) continue;
        rows.push({
          corps: td[0].innerText.trim(),
          predicted: td[1].innerText.trim(),
          actual: td[2].innerText.trim(),
          offBy: td[3].innerText.trim(),
          inRange: td[4] ? td[4].innerText.trim() : '',
        });
      }
      if (rows.length) out.push({ showName, meta, rows });
    }
    return out;
  });
}

async function scrapePredictions(page) {
  await page.goto(BASE + '/predictions', { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('button.board-toggle', { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  // expand every collapsed section
  const toggles = await page.$$('button.board-toggle');
  for (const t of toggles) {
    try {
      const expanded = await t.evaluate((el) => el.getAttribute('aria-expanded') === 'true');
      if (!expanded) await t.click();
    } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 1500));
  return page.evaluate(() => {
    const out = [];
    for (const board of document.querySelectorAll('section.board')) {
      const toggle = board.querySelector('.board-class .board-toggle') || board.querySelector('.board-class');
      const metaEl = board.querySelector('h3 .board-meta');
      if (!toggle) continue;
      const showName = toggle.innerText.replace(/▸/g, '').trim();
      const meta = metaEl ? metaEl.innerText.trim() : '';
      // header cols: Corps, Model, Give or take, Your pick, Actual, Model off by, You off by
      const rows = [];
      for (const tr of board.querySelectorAll('table tbody tr')) {
        const td = tr.querySelectorAll('td');
        if (td.length < 2) continue;
        rows.push({
          corps: td[0].innerText.trim(),
          model: td[1].innerText.trim(),
          giveOrTake: td[2] ? td[2].innerText.trim() : '',
          actual: td[4] ? td[4].innerText.trim() : '',
        });
      }
      if (rows.length) out.push({ showName, meta, rows });
    }
    return out;
  });
}

// ---------- upsert ----------
async function upsert(rec, canon, eventsByDate, nowIso) {
  const key = normCorps(rec.corps_name_raw);
  const c = canon.get(key) || null;
  const eventSlug = rec.show_date ? matchEvent(eventsByDate, rec.show_date, rec.show_name_raw) : null;
  await db.execute({
    sql: `
      INSERT INTO external_benchmark_predictions
        (source, page_source, show_date, show_name_raw, corps_name_raw,
         event_slug, show_name_norm, corps_name, corps_key,
         predicted_total, actual_total, interval_pm, in_range, status,
         first_seen_at, scraped_at)
      VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?)
      ON CONFLICT(source, page_source, show_date, show_name_raw, corps_name_raw)
      DO UPDATE SET
        event_slug      = excluded.event_slug,
        show_name_norm  = excluded.show_name_norm,
        corps_name      = excluded.corps_name,
        corps_key       = excluded.corps_key,
        predicted_total = excluded.predicted_total,
        actual_total    = excluded.actual_total,
        interval_pm     = excluded.interval_pm,
        in_range        = excluded.in_range,
        status          = excluded.status,
        scraped_at      = excluded.scraped_at
    `,
    args: [
      SOURCE, rec.page_source, rec.show_date, rec.show_name_raw, rec.corps_name_raw,
      eventSlug, normShow(rec.show_name_raw), c ? c.name : null, c ? c.corps_key : null,
      rec.predicted_total, rec.actual_total, rec.interval_pm, rec.in_range, rec.status,
      nowIso, nowIso,
    ],
  });
  return { matchedEvent: !!eventSlug, matchedCorps: !!c };
}

async function main() {
  await ensureTable();
  const [canon, eventsByDate] = await Promise.all([loadCorpsCanon(), loadEventsByDate()]);
  const nowIso = new Date().toISOString();

  const browser = await launchBrowser();
  let record, preds;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 corps-place-benchmark-bot',
    );
    record = await scrapeRecord(page);
    preds = await scrapePredictions(page);
    await page.close();
  } finally {
    await browser.close();
  }

  const stats = { record: 0, predictions: 0, matchedEvent: 0, matchedCorps: 0, shows: new Set() };

  for (const b of record) {
    const { date, status } = parseMeta(b.meta);
    if (!date) continue;
    stats.shows.add(b.showName + '@' + date);
    for (const r of b.rows) {
      const actual = /^—|^-$/.test(r.actual) ? null : num(r.actual);
      const res = await upsert(
        {
          page_source: 'record',
          show_date: date,
          show_name_raw: b.showName,
          corps_name_raw: r.corps,
          predicted_total: num(r.predicted),
          actual_total: actual,
          interval_pm: null,
          in_range: /✓/.test(r.inRange) ? 1 : /✗|✕|x/i.test(r.inRange) ? 0 : null,
          status: status || 'graded',
        },
        canon, eventsByDate, nowIso,
      );
      stats.record++;
      if (res.matchedEvent) stats.matchedEvent++;
      if (res.matchedCorps) stats.matchedCorps++;
    }
  }

  for (const b of preds) {
    const { date, status } = parseMeta(b.meta);
    if (!date) continue;
    for (const r of b.rows) {
      const actual = /^—|^-$/.test(r.actual) ? null : num(r.actual);
      await upsert(
        {
          page_source: 'predictions',
          show_date: date,
          show_name_raw: b.showName,
          corps_name_raw: r.corps,
          predicted_total: num(r.model),
          actual_total: actual,
          interval_pm: num(r.giveOrTake),
          in_range: null,
          status: status || null,
        },
        canon, eventsByDate, nowIso,
      );
      stats.predictions++;
    }
  }

  console.log(
    `[scrape-field-read] record rows=${stats.record} predictions rows=${stats.predictions} ` +
      `shows(record)=${stats.shows.size} ` +
      `corpsMatched(record)=${stats.matchedCorps}/${stats.record} ` +
      `eventMatched(record)=${stats.matchedEvent}/${stats.record}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => { console.error('[scrape-field-read] FAILED', e); process.exit(1); },
);
