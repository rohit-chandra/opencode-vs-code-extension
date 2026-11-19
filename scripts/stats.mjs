#!/usr/bin/env node
// How many people have the extension: installs on the Visual Studio Marketplace, downloads
// on Open VSX and downloads of the .vsix files attached to GitHub releases.
// Usage: npm run stats
//
// These are counts the stores keep. The extension has no telemetry, so there is no number
// of "active users"; installs and downloads are what exists.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1];
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : 'n/a');

async function marketplace() {
  // Flags: 0x100 statistics + 0x1 versions.
  const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 0x101 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ext = (await res.json()).results?.[0]?.extensions?.[0];
  if (!ext) return 'not listed (yet)';
  const stat = Object.fromEntries((ext.statistics ?? []).map((s) => [s.statisticName, s.value]));
  return `${n(stat.install)} installs, ${n(stat.updateCount)} updates, rating ${stat.averagerating ? stat.averagerating.toFixed(1) : 'n/a'} (${n(stat.ratingcount ?? 0)} reviews), latest ${ext.versions?.[0]?.version ?? '?'}`;
}

async function openVsx() {
  const res = await fetch(`https://open-vsx.org/api/${pkg.publisher}/${pkg.name}`);
  if (res.status === 404) return 'not listed (yet)';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return `${n(j.downloadCount)} downloads, rating ${j.averageRating ? j.averageRating.toFixed(1) : 'n/a'} (${n(j.reviewCount ?? 0)} reviews), latest ${j.version ?? '?'}`;
}

async function github() {
  if (!repo) return 'no repository in package.json';
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const [releases, info] = await Promise.all([fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers }), fetch(`https://api.github.com/repos/${repo}`, { headers })]);
  if (!releases.ok) throw new Error(`HTTP ${releases.status}`);
  const list = await releases.json();
  const perRelease = list.map((r) => [r.tag_name, r.assets.filter((a) => a.name.endsWith('.vsix')).reduce((sum, a) => sum + a.download_count, 0)]);
  const total = perRelease.reduce((sum, [, c]) => sum + c, 0);
  const stars = info.ok ? (await info.json()).stargazers_count : undefined;
  return `${n(total)} .vsix downloads (${perRelease.slice(0, 5).map(([t, c]) => `${t}: ${c}`).join(', ') || 'no releases'}), ${n(stars)} stars`;
}

console.log(`${pkg.displayName} (${id})\n`);
for (const [name, fn] of [['Visual Studio Marketplace', marketplace], ['Open VSX', openVsx], ['GitHub', github]]) {
  try {
    console.log(`${name.padEnd(26)} ${await fn()}`);
  } catch (err) {
    console.log(`${name.padEnd(26)} could not be read (${err.message})`);
  }
}
console.log(`\nDaily installs, page views and uninstalls: https://marketplace.visualstudio.com/manage/publishers/${pkg.publisher} (the extension's Reports).`);
