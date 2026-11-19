#!/usr/bin/env node
// Renders media/icon.svg to media/icon.png (256×256) with headless Chrome.
// The marketplace does not accept SVG icons. Usage: CHROME_BIN=/path/to/chrome node scripts/render-icon.mjs
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!chrome) throw new Error('Chrome not found. Set CHROME_BIN.');
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${readFileSync('media/icon.svg', 'utf8')}`);
await page.screenshot({ path: 'media/icon.png', omitBackground: true });
await browser.close();
console.log('media/icon.png written');
