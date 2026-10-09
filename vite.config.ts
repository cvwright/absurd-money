import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';

// 'wasm-unsafe-eval' lets the projection worker compile SQLite's WebAssembly; it does not
// allow eval of JavaScript. The hash is vite-plugin-pwa's inline dev service worker
// registration, which it adds to the dev HTML even though main.ts registers.
const headers = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-/AO8vAagk08SqUGxY96ci/dGyTDsuoetPOJYMn7sc+E='; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' https: ws: wss: http://localhost:* http://127.0.0.1:*; worker-src 'self'; frame-ancestors 'none';",
};

export default defineConfig({
  server: { headers },
  // `npm run build && npm run preview` is where to test offline and the PWA.
  preview: { headers },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // SQLite finds its .wasm next to its own module, which pre-bundling would break.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  test: {
    // Core is pure TypeScript with no DOM, so tests run in Node. `*.e2e.test.ts` need the
    // local reeeductio server and run only with `npm run test:e2e`.
    environment: 'node',
    include: process.env.E2E ? ['src/**/*.e2e.test.ts'] : ['src/**/*.test.ts'],
    exclude: process.env.E2E ? configDefaults.exclude : [...configDefaults.exclude, 'src/**/*.e2e.test.ts'],
    testTimeout: process.env.E2E ? 30_000 : 5_000,
    passWithNoTests: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Ledger data is end-to-end encrypted and lives in the projection, never in the
        // service worker cache. Only the app shell is precached.
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2,wasm}'],
        // Navigations are served by the navigateFallback route, which dev turns off (see
        // devOptions). Without this, the precache would still answer `/` with index.html.
        directoryIndex: null,
      },
      devOptions: {
        enabled: true,
        // Never serve the page from the dev precache: it would keep the headers it was
        // cached with, so CSP changes wouldn't apply. Dev modules aren't cached anyway.
        navigateFallbackAllowlist: [/^$/],
      },
      manifest: {
        name: 'Absurd Money',
        short_name: 'Money',
        description: 'Encrypted double-entry personal finance',
        theme_color: '#2bb3a0',
        background_color: '#121417',
        display: 'standalone',
        icons: [
          {
            src: '/money-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
});
