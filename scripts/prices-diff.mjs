#!/usr/bin/env node
// Compares two price tables (src/core/prices.json before and after `npm run prices`) and
// prints one line a changelog can use, or nothing when no price changed.
//   node scripts/prices-diff.mjs <before.json> <after.json>
import { readFileSync } from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2);
const flat = (file) => {
  const out = new Map();
  for (const [provider, models] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).prices ?? {})) for (const [id, row] of Object.entries(models)) out.set(`${provider}/${id}`, JSON.stringify(row));
  return out;
};
const before = flat(beforeFile);
const after = flat(afterFile);
const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
if (added.length + removed.length + changed.length === 0) process.exit(0);

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const parts = [];
if (added.length) parts.push(`${count(added.length, 'new model', 'new models')} (${added.slice(0, 6).join(', ')}${added.length > 6 ? ', …' : ''})`);
if (changed.length) parts.push(count(changed.length, 'changed price', 'changed prices'));
if (removed.length) parts.push(`${count(removed.length, 'retired model', 'retired models')} removed`);
console.log(`Cost estimates: the list prices that ship with the extension were refreshed. ${parts.join(', ')}.`);
