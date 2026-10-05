import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Honour the common _ prefix convention for intentionally unused params/vars
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // Prevent innerHTML/outerHTML assignments — use Lit html templates instead.
      // Payees, memos, account names, and imported CSV descriptions are user-controlled
      // and must never be interpolated into raw HTML.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression[left.property.name="innerHTML"]',
          message: 'Use Lit html`` templates instead of innerHTML to prevent stored XSS.',
        },
        {
          selector: 'AssignmentExpression[left.property.name="outerHTML"]',
          message: 'Use Lit html`` templates instead of outerHTML to prevent stored XSS.',
        },
        {
          selector: 'CallExpression[callee.property.name="insertAdjacentHTML"]',
          message: 'Use Lit html`` templates instead of insertAdjacentHTML to prevent stored XSS.',
        },
        {
          selector: 'CallExpression[callee.property.name="write"][callee.object.name="document"]',
          message: 'Use Lit html`` templates instead of document.write to prevent stored XSS.',
        },
      ],

      // Ban unsafeHTML — the only safe use is for truly static, developer-controlled
      // strings (never data from storage or external APIs).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lit/directives/unsafe-html.js',
              message: 'unsafeHTML must not be used with untrusted content. If you need this for static developer-controlled HTML, add an eslint-disable comment explaining why.',
            },
          ],
        },
      ],
    },
  },
  {
    // Core is pure TypeScript: no DOM, no network, no SDK, no UI. It may import only
    // other core modules, plus @noble/hashes for the label PRF (design/LABELS.md).
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/|@/core/|@noble/hashes/).*',
              message: 'src/core may import only other core modules and @noble/hashes.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'localStorage', 'sessionStorage',
          'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker'].map((name) => ({
          name,
          message: 'src/core has no DOM or network access.',
        })),
      ],
    },
  },
  {
    // The pinned CSV grammar (design/NORMALIZATION.md) wraps csv-parse, pinned to an exact
    // version. This one module may import it; the rest of core goes through parseCsv.
    files: ['src/core/csv.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/|@/core/|@noble/hashes/|csv-parse/browser/esm/sync$).*',
              message: 'src/core/csv.ts may import only core modules, @noble/hashes, and csv-parse/browser/esm/sync.',
            },
          ],
        },
      ],
    },
  },
  {
    // Core tests may also import vitest.
    files: ['src/core/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/|@/core/|@noble/hashes/|vitest$).*',
              message: 'core tests may import only core modules, @noble/hashes, and vitest.',
            },
          ],
        },
      ],
    },
  },
  {
    // Don't lint build output or dependencies
    ignores: ['dist/**', 'dev-dist/**', 'node_modules/**'],
  },
);
