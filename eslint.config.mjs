import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'test-results/**', '*.vsix', '.vscode-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Extension-host code must not reach into the webview and vice versa; only `src/shared` is common.
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/webview/**'], message: 'Host code cannot import webview code.' }] }] },
  },
  {
    files: ['src/core/**/*.ts', 'src/engines/opencode/**/*.ts', 'src/engines/direct/**/*.ts', 'src/engines/cli/**/*.ts', 'src/shared/**/*.ts', 'src/mcp/**/*.ts', 'src/ui/controller.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'Keep this module free of the vscode API so it can be tested without an editor. Inject what you need.' }] }] },
  },
  {
    files: ['test/**/*.ts', 'test/**/*.mjs', 'scripts/**/*.mjs', '*.mjs', '*.mts'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Buffer: 'readonly', fetch: 'readonly', window: 'readonly', document: 'readonly', getComputedStyle: 'readonly', Image: 'readonly', DataTransfer: 'readonly', File: 'readonly', ClipboardEvent: 'readonly', DragEvent: 'readonly', AbortSignal: 'readonly', PerformanceObserver: 'readonly', performance: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
);
