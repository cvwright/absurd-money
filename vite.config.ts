import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    headers: {
      // 'wasm-unsafe-eval' lets the projection worker compile SQLite's WebAssembly; it
      // does not allow eval of JavaScript.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' https: ws: wss:; worker-src 'self'; frame-ancestors 'none';",
    },
  },
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
    // Core is pure TypeScript with no DOM, so tests run in Node.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Ledger data is end-to-end encrypted and lives in the projection, never in the
        // service worker cache. Only the app shell is precached.
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2,wasm}'],
      },
      devOptions: {
        enabled: true,
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
