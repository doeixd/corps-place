import { defineConfig } from 'vite-plus';
// `@voidzero-dev/vite-plus-core` (where vite-plus's PluginOption lives) isn't
// resolvable from here, and vite's own PluginOption trips a deep-instantiation
// clash with vite-plus's defineConfig. The plugins below are all cast through
// `unknown` anyway, so alias it locally (`any` so it satisfies defineConfig's
// own plugin-array param, whose element type resolves to `any` when its core
// dep is unreachable).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginOption = any;
import { tanstackStart } from '@tanstack/react-start-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A unique id per build, compiled into both the client and server bundles via
// `define` (see below). The client polls /api/version and reloads when the server
// reports a different id — i.e. after a deploy. Prefer the git SHA (deterministic
// across the single config eval / both build environments); fall back to a build
// timestamp when .git isn't present in the build context.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return String(Date.now());
  }
})();

const basePath = process.env.SITE_BASE_PATH?.trim() || '/';
const normalizedBase = basePath === '/' ? '/' : basePath.replace(/\/$/, '');
const ignoredProjectArtifacts = [
  'sdk/**', // SDK has its own tsc check scripts; run explicitly when needed
  'src/**', // Old Astro remnants
  'astro.config.mjs',
  'app/components/reui/**', // Registry/vendor components; update via shadcn/ReUI.
  'app/fate/__generated__/**',
  'app/routeTree.gen.ts',
  'models/**',
  'results/**',
  '**/*.db',
  '**/*.json',
  '**/*.md',
  'dist/**',
  '.fate/**',
  '.nitro/**',
  '.output/**',
  'vite-smoke.*.log',
  'vite.config.timestamp*.js',
];

