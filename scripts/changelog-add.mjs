#!/usr/bin/env node
// Adds a line to CHANGELOG.md under the version that package.json has now, creating that
// section at the top when it is not there yet. Used by the weekly price refresh; handy by
// hand too:
//   npm version patch --no-git-tag-version
//   node scripts/changelog-add.mjs Changed "What changed, in a sentence."
import { readFileSync, writeFileSync } from 'node:fs';

const [kind, ...words] = process.argv.slice(2);
const text = words.join(' ').trim();
if (!['Added', 'Changed', 'Fixed'].includes(kind) || !text) {
  console.error('Usage: node scripts/changelog-add.mjs <Added|Changed|Fixed> "<what changed>"');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const heading = `## v${version}`;
const eol = readFileSync('CHANGELOG.md', 'utf8').includes('\r\n') ? '\r\n' : '\n';
const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
const bullet = `- ${text}`;

let at = lines.indexOf(heading);
if (at < 0) {
  // A new section, above the newest one.
  const first = lines.findIndex((l) => l.startsWith('## '));
  const section = [heading, '', `### ${kind}`, '', bullet, ''];
  if (first < 0) lines.push('', ...section);
  else lines.splice(first, 0, ...section);
} else {
  let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  if (end < 0) end = lines.length;
  const sub = lines.findIndex((l, i) => i > at && i < end && l === `### ${kind}`);
  if (sub < 0) {
    // Trailing blank lines of the section stay below what is added.
    let insert = end;
    while (insert > at + 1 && lines[insert - 1] === '') insert--;
    lines.splice(insert, 0, '', `### ${kind}`, '', bullet);
  } else {
    let insert = lines.findIndex((l, i) => i > sub && i <= end && (i === end || l.startsWith('#')));
    if (insert < 0) insert = end;
    while (insert > sub + 1 && lines[insert - 1] === '') insert--;
    lines.splice(insert, 0, bullet);
  }
}
writeFileSync('CHANGELOG.md', lines.join(eol));
console.log(`CHANGELOG.md: added under ${heading} / ${kind}`);
