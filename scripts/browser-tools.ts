#!/usr/bin/env npx tsx

/**
 * Cross-platform Chrome / Edge DevTools helpers inspired by Mario Zechner's
 * "What if you don't need MCP?" article.
 *
 * Keeps everything in one TypeScript CLI so agents (or humans) can drive
 * Chrome/Edge directly via the DevTools protocol without pulling in a large
 * MCP server.
 */
import { Command, Option } from 'commander';
import { execSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { inspect } from 'node:util';
import puppeteer, {
  type Browser,
  type ConsoleMessage,
  type JSHandle,
  type Page,
} from 'puppeteer-core';

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

type AsyncFunctionCtor = new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;
type BrowserName = 'chrome' | 'edge';
type LifeCycleEvent = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

interface BrowserMeta {
  displayName: string;
  win32Bins: string[];
  darwinBins: string[];
  linuxBins: string[];
  win32ProcessName: string;
  darwinProcessName: string;
  linuxProcessName: string;
  win32ProfileDir: string;
  darwinProfileDir: string;
  linuxProfileDir: string;
}

interface ChromeProcessInfo {
  pid: number;
  port?: number;
  usesPipe: boolean;
  command: string;
}

interface ChromeTabInfo {
  id?: string;
  title?: string;
  url?: string;
  type?: string;
}

interface BrowserSession extends ChromeProcessInfo {
  version?: Record<string, string>;
  tabs: ChromeTabInfo[];
}

interface State {
  lastPort?: number;
  lastBrowser?: BrowserName;
}

/* -------------------------------------------------------------------------- */
/*                                Constants                                   */
/* -------------------------------------------------------------------------- */

const BROWSER_META: Record<BrowserName, BrowserMeta> = {
  chrome: {
    displayName: 'Chrome',
    win32Bins: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwinBins: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linuxBins: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    win32ProcessName: 'chrome.exe',
    darwinProcessName: 'Google Chrome',
    linuxProcessName: 'chrome',
    win32ProfileDir: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    darwinProfileDir: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    linuxProfileDir: path.join(os.homedir(), '.config', 'google-chrome'),
  },
  edge: {
    displayName: 'Edge',
    win32Bins: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwinBins: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linuxBins: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    win32ProcessName: 'msedge.exe',
    darwinProcessName: 'Microsoft Edge',
    linuxProcessName: 'microsoft-edge',
    win32ProfileDir: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
    darwinProfileDir: path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
    linuxProfileDir: path.join(os.homedir(), '.config', 'microsoft-edge'),
  },
};

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.cache', 'browser-tools');
const STATE_FILE = path.join(DEFAULT_PROFILE_DIR, 'state.json');
const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/* -------------------------------------------------------------------------- */
/*                                Utilities                                   */
/* -------------------------------------------------------------------------- */

const useColor = process.stdout.isTTY;
const colorize = (text: string, code: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const log = {
  ok: (msg: string) => console.log(colorize(`✓ ${msg}`, '32')),
  err: (msg: string) => console.error(colorize(`✗ ${msg}`, '31')),
  info: (msg: string) => console.log(colorize(`ℹ ${msg}`, '36')),
  dim: (msg: string) => console.log(colorize(msg, '90')),
  warn: (msg: string) => console.log(colorize(`⚠ ${msg}`, '33')),
};

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}

function saveState(patch: Partial<State>) {
  const current = loadState();
  const next = { ...current, ...patch };
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
}

function resolvePort(cmdOptions: { port?: number }): number {
  if (cmdOptions.port !== undefined) return cmdOptions.port;
  if (process.env.BROWSER_TOOLS_PORT) {
    const p = Number(process.env.BROWSER_TOOLS_PORT);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const state = loadState();
  if (state.lastPort !== undefined) return state.lastPort;
  return DEFAULT_PORT;
}

function resolveBrowser(cmdOptions: { browser?: string }): BrowserName {
  const raw = cmdOptions.browser ?? process.env.BROWSER_TOOLS_BROWSER ?? loadState().lastBrowser;
  return raw === 'edge' ? 'edge' : 'chrome';
}

function getBrowserCandidates(browser: BrowserName): string[] {
  const meta = BROWSER_META[browser];
  if (process.platform === 'win32') return meta.win32Bins;
  if (process.platform === 'darwin') return meta.darwinBins;
  return meta.linuxBins;
}

function findBrowserViaShell(browser: BrowserName): string | undefined {
  const commands =
    browser === 'chrome'
      ? ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']
      : ['microsoft-edge-stable', 'microsoft-edge', 'msedge'];

  for (const cmd of commands) {
    try {
      const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim().split('\n')[0].trim();
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

function findBrowserViaMdfind(browser: BrowserName): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const bundleId = browser === 'edge' ? 'com.microsoft.edgemac' : 'com.google.Chrome';
  const binaryName = browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  try {
    const result = spawnSync('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout.trim()) {
      const appPath = result.stdout.trim().split('\n')[0].trim();
      return path.join(appPath, 'Contents', 'MacOS', binaryName);
    }
  } catch {
    // continue
  }
  return undefined;
}

function findBrowserViaRegistry(browser: BrowserName): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const exeName = browser === 'edge' ? 'msedge.exe' : 'chrome.exe';
  const regPaths = [
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  for (const regPath of regPaths) {
    try {
      const result = spawnSync('reg', ['query', regPath, '/ve'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      if (result.status === 0) {
        const match = result.stdout.match(/REG_SZ\s+(.+?\.exe)/i);
        if (match) return match[1].trim();
      }
    } catch {
      // continue
    }
  }
  return undefined;
}

function getDefaultBrowserBin(browser: BrowserName): string {
  const shellPath = findBrowserViaShell(browser);
  if (shellPath && existsSync(shellPath)) return shellPath;

  if (process.platform === 'darwin') {
    const mdfindPath = findBrowserViaMdfind(browser);
    if (mdfindPath && existsSync(mdfindPath)) return mdfindPath;
  }

  if (process.platform === 'win32') {
    const regPath = findBrowserViaRegistry(browser);
    if (regPath && existsSync(regPath)) return regPath;
  }

  const candidates = getBrowserCandidates(browser);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function getProfileSource(browser: BrowserName): string {
  const meta = BROWSER_META[browser];
  if (process.platform === 'win32') return meta.win32ProfileDir;
  if (process.platform === 'darwin') return meta.darwinProfileDir;
  return meta.linuxProfileDir;
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      server.close();
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

function copyProfile(source: string, target: string): void {
  if (!existsSync(source)) {
    log.info(`Profile source not found: ${source}`);
    return;
  }

  let totalSize = 0;
  function calcSize(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          calcSize(fullPath);
        } catch {
          // ignore permission errors
        }
      } else {
        try {
          totalSize += statSync(fullPath).size;
        } catch {
          // ignore
        }
      }
    }
  }
  try {
    calcSize(source);
  } catch {
    // ignore
  }

  const sizeMB = totalSize / 1024 / 1024;
  if (sizeMB > 100) {
    log.warn(`Profile is ${sizeMB.toFixed(0)}MB. Copying may take a while (skipping caches)...`);
  }

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });

  const skipList = new Set([
    'cache',
    'code cache',
    'service worker',
    'indexeddb',
    'file_systems',
    'blob_storage',
    'gpu_cache',
    'media_cache',
    'network',
    'session storage',
    'shared_proto_db',
    'platform notifications',
    'push',
    'safe browsing',
    'certificate transparency',
    'optimization hints',
    'crashpad',
  ]);

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (skipList.has(entry.name.toLowerCase())) continue;
    try {
      cpSync(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore individual copy failures
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                           Process Discovery                                */
/* -------------------------------------------------------------------------- */

function parseWindowsProcessOutput(stdout: string): ChromeProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];

  let data:
    | Array<{ ProcessId: number; CommandLine: string }>
    | { ProcessId: number; CommandLine: string }
    | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data) return [];

  const entries = Array.isArray(data) ? data : [data];
  return entries
    .map((entry) => {
      const pid = Number(entry.ProcessId);
      const command = entry.CommandLine || '';
      if (!Number.isFinite(pid) || pid <= 0) return null;
      const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
      if (portMatch) {
        return { pid, port: Number(portMatch[1]), usesPipe: false, command };
      }
      if (/--remote-debugging-pipe/.test(command)) {
        return { pid, usesPipe: true, command };
      }
      return null;
    })
    .filter((x) => x !== null) as ChromeProcessInfo[];
}

function listWindowsProcesses(browser: BrowserName | 'all'): ChromeProcessInfo[] {
  const patterns =
    browser === 'all'
      ? ['*chrome*', '*msedge*']
      : [`*${BROWSER_META[browser].win32ProcessName.replace('.exe', '')}*`];

  const groups = patterns.map(
    (p) => `$_.CommandLine -match '--remote-debugging' -and $_.CommandLine -like '${p}'`
  );
  const whereClause = groups.join(' -or ');
  const cmd = `Get-CimInstance Win32_Process | Where-Object { ${whereClause} } | Select-Object ProcessId,CommandLine | ConvertTo-Json`;

  const result = spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  if (result.error || result.status !== 0) return [];
  return parseWindowsProcessOutput(result.stdout);
}

function listUnixProcesses(browser: BrowserName | 'all'): ChromeProcessInfo[] {
  let output: string;
  try {
    output = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to enumerate processes: ${message}`);
  }

  const processes: ChromeProcessInfo[] = [];
  for (const line of output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const hasDevTools =
      /--remote-debugging-port/.test(command) || /--remote-debugging-pipe/.test(command);
    if (!hasDevTools) continue;

    if (browser !== 'all') {
      const meta = BROWSER_META[browser];
      const isMatch =
        new RegExp(meta.linuxProcessName, 'i').test(command) ||
        (browser === 'chrome' && /chrome|chromium/i.test(command)) ||
        (browser === 'edge' && /msedge|microsoft-edge/i.test(command));
      if (!isMatch) continue;
    } else {
      if (!/chrome|chromium|msedge|microsoft-edge/i.test(command)) continue;
    }

    const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    if (portMatch) {
      const port = Number.parseInt(portMatch[1], 10);
      if (Number.isFinite(port)) {
        processes.push({ pid, port, usesPipe: false, command });
      }
    } else if (/--remote-debugging-pipe/.test(command)) {
      processes.push({ pid, usesPipe: true, command });
    }
  }
  return processes;
}

async function listDevtoolsBrowsers(browser: BrowserName | 'all'): Promise<ChromeProcessInfo[]> {
  if (process.platform === 'win32') {
    return listWindowsProcesses(browser);
  }
  return listUnixProcesses(browser);
}

async function describeBrowserSessions(options: {
  browser: BrowserName | 'all';
  ports?: number[];
  pids?: number[];
  includeAll?: boolean;
}): Promise<BrowserSession[]> {
  const { browser, ports, pids, includeAll } = options;
  const processes = await listDevtoolsBrowsers(browser);
  const portSet = new Set(ports ?? []);
  const pidSet = new Set(pids ?? []);

  const candidates = processes.filter((proc) => {
    if (includeAll) return true;
    if (portSet.size > 0 && proc.port !== undefined && portSet.has(proc.port)) return true;
    if (pidSet.size > 0 && pidSet.has(proc.pid)) return true;
    return false;
  });

  const results: BrowserSession[] = [];
  for (const proc of candidates) {
    let version: Record<string, string> | undefined;
    let filteredTabs: ChromeTabInfo[] = [];

    if (proc.port !== undefined) {
      const [versionResp, tabs] = await Promise.all([
        fetchJson(`http://localhost:${proc.port}/json/version`).catch(() => undefined),
        fetchJson(`http://localhost:${proc.port}/json/list`).catch(() => []),
      ]);
      version = versionResp as Record<string, string> | undefined;
      filteredTabs = Array.isArray(tabs)
        ? (tabs as ChromeTabInfo[]).filter((tab) => {
            const type = tab.type?.toLowerCase() ?? '';
            if (type && type !== 'page' && type !== 'app') {
              if (
                !tab.url ||
                tab.url.startsWith('devtools://') ||
                tab.url.startsWith('chrome-extension://')
              ) {
                return false;
              }
            }
            if (!tab.url || tab.url.trim().length === 0) return false;
            return true;
          })
        : [];
    }

    results.push({ ...proc, version, tabs: filteredTabs });
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*                            Puppeteer Helpers                               */
/* -------------------------------------------------------------------------- */

function browserURL(port: number): string {
  return `http://localhost:${port}`;
}

async function connectBrowser(port: number, timeoutMs = 5000): Promise<Browser> {
  return Promise.race([
    puppeteer.connect({ browserURL: browserURL(port), defaultViewport: null }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// esbuild's --keep-names (enabled by tsx) rewrites named functions we pass to
// page.evaluate into `__name(fn, "...")`. The browser has no `__name`, so those
// injected functions throw "__name is not defined". Define a no-op shim in the
// page so the wrapper calls are harmless. evaluateOnNewDocument reinstalls it on
// every navigation (page.goto creates a fresh JS context that loses globals).
const installShim = () => {
  (globalThis as Record<string, unknown>).__name ??= (fn: unknown) => fn;
};

async function installPageShims(page: Page) {
  try {
    await page.evaluateOnNewDocument(installShim);
  } catch {
    // ignore
  }
  try {
    await page.evaluate(installShim);
  } catch {
    // ignore
  }
}

async function preparePage(page: Page) {
  try {
    await page.setUserAgent(REALISTIC_USER_AGENT);
  } catch {
    // ignore
  }
  try {
    await page.setBypassCSP(true);
  } catch {
    // ignore
  }
  await installPageShims(page);
}

async function withActivePage<T>(
  port: number,
  fn: (page: Page, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await connectBrowser(port);
  try {
    let pages = await browser.pages();
    if (pages.length === 0) {
      await browser.newPage();
      pages = await browser.pages();
    }
    const page = pages.at(-1)!;
    await preparePage(page);
    return await fn(page, browser);
  } finally {
    await browser.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/*                           Readability Helpers                              */
/* -------------------------------------------------------------------------- */

async function ensureReadability(page: Page) {
  try {
    await page.setBypassCSP?.(true);
  } catch {
    // ignore
  }

  const scripts = [
    'https://unpkg.com/@mozilla/readability@0.4.4/Readability.js',
    'https://unpkg.com/turndown@7.1.2/dist/turndown.js',
    'https://unpkg.com/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js',
  ];

  for (const src of scripts) {
    try {
      const alreadyLoaded = await page.evaluate((url) => {
        return Boolean(document.querySelector(`script[src="${url}"]`));
      }, src);
      if (!alreadyLoaded) {
        await page.addScriptTag({ url: src });
      }
    } catch {
      // best-effort; continue
    }
  }
}

async function extractReadableContent(
  page: Page
): Promise<{ title?: string; content?: string; url: string }> {
  await ensureReadability(page);

  const result = await page.evaluate(() => {
    const asMarkdown = (html: string | null | undefined) => {
      if (!html) return '';
      const TurndownService = (window as any).TurndownService;
      const turndownPluginGfm = (window as any).turndownPluginGfm;
      if (!TurndownService) return '';
      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      if (turndownPluginGfm?.gfm) {
        turndown.use(turndownPluginGfm.gfm);
      }
      return turndown
        .turndown(html)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    const fallbackText = () => {
      const main =
        document.querySelector('main, article, [role="main"], .content, #content') ||
        document.body ||
        document.documentElement;
      return main?.textContent?.trim() ?? '';
    };

    let title = document.title;
    let content = '';

    try {
      const Readability = (window as any).Readability;
      if (Readability) {
        const clone = document.cloneNode(true) as Document;
        const article = new Readability(clone).parse();
        title = article?.title || title;
        content = asMarkdown(article?.content) || article?.textContent || '';
      }
    } catch {
      // ignore readability failures
    }

    if (!content) {
      content = fallbackText();
    }

    content = content?.trim().slice(0, 8000);
    return { title, content, url: location.href };
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/*                              CLI Helpers                                   */
/* -------------------------------------------------------------------------- */

function parseNumberListArg(value: string): number[] {
  return parseNumberList(value) ?? [];
}

function parseNumberList(inputValue: string | undefined): number[] | undefined {
  if (!inputValue) return undefined;
  const parsed = inputValue
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((value) => Number.isFinite(value));
  return parsed.length > 0 ? parsed : undefined;
}

function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs, family: 4 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Request to ${url} timed out`));
    });
    request.on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/*                                 CLI Setup                                  */
/* -------------------------------------------------------------------------- */

const program = new Command();
program
  .name('browser-tools')
  .description('Lightweight Chrome / Edge DevTools helpers (no MCP required).')
  .version('0.2.0')
  .configureHelp({ sortSubcommands: true })
  .showSuggestionAfterError()
  .option('-p, --port <number>', 'Remote debugging port (env: BROWSER_TOOLS_PORT)', (v) =>
    Number.parseInt(v, 10)
  )
  .addOption(
    new Option('--browser <name>', 'Default browser (env: BROWSER_TOOLS_BROWSER)').choices([
      'chrome',
      'edge',
    ])
  );

/* -------------------------------------------------------------------------- */
/*                                   start                                    */
/* -------------------------------------------------------------------------- */

program
  .command('start')
  .description('Launch the browser with remote debugging enabled.')
  .option('--profile', 'Copy your default browser profile before launch.', false)
  .option(
    '--profile-dir <path>',
    'Directory for the temporary browser profile.',
    DEFAULT_PROFILE_DIR
  )
  .option('--binary-path <path>', 'Path to the browser binary (overrides auto-detect).')
  .option('--chrome-path <path>', 'Deprecated alias for --binary-path.')
  .option('--kill-existing', 'Stop any running browser instances before launch.', false)
  .option('--headless', 'Run in headless mode.', false)
  .action(async (options) => {
    const port = resolvePort(options);
    const browserName = resolveBrowser(options);
    const { profile, profileDir, binaryPath, chromePath, killExisting, headless } = options as {
      profile: boolean;
      profileDir: string;
      binaryPath: string | undefined;
      chromePath: string | undefined;
      killExisting: boolean;
      headless: boolean;
    };

    const displayName = BROWSER_META[browserName].displayName;

    if (await isPortInUse(port)) {
      log.err(`Port ${port} is already in use. Another process may be listening.`);
      log.info('Use a different port with --port or kill the existing browser.');
      process.exit(1);
    }

    if (killExisting) {
      const procs = await listDevtoolsBrowsers(browserName);
      for (const proc of procs) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
          } else {
            process.kill(proc.pid);
          }
          log.dim(`Killed existing ${displayName} (PID ${proc.pid})`);
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    mkdirSync(profileDir, { recursive: true });

    if (profile) {
      const source = getProfileSource(browserName);
      copyProfile(source, profileDir);
    }

    const manualBin = binaryPath || chromePath;
    const binPath = manualBin || getDefaultBrowserBin(browserName);
    if (!existsSync(binPath)) {
      log.err(`Browser binary not found: ${binPath}`);
      log.info(`Install ${displayName} or pass --binary-path.`);
      process.exit(1);
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-popup-blocking',
    ];
    if (headless) {
      args.push('--headless=new');
    }

    const stderrChunks: Buffer[] = [];
    const child = spawn(binPath, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdout?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const browser = await connectBrowser(port, 2000);
        await browser.disconnect();
        connected = true;
        break;
      } catch {
        if (child.exitCode !== null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!connected) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      log.err(`Failed to start ${displayName} on port ${port}`);
      if (child.exitCode !== null) {
        log.err(`Process exited with code ${child.exitCode}`);
      }
      if (stderr.trim()) {
        log.err(`Output: ${stderr.trim().slice(0, 1000)}`);
      }
      process.exit(1);
    }

    child.stderr?.removeAllListeners('data');
    child.stdout?.removeAllListeners('data');
    child.stderr?.destroy();
    child.stdout?.destroy();
    child.unref();

    saveState({ lastPort: port, lastBrowser: browserName });
    log.ok(
      `${displayName} listening on http://localhost:${port}${profile ? ' (profile copied)' : ''}`
    );
  });

/* -------------------------------------------------------------------------- */
/*                                    nav                                     */
/* -------------------------------------------------------------------------- */

program
  .command('nav <url>')
  .description('Navigate the current tab or open a new tab.')
  .option('--new', 'Open in a new tab.', false)
  .addOption(
    new Option('--wait-until <event>', 'Navigation wait condition')
      .choices(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
      .default('domcontentloaded')
  )
  .action(async (url: string, options) => {
    const port = resolvePort(options);
    const waitUntil = options.waitUntil as LifeCycleEvent;
    const browser = await connectBrowser(port);
    try {
      if (options.new) {
        const page = await browser.newPage();
        await preparePage(page);
        await page.goto(url, { waitUntil });
        log.ok(`Opened in new tab: ${url}`);
      } else {
        const pages = await browser.pages();
        const page = pages.at(-1);
        if (!page) {
          throw new Error('No active tab found');
        }
        await preparePage(page);
        await page.goto(url, { waitUntil });
        log.ok(`Navigated current tab to: ${url}`);
      }
    } finally {
      await browser.disconnect();
    }
  });

/* -------------------------------------------------------------------------- */
/*                                    eval                                    */
/* -------------------------------------------------------------------------- */

program
  .command('eval <code...>')
  .description('Evaluate JavaScript in the active page context.')
  .option('--pretty-print', 'Format array/object results with indentation.', false)
  .option('--timeout <ms>', 'Evaluation timeout in milliseconds', '30000')
  .action(async (code: string[], options) => {
    const snippet = code.join(' ');
    const port = resolvePort(options);
    const pretty = Boolean(options.prettyPrint);
    const timeout = Number(options.timeout) || 30000;
    const tty = process.stdout.isTTY;

    const printPretty = (value: unknown) => {
      console.log(
        inspect(value, {
          depth: 6,
          colors: tty,
          maxArrayLength: 50,
          breakLength: 80,
          compact: false,
        })
      );
    };

    await withActivePage(port, async (page) => {
      const result = await Promise.race([
        page.evaluate((body) => {
          const ASYNC_FN = Object.getPrototypeOf(async () => {}).constructor as AsyncFunctionCtor;
          return new ASYNC_FN(`return (${body})`)().catch((e: unknown) => ({ __error: String(e) }));
        }, snippet),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Evaluation timed out after ${timeout}ms`)), timeout)
        ),
      ]);

      if (result && typeof result === 'object' && '__error' in result) {
        log.err((result as any).__error);
        return;
      }

      if (pretty) {
        printPretty(result);
      } else if (result === undefined) {
        log.dim('undefined');
      } else if (result === null) {
        log.dim('null');
      } else if (Array.isArray(result)) {
        result.forEach((entry, index) => {
          if (index > 0) console.log('');
          Object.entries(entry).forEach(([key, value]) => {
            console.log(`${key}: ${value}`);
          });
        });
      } else if (typeof result === 'object') {
        Object.entries(result).forEach(([key, value]) => {
          console.log(`${key}: ${value}`);
        });
      } else {
        console.log(result);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                 screenshot                                 */
/* -------------------------------------------------------------------------- */

program
  .command('screenshot')
  .description('Capture the current viewport and print the temp PNG path.')
  .option('-o, --output <path>', 'Output file path (default: temp file).')
  .option('--full-page', 'Capture the full scrollable page.', false)
  .action(async (options) => {
    const port = resolvePort(options);
    const outputPath = options.output as string | undefined;
    const fullPage = Boolean(options.fullPage);
    const filePath = outputPath || path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);

    await withActivePage(port, async (page) => {
      if (fullPage) {
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(filePath);
        return;
      }

      const client = await page.target().createCDPSession();
      try {
        const layoutMetrics = await client.send('Page.getLayoutMetrics').catch(() => undefined);
        const layoutViewport = layoutMetrics?.layoutViewport as
          | { clientWidth: number; clientHeight: number; pageX?: number; pageY?: number }
          | undefined;

        let cssWidth = layoutViewport?.clientWidth;
        let cssHeight = layoutViewport?.clientHeight;
        const pageX = layoutViewport?.pageX ?? 0;
        const pageY = layoutViewport?.pageY ?? 0;

        if (!cssWidth || !cssHeight) {
          const viewport = page.viewport();
          cssWidth = viewport?.width;
          cssHeight = viewport?.height;
        }

        if (!cssWidth || !cssHeight) {
          const fallback = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }));
          cssWidth = fallback.width;
          cssHeight = fallback.height;
        }

        if (!cssWidth || !cssHeight) {
          await page.screenshot({ path: filePath });
          console.log(filePath);
          return;
        }

        const maxDimension = 2000;
        const scale =
          cssWidth && cssHeight
            ? Math.max(0.01, Math.min(1, maxDimension / Math.max(cssWidth, cssHeight)))
            : 1;

        const screenshot = await client.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: pageX,
            y: pageY,
            width: cssWidth,
            height: cssHeight,
            scale,
          },
        });

        await writeFile(filePath, Buffer.from(screenshot.data, 'base64'));
        console.log(filePath);
      } finally {
        try {
          await client.detach();
        } catch {
          // ignore
        }
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                    pick                                    */
/* -------------------------------------------------------------------------- */

program
  .command('pick <message...>')
  .description('Interactive DOM picker that prints metadata for clicked elements.')
  .action(async (messageParts: string[], options) => {
    const message = messageParts.join(' ');
    const port = resolvePort(options);

    await withActivePage(port, async (page) => {
      const injectionResult = await page
        .evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            pickOverlayInjected?: boolean;
            pick?: (prompt: string) => Promise<unknown>;
          };
          if (scope.pickOverlayInjected) return { status: 'already-injected' };
          scope.pickOverlayInjected = true;
          scope.pick = async (prompt: string) =>
            new Promise((resolve) => {
              const selections: unknown[] = [];
              const selectedElements = new Set<HTMLElement>();

              const overlay = document.createElement('div');
              overlay.style.cssText =
                'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none';

              const highlight = document.createElement('div');
              highlight.style.cssText =
                'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.05s ease';
              overlay.appendChild(highlight);

              const banner = document.createElement('div');
              banner.style.cssText =
                'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:12px 24px;border-radius:8px;font:14px system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647';

              const updateBanner = () => {
                banner.textContent = `${prompt} (${selections.length} selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)`;
              };

              const cleanup = () => {
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('click', onClick, true);
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                banner.remove();
                selectedElements.forEach((el) => {
                  el.style.outline = '';
                });
              };

              const serialize = (el: HTMLElement) => {
                const parents: string[] = [];
                let current = el.parentElement;
                while (current && current !== document.body) {
                  const id = current.id ? `#${current.id}` : '';
                  const cls = current.className
                    ? `.${current.className.trim().split(/\s+/).join('.')}`
                    : '';
                  parents.push(`${current.tagName.toLowerCase()}${id}${cls}`);
                  current = current.parentElement;
                }
                return {
                  tag: el.tagName.toLowerCase(),
                  id: el.id || null,
                  class: el.className || null,
                  text: el.textContent?.trim()?.slice(0, 200) || null,
                  html: el.outerHTML.slice(0, 500),
                  parents: parents.join(' > '),
                };
              };

              const onMove = (event: MouseEvent) => {
                const node = document.elementFromPoint(
                  event.clientX,
                  event.clientY
                ) as HTMLElement | null;
                if (!node || overlay.contains(node) || banner.contains(node)) return;
                const rect = node.getBoundingClientRect();
                highlight.style.cssText = `position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;
              };

              const onClick = (event: MouseEvent) => {
                if (banner.contains(event.target as Node)) return;
                event.preventDefault();
                event.stopPropagation();
                const node = document.elementFromPoint(
                  event.clientX,
                  event.clientY
                ) as HTMLElement | null;
                if (!node || overlay.contains(node) || banner.contains(node)) return;

                if (event.metaKey || event.ctrlKey) {
                  if (!selectedElements.has(node)) {
                    selectedElements.add(node);
                    node.style.outline = '3px solid #10b981';
                    selections.push(serialize(node));
                    updateBanner();
                  }
                } else {
                  cleanup();
                  const info = serialize(node);
                  resolve(selections.length > 0 ? selections : info);
                }
              };

              const onKey = (event: KeyboardEvent) => {
                if (event.key === 'Escape') {
                  cleanup();
                  resolve(null);
                } else if (event.key === 'Enter' && selections.length > 0) {
                  cleanup();
                  resolve(selections);
                }
              };

              document.addEventListener('mousemove', onMove, true);
              document.addEventListener('click', onClick, true);
              document.addEventListener('keydown', onKey, true);

              document.body.append(overlay, banner);
              updateBanner();
            });
          return { status: 'injected' };
        })
        .catch((e) => ({ status: 'error', message: String(e) }));

      if (injectionResult && typeof injectionResult === 'object' && 'status' in injectionResult) {
        if (injectionResult.status === 'error') {
          log.err(`Failed to inject picker: ${(injectionResult as any).message}`);
          return;
        }
      }

      const result = await page.evaluate((msg) => {
        const pickFn = (window as Window & { pick?: (message: string) => Promise<unknown> }).pick;
        if (!pickFn) return { __error: 'Picker not available' };
        return pickFn(msg);
      }, message);

      if (result && typeof result === 'object' && '__error' in result) {
        log.err((result as any).__error);
        return;
      }

      if (Array.isArray(result)) {
        result.forEach((entry, index) => {
          if (index > 0) console.log('');
          Object.entries(entry).forEach(([key, value]) => {
            console.log(`${key}: ${value}`);
          });
        });
      } else if (result && typeof result === 'object') {
        Object.entries(result).forEach(([key, value]) => {
          console.log(`${key}: ${value}`);
        });
      } else {
        console.log(result);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                  console                                   */
/* -------------------------------------------------------------------------- */

program
  .command('console')
  .description('Capture and display console logs from the active tab.')
  .option(
    '--types <list>',
    'Comma-separated log types to show (e.g., log,error,warn). Default: all types'
  )
  .option('--follow', 'Continuous monitoring mode (like tail -f)', false)
  .option(
    '--timeout <seconds>',
    'Capture duration in seconds (default: 5 for one-shot, infinite for --follow)',
    (value) => Number.parseInt(value, 10)
  )
  .option('--color', 'Force color output')
  .option('--no-color', 'Disable color output')
  .option('--no-serialize', 'Disable object serialization (show raw text only)', false)
  .action(async (options) => {
    const port = resolvePort(options);
    const follow = options.follow as boolean;
    const timeout = options.timeout as number | undefined;
    const typesFilter = options.types as string | undefined;
    const noSerialize = options.noSerialize as boolean;
    const serialize = !noSerialize;

    const argv = process.argv.slice(2);
    const colorFlag = argv.includes('--color')
      ? true
      : argv.includes('--no-color')
        ? false
        : undefined;
    const tty = colorFlag ?? process.stdout.isTTY;

    const normalizeType = (value: string) => {
      const lower = value.toLowerCase();
      if (lower === 'warning') return 'warn';
      return lower;
    };

    const allowedTypes = typesFilter
      ? new Set(typesFilter.split(',').map((t) => normalizeType(t.trim())))
      : null;

    const c = (text: string, code: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
    const red = (text: string) => c(text, '31');
    const yellow = (text: string) => c(text, '33');
    const cyan = (text: string) => c(text, '36');
    const gray = (text: string) => c(text, '90');
    const white = (text: string) => text;

    const typeColors: Record<string, (text: string) => string> = {
      error: red,
      warn: yellow,
      warning: yellow,
      info: cyan,
      debug: gray,
      log: white,
      pageerror: red,
    };

    const formatTimestamp = () => {
      const now = new Date();
      return (
        now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0')
      );
    };

    const formatValue = (value: unknown, depth = 0, maxDepth = 10): string => {
      if (depth > maxDepth) return '[Object]';
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'string') return `'${value}'`;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value === 'function') return '[Function]';
      if (Array.isArray(value)) {
        const items = value.map((v) => formatValue(v, depth + 1, maxDepth));
        return `[ ${items.join(', ')} ]`;
      }
      if (typeof value === 'object') {
        const entries = Object.entries(value).map(
          ([k, v]) => `${k}: ${formatValue(v, depth + 1, maxDepth)}`
        );
        return entries.length > 0 ? `{ ${entries.join(', ')} }` : '{}';
      }
      return String(value);
    };

    const serializeArgs = async (msg: ConsoleMessage): Promise<string> => {
      try {
        const args: JSHandle[] = msg.args();
        const values = await Promise.all(
          args.map(async (arg) => {
            try {
              const value = await arg.jsonValue();
              return formatValue(value);
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              if (errorMsg.includes('circular')) return '[Circular]';
              if (errorMsg.includes('reference chain')) return '[DeepObject]';
              return '[Unserializable]';
            }
          })
        );
        return values.join(' ');
      } catch {
        return msg.text();
      }
    };

    const formatMessage = (
      type: string,
      text: string,
      location?: { url?: string; lineNumber?: number }
    ) => {
      const color = typeColors[type] || white;
      const timestamp = formatTimestamp();
      const loc =
        location?.url && location?.lineNumber ? ` ${location.url}:${location.lineNumber}` : '';
      return color(`[${type.toUpperCase()}] ${timestamp} ${text}${loc}`);
    };

    await withActivePage(port, async (page) => {
      page.on('console', async (msg) => {
        const type = normalizeType(msg.type());
        if (allowedTypes && !allowedTypes.has(type)) return;
        const text = serialize ? await serializeArgs(msg) : msg.text();
        console.log(formatMessage(type, text, msg.location()));
      });

      page.on('pageerror', (error) => {
        if (allowedTypes && !allowedTypes.has('pageerror') && !allowedTypes.has('error')) return;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(formatMessage('pageerror', msg));
      });

      if (follow) {
        log.dim('Monitoring console logs (Ctrl+C to stop)...');
        const waitForExit = () =>
          new Promise<void>((resolve) => {
            let exited = false;
            const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
            const onSignal = () => {
              if (exited) return;
              exited = true;
              cleanup();
              resolve();
            };
            const cleanup = () => {
              signals.forEach((signal) => process.off(signal, onSignal));
              process.off('beforeExit', onSignal);
            };
            signals.forEach((signal) => process.once(signal, onSignal));
            process.once('beforeExit', onSignal);
          });

        await waitForExit();
      } else {
        const duration = timeout ?? 5;
        log.dim(`Capturing console logs for ${duration} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, duration * 1000));
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                  network                                   */
/* -------------------------------------------------------------------------- */

program
  .command('network')
  .description(
    'Capture network requests from the active tab from attach time; websocket shows only the upgrade handshake.'
  )
  .option(
    '--types <list>',
    'Comma-separated resource types (e.g., xhr,fetch,document). Default: all'
  )
  .option('--follow', 'Continuous monitoring mode (like tail -f)', false)
  .option(
    '--timeout <seconds>',
    'Capture duration in seconds (default: 5 for one-shot, infinite for --follow)',
    (value) => Number.parseInt(value, 10)
  )
  .option('--color', 'Force color output')
  .option('--no-color', 'Disable color output')
  .action(async (options) => {
    const port = resolvePort(options);
    const follow = options.follow as boolean;
    const timeout = options.timeout as number | undefined;
    const typesFilter = options.types as string | undefined;

    const argv = process.argv.slice(2);
    const colorFlag = argv.includes('--color')
      ? true
      : argv.includes('--no-color')
        ? false
        : undefined;
    const tty = colorFlag ?? process.stdout.isTTY;

    const allowedTypes = typesFilter
      ? new Set(typesFilter.split(',').map((t) => t.trim().toLowerCase()))
      : null;

    const c = (text: string, code: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
    const red = (text: string) => c(text, '31');
    const yellow = (text: string) => c(text, '33');
    const green = (text: string) => c(text, '32');
    const cyan = (text: string) => c(text, '36');
    const gray = (text: string) => c(text, '90');
    const white = (text: string) => text;

    const statusColor = (status: number) => {
      if (status >= 400) return red;
      if (status >= 300) return yellow;
      if (status >= 200) return green;
      return white;
    };

    const pad = (s: string, width: number) =>
      s.length >= width ? s : s + ' '.repeat(width - s.length);

    const formatTimestamp = () => {
      const now = new Date();
      return (
        now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0')
      );
    };

    await withActivePage(port, async (page) => {
      let reqCounter = 0;
      const requestMeta = new Map<number, { method: string; url: string; startedAt: number }>();

      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (allowedTypes && !allowedTypes.has(resourceType)) return;
        const id = ++reqCounter;
        (req as any).__btId = id;
        requestMeta.set(id, { method: req.method(), url: req.url(), startedAt: Date.now() });
        console.log(
          `${cyan('[REQ ]')} ${gray(formatTimestamp())} ${pad(req.method(), 6)} ${pad(resourceType, 9)} ${req.url()}`
        );
      });

      page.on('response', (resp) => {
        const req = resp.request();
        const resourceType = req.resourceType();
        if (allowedTypes && !allowedTypes.has(resourceType)) return;
        const status = resp.status();
        const id = (req as any).__btId as number | undefined;
        const meta = id !== undefined ? requestMeta.get(id) : undefined;
        const ms = meta !== undefined ? Date.now() - meta.startedAt : undefined;
        const durationStr = ms !== undefined ? gray(` (${ms}ms)`) : '';
        console.log(
          `${statusColor(status)('[RESP]')} ${gray(formatTimestamp())} ${pad(String(status), 6)} ${pad(resourceType, 9)} ${req.url()}${durationStr}`
        );
        if (id !== undefined) requestMeta.delete(id);
      });

      page.on('requestfailed', (req) => {
        const resourceType = req.resourceType();
        if (allowedTypes && !allowedTypes.has(resourceType)) return;
        const id = (req as any).__btId as number | undefined;
        if (id !== undefined) requestMeta.delete(id);
        const failure = req.failure();
        const reason = failure ? failure.errorText : 'unknown';
        console.log(
          `${red('[FAIL]')} ${gray(formatTimestamp())} ${pad(req.method(), 6)} ${pad(resourceType, 9)} ${req.url()}  ${red('(' + reason + ')')}`
        );
      });

      if (follow) {
        log.dim('Monitoring network requests (Ctrl+C to stop)...');
        const waitForExit = () =>
          new Promise<void>((resolve) => {
            let exited = false;
            const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
            const onSignal = () => {
              if (exited) return;
              exited = true;
              cleanup();
              resolve();
            };
            const cleanup = () => {
              signals.forEach((signal) => process.off(signal, onSignal));
              process.off('beforeExit', onSignal);
            };
            signals.forEach((signal) => process.once(signal, onSignal));
            process.once('beforeExit', onSignal);
          });

        await waitForExit();
      } else {
        const duration = timeout ?? 5;
        log.dim(`Capturing network requests for ${duration} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, duration * 1000));
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                   search                                   */
/* -------------------------------------------------------------------------- */

program
  .command('search <query...>')
  .description('Google search with optional readable content extraction.')
  .option(
    '-n, --count <number>',
    'Number of results to return (default: 5, max: 50)',
    (value) => Number.parseInt(value, 10),
    5
  )
  .option('--content', 'Fetch readable content for each result (slower).', false)
  .option(
    '--timeout <seconds>',
    'Per-navigation timeout in seconds (default: 10).',
    (value) => Number.parseInt(value, 10),
    10
  )
  .action(async (queryWords: string[], options) => {
    const port = resolvePort(options);
    const count = Math.max(1, Math.min(options.count as number, 50));
    const fetchContent = Boolean(options.content);
    const timeoutMs = Math.max(3, (options.timeout as number) ?? 10) * 1000;
    const query = queryWords.join(' ');

    await withActivePage(port, async (page) => {
      const results: { title: string; link: string; snippet: string; content?: string }[] = [];
      let start = 0;
      while (results.length < count) {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}`;

        const resp = await page
          .goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          .catch((e) => {
            log.err(`Navigation failed: ${e.message}`);
            return null;
          });
        if (!resp) break;

        const hasResults = await page
          .waitForSelector('div.MjjYud', { timeout: 3000 })
          .catch(() => false);
        if (!hasResults) {
          const title = await page.title().catch(() => 'Unknown');
          const url = page.url();
          log.warn(`No search results found. Current page: ${title} (${url})`);
          break;
        }

        const pageResults = await page.evaluate(() => {
          const items: { title: string; link: string; snippet: string }[] = [];
          document.querySelectorAll('div.MjjYud').forEach((result) => {
            const titleEl = result.querySelector('h3');
            const linkEl = result.querySelector('a');
            const snippetEl = result.querySelector('div.VwiC3b, div[data-sncf]');
            const link = linkEl?.getAttribute('href') ?? '';
            if (titleEl && linkEl && link && !link.startsWith('https://www.google.com')) {
              items.push({
                title: titleEl.textContent?.trim() ?? '',
                link,
                snippet: snippetEl?.textContent?.trim() ?? '',
              });
            }
          });
          return items;
        });

        for (const r of pageResults) {
          if (results.length >= count) break;
          if (!results.some((existing) => existing.link === r.link)) {
            results.push(r);
          }
        }

        if (pageResults.length === 0 || start >= 90) break;
        start += 10;
        if (results.length < count) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if (fetchContent) {
        for (const result of results) {
          try {
            const ok = await page
              .goto(result.link, { waitUntil: 'networkidle2', timeout: timeoutMs })
              .catch((e) => {
                log.warn(`Failed to fetch ${result.link}: ${e.message}`);
                return null;
              });
            if (!ok) {
              result.content = '(Navigation failed)';
              continue;
            }
            const article = await extractReadableContent(page);
            result.content = article.content ?? '(No readable content)';
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.content = `(Error fetching content: ${message})`;
          }
        }
      }

      results.forEach((r, index) => {
        console.log(`--- Result ${index + 1} ---`);
        console.log(`Title: ${r.title}`);
        console.log(`Link: ${r.link}`);
        if (r.snippet) {
          console.log(`Snippet: ${r.snippet}`);
        }
        if (r.content) {
          console.log(`Content:\n${r.content}`);
        }
        console.log('');
      });

      if (results.length === 0) {
        console.log('No results found.');
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                  content                                   */
/* -------------------------------------------------------------------------- */

program
  .command('content <url>')
  .description('Extract readable content from a URL as markdown-like text.')
  .option(
    '--timeout <seconds>',
    'Navigation timeout in seconds (default: 10).',
    (value) => Number.parseInt(value, 10),
    10
  )
  .action(async (url: string, options) => {
    const port = resolvePort(options);
    const timeoutMs = Math.max(3, (options.timeout as number) ?? 10) * 1000;

    await withActivePage(port, async (page) => {
      const resp = await page
        .goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs })
        .catch((e) => {
          log.err(`Navigation failed: ${e.message}`);
          return null;
        });
      if (!resp) return;

      const article = await extractReadableContent(page);
      console.log(`URL: ${article.url}`);
      if (article.title) {
        console.log(`Title: ${article.title}`);
      }
      console.log('');
      console.log(article.content ?? '(No readable content)');
    });
  });

/* -------------------------------------------------------------------------- */
/*                                  cookies                                   */
/* -------------------------------------------------------------------------- */

program
  .command('cookies')
  .description('Dump cookies from the active tab as JSON.')
  .action(async (options) => {
    const port = resolvePort(options);
    await withActivePage(port, async (page) => {
      const cookies = await page.cookies();
      console.log(JSON.stringify(cookies, null, 2));
    });
  });

/* -------------------------------------------------------------------------- */
/*                                  inspect                                   */
/* -------------------------------------------------------------------------- */

program
  .command('inspect')
  .description(
    'List browser processes launched with --remote-debugging-port and show their open tabs.'
  )
  .option('--browser <name>', 'Filter by browser (chrome, edge, or all).', 'all')
  .option('--ports <list>', 'Comma-separated list of ports to include.', parseNumberListArg)
  .option('--pids <list>', 'Comma-separated list of PIDs to include.', parseNumberListArg)
  .option('--json', 'Emit machine-readable JSON output.', false)
  .action(async (options) => {
    const browser = options.browser as BrowserName | 'all';
    const ports = (options.ports as number[] | undefined)?.filter(
      (entry) => Number.isFinite(entry) && entry > 0
    );
    const pids = (options.pids as number[] | undefined)?.filter(
      (entry) => Number.isFinite(entry) && entry > 0
    );
    const sessions = await describeBrowserSessions({
      browser,
      ports,
      pids,
      includeAll: !ports?.length && !pids?.length,
    });
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('No browser instances with DevTools ports found.');
      return;
    }
    sessions.forEach((session, index) => {
      if (index > 0) console.log('');
      const transport =
        session.port !== undefined
          ? `port ${session.port}`
          : session.usesPipe
            ? 'debugging pipe'
            : 'unknown transport';
      const header = [`PID ${session.pid}`, `(${transport})`];
      if (session.version?.Browser) {
        header.push(`- ${session.version.Browser}`);
      }
      console.log(header.join(' '));
      if (session.tabs.length === 0) {
        console.log('  (no tabs reported)');
        return;
      }
      session.tabs.forEach((tab, idx) => {
        const title = tab.title || '(untitled)';
        const url = tab.url || '(no url)';
        console.log(`  Tab ${idx + 1}: ${title}`);
        console.log(`           ${url}`);
      });
    });
  });

/* -------------------------------------------------------------------------- */
/*                                    kill                                    */
/* -------------------------------------------------------------------------- */

program
  .command('kill')
  .description('Terminate browser instances that have DevTools ports open.')
  .option('--browser <name>', 'Filter by browser (chrome, edge, or all).', 'all')
  .option('--ports <list>', 'Comma-separated list of ports to target.', parseNumberListArg)
  .option('--pids <list>', 'Comma-separated list of PIDs to target.', parseNumberListArg)
  .option('--all', 'Kill every matching browser instance.', false)
  .option('--force', 'Skip the confirmation prompt.', false)
  .action(async (options) => {
    const browser = options.browser as BrowserName | 'all';
    const ports = (options.ports as number[] | undefined)?.filter(
      (entry) => Number.isFinite(entry) && entry > 0
    );
    const pids = (options.pids as number[] | undefined)?.filter(
      (entry) => Number.isFinite(entry) && entry > 0
    );
    const killAll = Boolean(options.all);
    if (!killAll && !ports?.length && !pids?.length) {
      log.err('Specify --all, --ports <list>, or --pids <list> to select targets.');
      process.exit(1);
    }
    const sessions = await describeBrowserSessions({ browser, ports, pids, includeAll: killAll });
    if (sessions.length === 0) {
      console.log('No matching browser instances found.');
      return;
    }
    if (!options.force) {
      console.log('About to terminate the following browser sessions:');
      sessions.forEach((session) => {
        const transport =
          session.port !== undefined
            ? `port ${session.port}`
            : session.usesPipe
              ? 'debugging pipe'
              : 'unknown transport';
        console.log(`  PID ${session.pid} (${transport})`);
      });
      const rl = readline.createInterface({ input, output });
      const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    }
    const failures: { pid: number; error: string }[] = [];
    for (const session of sessions) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${session.pid} /T /F`, { stdio: 'ignore' });
        } else {
          process.kill(session.pid);
        }
        const transport =
          session.port !== undefined
            ? `port ${session.port}`
            : session.usesPipe
              ? 'debugging pipe'
              : 'unknown transport';
        log.ok(`Killed browser PID ${session.pid} (${transport})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.err(`Failed to kill PID ${session.pid}: ${message}`);
        failures.push({ pid: session.pid, error: message });
      }
    }
    if (failures.length > 0) {
      process.exitCode = 1;
    }
  });

/* -------------------------------------------------------------------------- */
/*                                 wait-for                                   */
/* -------------------------------------------------------------------------- */

program
  .command('wait-for <selector>')
  .description('Wait for an element to appear in the DOM.')
  .option('--timeout <ms>', 'Timeout in milliseconds', '5000')
  .action(async (selector: string, options) => {
    const port = resolvePort(options);
    const timeout = Number(options.timeout) || 5000;
    await withActivePage(port, async (page) => {
      try {
        await page.waitForSelector(selector, { timeout });
        log.ok(`Element appeared: ${selector}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`wait-for failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                   click                                    */
/* -------------------------------------------------------------------------- */

program
  .command('click <selector>')
  .description('Click an element.')
  .action(async (selector: string, options) => {
    const port = resolvePort(options);
    await withActivePage(port, async (page) => {
      try {
        await page.click(selector);
        log.ok(`Clicked: ${selector}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`click failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                    type                                    */
/* -------------------------------------------------------------------------- */

program
  .command('type <selector> <text...>')
  .description('Type text into an input field.')
  .option('--clear', 'Clear the field first', false)
  .action(async (selector: string, textParts: string[], options) => {
    const port = resolvePort(options);
    const text = textParts.join(' ');
    await withActivePage(port, async (page) => {
      try {
        if (options.clear) {
          await page.click(selector, { clickCount: 3 });
          await page.keyboard.press('Backspace');
        }
        await page.type(selector, text);
        log.ok(`Typed into ${selector}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`type failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                   scroll                                   */
/* -------------------------------------------------------------------------- */

program
  .command('scroll')
  .description('Scroll the page.')
  .option('--to <y>', 'Scroll to absolute Y coordinate', (v) => Number(v))
  .option('--by <y>', 'Scroll by Y delta', (v) => Number(v))
  .option('--bottom', 'Scroll to bottom', false)
  .action(async (options) => {
    const port = resolvePort(options);
    await withActivePage(port, async (page) => {
      try {
        if (options.bottom) {
          await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight ?? 0));
        } else if (options.to !== undefined) {
          await page.evaluate((y: number) => window.scrollTo(0, y), options.to);
        } else if (options.by !== undefined) {
          await page.evaluate((y: number) => window.scrollBy(0, y), options.by);
        } else {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        }
        log.ok('Scrolled');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`scroll failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                    pdf                                     */
/* -------------------------------------------------------------------------- */

program
  .command('pdf <url>')
  .description('Save a page as PDF.')
  .option('-o, --output <path>', 'Output path')
  .option('--format <format>', 'Paper format (e.g., A4, Letter)', 'A4')
  .action(async (url: string, options) => {
    const port = resolvePort(options);
    const outputPath = options.output || path.join(os.tmpdir(), `page-${Date.now()}.pdf`);
    await withActivePage(port, async (page) => {
      const resp = await page.goto(url, { waitUntil: 'networkidle2' }).catch((e) => {
        log.err(`Navigation failed: ${e.message}`);
        return null;
      });
      if (!resp) return;
      await page.pdf({ path: outputPath, format: options.format });
      log.ok(`PDF saved: ${outputPath}`);
    });
  });

/* -------------------------------------------------------------------------- */
/*                                set-cookie                                  */
/* -------------------------------------------------------------------------- */

program
  .command('set-cookie <json>')
  .description('Set cookies from a JSON array or object.')
  .action(async (json: string, options) => {
    const port = resolvePort(options);
    let cookies: unknown;
    try {
      cookies = JSON.parse(json);
    } catch {
      log.err('Invalid JSON provided');
      process.exit(1);
    }
    const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
    await withActivePage(port, async (page) => {
      try {
        const currentUrl = page.url();
        const enriched = cookieArray.map((c: any) => ({
          url: currentUrl,
          ...c,
        }));
        await page.setCookie(...enriched);
        log.ok(`Set ${enriched.length} cookie(s)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`set-cookie failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                               clear-cookies                                */
/* -------------------------------------------------------------------------- */

program
  .command('clear-cookies')
  .description('Clear all cookies for the active tab.')
  .action(async (options) => {
    const port = resolvePort(options);
    await withActivePage(port, async (page) => {
      try {
        const cookies = await page.cookies();
        await page.deleteCookie(...cookies);
        log.ok(`Cleared ${cookies.length} cookie(s)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err(`clear-cookies failed: ${msg}`);
      }
    });
  });

/* -------------------------------------------------------------------------- */
/*                                 close-tab                                  */
/* -------------------------------------------------------------------------- */

program
  .command('close-tab [index]')
  .description('Close a tab by index (default: current active tab).')
  .action(async (indexStr: string | undefined, options) => {
    const port = resolvePort(options);
    const browser = await connectBrowser(port);
    try {
      const pages = await browser.pages();
      if (indexStr !== undefined) {
        const index = Number(indexStr);
        if (!Number.isFinite(index) || index < 0 || index >= pages.length) {
          log.err(`Invalid tab index: ${index}. There are ${pages.length} tab(s).`);
          process.exit(1);
        }
        await pages[index].close();
        log.ok(`Closed tab ${index}`);
      } else {
        const page = pages.at(-1);
        if (!page) {
          log.err('No active tab');
          process.exit(1);
        }
        await page.close();
        log.ok('Closed active tab');
      }
    } finally {
      await browser.disconnect();
    }
  });

/* -------------------------------------------------------------------------- */
/*                                 list-tabs                                  */
/* -------------------------------------------------------------------------- */

program
  .command('list-tabs')
  .description('List all open tabs.')
  .option('--json', 'JSON output', false)
  .action(async (options) => {
    const port = resolvePort(options);
    const browser = await connectBrowser(port);
    try {
      const pages = await browser.pages();
      const tabs = await Promise.all(
        pages.map(async (p, i) => ({
          index: i,
          url: p.url(),
          title: await p.title().catch(() => '(untitled)'),
        }))
      );
      if (options.json) {
        console.log(JSON.stringify(tabs, null, 2));
      } else {
        tabs.forEach((tab) => {
          console.log(`[${tab.index}] ${tab.title}`);
          console.log(`    ${tab.url}`);
        });
      }
    } finally {
      await browser.disconnect();
    }
  });

/* -------------------------------------------------------------------------- */
/*                                   parse                                    */
/* -------------------------------------------------------------------------- */

program.parseAsync(process.argv).catch((err) => {
  log.err(err.message);
  process.exit(1);
});