const dciApiProxy =
  process.env.DCI_API_PROXY_DISABLED !== 'true'
    ? {
        [process.env.DCI_API_PROXY_PREFIX ?? '/dci-api']: {
          target: process.env.DCI_API_PROXY_TARGET ?? 'https://api.dci.org/api/v1',
          changeOrigin: true,
          secure: (process.env.DCI_API_PROXY_TARGET ?? 'https://api.dci.org/api/v1').startsWith(
            'https'
          ),
          rewrite: (p: string) =>
            p.replace(
              new RegExp(
                `^${(process.env.DCI_API_PROXY_PREFIX ?? '/dci-api').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
              ),
              '/'
            ),
        },
      }
    : undefined;

const plugins: PluginOption[] = [
  ...(tanstackStart({
    customViteReactPlugin: true,
    tsr: {
      srcDirectory: './app',
      routesDirectory: './app/routes',
      generatedRouteTree: './app/routeTree.gen.ts',
    },
  }) as unknown as PluginOption[]),
  // NOTE: @vitejs/plugin-react v6 is oxc-based and no longer accepts a `babel`
  // option — the previous `babel.plugins: ["babel-plugin-react-compiler"]` was a
  // silent no-op (React Compiler was NOT actually running). Re-enabling the
  // compiler under v6 requires a separate babel pass (e.g. vite-plugin-babel) or
  // pinning plugin-react to v4. Tracked as migration follow-up.
  react() as unknown as PluginOption,
  // NOTE: the react-fate codegen plugin was removed — it re-evaluates the app
  // module graph (sources.ts -> event-directory.ts) under its own runner and
  // trips `Schema.TaggedErrorClass is not a function` (an Effect/Schema version
  // mismatch in the alpha plugin), breaking every production build. The committed
  // app/fate/__generated__/fate.ts is used as-is; Fate is slated for removal
  // (see docs/plans/DATA_LAYER_DECISION.md). Re-add codegen only if Fate stays.
  tailwindcss() as unknown as PluginOption,
];

export default defineConfig({
  base: normalizedBase === '/' ? undefined : normalizedBase,
  build: {
    // "r1" cache-generation prefix (2026-07-02 incident): Cloudflare cached
    // rollout-window 404s for /assets/<chunk> URLs WITH the immutable header
    // (routeRules stamped it on error responses too — since guarded by the
    // no-cache-errors nitro plugin), poisoning those URLs at the edge for up to
    // a year. Moving every built asset to a fresh path makes all poisoned URLs
    // unreachable without an edge purge. Bump r1 → r2 if it ever happens again.
    assetsDir: 'assets/r1',
  },
  define: {
    // Shared by the client (AutoUpdater) and the /api/version route — same value
    // per build, so a mismatch reliably means "the server was redeployed".
    __APP_VERSION__: JSON.stringify(BUILD_ID),
  },
  plugins,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'app'),
      '@sdk': path.resolve(__dirname, 'sdk'),
    },
    dedupe: ['react', 'react-dom'],
  },
  // Persistent cache for faster rebuilds (dev + production). Overridable via
  // VITE_CACHE_DIR for environments where node_modules isn't writable.
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  // Pre-bundle heavy deps so dev doesn't compile them on-demand on first
  // navigation (the ~4s cold-route delay). Production builds are unaffected.
  optimizeDeps: {
    include: [
      'effect',
      'xstate',
      '@xstate/react',
      '@xstate/store',
      'motion/react',
      'jotai',
      'jotai-solid-api',
      '@tanstack/react-table',
      '@tanstack/react-router',
      '@tanstack/react-virtual',
      'react-fate',
      '@nkzw/fate',
      'recharts',
      '@effect/rpc/Rpc',
      '@effect/rpc/RpcGroup',
      '@libsql/client',
      // ReUI / shadcn primitive deps — discovered lazily on first component
      // render otherwise, triggering a mid-session re-optimize + full reload.
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      '@base-ui/react/button',
      '@base-ui/react/checkbox',
      '@base-ui/react/input',
      '@base-ui/react/menu',
      '@base-ui/react/merge-props',
      '@base-ui/react/popover',
      '@base-ui/react/scroll-area',
      '@base-ui/react/select',
      '@base-ui/react/separator',
      '@base-ui/react/slider',
      '@base-ui/react/toggle',
      '@base-ui/react/toggle-group',
      '@base-ui/react/tooltip',
      '@base-ui/react/use-render',
      'radix-ui',
      '@dnd-kit/core',
      '@dnd-kit/modifiers',
      '@dnd-kit/sortable',
      '@dnd-kit/utilities',
    ],
  },
  server: {
    proxy: dciApiProxy,
    // Allow Cloudflare quick-tunnel hosts (`cloudflared tunnel --url ...`) through
    // Vite's dev host check so the app can be shared via a public URL. The leading
    // dot matches any `*.trycloudflare.com` subdomain (they're randomized per run).
    allowedHosts: [
      '.trycloudflare.com',
      'drumcorps.app',
      '.drumcorps.app',
      'pageantryjobs.com',
      '.pageantryjobs.com',
    ],
    // When serving the dev server through the Cloudflare tunnel (deploy.ps1 -Dev),
    // the HMR websocket must connect back over the public HTTPS host on 443 — the
    // default `ws://localhost:3000` is unreachable from a remote browser. The host
    // is passed in via env so plain `vite` on localhost keeps its normal HMR.
    hmr: process.env.TUNNEL_HMR_HOST
      ? { protocol: 'wss', host: process.env.TUNNEL_HMR_HOST, clientPort: 443 }
      : undefined,
    // Transform route + component modules at server start instead of on first
    // navigation, eliminating the cold-route compile stall in dev.
    warmup: {
      clientFiles: [
        './app/router.tsx',
        './app/routes/**/*.tsx',
        './app/components/**/*.tsx',
        '!./app/components/reui/**',
        './app/fate/client.ts',
        './app/fate/use-connection.ts',
        './app/machines/**/*.ts',
      ],
      ssrFiles: ['./app/router.tsx', './app/routes/**/*.tsx', './app/fate/server.ts'],
    },
  },
  ssr: {
    // Bundle recharts + its redux stack into the server build instead of
    // leaving them external: nitro's file tracing copies an incomplete
    // @reduxjs/toolkit into .output/server/node_modules in the Docker build
    // (dist entry missing), 500ing every SSR'd page that imports a chart.
    // use-sync-external-store is intentionally NOT here: its CJS shim
    // (shim/with-selector.js, pulled in by @xstate/react) throws "module is not
    // defined" when Vite's dev SSR module-runner inlines it. Externalizing it lets
    // Node load the CJS natively. It's a complete, simple package, so nitro's file
    // tracing copies it fine in the Docker build (unlike @reduxjs/toolkit, whose
    // missing dist entry is the reason the rest of this list stays bundled).
    noExternal: [
      /^recharts/,
      /^@reduxjs\/toolkit/,
      /^react-redux/,
      /^redux/,
      /^immer/,
      /^reselect/,
      /^victory-vendor/,
      /^d3-/,
      // use-sync-external-store's CJS shim (shim/with-selector.js, pulled in by
      // @xstate/react) throws "module is not defined" when Vite's dev SSR
      // module-runner tries to leave it as external. Bundling it (noExternal)
      // forces Vite's CJS→ESM transform, which works.
      'use-sync-external-store',
    ],
    optimizeDeps: {
      exclude: [
        'react',
        'react-dom',
        '@tanstack/react-router',
        '@tanstack/react-start',
        '@tanstack/react-start/server',
        '@tanstack/react-start/client',
        'react-fate',
      ],
    },
  },
  preview: {
    proxy: dciApiProxy,
  },

  // Vite+ unified toolchain configuration (added during migration).
  // These replace separate ESLint/Prettier/Vitest/tsdown configs.
  lint: {
    // Oxlint + tsgolint (TypeScript Go). Very fast type-aware linting.
    options: {
      typeAware: true,
      typeCheck: true,
    },
    // This project has a large SDK data/ingestion layer with many one-off scripts,
    // ML models, and generated artifacts. Keep `vp check` focused on real app code.
    ignorePatterns: [...ignoredProjectArtifacts],
  },

  fmt: {
    // Oxfmt — Prettier-compatible, Rust-based.
    // Tune these to match your team's style. Run `vp fmt` or `vp check --fix`.
    ignorePatterns: [...ignoredProjectArtifacts],
    singleQuote: true,
    semi: true,
    trailingComma: 'es5',
    printWidth: 100,
  },

  test: {
    // Vitest configuration (replaces vitest.config.ts).
    // Add setup files, coverage, browser mode, etc. as needed.
    include: ['app/**/*.{test,spec}.{ts,tsx}', 'sdk/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'sdk/models/**'],
  },

  // Future: staged block for commit hooks via `vp staged`
  // staged: {
  //   '*.{ts,tsx,js,jsx}': 'vp check --fix',
  // },
});
