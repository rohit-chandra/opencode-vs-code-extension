#!/usr/bin/env node
// Renders the README diagrams (docs/diagrams/*.html) to PNG with headless Chrome.
// The Marketplace page does not render Mermaid and does not accept SVG images, so the
// diagrams are drawn as HTML and shipped as PNG.
// Usage: npm run diagrams   (CHROME_BIN=/path/to/chrome if Chrome is not found)
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
if (!chrome) throw new Error('Chrome not found. Set CHROME_BIN.');

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'docs', 'diagrams');
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  for (const file of readdirSync(source).filter((f) => f.endsWith('.html'))) {
    const page = await browser.newPage();
    // A short viewport, so the full-page screenshot is exactly as tall as the diagram.
    await page.setViewport({ width: 1600, height: 200, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(path.join(source, file)).href);
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(root, 'docs', 'images', file.replace(/\.html$/, '.png'));
    await page.screenshot({ path: out, fullPage: true });
    await page.close();
    console.log(`${path.relative(root, out)} written`);
  }
} finally {
  await browser.close();
}
