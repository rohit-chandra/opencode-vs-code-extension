#!/usr/bin/env node
// Bundles the extension host (Node, CommonJS) and the two webview bundles (browser, IIFE).
import { build, context } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  metafile: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const targets = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    // The MCP SDK ships ESM; prefer its module builds and keep Node built-ins external.
    mainFields: ['module', 'main'],
  },
  {
    ...common,
    entryPoints: ['webview/src/main.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
  },
  {
    ...common,
    entryPoints: ['webview/src/avatar/index.ts'],
    outfile: 'dist/avatar.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

mkdirSync('dist', { recursive: true });
if (watch) {
  for (const t of targets) await (await context(t)).watch();
  console.log('watching…');
} else {
  const results = await Promise.all(targets.map((t) => build(t)));
  writeNotices(results);
  for (const f of ['dist/extension.js', 'dist/webview.js', 'dist/webview.css', 'dist/avatar.js']) {
    console.log(`${f}  ${(statSync(f).size / 1024).toFixed(0)} kB`);
  }
}

/** List every npm package that ended up in a bundle, with its licence text, as the licences require. */
function writeNotices(results) {
  const packages = new Map();
  for (const r of results) {
    for (const input of Object.keys(r.metafile?.inputs ?? {})) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.split('node_modules/').length > 1 ? input.replace(/^.*?(node_modules\/)/, '$1').replace(/^(.*)node_modules\//, 'node_modules/') : '');
      if (!m) continue;
      const dir = path.resolve(m[1]);
      if (packages.has(dir) || !existsSync(path.join(dir, 'package.json'))) continue;
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const licenceFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
      packages.set(dir, { name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package'), text: licenceFile ? readFileSync(path.join(dir, licenceFile), 'utf8').trim() : '' });
    }
  }
  const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = ['THIRD-PARTY NOTICES', '', 'OpenCode Hub bundles the following open-source packages.', '', ...list.map((p) => `- ${p.name}@${p.version} (${p.license})`), '', ...list.flatMap((p) => ['='.repeat(78), `${p.name}@${p.version} (${p.license})`, '='.repeat(78), p.text || '(no licence file shipped with the package)', ''])];
  writeFileSync('dist/THIRD_PARTY_NOTICES.txt', out.join('\n'));
  console.log(`dist/THIRD_PARTY_NOTICES.txt  ${list.length} packages`);
}
