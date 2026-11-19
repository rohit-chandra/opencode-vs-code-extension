#!/usr/bin/env node
// Refreshes src/core/prices.json: list prices (USD per million tokens) used to estimate what
// a reply costs when the engine does not report a cost itself (Codex, Direct BYOK).
//
// The numbers come from the model catalog that the opencode CLI carries (models.dev). They
// are read from the CLI on this machine, so the extension itself never downloads prices.
// Usage: npm run prices     (needs `opencode` on PATH; run it before a release)
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Providers the Direct BYOK presets and Codex can bill. OpenRouter reports the cost of each
// request itself, and local servers cost nothing, so neither needs a list price.
const PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'xai', 'togetherai', 'huggingface'];
// `opencode models` lists a provider only when it looks connected. Placeholder keys make it
// list all of them; the command reads its catalog and calls no provider.
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY', 'HF_TOKEN'];

const scratch = path.join(os.tmpdir(), 'ochub-prices');
const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache') };
for (const k of KEYS) env[k] ??= 'placeholder';
const run = (args) => spawnSync('opencode', args, { env, cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
const listed = run(['models', '--verbose']);
if (listed.status !== 0 || !listed.stdout) throw new Error(`opencode models --verbose failed: ${listed.stderr || listed.error || 'no output'}`);
const version = (run(['--version']).stdout || '').trim();

// Output is "<provider>/<model>" on one line, then that model as pretty-printed JSON.
const prices = {};
const parts = listed.stdout.split(/^([a-z0-9.-]+\/\S+)\r?\n(?=\{)/m);
for (let i = 1; i + 1 < parts.length; i += 2) {
  let model;
  try {
    model = JSON.parse(parts[i + 1]);
  } catch {
    continue;
  }
  const c = model.cost;
  if (!PROVIDERS.includes(model.providerID) || !c || !(c.input > 0 || c.output > 0)) continue;
  const row = [c.input ?? 0, c.output ?? 0, c.cache?.read ?? 0, c.cache?.write ?? 0];
  while (row.length > 2 && row[row.length - 1] === 0) row.pop();
  (prices[model.providerID] ??= {})[model.id] = row;
}
const count = Object.values(prices).reduce((n, p) => n + Object.keys(p).length, 0);
if (count < 50) throw new Error(`Only ${count} prices found; refusing to overwrite the table.`);
const sorted = Object.fromEntries(Object.keys(prices).sort().map((p) => [p, Object.fromEntries(Object.entries(prices[p]).sort(([a], [b]) => a.localeCompare(b)))]));
const out = { updated: new Date().toISOString().slice(0, 10), source: `models.dev catalog in opencode ${version}`, unit: 'USD per million tokens: [input, output, cache read, cache write]', prices: sorted };
writeFileSync('src/core/prices.json', JSON.stringify(out) + '\n');
console.log(`src/core/prices.json: ${count} models from ${Object.keys(sorted).length} providers (${out.source})`);
