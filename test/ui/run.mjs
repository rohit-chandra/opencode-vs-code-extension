#!/usr/bin/env node
// Webview UI tests: load the real webview bundle in headless Chrome with a mocked VS Code
// API, drive it like a user would, assert on what it renders and posts, and save screenshots.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { base, conversation, usageSummary } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, 'test-results', 'ui');
mkdirSync(outDir, { recursive: true });

const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('Chrome not found. Set CHROME_BIN to run the UI tests.');
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = url.pathname === '/' ? path.join(root, 'test/ui/harness.html') : path.join(root, url.pathname);
  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-device-scale-factor=2'],
});

const results = [];
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(theme = 'dark', width = 400, height = 760) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`${origin}/?theme=${theme}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  // The webview renders at most once per animation frame, and effects run after paint. Give
  // both a chance before the test looks, so slow CI runners see the same thing as fast laptops.
  const host = (m) =>
    page.evaluate(async (msg) => {
      window.__host(msg);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, m);
  const posted = (type) =>
    page.evaluate(async (t) => {
      const pick = () => window.__posted.filter((m) => !t || m.type === t);
      for (let i = 0; i < 25 && t && pick().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      return pick();
    }, type);
  const clearPosted = () => page.evaluate(() => (window.__posted.length = 0));
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
  const text = (sel) => page.$eval(sel, (el) => el.textContent);
  return { page, host, posted, clearPosted, shot, text, consoleErrors };
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`);
  }
}

await test('empty state: welcome copy, suggestions and a live 3D companion', async () => {
  const t = await open();
  await t.host({ type: 'state', state: base });
  await t.page.waitForSelector('.welcome-line');
  // The first paint can still show the start-up state; wait for the real one.
  await t.page.waitForFunction(() => /What are we building\?/.test(document.querySelector('.stage-caption')?.textContent ?? ''));
  assert.match(await t.text('.welcome-line'), /Chatting through opencode with claude-sonnet-5-5/);
  assert.equal(await t.text('.session-title'), 'New session');
  // The companion bundle loads lazily and must render real WebGL frames.
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.renderer === 'webgl', { timeout: 15000 });
  const f1 = await t.page.$eval('canvas.oki', (c) => Number(c.dataset.frames || 0));
  await sleep(700);
  const f2 = await t.page.$eval('canvas.oki', (c) => Number(c.dataset.frames || 0));
  assert.ok(f2 > f1 + 5, `avatar is animating (${f1} -> ${f2} frames)`);
  // The canvas is not blank. A WebGL canvas cannot be read back after compositing, so look at what is on screen.
  const box = await (await t.page.$('canvas.oki')).boundingBox();
  const png = await t.page.screenshot({ clip: box, encoding: 'base64' });
  const painted = await t.page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 64;
    const g = probe.getContext('2d');
    g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
    return n / (64 * 64);
  }, png);
  assert.ok(painted > 0.15, `avatar draws something (${(painted * 100).toFixed(0)}% of pixels)`);
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'idle');
  await t.shot('01-empty-dark');
  await t.page.click('.suggestion');
  assert.deepEqual((await t.posted('send'))[0], { type: 'send', text: 'Give me a short tour of this workspace: what it does and where the important code lives.' });
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('conversation: markdown, code, tool cards, reasoning, files and per-message usage', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.msg.assistant .md');
  assert.equal(await t.text('.session-title'), 'Refactor the auth middleware');
  assert.equal(await t.text('.msg.user .bubble'), 'Why is every request so slow after the auth change?');
  assert.equal(await t.text('.stage-caption'), 'Ready');
  assert.match(await t.text('.stage-sub'), /opencode, claude-sonnet-5-5/);
  assert.equal(await t.page.$$eval('.fold.tool', (els) => els.length), 2);
  assert.equal(await t.page.$eval('.fold.tool.error .tool-name', (el) => el.textContent), 'bash');
  assert.ok(await t.page.$('.code .hljs-keyword'), 'code is syntax highlighted');
  assert.equal(await t.text('.code-lang'), 'ts');
  // Under the reply: the model that answered, then what it used. Input read back from the prompt
  // cache is counted apart from new input, and is not part of the session's total.
  assert.match(await t.text('.msg.assistant .meta'), /^claude-sonnet-5-5.*8\.2k in.*15k cached.*852 out.*\$0\.04$/s);
  assert.match(await t.page.$eval('.msg.assistant .meta', (el) => el.title), /^claude-sonnet-5-5: 8,240 new input tokens, 15,200 read back from the prompt cache/);
  assert.match(await t.text('.pill.session-tokens'), /^9\.1k · \$0\.04$/);
  assert.match(await t.page.$eval('.usage-btn', (el) => el.title), /8,240 new input tokens, 15,200 read back from the prompt cache.*612 output tokens, 240 thinking tokens, \$0\.04/);
  assert.ok(await t.page.$('.md table'), 'tables render');

  // Tool card expands to show input and output.
  await t.page.click('.fold.tool .fold-head');
  assert.match(await t.text('.fold.tool.open .tool-io'), /verify/);
  // Copy and insert buttons on code blocks go through the host.
  await t.clearPosted();
  await t.page.click('.code [data-action="copy"]');
  await t.page.click('.code [data-action="insert"]');
  const copy = (await t.posted('copy'))[0];
  assert.match(copy.text, /^export function auth/);
  assert.equal((await t.posted('insertCode')).length, 1);
  // Links never navigate: files open in the editor, http links go to the browser.
  await t.page.click('.md [data-href="src/middleware/auth.ts"]');
  await t.page.click('.md [data-href^="https://expressjs.com"]');
  assert.deepEqual(await t.posted('openFile'), [{ type: 'openFile', path: 'src/middleware/auth.ts' }]);
  assert.deepEqual(await t.posted('openExternal'), [{ type: 'openExternal', url: 'https://expressjs.com/en/guide/using-middleware.html' }]);
  await t.page.click('.msg.user .chip.file');
  assert.equal((await t.posted('openFile'))[1].path, '/work/app/src/middleware/auth.ts');
  await sleep(600);
  await t.shot('02-conversation-dark');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('streaming: deltas append text and the companion follows along', async () => {
  const t = await open();
  await t.host({ type: 'state', state: { ...conversation, activity: 'busy' } });
  await t.page.waitForSelector('.msg.assistant');
  const sid = 'ses_1';
  await t.host({ type: 'event', event: { type: 'message.updated', message: { id: 'm3', sessionId: sid, role: 'user', createdAt: Date.now(), parts: [{ id: 'u', type: 'text', text: 'And the tests?' }] } } });
  await t.host({ type: 'event', event: { type: 'message.updated', message: { id: 'm4', sessionId: sid, role: 'assistant', createdAt: Date.now() + 1, parts: [] } } });
  await t.page.waitForSelector('[data-message-id="m4"] .typing');
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Thinking…');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.mood === 'thinking');
  await t.host({ type: 'event', event: { type: 'part.updated', sessionId: sid, messageId: 'm4', part: { id: 'pt', type: 'text', text: 'Run ' } } });
  for (const delta of ['`npm', ' test`', ' to', ' check', ' them.']) {
    await t.host({ type: 'event', event: { type: 'part.delta', sessionId: sid, messageId: 'm4', partId: 'pt', delta } });
    await sleep(40);
  }
  await t.page.waitForFunction(() => document.querySelector('[data-message-id="m4"] .md')?.textContent.trim() === 'Run npm test to check them.');
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Writing…');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'speaking');
  await t.shot('03-streaming-dark');
  // A running tool switches the companion to its working mood.
  await t.host({ type: 'event', event: { type: 'part.updated', sessionId: sid, messageId: 'm4', part: { id: 'tool1', type: 'tool', tool: 'bash', callId: 'c9', status: 'running', title: 'npm test' } } });
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Running bash…');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'working');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.work), 'build');
  // Stop button and Esc both abort.
  await t.clearPosted();
  await t.page.click('.send.stop');
  assert.equal((await t.posted('abort')).length, 1);
  // The tool finishes: a little cheer straight away, and real excitement when the turn ends well.
  await t.host({ type: 'event', event: { type: 'part.updated', sessionId: sid, messageId: 'm4', part: { id: 'tool1', type: 'tool', tool: 'bash', callId: 'c9', status: 'completed', title: 'npm test', output: '12 passed' } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.reaction === 'success');
  await t.host({ type: 'patch', patch: { activity: 'idle' } });
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'It worked!');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'excited');
  await sleep(450);
  await t.shot('03b-excited-dark');
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Ready', { timeout: 6000 });
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'idle');

  // Next turn: a lookup, then an edit that fails. Oki picks the matching prop, winces, and ends up sad.
  await t.host({ type: 'patch', patch: { activity: 'busy' } });
  await t.host({ type: 'event', event: { type: 'message.updated', message: { id: 'm5', sessionId: sid, role: 'assistant', createdAt: Date.now() + 5, parts: [{ id: 'tl', type: 'tool', tool: 'grep', callId: 'c10', status: 'running' }] } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.work === 'search');
  assert.equal(await t.text('.stage-caption'), 'Looking with grep…');
  await t.host({ type: 'event', event: { type: 'part.updated', sessionId: sid, messageId: 'm5', part: { id: 'te', type: 'tool', tool: 'edit', callId: 'c11', status: 'running' } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.work === 'edit');
  await t.host({ type: 'event', event: { type: 'part.updated', sessionId: sid, messageId: 'm5', part: { id: 'te', type: 'tool', tool: 'edit', callId: 'c11', status: 'error', error: 'old_string not found' } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.reaction === 'fail');
  await t.host({ type: 'patch', patch: { activity: 'idle' } });
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'That did not work');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'sad');
  await sleep(500);
  await t.shot('03c-sad-dark');

  // A turn split over two messages, the way opencode sends it: a tool that is already finished
  // when it first shows up, then the answer in a second message. Still counts as a success.
  await t.host({ type: 'patch', patch: { activity: 'busy' } });
  await t.host({ type: 'event', event: { type: 'message.updated', message: { id: 'm6', sessionId: sid, role: 'user', createdAt: Date.now() + 6, parts: [{ id: 'u6', type: 'text', text: 'Try again' }] } } });
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Thinking…');
  await t.host({ type: 'events', events: [
    { type: 'message.updated', message: { id: 'm7', sessionId: sid, role: 'assistant', createdAt: Date.now() + 7, completedAt: Date.now() + 8, parts: [{ id: 't7', type: 'tool', tool: 'mockmcp_add', callId: 'c12', status: 'completed', output: '42' }] } },
    { type: 'message.updated', message: { id: 'm8', sessionId: sid, role: 'assistant', createdAt: Date.now() + 9, completedAt: Date.now() + 10, parts: [{ id: 't8', type: 'text', text: 'The answer is 42.' }] } },
  ] });
  await t.host({ type: 'patch', patch: { activity: 'idle' } });
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'It worked!');
  assert.equal(await t.page.$eval('canvas.oki', (c) => c.dataset.mood), 'excited');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('slash commands: popup, filtering, keyboard selection and argument hints', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('textarea');
  await t.page.focus('textarea');
  await t.page.keyboard.type('/');
  await t.page.waitForSelector('.popup .popup-item');
  const all = await t.page.$$eval('.popup .popup-name', (els) => els.map((e) => e.textContent.trim().split(' ')[0]));
  assert.deepEqual(all.slice(0, 3), ['/new', '/sessions', '/model']);
  assert.ok(all.includes('/review'), 'engine commands are listed');
  await t.shot('04-slash-popup-dark');
  await t.page.keyboard.type('mc');
  await t.page.waitForFunction(() => document.querySelectorAll('.popup .popup-item').length === 1);
  assert.match(await t.text('.popup-item.active'), /\/mcp/);
  await t.clearPosted();
  await t.page.keyboard.press('Enter');
  assert.deepEqual(await t.posted('send'), [{ type: 'send', text: '/mcp' }]);
  assert.equal(await t.page.$eval('textarea', (el) => el.value), '');
  // A command that takes an argument is completed, not sent.
  await t.page.keyboard.type('/mod');
  await t.page.keyboard.press('Tab');
  assert.equal(await t.page.$eval('textarea', (el) => el.value), '/model ');
  assert.equal((await t.posted('send')).length, 1);
  await t.page.keyboard.type('haiku');
  await t.page.keyboard.press('Enter');
  assert.deepEqual((await t.posted('send'))[1], { type: 'send', text: '/model haiku' });
  // Arrow keys move the selection; Escape closes the popup.
  await t.page.keyboard.type('/');
  await t.page.keyboard.press('ArrowDown');
  assert.match(await t.text('.popup-item.active'), /\/sessions/);
  await t.page.keyboard.press('Escape');
  assert.equal(await t.page.$('.popup'), null);
  // Shift+Enter makes a new line instead of sending.
  await t.page.$eval('textarea', (el) => (el.value = ''));
  await t.page.keyboard.type('line one');
  await t.page.keyboard.down('Shift');
  await t.page.keyboard.press('Enter');
  await t.page.keyboard.up('Shift');
  await t.page.keyboard.type('line two');
  await t.clearPosted();
  await t.page.keyboard.press('Enter');
  assert.equal((await t.posted('send'))[0].text, '/line one\nline two'.replace('/', ''));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('attachments: @ mentions, chips, removal and pasted images', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('textarea');
  await t.page.focus('textarea');
  await t.page.keyboard.type('look at @led');
  await t.page.waitForFunction(() => window.__posted.some((m) => m.type === 'searchFiles' && m.query === 'led'));
  const req = (await t.posted('searchFiles')).pop();
  await t.host({ type: 'fileResults', requestId: req.requestId, files: [{ path: '/work/app/src/core/usageLedger.ts', relative: 'src/core/usageLedger.ts' }, { path: '/work/app/test/usageLedger.test.ts', relative: 'test/usageLedger.test.ts' }] });
  await t.page.waitForSelector('.popup .popup-item');
  assert.equal(await t.page.$$eval('.popup .popup-item', (els) => els.length), 2);
  await t.page.keyboard.press('Enter');
  assert.equal(await t.page.$eval('textarea', (el) => el.value), 'look at @src/core/usageLedger.ts ');
  assert.deepEqual(await t.posted('addPaths'), [{ type: 'addPaths', paths: ['/work/app/src/core/usageLedger.ts'] }]);

  // The host answers with the attachment list; chips appear and can be removed.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await t.host({ type: 'patch', patch: { attachments: [{ id: 'a1', kind: 'file', name: 'src/core/usageLedger.ts', mime: 'text/plain', path: '/work/app/src/core/usageLedger.ts' }, { id: 'a2', kind: 'selection', name: 'src/app.ts:10-24', mime: 'text/plain', text: 'x' }, { id: 'a3', kind: 'image', name: 'screenshot.png', mime: 'image/png', dataUrl: png }] } });
  await t.page.waitForFunction(() => document.querySelectorAll('.attachments .chip').length === 3);
  assert.ok(await t.page.$('.attachments .thumb'), 'image attachments show a thumbnail');
  await t.shot('05-attachments-dark');
  await t.page.click('.attachments .chip:nth-child(2) .chip-x');
  assert.deepEqual(await t.posted('removeAttachment'), [{ type: 'removeAttachment', id: 'a2' }]);
  await t.page.click('button[aria-label="Attach files"]');
  assert.equal((await t.posted('pickFiles')).length, 1);

  // Pasting an image from the clipboard turns into an attachment with its bytes.
  await t.clearPosted();
  await t.page.evaluate(async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'clip.png', { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await t.page.waitForFunction(() => window.__posted.some((m) => m.type === 'addAttachment'));
  const pasted = (await t.posted('addAttachment'))[0].attachment;
  assert.equal(pasted.kind, 'image');
  assert.equal(pasted.name, 'clip.png');
  assert.ok(pasted.dataUrl.startsWith('data:image/png;base64,'));

  // Dropping files from the VS Code explorer sends their URIs to the host.
  await t.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'file:///work/app/README.md\r\nfile:///work/app/package.json');
    document.querySelector('.app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await t.posted('addPaths'), [{ type: 'addPaths', paths: ['file:///work/app/README.md', 'file:///work/app/package.json'] }]);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('the file open in the editor is one click away, like Copilot\'s current file', async () => {
  const t = await open('dark', 400, 760);
  await t.host({ type: 'state', state: { ...conversation, attachments: [], activeFile: { path: '/repo/src/middleware/auth.ts', name: 'src/middleware/auth.ts' } } });
  await t.page.waitForSelector('.chip.suggest');
  assert.equal(await t.text('.chip.suggest span'), 'auth.ts');
  await t.shot('17-current-file-chip');
  await t.clearPosted();
  await t.page.click('.chip.suggest');
  assert.deepEqual(await t.posted('addActiveFile'), [{ type: 'addActiveFile' }]);
  // Once attached, the suggestion steps aside.
  await t.host({ type: 'patch', patch: { attachments: [{ id: 'a1', kind: 'file', name: 'src/middleware/auth.ts', mime: 'text/plain', path: '/repo/src/middleware/auth.ts' }] } });
  await t.page.waitForFunction(() => !document.querySelector('.chip.suggest'));
  // A selection is offered as its lines.
  await t.host({ type: 'patch', patch: { activeFile: { path: '/repo/src/middleware/auth.ts', name: 'src/middleware/auth.ts', selection: { startLine: 12, endLine: 30 } } } });
  await t.page.waitForSelector('.chip.suggest');
  assert.equal(await t.text('.chip.suggest span'), 'auth.ts:12-30');
  // No file open: no chip.
  // Sent the way the host sends a cleared field: VS Code's JSON transport would drop undefined.
  await t.host({ type: 'patch', patch: { activeFile: null, attachments: [] } });
  await t.page.waitForFunction(() => !document.querySelector('.chip.suggest'));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('model picker: Claude Code and Codex can add a model by name', async () => {
  const t = await open('dark', 400, 760);
  const models = [
    { providerId: 'claude-code', modelId: 'default', name: 'Default (Opus 5.5)' },
    { providerId: 'claude-code', modelId: 'opus', name: 'Opus 5.5' },
    { providerId: 'claude-code', modelId: 'fable', name: 'Fable 5.2' },
    { providerId: 'claude-code', modelId: 'sonnet', name: 'Sonnet 5.5' },
    { providerId: 'claude-code', modelId: 'haiku', name: 'Haiku 5.5' },
    { providerId: 'claude-code', modelId: 'opusplan', name: 'Opus Plan Mode', description: 'Opus while planning, Sonnet for the rest' },
  ];
  await t.host({ type: 'state', state: { ...conversation, engine: 'claude-code', model: { providerId: 'claude-code', modelId: 'default' }, providers: [{ id: 'claude-code', name: 'Claude Code', connected: true, models }], recentModels: [] } });
  await t.page.waitForSelector('.pill.model');
  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .list .row');
  assert.deepEqual(await t.page.$$eval('.sheet .group:not(.recent) .row-title', (els) => els.map((e) => e.textContent)), models.map((m) => m.name));
  assert.match(await t.text('.add-model'), /First the models Claude Code reports for your account, then every other Claude version, by name\. Missing one\?/);
  await new Promise((r) => setTimeout(r, 400)); // let the sheet finish sliding in
  await t.shot('18-claude-models');
  await t.clearPosted();
  await t.page.click('.add-model .btn');
  assert.deepEqual(await t.posted('addModel'), [{ type: 'addModel' }]);
  assert.equal(await t.page.$('.sheet'), null);
  // Engines whose list is already complete (opencode, Direct BYOK, Copilot) have no such button.
  await t.host({ type: 'state', state: conversation });
  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .list .row');
  assert.equal(await t.page.$('.add-model'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('permission and question prompts', async () => {
  const t = await open();
  await t.host({ type: 'state', state: { ...conversation, activity: 'busy', permissions: [{ id: 'per_1', sessionId: 'ses_1', kind: 'bash', title: 'Allow bash?', detail: 'rm -rf dist && npm run build' }], questions: [{ id: 'que_1', sessionId: 'ses_1', questions: [{ question: 'Which test runner should I set up?', options: [{ label: 'Vitest' }, { label: 'Jest' }] }] }] } });
  await t.page.waitForSelector('.request');
  assert.equal(await t.text('.request-title'), 'Allow bash?');
  assert.equal(await t.text('.request-detail'), 'rm -rf dist && npm run build');
  assert.equal(await t.text('.stage-caption'), 'Needs your OK');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.mood === 'waiting');
  await sleep(500);
  await t.shot('06-permission-dark');
  await t.page.click('.request .btn.primary');
  assert.deepEqual(await t.posted('permissionReply'), [{ type: 'permissionReply', requestId: 'per_1', reply: 'once' }]);
  const buttons = await t.page.$$eval('.request:first-child .btn', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(buttons, ['Allow once', 'Always allow', 'Deny', 'Switch to Auto']);
  // The question needs an option before it can be sent.
  assert.equal(await t.page.$eval('.request:last-child .btn.primary', (el) => el.disabled), true);
  await t.page.click('.option');
  await t.page.click('.request:last-child .btn.primary');
  assert.deepEqual(await t.posted('questionReply'), [{ type: 'questionReply', requestId: 'que_1', answers: [['Vitest']] }]);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('MCP panel: status of every server and a working toggle switch', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.mcp-btn');
  assert.equal(await t.text('.mcp-btn .badge'), '1');
  assert.ok(await t.page.$('.mcp-btn .alert-dot'), 'a dot flags servers that need attention');
  await t.page.click('.mcp-btn');
  await t.page.waitForSelector('.sheet .row.mcp');
  assert.match(await t.text('.sheet-lede'), /1 of 4 connected for opencode/);
  const rows = await t.page.$$eval('.row.mcp', (els) => els.map((e) => ({ name: e.querySelector('.row-title').textContent, sub: e.querySelector('.row-sub').textContent, on: e.querySelector('.switch').getAttribute('aria-checked') })));
  assert.deepEqual(rows.map((r) => [r.name, r.on]), [['github', 'true'], ['postgres', 'false'], ['sentry', 'true'], ['linear', 'true']]);
  assert.match(rows[0].sub, /Connected, 26 tools/);
  assert.match(rows[2].sub, /ENOENT/);
  assert.match(rows[3].sub, /Needs sign-in/);
  await t.shot('07-mcp-panel-dark');
  await t.clearPosted();
  await t.page.click('.row.mcp:nth-child(2) .switch');
  await t.page.click('.row.mcp:nth-child(1) .switch');
  assert.deepEqual(await t.posted('mcpToggle'), [{ type: 'mcpToggle', name: 'postgres', enabled: true }, { type: 'mcpToggle', name: 'github', enabled: false }]);
  // The host confirms; the switch and the badge follow.
  await t.host({ type: 'patch', patch: { mcp: conversation.mcp.map((m) => (m.name === 'postgres' ? { ...m, status: 'connected', enabled: true } : m)) } });
  await t.page.waitForFunction(() => document.querySelector('.row.mcp:nth-child(2) .switch').getAttribute('aria-checked') === 'true');
  assert.equal(await t.text('.mcp-btn .badge'), '2');
  // Switches work from the keyboard and Escape closes the sheet.
  await t.page.focus('.row.mcp:nth-child(3) .switch');
  await t.page.keyboard.press('Space');
  assert.deepEqual((await t.posted('mcpToggle')).pop(), { type: 'mcpToggle', name: 'sentry', enabled: false });
  await t.page.keyboard.press('Escape');
  assert.equal(await t.page.$('.sheet'), null);
  // The host can open the panel too (the /mcp command and the title-bar button do this).
  await t.host({ type: 'patch', patch: { panel: { name: 'mcp', nonce: 5 } } });
  await t.page.waitForSelector('.sheet .row.mcp');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('feedback form: kind, details, diagnostics preview and what is sent', async () => {
  const t = await open('dark', 400, 820);
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.messages');
  // /feedback and the title-bar command open it from the host, with the diagnostics filled in.
  await t.host({ type: 'patch', patch: { panel: { name: 'feedback', nonce: 11 } } });
  await t.page.waitForSelector('.sheet .feedback-text');
  assert.equal(await t.text('.sheet-head h2'), 'Send feedback');
  // Bug is the default kind, and nothing can be sent while the form is empty.
  assert.equal(await t.page.$eval('.segmented button.on', (el) => el.textContent), 'Bug');
  assert.equal(await t.page.$eval('.sheet-actions .btn.primary', (el) => el.disabled), true);
  // The user can see exactly what "diagnostics" means before anything leaves.
  await t.page.click('.diagnostics summary');
  const diagnostics = await t.text('.diagnostics pre');
  assert.match(diagnostics, /OpenCode Hub: 0\.5\.0/);
  assert.match(diagnostics, /OS: macOS arm64/);
  await t.page.click('.segmented button:nth-child(2)');
  await t.page.type('.sheet .field-input[type="text"]', 'A cape for Oki');
  await t.page.type('.feedback-text', 'Oki should wear a cape when a build passes.');
  await t.shot('13-feedback');
  assert.equal(await t.page.$eval('.sheet-actions .btn.primary', (el) => el.disabled), false);
  await t.page.click('.sheet-actions .btn.primary');
  assert.deepEqual(await t.posted('feedback'), [{ type: 'feedback', kind: 'idea', title: 'A cape for Oki', description: 'Oki should wear a cape when a build passes.', includeDiagnostics: true }]);
  // Sending closes the form; GitHub opens in the browser from the host side.
  assert.equal(await t.page.$('.sheet'), null);

  // A draft from "/feedback bug <text>" is filled in, diagnostics can be left out, Ctrl+Enter sends.
  await t.clearPosted();
  await t.host({ type: 'patch', patch: { feedbackDraft: { kind: 'bug', text: 'Codex never answers' }, panel: { name: 'feedback', nonce: 12 } } });
  await t.page.waitForSelector('.sheet .feedback-text');
  assert.equal(await t.page.$eval('.feedback-text', (el) => el.value), 'Codex never answers');
  await t.page.click('.check input');
  assert.equal(await t.page.$('.diagnostics'), null);
  await t.page.focus('.feedback-text');
  await t.page.keyboard.down('Control');
  await t.page.keyboard.press('Enter');
  await t.page.keyboard.up('Control');
  assert.deepEqual(await t.posted('feedback'), [{ type: 'feedback', kind: 'bug', title: '', description: 'Codex never answers', includeDiagnostics: false }]);
  // Copy link: for a browser where a personal GitHub account is signed in (company-managed accounts cannot post).
  await t.clearPosted();
  await t.host({ type: 'patch', patch: { feedbackDraft: { kind: 'idea', text: 'Via another browser' }, panel: { name: 'feedback', nonce: 13 } } });
  await t.page.waitForSelector('.sheet .feedback-text');
  assert.match(await t.text('.sheet'), /company-managed account/);
  await t.page.click('.sheet-actions .btn:not(.primary):not(.quiet)');
  assert.deepEqual(await t.posted('feedback'), [{ type: 'feedback', kind: 'idea', title: '', description: 'Via another browser', includeDiagnostics: true, copyLink: true }]);
  assert.equal(await t.page.$('.sheet'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('/help and /doctor output can be closed; a session can be used as context', async () => {
  const t = await open('dark', 400, 760);
  const now = Date.now();
  const help = { id: 'local_msg_1', sessionId: conversation.sessionId, role: 'assistant', createdAt: now, completedAt: now, parts: [{ id: 'p_help', type: 'text', text: '**Commands**\n\n- `/new` — Start a new session\n- `/doctor` — Check versions' }] };
  await t.host({ type: 'state', state: { ...conversation, messages: [...conversation.messages, help] } });
  await t.page.waitForSelector('.msg.local .msg-close');
  // Only the extension's own messages get a close button.
  assert.equal((await t.page.$$('.msg-close')).length, 1);
  await t.page.$eval('.messages', (el) => (el.scrollTop = el.scrollHeight));
  await t.shot('14-help-closable');
  await t.page.click('.msg.local .msg-close');
  assert.deepEqual(await t.posted('dismissMessage'), [{ type: 'dismissMessage', id: 'local_msg_1' }]);
  await t.host({ type: 'patch', patch: { messages: conversation.messages } });
  await t.page.waitForFunction(() => !document.querySelector('.msg.local'));

  // Sessions panel: every session except the open one can be attached as condensed context.
  await t.clearPosted();
  await t.page.click('.icon-btn[title="Sessions"]');
  await t.page.waitForSelector('.sheet .list .row');
  const rows = await t.page.$$eval('.sheet .list > li', (els) => els.map((e) => !!e.querySelector('[aria-label^="Use "]')));
  assert.equal(rows.filter((x) => !x).length, 1, 'the open session cannot be attached to itself');
  await t.page.click('.sheet .list [aria-label^="Use "]');
  const sent = await t.posted('attachSession');
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].sessionId, conversation.sessionId);
  assert.equal(await t.page.$('.sheet'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('provider colours: the frame follows the model\'s maker, and can be turned off', async () => {
  const t = await open('dark', 400, 760);
  const frame = () => t.page.evaluate(() => ({ top: getComputedStyle(document.querySelector('.app')).borderTopColor, box: getComputedStyle(document.querySelector('.input-box')).borderColor, provider: document.querySelector('.app').dataset.provider ?? null }));
  await t.host({ type: 'state', state: { ...conversation, engine: 'claude-code', model: { providerId: 'claude-code', modelId: 'sonnet' } } });
  await t.page.waitForFunction(() => getComputedStyle(document.querySelector('.app')).borderTopColor === 'rgb(217, 119, 87)');
  let f = await frame();
  assert.equal(f.provider, 'anthropic');
  assert.equal(f.top, 'rgb(217, 119, 87)');
  assert.ok(await t.page.$('.stage-sub .brand-dot'));
  assert.match(await t.page.$eval('.pill.model', (el) => el.title), /Anthropic \(Claude\)/);
  await t.shot('15-provider-claude');
  await t.host({ type: 'patch', patch: { engine: 'codex', model: { providerId: 'codex', modelId: 'default' } } });
  // The colour fades over a quarter second.
  await t.page.waitForFunction(() => document.querySelector('.app').dataset.provider === 'openai' && getComputedStyle(document.querySelector('.app')).borderTopColor === 'rgb(16, 163, 127)');
  f = await frame();
  assert.equal(f.top, 'rgb(16, 163, 127)');
  await t.shot('16-provider-openai');
  await t.host({ type: 'patch', patch: { engine: 'direct', model: { providerId: 'google', modelId: 'gemini-2.5-pro' } } });
  await t.page.waitForFunction(() => document.querySelector('.app').dataset.provider === 'google');
  // Off: no strip, no dot, the theme's own border.
  await t.host({ type: 'patch', patch: { providerColors: false } });
  await t.page.waitForFunction(() => !document.querySelector('.app.branded'));
  assert.equal(await t.page.$('.brand-dot'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('usage panel: this session, totals, per provider and model, per day', async () => {
  const t = await open('dark', 400, 980);
  await t.host({ type: 'state', state: { ...conversation, usage: usageSummary } });
  await t.page.waitForSelector('.usage-btn');
  await t.page.click('.usage-btn');
  await t.page.waitForSelector('.sheet .stats');
  assert.equal((await t.posted('usageRefresh')).length, 1);
  const stats = await t.page.$$eval('.usage-section:first-of-type .stat', (els) => els.map((e) => `${e.querySelector('.stat-label').textContent}=${e.querySelector('.stat-value').textContent}`));
  assert.deepEqual(stats, ['input=8.2k', 'output=612', 'thinking=240', 'cache reads=15k', 'cost=$0.04', 'reply=1']);
  const totals = await t.page.$$eval('.usage-section:nth-of-type(2) .stat-value', (els) => els.map((e) => e.textContent));
  // Input is new input plus what was stored in the cache; cache reads have a figure of their own.
  assert.deepEqual(totals, ['1.5M', '96k', '41k', '3.4M', '$18.4', '412']);
  const groups = await t.page.$$eval('.usage-group', (els) => els.map((e) => `${e.querySelector('.usage-provider').textContent}|${e.querySelector('.tag').textContent}|${e.querySelectorAll('tbody tr').length}`));
  assert.deepEqual(groups, ['Anthropic|opencode|2', 'openrouter|Direct BYOK|1', 'claude-code|Claude Code|1', 'ollama|Direct BYOK|1']);
  // Bars are proportional: the biggest row is full width, a row a tenth its size is clearly shorter.
  const widths = await t.page.$$eval('.usage-group .bar', (els) => els.map((e) => parseFloat(e.style.width)));
  assert.equal(widths[0], 100);
  assert.ok(widths[1] < 20 && widths[1] > 5, `second bar is proportional (${widths[1]}%)`);
  assert.equal(await t.page.$$eval('.days .day', (els) => els.length), 14);
  assert.match(await t.page.$eval('.days .day:nth-child(11)', (el) => el.title), /261,000 tokens/);
  assert.equal(await t.page.$$eval('.usage-table.sessions tbody tr', (els) => els.length), 3);
  await t.shot('08-usage-panel-dark');
  await t.clearPosted();
  await t.page.click('.sheet-head .btn.quiet');
  assert.equal((await t.posted('usageReset')).length, 1);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('sessions panel: search, switch, rename, delete, new', async () => {
  const t = await open();
  await t.host({ type: 'state', state: { ...conversation, usage: usageSummary } });
  await t.page.waitForSelector('.session-btn');
  await t.page.click('.session-btn');
  await t.page.waitForSelector('.sheet .row.session');
  assert.equal(await t.page.$$eval('.row.session', (els) => els.length), 3);
  assert.equal(await t.text('.row.session.active .row-title'), 'Refactor the auth middleware');
  assert.match(await t.text('.row.session.active .row-sub'), /min ago, 9\.1k tokens/);
  await t.shot('09-sessions-panel-dark');
  await t.page.type('.sheet .search input', 'flaky');
  await t.page.waitForFunction(() => document.querySelectorAll('.row.session').length === 1);
  await t.clearPosted();
  await t.page.click('.row.session .row-main');
  assert.deepEqual(await t.posted('switchSession'), [{ type: 'switchSession', sessionId: 'ses_2' }]);
  assert.equal(await t.page.$('.sheet'), null);

  await t.page.click('button[aria-label="Sessions"]');
  await t.page.waitForSelector('.row.session');
  await t.page.hover('.row.session:nth-child(3)');
  await t.page.click('.row.session:nth-child(3) button[title="Rename"]');
  await t.page.waitForSelector('input.rename');
  await t.page.$eval('input.rename', (el) => el.select());
  await t.page.keyboard.type('Ledger tests');
  await t.page.keyboard.press('Enter');
  assert.deepEqual(await t.posted('renameSession'), [{ type: 'renameSession', sessionId: 'ses_3', title: 'Ledger tests' }]);
  await t.page.hover('.row.session:nth-child(2)');
  await t.page.click('.row.session:nth-child(2) button[title="Delete"]');
  assert.deepEqual(await t.posted('deleteSession'), [{ type: 'deleteSession', sessionId: 'ses_2' }]);
  await t.page.click('.sheet-head .btn.small');
  assert.equal((await t.posted('newSession')).length, 1);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('sessions panel: every engine\'s saved sessions in one list', async () => {
  const t = await open();
  const now = Date.now();
  const otherSessions = [
    { id: 'cc_1', engine: 'claude-code', title: 'Fix the login bug', createdAt: now - 7200_000, updatedAt: now - 60_000 },
    { id: 'cx_1', engine: 'codex', title: 'Write release notes', createdAt: now - 3 * 86400_000, updatedAt: now - 2 * 86400_000 },
  ];
  await t.host({ type: 'state', state: { ...conversation, otherSessions } });
  await t.page.click('.session-btn');
  await t.page.waitForSelector('.sheet .row.session');
  assert.deepEqual(await t.posted('sessionsRefresh'), [{ type: 'sessionsRefresh' }]);
  // Newest first, across engines, each labelled with its engine.
  const rows = await t.page.$$eval('.row.session', (els) => els.map((e) => `${e.querySelector('.engine-tag')?.textContent}|${e.querySelector('.row-title').textContent}`));
  assert.deepEqual(rows, ['Claude Code|Fix the login bug', 'opencode|Refactor the auth middleware', 'opencode|Why is the CI job flaky?', 'Codex (ChatGPT)|Write release notes', 'opencode|Write tests for the usage ledger']);
  // Another engine's session cannot be renamed from here, but opens in its engine and can be deleted.
  assert.equal(await t.page.$('.row.session:first-child button[title="Rename"]'), null);
  await sleep(400);
  await t.shot('24-sessions-all-engines-dark');
  await t.clearPosted();
  await t.page.click('.row.session:first-child .row-main');
  assert.deepEqual(await t.posted('switchSession'), [{ type: 'switchSession', sessionId: 'cc_1', engine: 'claude-code' }]);
  await t.page.click('.session-btn');
  await t.page.waitForSelector('.segmented');
  await t.page.hover('.row.session:nth-child(4)');
  await t.page.click('.row.session:nth-child(4) button[title="Delete"]');
  assert.deepEqual(await t.posted('deleteSession'), [{ type: 'deleteSession', sessionId: 'cx_1', engine: 'codex' }]);
  // Only this engine's sessions.
  await t.page.$$eval('.segmented button', (els) => els[1].click());
  await t.page.waitForFunction(() => document.querySelectorAll('.row.session').length === 3);
  assert.equal(await t.page.$('.row.session .engine-tag'), null);
  await t.page.type('.sheet .search input', 'login');
  await t.page.waitForFunction(() => document.querySelector('.empty-note')?.textContent === 'No session matches.');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('engine, model and agent pickers', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.controls .pill');
  await t.page.click('.controls .pill');
  await t.page.waitForSelector('.menu .menu-item');
  const engines = await t.page.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
  // Engines that sign in with a plan first; Direct BYOK (API keys only) last.
  assert.deepEqual(engines.slice(0, 5), ['opencodev1.19.6', 'Claude Codev2.1.328', 'Codex (ChatGPT)not available', 'Copilot / VS Code models', 'Direct BYOKready']);
  await t.shot('10-engine-menu-dark');
  await t.clearPosted();
  await t.page.click('.menu .menu-item:nth-child(5)');
  assert.deepEqual(await t.posted('setEngine'), [{ type: 'setEngine', engine: 'direct' }]);
  assert.equal(await t.page.$('.menu'), null);

  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .group');
  assert.deepEqual(await t.page.$$eval('.sheet .group h3', (els) => els.map((e) => e.textContent)), ['Anthropic', 'OpenRouter', 'Ollama (local)']);
  await t.shot('11-models-panel-dark');
  await t.page.type('.sheet .search input', 'qwen');
  await t.page.waitForFunction(() => document.querySelectorAll('.sheet .row').length === 1);
  await t.page.click('.sheet .row .row-main');
  assert.deepEqual(await t.posted('setModel'), [{ type: 'setModel', model: { providerId: 'openrouter', modelId: 'qwen/qwen3-coder' } }]);

  await t.page.click('.controls .menu-anchor:nth-of-type(2) .pill, .controls .menu-anchor:last-of-type .pill');
  await t.page.waitForSelector('.menu .menu-item');
  await t.page.click('.menu .menu-item:nth-child(2)');
  assert.deepEqual(await t.posted('setAgent'), [{ type: 'setAgent', agent: 'plan' }]);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('context meter, retry after a failed reply, and recent models', async () => {
  const t = await open();
  // The fixture's last reply used a small part of a 1M-token window: a quiet ring, no number.
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.context-meter');
  assert.equal(await t.page.$eval('.context-meter', (e) => e.className), 'context-meter ok');
  assert.equal(await t.page.$('.context-pct'), null);
  assert.match(await t.page.$eval('.context-meter', (e) => e.title), /^Context: about 24k of 1.0M tokens \(\d+%\)\.$/);
  // Same reply on a model with a small window: the meter turns into a warning with a percentage and advice.
  const used = await t.page.$eval('.context-meter', (e) => e.title);
  const small = JSON.parse(JSON.stringify(conversation));
  const lastWithUsage = small.messages.filter((m) => m.usage).pop();
  const total = lastWithUsage.usage.input + lastWithUsage.usage.output + lastWithUsage.usage.reasoning + lastWithUsage.usage.cacheRead + lastWithUsage.usage.cacheWrite;
  small.providers[0].models[0].contextWindow = Math.round(total / 0.93);
  await t.host({ type: 'state', state: small });
  await t.page.waitForFunction(() => document.querySelector('.context-meter')?.classList.contains('full'));
  assert.equal(await t.text('.context-pct'), '93%');
  assert.match(await t.page.$eval('.context-meter', (e) => e.title), /Run \/compact to make room\.$/);
  assert.notEqual(await t.page.$eval('.context-meter', (e) => e.title), used);
  await t.shot('21-context-meter-dark');
  await t.clearPosted();
  await t.page.$eval('.context-meter', (el) => el.click());
  assert.deepEqual(await t.posted('send'), [{ type: 'send', text: '/usage' }]);

  // Retry shows only when the host offers it, and never while a reply is running.
  assert.equal(await t.page.$('.retry'), null);
  await t.host({ type: 'patch', patch: { canRetry: true } });
  await t.page.waitForSelector('.retry');
  await t.shot('22-retry-dark');
  await t.clearPosted();
  await t.page.click('.retry');
  assert.deepEqual(await t.posted('retry'), [{ type: 'retry' }]);
  // Next to Retry: tell the maintainers. It opens the feedback form as a bug report.
  await t.page.click('.retry-row .report');
  assert.deepEqual(await t.posted('openFeedback'), [{ type: 'openFeedback', kind: 'bug' }]);
  await t.host({ type: 'patch', patch: { activity: 'busy' } });
  await t.page.waitForFunction(() => !document.querySelector('.retry'));
  await t.host({ type: 'patch', patch: { activity: 'idle', canRetry: false } });

  // Recent models sit above the provider groups, and disappear while searching.
  await t.host({ type: 'patch', patch: { recentModels: [{ providerId: 'openrouter', modelId: 'qwen/qwen3-coder' }, { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }, { providerId: 'gone', modelId: 'removed-model' }] } });
  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .group.recent');
  assert.deepEqual(await t.page.$$eval('.sheet .group.recent .row-title', (els) => els.map((e) => e.textContent)), ['Qwen3 Coder', 'Claude Sonnet 5.5']);
  assert.equal(await t.page.$$eval('.sheet .group h3', (els) => els[0].textContent), 'Recent');
  await t.shot('23-recent-models-dark');
  await t.clearPosted();
  await t.page.click('.sheet .group.recent .row .row-main');
  assert.deepEqual(await t.posted('setModel'), [{ type: 'setModel', model: { providerId: 'openrouter', modelId: 'qwen/qwen3-coder' } }]);
  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .search input');
  await t.page.type('.sheet .search input', 'haiku');
  await t.page.waitForFunction(() => !document.querySelector('.sheet .group.recent'));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('companion: dots style, poke, listening, hide and show', async () => {
  const t = await open();
  await t.host({ type: 'state', state: { ...base, avatar: { enabled: true, style: 'dots' } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.style === 'dots', { timeout: 15000 });
  await sleep(600);
  await t.shot('12-dots-dark');
  await t.clearPosted();
  // The swap button changes the style; the host confirms it.
  await t.page.hover('.stage');
  await t.page.click('.stage-swap');
  assert.deepEqual(await t.posted('setAvatar'), [{ type: 'setAvatar', style: 'buddy' }]);
  await t.host({ type: 'patch', patch: { avatar: { enabled: true, style: 'buddy' } } });
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.style === 'buddy');
  // Clicking Oki is just for fun: it reacts, nothing is sent anywhere.
  await t.clearPosted();
  await t.page.click('.stage-oki');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.reaction === 'poke');
  assert.deepEqual(await t.posted(), []);
  // Typing makes it pay attention, and it relaxes again afterwards.
  await t.page.focus('textarea');
  await t.page.keyboard.type('hel');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.mood === 'listening');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.mood === 'idle', { timeout: 5000 });
  // The animation keeps running in every mood without errors.
  const f1 = await t.page.$eval('canvas.oki', (c) => Number(c.dataset.frames));
  await sleep(500);
  assert.ok((await t.page.$eval('canvas.oki', (c) => Number(c.dataset.frames))) > f1);

  await t.page.click('button[aria-label="Hide companion"]');
  assert.deepEqual((await t.posted('setAvatar')).pop(), { type: 'setAvatar', enabled: false });
  await t.host({ type: 'patch', patch: { avatar: { enabled: false, style: 'buddy' } } });
  await t.page.waitForFunction(() => !document.querySelector('canvas.oki'));
  assert.equal(await t.text('.welcome h1'), 'What are we building?');
  await t.host({ type: 'patch', patch: { ...conversation, avatar: { enabled: false, style: 'buddy' }, activity: 'busy' } });
  await t.page.waitForSelector('.status-line');
  assert.match(await t.text('.status-line'), /Thinking…/);
  await t.shot('13-no-avatar-dark');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('companion gallery: every mood renders and animates in both styles', async () => {
  for (const [style, name] of [['buddy', '18-moods-buddy'], ['dots', '19-moods-dots']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 950, height: 620, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`${origin}/test/ui/gallery.html?style=${style}`);
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer="webgl"]').length === 12, { timeout: 20000 });
    await sleep(1500);
    const cells = await page.$$eval('canvas', (els) => els.map((c) => ({ mood: c.dataset.mood, frames: Number(c.dataset.frames || 0) })));
    assert.deepEqual([...new Set(cells.map((c) => c.mood))].sort(), ['excited', 'happy', 'idle', 'listening', 'sad', 'sleepy', 'speaking', 'thinking', 'waiting', 'working']);
    assert.ok(cells.every((c) => c.frames > 5), `every canvas animates: ${JSON.stringify(cells)}`);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

await test('layout: text zoom, a wide editor tab, and moving the chat', async () => {
  const t = await open('dark', 1200, 800);
  await t.host({ type: 'state', state: { ...conversation, zoom: 1 } });
  await t.page.waitForSelector('.msg.assistant .md');
  const size = () => t.page.$eval('.msg.assistant .md p', (el) => parseFloat(getComputedStyle(el).fontSize));
  const codeSize = () => t.page.$eval('.code pre', (el) => parseFloat(getComputedStyle(el).fontSize));
  assert.equal(await size(), 13);
  assert.equal(await codeSize(), 12);
  await t.host({ type: 'patch', patch: { zoom: 1.4 } });
  await t.page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--oh-zoom').trim() === '1.4');
  assert.ok(Math.abs((await size()) - 18.2) < 0.1, `text scales with zoom (${await size()}px)`);
  assert.ok(Math.abs((await codeSize()) - 16.8) < 0.1, `code scales with zoom (${await codeSize()}px)`);
  await t.host({ type: 'patch', patch: { zoom: 1 } });
  // In a wide tab the conversation stays a readable, centred column instead of stretching edge to edge.
  const box = await t.page.$eval('.msg.assistant', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: window.innerWidth - r.right, width: r.width };
  });
  assert.ok(box.width <= 880.5, `column width is capped (${box.width}px)`);
  // The scrollbar gutter sits on the right, so allow for its width.
  assert.ok(Math.abs(box.left - box.right) < 20, `column is centred (${box.left} vs ${box.right})`);
  const input = await t.page.$eval('.input-box', (el) => el.getBoundingClientRect().width);
  assert.ok(input <= 880.5);
  await t.shot('20-wide-editor-tab');
  // /move and /zoom are ordinary commands: they complete with an argument hint and go to the host.
  await t.page.focus('textarea');
  await t.page.keyboard.type('/mov');
  await t.page.waitForSelector('.popup .popup-item');
  await t.page.keyboard.press('Tab');
  assert.equal(await t.page.$eval('textarea', (el) => el.value), '/move ');
  await t.page.keyboard.type('right');
  await t.clearPosted();
  await t.page.keyboard.press('Enter');
  assert.deepEqual(await t.posted('send'), [{ type: 'send', text: '/move right' }]);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('performance: a long streamed reply stays smooth', async () => {
  const t = await open('dark', 420, 800);
  const para = 'The **quick** brown fox jumps over the lazy dog and keeps running through `code` and [links](https://example.com) until the paragraph ends.\n\n';
  const code = '```ts\nexport function add(a: number, b: number) {\n  return a + b;\n}\n```\n\n';
  let doc = '';
  for (let i = 0; i < 60; i++) doc += `### Section ${i + 1}\n\n` + para + (i % 3 === 0 ? code : '- one\n- two\n- three\n\n');
  doc += 'ENDMARK\n';
  await t.host({ type: 'state', state: { ...conversation, avatar: { enabled: false, style: 'buddy' }, activity: 'busy', messages: [...conversation.messages, { id: 'big', sessionId: 'ses_1', role: 'assistant', createdAt: Date.now(), parts: [{ id: 'bp', type: 'text', text: '' }] }] } });
  await t.page.waitForSelector('[data-message-id="big"]');
  const r = await t.page.evaluate(async (text) => {
    let longest = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (longest = Math.max(longest, e.duration)))).observe({ entryTypes: ['longtask'] });
    const start = performance.now();
    let first;
    // The host sends streamed tokens in small batches, about one per frame.
    const size = 12;
    for (let i = 0, n = 0; i < text.length; n++) {
      const events = [];
      for (let k = 0; k < 4 && i < text.length; k++, i += size) events.push({ type: 'part.delta', sessionId: 'ses_1', messageId: 'big', partId: 'bp', delta: text.slice(i, i + size) });
      window.__host({ type: 'events', events });
      await new Promise((res) => setTimeout(res, 0));
      // Remember the first rendered block: it must survive every later chunk untouched.
      if (!first && n > 30) first = document.querySelector('[data-message-id="big"] .mdb');
    }
    while (!document.querySelector('[data-message-id="big"] .md')?.textContent.includes('ENDMARK')) await new Promise((res) => setTimeout(res, 10));
    const total = performance.now() - start;
    await new Promise((res) => setTimeout(res, 150));
    return { total, longest, blocks: document.querySelectorAll('[data-message-id="big"] .mdb').length, firstKept: !!first && first.isConnected && first === document.querySelector('[data-message-id="big"] .mdb'), chunks: Math.ceil(text.length / size) };
  }, doc);
  console.log(`      streamed ${r.chunks} chunks into ${r.blocks} blocks in ${Math.round(r.total)} ms, longest task ${Math.round(r.longest)} ms`);
  assert.ok(r.firstKept, 'earlier blocks keep their DOM nodes while later text streams in');
  assert.ok(r.blocks >= 150, `rendered block by block (${r.blocks})`);
  // Generous limits so slow CI machines pass; a regression to whole-message re-rendering takes several times longer.
  assert.ok(r.total < 5000, `finished in ${Math.round(r.total)} ms`);
  assert.ok(r.longest < 400, `no long main-thread stalls (${Math.round(r.longest)} ms)`);
  // The view sticks to the bottom while streaming.
  const gap = await t.page.$eval('.messages', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(gap < 60, `stays scrolled to the newest text (${gap}px from the bottom)`);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('copy button on every response', async () => {
  const t = await open();
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.msg.assistant .copy-reply');
  // The whole reply as Markdown: its text, without thinking or tool calls.
  const reply = conversation.messages[1].parts.filter((p) => p.type === 'text').map((p) => p.text.trim()).join('\n\n');
  await t.clearPosted();
  await t.page.click('.msg.assistant .copy-reply');
  assert.deepEqual(await t.posted('copy'), [{ type: 'copy', text: reply }]);
  await t.page.waitForFunction(() => /Copied/.test(document.querySelector('.copy-reply')?.textContent ?? ''));
  assert.match(await t.text('.msg.assistant .msg-foot .meta'), /8\.2k in/);
  await t.shot('19-copy-response-dark');
  await t.page.waitForFunction(() => /^Copy$/.test(document.querySelector('.copy-reply')?.textContent ?? ''), { timeout: 4000 });
  // A reply that is still streaming offers no copy button yet; it appears once it is done.
  const streaming = { id: 'm3', sessionId: 'ses_1', role: 'assistant', createdAt: Date.now(), parts: [{ id: 'q1', type: 'text', text: 'Half an ans' }] };
  await t.host({ type: 'patch', patch: { messages: [...conversation.messages, streaming], activity: 'busy' } });
  assert.equal(await t.page.$$eval('.msg.assistant', (els) => els.at(-1).querySelector('.copy-reply')), null);
  await t.host({ type: 'patch', patch: { messages: [...conversation.messages, { ...streaming, completedAt: Date.now(), parts: [{ id: 'q1', type: 'text', text: 'Half an answer, then the rest.' }] }], activity: 'idle' } });
  await t.clearPosted();
  await t.page.$$eval('.msg.assistant .copy-reply', (els) => els.at(-1).click());
  assert.deepEqual(await t.posted('copy'), [{ type: 'copy', text: 'Half an answer, then the rest.' }]);
  assert.equal(await t.page.$$eval('.msg.user .copy-reply', (els) => els.length), 0);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('Claude Code and Codex ask to sign in with the account first, API key second', async () => {
  const t = await open();
  const claude = { ...base, engine: 'claude-code', sessions: [], model: { providerId: 'claude-code', modelId: 'default' }, auth: { engine: 'claude-code', mode: 'subscription', signedIn: false } };
  await t.host({ type: 'state', state: claude });
  await t.page.waitForSelector('.callout.account');
  assert.equal(await t.text('.callout.account .callout-title'), 'Sign in to Claude Code with your Claude account');
  assert.match(await t.text('.callout.account'), /Claude Pro or Max plan: no API key and no per-token charges/);
  assert.equal(await t.text('.callout.account .btn.primary'), 'Sign in with Claude');
  assert.equal(await t.page.$('.suggestion'), null);
  await t.shot('20-sign-in-claude-dark');
  await t.clearPosted();
  await t.page.click('.callout.account .btn.primary');
  assert.deepEqual(await t.posted('signIn'), [{ type: 'signIn' }]);
  const [apiKey] = await t.page.$$('xpath/.//button[contains(., "Use an API key instead")]');
  await apiKey.click();
  assert.deepEqual(await t.posted('useApiKey'), [{ type: 'useApiKey' }]);

  // Waiting for the browser sign-in.
  await t.host({ type: 'patch', patch: { auth: { ...claude.auth, pending: true } } });
  await t.page.waitForFunction(() => /Waiting for your Claude sign-in/.test(document.querySelector('.callout.account')?.textContent ?? ''));
  assert.ok(await t.page.$('.callout.account .spinner'));

  // Signed in: the welcome comes back, with the account shown.
  await t.host({ type: 'patch', patch: { auth: { engine: 'claude-code', mode: 'subscription', signedIn: true, billing: 'subscription', label: 'Claude account · Max · me@example.com' } } });
  await t.page.waitForSelector('.account-chip');
  assert.match(await t.text('.account-chip'), /Claude account · Max · me@example\.com.*Change/);
  assert.ok(await t.page.$('.suggestion'));
  await t.clearPosted();
  await t.page.click('.account-chip');
  assert.deepEqual(await t.posted('accountMenu'), [{ type: 'accountMenu' }]);

  // Codex: ChatGPT account, with a device-code option; and a warning when it is billing an API key.
  const codex = { ...base, engine: 'codex', engines: base.engines.map((e) => (e.engine === 'codex' ? { engine: 'codex', state: 'ready', version: '0.170.0' } : e)), sessions: [], model: { providerId: 'codex', modelId: 'default' }, auth: { engine: 'codex', mode: 'subscription', signedIn: true, billing: 'apiKey', label: 'API key (saved by `codex login`)' } };
  await t.host({ type: 'state', state: codex });
  await t.page.waitForFunction(() => /Codex \(ChatGPT\) is using an API key/.test(document.querySelector('.callout.account')?.textContent ?? ''));
  assert.match(await t.text('.callout.account'), /ChatGPT Plus or Pro plan instead/);
  await t.clearPosted();
  const [device] = await t.page.$$('xpath/.//button[contains(., "Use a device code")]');
  await device.click();
  assert.deepEqual(await t.posted('signIn'), [{ type: 'signIn', deviceCode: true }]);

  // API-key mode without a key, inside a conversation: a bar above the composer.
  await t.host({ type: 'state', state: { ...conversation, engine: 'claude-code', auth: { engine: 'claude-code', mode: 'apiKey', signedIn: false } } });
  await t.page.waitForSelector('.callout.auth-bar');
  assert.equal(await t.text('.auth-bar .callout-title'), 'Add an API key for Claude Code');
  await t.clearPosted();
  await t.page.click('.auth-bar .btn.primary');
  assert.deepEqual(await t.posted('useApiKey'), [{ type: 'useApiKey' }]);
  await t.shot('21-api-key-bar-dark');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('Ask / Auto approvals, and tokens for the open session', async () => {
  const t = await open('dark', 400, 900);
  const u = (input, output, cost) => ({ input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost });
  const extra = [
    { id: 'm3', sessionId: 'ses_1', role: 'user', createdAt: Date.now() - 30_000, parts: [{ id: 'u3', type: 'text', text: 'And the tests?' }] },
    { id: 'm4', sessionId: 'ses_1', role: 'assistant', createdAt: Date.now() - 29_000, completedAt: Date.now() - 20_000, model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5' }, usage: u(2100, 300, 0.002), parts: [{ id: 'a4', type: 'text', text: 'Added two tests.' }] },
  ];
  const state = { ...conversation, messages: [...conversation.messages, ...extra], approvals: 'ask' };
  await t.host({ type: 'state', state });
  await t.page.waitForSelector('.pill.approvals');
  assert.equal(await t.text('.pill.approvals'), 'Ask');
  // The open session's tokens sit in the composer, always in view.
  assert.match(await t.text('.pill.session-tokens'), /^9\.1k · \$0\.04$/);
  assert.match(await t.page.$eval('.pill.session-tokens', (el) => el.title), /This session used 9,092 tokens \(\$0\.04\) over 1 reply: 8,240 new input tokens.*Cache reads are not part of the number shown/);
  await t.clearPosted();
  await t.page.click('.pill.session-tokens');
  assert.deepEqual(await t.posted('send'), [{ type: 'send', text: '/usage' }]);

  // Ask / Auto menu.
  await t.page.click('.pill.approvals');
  await t.page.waitForSelector('.approvals-menu');
  assert.deepEqual(await t.page.$$eval('.approvals-menu .menu-label', (els) => els.map((e) => e.textContent)), ['Ask before acting', 'Auto']);
  await t.shot('22-approvals-menu-dark');
  await t.clearPosted();
  await t.page.$$eval('.approvals-menu .menu-item', (els) => els[1].click());
  assert.deepEqual(await t.posted('setApprovals'), [{ type: 'setApprovals', mode: 'auto' }]);
  await t.host({ type: 'patch', patch: { approvals: 'auto' } });
  assert.equal(await t.text('.pill.approvals'), 'Auto');
  assert.ok(await t.page.$('.pill.approvals.auto'));

  // A permission prompt offers to switch to Auto.
  await t.host({ type: 'patch', patch: { approvals: 'ask', permissions: [{ id: 'per_1', sessionId: 'ses_1', kind: 'bash', title: 'Run a command: run the tests', detail: 'npm test' }] } });
  await t.page.waitForSelector('.request .auto-switch');
  await t.clearPosted();
  await t.page.click('.request .auto-switch');
  assert.deepEqual(await t.posted('setApprovals'), [{ type: 'setApprovals', mode: 'auto' }]);
  await t.host({ type: 'patch', patch: { permissions: [] } });

  // The usage panel lists every reply of the session.
  await t.host({ type: 'patch', patch: { sessionUsage: { ...conversation.sessionUsage, messages: 2 } } });
  await t.page.click('.usage-btn');
  await t.page.waitForSelector('.reply-rows');
  assert.match(await t.text('.usage-section h3'), /This session: Refactor the auth middleware/);
  const rows = await t.page.$$eval('.usage-table.replies tbody tr', (els) => els.map((e) => [...e.children].map((c) => c.textContent.trim()).join('|')));
  // In, cached (read back from the prompt cache), out, cost.
  assert.deepEqual(rows, ['2|claude-haiku-5-5|2.1k||300|$0.0020', '1|claude-sonnet-5-5|8.2k|15k|852|$0.04']);
  await t.shot('23-usage-per-reply-dark');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('effort: a picker for models that have the setting', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id }));
  const providers = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      connected: true,
      models: [
        { providerId: 'claude-code', modelId: 'opus', name: 'Opus 5.5', efforts: levels, defaultEffort: 'medium' },
        { providerId: 'claude-code', modelId: 'legacy', name: 'Legacy model' },
      ],
    },
  ];
  const state = { ...conversation, engine: 'claude-code', providers, agents: [], agent: undefined, model: { providerId: 'claude-code', modelId: 'opus' }, effort: undefined };
  const t = await open();
  await t.host({ type: 'state', state });
  await t.page.waitForSelector('.pill.effort');
  // Nothing chosen: the pill shows the model's own level.
  assert.equal(await t.text('.pill.effort .effort-full'), 'Medium');
  // At this width the pill shows the short form and keeps the full one for wider views and screen readers.
  assert.equal(await t.page.$eval('.pill.effort', (el) => [...el.querySelectorAll('.pill-text')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent).join()), 'Med');
  assert.equal(await t.page.$eval('.pill.effort', (el) => el.getAttribute('aria-label')), 'Effort: Medium');
  assert.equal(await t.page.$('.effort-menu'), null);
  await t.page.click('.pill.effort');
  await t.page.waitForSelector('.effort-menu');
  assert.match(await t.text('.effort-menu .menu-note'), /more thorough, but slower/);
  const items = await t.page.$$eval('.effort-menu .menu-item', (els) => els.map((e) => [e.querySelector('.menu-label').firstChild.textContent.trim(), e.getAttribute('aria-checked')]));
  assert.deepEqual(items, [['Default', 'true'], ['Low', 'false'], ['Medium', 'false'], ['High', 'false'], ['Extra high', 'false'], ['Max', 'false']]);
  assert.equal(await t.text('.effort-menu .menu-item:nth-of-type(1) .menu-desc'), "Medium, the model's own setting");
  assert.equal(await t.text('.effort-menu .menu-tag'), 'default');
  // Only the top level carries the warning about limits.
  assert.deepEqual(await t.page.$$eval('.effort-menu .menu-warn', (els) => els.map((e) => e.closest('.menu-item').querySelector('.menu-label').textContent.trim())), ['Max']);
  await sleep(200);
  await t.shot('25-effort-menu-dark');
  await t.page.click('.effort-menu .menu-item:nth-of-type(4)');
  assert.deepEqual(await t.posted('setEffort'), [{ type: 'setEffort', effort: 'high' }]);
  assert.equal(await t.page.$('.effort-menu'), null);

  // The host confirms the choice; the top level is tinted as a reminder.
  await t.host({ type: 'patch', patch: { effort: 'max' } });
  await t.page.waitForFunction(() => document.querySelector('.pill.effort .effort-full')?.textContent === 'Max');
  assert.equal(await t.page.$eval('.pill.effort', (el) => el.classList.contains('costly')), true);
  await t.page.click('.pill.effort');
  assert.equal(await t.page.$eval('.effort-menu .menu-item.active .menu-label', (el) => el.firstChild.textContent.trim()), 'Max');
  // Back to the model's own level.
  await t.clearPosted();
  await t.page.click('.effort-menu .menu-item:nth-of-type(1)');
  assert.deepEqual(await t.posted('setEffort'), [{ type: 'setEffort', effort: null }]);
  await t.host({ type: 'patch', patch: { effort: null } });
  await t.page.waitForFunction(() => document.querySelector('.pill.effort .effort-full')?.textContent === 'Medium');

  // A model without the setting has no pill.
  await t.host({ type: 'patch', patch: { model: { providerId: 'claude-code', modelId: 'legacy' } } });
  await t.page.waitForFunction(() => !document.querySelector('.pill.effort'));

  // In a narrow side bar the row still fits and the menu stays on screen.
  const narrow = await open('dark', 300, 700);
  await narrow.host({ type: 'state', state: { ...state, agents: conversation.agents, agent: 'build', effort: 'xhigh', sessionUsage: conversation.sessionUsage } });
  await narrow.page.waitForSelector('.pill.effort');
  const overflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal overflow (${overflow}px)`);
  assert.deepEqual(await narrow.page.$$eval('.controls > *', (els) => els.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className)), []);
  await narrow.page.click('.pill.effort');
  await narrow.page.waitForSelector('.effort-menu');
  const box = await narrow.page.$eval('.effort-menu', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; });
  assert.ok(box.left >= 0 && box.right <= 300 && box.top >= 0, `menu on screen: ${JSON.stringify(box)}`);
  await narrow.shot('26-effort-menu-narrow');
  assert.deepEqual([...t.consoleErrors, ...narrow.consoleErrors], []);
  await narrow.page.close();
  await t.page.close();
});

await test('questions: one at a time, with an answer of your own', async () => {
  const questions = [
    { header: 'Database', question: 'Which database should the service use?', options: [{ label: 'Postgres', description: 'Relational, what the other services use' }, { label: 'SQLite', description: 'A single file, no server' }] },
    { header: 'Extras', question: 'Which extras do you want?', options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Billing' }], multiple: true },
    { question: 'What should the service be called?', options: [] },
  ];
  const t = await open();
  await t.host({ type: 'state', state: { ...conversation, activity: 'busy', questions: [{ id: 'que_9', sessionId: 'ses_1', questions }] } });
  await t.page.waitForSelector('.question-card');
  const title = () => t.text('.question-card .request-title');
  const buttons = () => t.page.$$eval('.question-card .request-actions .btn', (els) => els.map((e) => [e.textContent.trim(), e.disabled]));
  const optionLabels = () => t.page.$$eval('.question-card .option-label', (els) => els.map((e) => e.textContent));

  // Only the first question is on screen.
  assert.equal(await title(), 'Which database should the service use?');
  assert.equal((await t.page.$$('.question-card .request-title')).length, 1);
  assert.equal((await t.text('.question-progress')).replace(/\s+/g, ' ').trim(), 'Question 1 of 3');
  assert.equal(await t.text('.question-header'), 'Database');
  assert.deepEqual(await optionLabels(), ['Postgres', 'SQLite']);
  assert.equal(await t.text('.question-card .option-desc'), 'Relational, what the other services use');
  assert.equal(await t.page.$eval('.question-input', (el) => el.placeholder), 'Or type your own answer');
  assert.deepEqual(await buttons(), [['Next', true], ['Skip all', false]]);
  await sleep(200);
  await t.shot('27-question-one-at-a-time-dark');

  // Pick an option, then type instead: the typed answer replaces the option.
  await t.page.click('.question-card .option');
  assert.equal(await t.page.$eval('.question-card .option', (el) => el.getAttribute('aria-checked')), 'true');
  await t.page.type('.question-input', 'MySQL, we already run it');
  assert.deepEqual(await t.page.$$eval('.question-card .option', (els) => els.map((e) => e.getAttribute('aria-checked'))), ['false', 'false']);
  assert.deepEqual(await buttons(), [['Next', false], ['Skip all', false]]);
  await t.shot('28-question-own-answer-dark');
  // Enter in the answer box moves on; nothing is sent yet.
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => document.querySelector('.question-card .request-title')?.textContent === 'Which extras do you want?');
  assert.deepEqual(await t.posted(), (await t.posted()).filter((m) => m.type !== 'questionReply'));

  // Second question: several options and an own answer together.
  assert.equal((await t.text('.question-progress')).replace(/\s+/g, ' ').trim(), 'Question 2 of 3');
  assert.equal(await t.text('.question-hint'), 'Choose any that apply.');
  assert.equal(await t.page.$eval('.question-input', (el) => [el.value, el.placeholder].join('|')), '|Add an answer of your own');
  assert.deepEqual(await buttons(), [['Back', false], ['Next', true], ['Skip all', false]]);
  await t.page.click('.question-card .option:nth-child(1)');
  await t.page.click('.question-card .option:nth-child(3)');
  await t.page.click('.question-card .option:nth-child(3)');
  await t.page.click('.question-card .option:nth-child(2)');
  await t.page.type('.question-input', 'Rate limiting');
  assert.deepEqual(await t.page.$$eval('.question-card .option', (els) => els.map((e) => e.getAttribute('aria-checked'))), ['true', 'true', 'false']);

  // Back keeps what was answered, and it can be changed.
  await t.page.click('.question-card .request-actions .btn:nth-child(1)');
  await t.page.waitForFunction(() => document.querySelector('.question-card .request-title')?.textContent.startsWith('Which database'));
  assert.equal(await t.page.$eval('.question-input', (el) => el.value), 'MySQL, we already run it');
  await t.page.click('.question-card .option:nth-child(2)');
  assert.equal(await t.page.$eval('.question-input', (el) => el.value), '');
  await t.page.click('.question-card .btn.primary');
  await t.page.waitForFunction(() => document.querySelector('.question-card .request-title')?.textContent === 'Which extras do you want?');
  assert.equal(await t.page.$eval('.question-input', (el) => el.value), 'Rate limiting');
  await t.page.click('.question-card .btn.primary');

  // Last question has no options: the answer box has the cursor, and the button sends everything.
  await t.page.waitForFunction(() => document.querySelector('.question-card .request-title')?.textContent === 'What should the service be called?');
  assert.equal((await t.page.$$('.question-card .option')).length, 0);
  assert.equal(await t.page.$eval('.question-input', (el) => el.placeholder), 'Type your answer');
  // (The cursor moves there just after the question is drawn.)
  await t.page.waitForFunction(() => document.activeElement === document.querySelector('.question-input'));
  assert.deepEqual(await buttons(), [['Back', false], ['Send answers', true], ['Skip all', false]]);
  await t.page.keyboard.type('  ledger  ');
  await t.page.click('.question-card .btn.primary');
  assert.deepEqual(await t.posted('questionReply'), [{ type: 'questionReply', requestId: 'que_9', answers: [['SQLite'], ['Auth', 'Search', 'Rate limiting'], ['ledger']] }]);

  // "Skip all" answers nothing; a question that only takes its options has no answer box.
  await t.clearPosted();
  await t.host({ type: 'patch', patch: { questions: [{ id: 'que_10', sessionId: 'ses_1', questions: [{ question: 'Continue with the migration?', options: [{ label: 'Yes' }, { label: 'No' }], custom: false }] }] } });
  await t.page.waitForFunction(() => document.querySelector('.question-card .request-title')?.textContent === 'Continue with the migration?');
  assert.equal(await t.page.$('.question-input'), null);
  assert.equal(await t.page.$('.question-progress'), null);
  assert.deepEqual(await buttons(), [['Send answer', true], ['Skip', false]]);
  await t.page.click('.question-card .btn.quiet');
  assert.deepEqual(await t.posted('questionReply'), [{ type: 'questionReply', requestId: 'que_10', answers: null }]);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('model picker says it is loading while an engine is asked for the first time', async () => {
  const t = await open();
  await t.host({ type: 'state', state: { ...base, providers: [], model: undefined, loading: true } });
  await t.page.click('.pill.model');
  await t.page.waitForSelector('.sheet .empty-note');
  assert.equal(await t.text('.sheet .empty-note'), 'Loading models…');
  // Opening the picker tells the host, which checks with the engine that the list is current.
  assert.deepEqual(await t.posted('modelsShown'), [{ type: 'modelsShown' }]);
  // The list arrives: the note gives way to it without reopening the picker.
  await t.host({ type: 'patch', patch: { providers: base.providers, model: base.model, loading: false } });
  await t.page.waitForFunction(() => !document.querySelector('.sheet .empty-note') && document.querySelectorAll('.sheet .row').length > 0);
  // Nothing connected is a different message.
  await t.host({ type: 'patch', patch: { providers: [], model: null } });
  await t.page.waitForFunction(() => document.querySelector('.sheet .empty-note')?.textContent.startsWith('No models yet'));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('engine not available, untrusted workspace and toasts', async () => {
  const t = await open();
  const down = { ...base, engine: 'codex', model: undefined, providers: [], mcp: [], agents: [] };
  await t.host({ type: 'state', state: down });
  await t.page.waitForSelector('.callout');
  assert.match(await t.text('.callout'), /Codex \(ChatGPT\) is not available.*Codex CLI not found\./s);
  await t.page.waitForFunction(() => document.querySelector('.stage-caption')?.textContent === 'Engine not available');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.mood === 'sad');
  await sleep(500);
  await t.shot('14-engine-unavailable-dark');
  await t.page.click('.callout .btn.primary');
  assert.equal((await t.posted('restartEngine')).length, 1);
  await t.host({ type: 'state', state: { ...base, trusted: false } });
  await t.page.waitForFunction(() => /Workspace not trusted/.test(document.querySelector('.callout')?.textContent ?? ''));
  assert.match(await t.page.$eval('textarea', (el) => el.placeholder), /Trust this workspace/);
  await t.host({ type: 'patch', patch: { trusted: true, notice: { level: 'error', text: 'Chat request failed (401): invalid x-api-key. Check the API key for this provider.', nonce: 1 } } });
  await t.page.waitForSelector('.toast.error');
  assert.match(await t.text('.toast'), /invalid x-api-key/);
  await t.page.click('.toast .icon-btn');
  assert.equal(await t.page.$('.toast'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('model output is sanitized: no script execution, no remote requests', async () => {
  const t = await open();
  const requests = [];
  t.page.on('request', (r) => !r.url().startsWith(origin) && !r.url().startsWith('data:') && requests.push(r.url()));
  const evil = 'Hello <img src="x" onerror="window.__xss=1"> <script>window.__xss=2</script> <iframe src="https://evil.example"></iframe>\n\n![t](https://tracker.example/pixel.png)\n\n[click](javascript:window.__xss=3) <a href="https://ok.example" onclick="window.__xss=4">ok</a>\n\n<style>body{display:none}</style><form action="https://evil.example"><input name="a"></form>';
  await t.host({ type: 'state', state: { ...conversation, messages: [{ id: 'x1', sessionId: 'ses_1', role: 'assistant', createdAt: 1, completedAt: 2, parts: [{ id: 'xp', type: 'text', text: evil }, { id: 'xt', type: 'tool', tool: '<b>t</b>', callId: 'c', status: 'completed', title: '<img src=x onerror=window.__xss=5>', output: '<script>window.__xss=6</script>' }] }] } });
  await t.page.waitForSelector('.msg.assistant .md');
  await t.page.click('.fold.tool .fold-head');
  for (const link of await t.page.$$('.md [data-href]')) await link.click();
  await sleep(400);
  assert.equal(await t.page.evaluate(() => window.__xss), undefined);
  assert.equal(await t.page.$$eval('.md script, .md iframe, .md img, .md style, .md form, .md input, .md [onclick], .md [onerror], .md a[href]', (els) => els.length), 0);
  assert.equal(await t.page.evaluate(() => getComputedStyle(document.body).display), 'block');
  assert.deepEqual(requests, []);
  // javascript: links are dropped by the sanitizer and never reach the host as navigations.
  const opened = [...(await t.posted('openExternal')), ...(await t.posted('openFile'))].map((m) => m.url ?? m.path);
  assert.deepEqual(opened, ['https://ok.example']);
  assert.equal(await t.text('.fold.tool .tool-name'), '<b>t</b>');
  await t.page.close();
});

await test('light theme and a narrow sidebar', async () => {
  const t = await open('light', 300, 700);
  await t.host({ type: 'state', state: { ...conversation, usage: usageSummary } });
  await t.page.waitForSelector('.msg.assistant .md');
  await t.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.renderer === 'webgl', { timeout: 15000 });
  await sleep(500);
  // Nothing overflows horizontally at 300px.
  const overflow = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal overflow (${overflow}px)`);
  const clipped = await t.page.$$eval('.topbar > *, .controls > *', (els) => els.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className));
  assert.deepEqual(clipped, []);
  await t.shot('15-conversation-light-narrow');
  await t.page.click('.usage-btn');
  await t.page.waitForSelector('.sheet .stats');
  await t.shot('16-usage-light-narrow');
  const t2 = await open('light');
  await t2.host({ type: 'state', state: base });
  await t2.page.waitForFunction(() => document.querySelector('canvas.oki')?.dataset.renderer === 'webgl', { timeout: 15000 });
  await sleep(600);
  await t2.shot('17-empty-light');
  assert.deepEqual([...t.consoleErrors, ...t2.consoleErrors], []);
  await t.page.close();
  await t2.page.close();
});


await test('scrolling: follows a streaming reply, lets go when you scroll up, and nothing jumps', async () => {
  const t = await open('dark', 420, 640);
  const long = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of a long answer, with enough words in it to wrap over a couple of lines in a narrow side bar.`).join('\n\n');
  const history = [];
  for (let i = 0; i < 24; i++) {
    history.push({ id: `u${i}`, sessionId: 'ses_1', role: 'user', createdAt: 1000 + i * 10, parts: [{ id: `up${i}`, type: 'text', text: `Question ${i + 1}` }] });
    history.push({ id: `a${i}`, sessionId: 'ses_1', role: 'assistant', createdAt: 1005 + i * 10, completedAt: 1006 + i * 10, parts: [{ id: `ap${i}`, type: 'text', text: long(2 + (i % 5) * 3) }] });
  }
  const live = { id: 'live', sessionId: 'ses_1', role: 'assistant', createdAt: 5000, parts: [{ id: 'lp', type: 'text', text: 'Start. ' }] };
  await t.host({ type: 'state', state: { ...conversation, avatar: { enabled: false, style: 'buddy' }, activity: 'busy', messages: [...history, live] } });
  await t.page.waitForSelector('[data-message-id="live"]');
  const gap = () => t.page.$eval('.messages', (el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const chunk = (text) => t.host({ type: 'event', event: { type: 'part.delta', sessionId: 'ses_1', messageId: 'live', partId: 'lp', delta: text } });
  // A session opens at its end and stays there while the reply grows.
  assert.ok((await gap()) <= 2, 'opens at the end');
  for (let i = 0; i < 6; i++) await chunk(`${long(1)}\n\n`);
  assert.ok((await gap()) <= 2, `follows the streaming reply (${await gap()}px from the end)`);

  // Messages are not sized by a guess before they are drawn, so the list is as tall when you
  // arrive at the top as it was at the bottom: the scroll bar does not jump on the way.
  assert.equal(await t.page.$eval('.msg', (el) => getComputedStyle(el).contentVisibility), 'visible');
  const heightAtEnd = await t.page.$eval('.messages', (el) => el.scrollHeight);

  // Scroll up a little while text keeps arriving: the view must stay where the reader put it.
  const box = await (await t.page.$('.messages')).boundingBox();
  await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await t.page.mouse.wheel({ deltaY: -30 });
  await sleep(80);
  const afterWheel = await gap();
  assert.ok(afterWheel > 2, `a small scroll up leaves the end (${afterWheel}px)`);
  for (let i = 0; i < 4; i++) await chunk(`${long(1)}\n\n`);
  assert.ok((await gap()) > afterWheel, 'new text does not pull the view back down');
  const top = await t.page.$eval('.messages', (el) => el.scrollTop);
  await chunk(`${long(2)}\n\n`);
  assert.equal(await t.page.$eval('.messages', (el) => el.scrollTop), top, 'what the reader is looking at does not move');

  // "Latest" floats over the list. It is not part of what scrolls, so showing it changes nothing.
  await t.page.mouse.wheel({ deltaY: -400 });
  await t.page.waitForSelector('.jump');
  assert.equal(await t.page.$('.messages .jump'), null);
  assert.ok(await t.page.$('.messages-wrap > .jump'));
  const before = await t.page.$eval('.messages', (el) => ({ top: el.scrollTop, height: el.scrollHeight }));
  await sleep(60);
  assert.deepEqual(await t.page.$eval('.messages', (el) => ({ top: el.scrollTop, height: el.scrollHeight })), before);

  // All the way up and back down: the content's height never changed underneath.
  await t.page.$eval('.messages', (el) => (el.scrollTop = 0));
  await sleep(80);
  const heightAtTop = await t.page.$eval('.messages', (el) => el.scrollHeight);
  assert.equal(heightAtTop, before.height, 'the list is as tall at the top as it was further down');
  assert.ok(heightAtTop > heightAtEnd, 'and it only ever grew with the reply');

  // Latest goes back to the end and follows again.
  await t.page.click('.jump');
  await t.page.waitForFunction(() => {
    const el = document.querySelector('.messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  });
  await chunk(`${long(2)}\n\nEND`);
  assert.ok((await gap()) <= 2, 'follows again after Latest');
  assert.equal(await t.page.$('.jump'), null);

  // Scrolling back down to the end by hand does the same.
  await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await t.page.mouse.wheel({ deltaY: -200 });
  await t.page.waitForFunction(() => {
    const el = document.querySelector('.messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight > 100;
  });
  await t.page.mouse.wheel({ deltaY: 5000 });
  await t.page.waitForFunction(() => {
    const el = document.querySelector('.messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  });
  await sleep(50);
  await chunk(' and more.');
  assert.ok((await gap()) <= 2, 'follows again after scrolling back to the end');
  await t.shot('24-scrolling-dark');
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('send later: menu, presets, a time of your own, and the Scheduled list', async () => {
  const t = await open('dark', 420, 760);
  await t.host({ type: 'state', state: conversation });
  await t.page.waitForSelector('.later-btn');
  // Nothing to schedule yet.
  assert.equal(await t.page.$eval('.later-btn', (el) => el.disabled), true);
  await t.page.type('.input-box textarea', 'run the tests again');
  await t.page.waitForFunction(() => !document.querySelector('.later-btn').disabled);
  await t.page.click('.later-btn');
  await t.page.waitForSelector('.when-menu');
  const labels = await t.page.$$eval('.when-menu .menu-item:not([hidden]) .menu-label', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels.slice(0, 3), ['In 30 minutes', 'In 1 hour', 'In 3 hours']);
  assert.equal(labels.at(-1), 'Choose date and time…');
  assert.ok(labels.includes('Tomorrow at 9:00'));
  await t.shot('25-send-later-menu-dark');
  await t.clearPosted();
  const clicked = Date.now();
  await t.page.$$eval('.when-menu .menu-item', (els) => els.find((e) => e.textContent.includes('In 30 minutes')).click());
  const [sent] = await t.posted('schedule');
  assert.equal(sent.text, 'run the tests again');
  assert.ok(Math.abs(sent.at - (clicked + 30 * 60_000)) < 10_000, 'thirty minutes from now');
  // The message box is empty again and the menu is closed.
  await t.page.waitForFunction(() => document.querySelector('.input-box textarea').value === '' && !document.querySelector('.when-menu'));

  // A date and time of your own. The menu stays open while you pick.
  await t.page.type('.input-box textarea', 'ship it');
  await t.page.click('.later-btn');
  await t.page.$$eval('.when-menu .menu-item', (els) => els.find((e) => e.textContent.includes('Choose date')).click());
  await t.page.waitForSelector('.when-custom input');
  assert.ok(await t.page.$('.when-menu'), 'the menu is still open');
  const target = new Date(Date.now() + 2 * 86400_000);
  target.setHours(14, 30, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const value = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T14:30`;
  await t.page.$eval('.when-custom input', (el, v) => {
    el.value = v;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }, value);
  await t.clearPosted();
  await t.page.click('.when-custom .btn');
  assert.deepEqual(await t.posted('schedule'), [{ type: 'schedule', text: 'ship it', at: target.getTime() }]);

  // While a reply is being written, "when this reply is done" comes first and sends a time that has come.
  await t.host({ type: 'patch', patch: { activity: 'busy' } });
  await t.page.type('.input-box textarea', 'then commit');
  await t.page.click('.later-btn');
  await t.page.waitForSelector('.when-menu');
  assert.equal(await t.page.$eval('.when-menu .menu-item .menu-label', (el) => el.textContent), 'When this reply is done');
  await t.clearPosted();
  const queued = Date.now();
  await t.page.click('.when-menu .menu-item');
  const [next] = await t.posted('schedule');
  assert.ok(next.at <= queued + 1000 && next.text === 'then commit');
  await t.host({ type: 'patch', patch: { activity: 'idle' } });

  // What is scheduled is listed above the message box: this conversation's first.
  const now = Date.now();
  const scheduled = [
    { id: 'l1', engine: 'claude-code', sessionId: 'other', sessionTitle: 'Fix the flaky test', text: 'check the build', attachments: [], sendAt: now + 5 * 60_000, createdAt: now },
    { id: 'l2', engine: 'opencode', sessionId: 'ses_1', sessionTitle: 'Refactor the auth middleware', text: 'run the tests again', attachments: [{ id: 'a', kind: 'file', name: 'a.ts', mime: 'text/plain', path: '/w/a.ts' }], sendAt: now + 28 * 60_000, createdAt: now },
    { id: 'l3', engine: 'opencode', sessionId: 'ses_1', text: 'deploy', attachments: [], sendAt: now - 3600_000, createdAt: now - 7200_000, problem: 'opencode is not available.' },
  ];
  await t.host({ type: 'patch', patch: { scheduled } });
  await t.page.waitForSelector('.scheduled-item');
  assert.equal(await t.text('.scheduled-head'), 'Scheduled (3)');
  const items = await t.page.$$eval('.scheduled-item', (els) => els.map((e) => `${e.querySelector('.scheduled-when').textContent} | ${e.querySelector('.scheduled-text').textContent}`));
  assert.match(items[0], /^Not sent \| deploy$/);
  assert.match(items[1], /^in 28 min · today at \d\d:\d\d \| run the tests again · 1 attachment$|^in 28 min · tomorrow at \d\d:\d\d \| run the tests again · 1 attachment$/);
  assert.match(items[2], /^in 5 min · .* in "Fix the flaky test", Claude Code \| check the build$/);
  assert.equal(await t.text('.scheduled-item.stuck .scheduled-problem'), 'opencode is not available.');
  await t.shot('26-scheduled-list-dark');
  // Send now, edit, change the time, cancel.
  await t.clearPosted();
  await t.page.click('.scheduled-item:nth-child(2) [aria-label="Send now"]');
  await t.page.click('.scheduled-item:nth-child(2) [aria-label="Edit"]');
  await t.page.click('.scheduled-item:nth-child(2) [aria-label="Cancel this scheduled message"]');
  assert.deepEqual((await t.posted()).filter((m) => m.type.startsWith('scheduled')), [{ type: 'scheduledSendNow', id: 'l2' }, { type: 'scheduledEdit', id: 'l2' }, { type: 'scheduledCancel', id: 'l2' }]);
  await t.page.click('.scheduled-item:nth-child(2) [aria-label="Change the time"]');
  await t.page.waitForSelector('.scheduled-move .when-menu');
  // The menu opens out of the list and is not cut off by it: its first entry can really be clicked.
  const reachable = await t.page.evaluate(() => {
    const item = document.querySelector('.scheduled-move .when-menu .menu-item');
    const r = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  assert.ok(reachable, 'the menu is not clipped by the list');
  await t.shot('26b-scheduled-move-dark');
  await t.clearPosted();
  const moved = Date.now();
  await t.page.$$eval('.scheduled-move .when-menu .menu-item', (els) => els.find((e) => e.textContent.includes('In 1 hour')).click());
  const [move] = await t.posted('scheduledReschedule');
  assert.equal(move.id, 'l2');
  assert.ok(Math.abs(move.at - (moved + 3600_000)) < 10_000);
  // The session list marks conversations with a message waiting.
  await t.page.click('.session-btn');
  await t.page.waitForSelector('.sheet .row.session');
  assert.equal(await t.page.$$eval('.row.session .row-clock', (els) => els.length), 1);
  assert.ok(await t.page.$('.row.session.active .row-clock'));
  // An edited message comes back into the box (the host sends its text).
  await t.page.keyboard.press('Escape');
  await t.host({ type: 'insertText', text: 'run the tests again' });
  await t.page.waitForFunction(() => document.querySelector('.input-box textarea').value.includes('run the tests again'));
  // Nothing scheduled: no list.
  await t.host({ type: 'patch', patch: { scheduled: [] } });
  await t.page.waitForFunction(() => !document.querySelector('.scheduled'));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('html previews: drawn in the chat, without scripts, forms or anything that leaves their box', async () => {
  const t = await open('dark', 440, 820);
  await t.page.evaluate(() => (window.__pwned = 0));
  const html = [
    '<style>body { font-family: serif } .kpi { display: flex; gap: 8px } .kpi > div { padding: 6px 10px; border: 1px solid var(--vscode-widget-border) } @import url("https://evil.example/x.css"); .bg { background: url(https://evil.example/pixel.png) } .cover { position: fixed; inset: 0; background: red }</style>',
    '<h2>Build times</h2>',
    '<div class="kpi"><div><b>41 s</b><br>unit</div><div><b>3 min</b><br>e2e</div></div>',
    '<svg viewBox="0 0 120 40" width="100%"><rect x="0" y="10" width="80" height="12" fill="var(--vscode-charts-blue, #3794ff)"/><script>window.__pwned = 1</script></svg>',
    '<table><tr><th>Suite</th><th>Time</th></tr><tr><td>unit</td><td>41 s</td></tr></table>',
    '<details><summary>More</summary><p>Hidden detail</p></details>',
    '<img src="https://evil.example/track.png" onerror="window.__pwned = 2"><img src="x" onerror="window.__pwned = 3">',
    '<form action="https://evil.example"><input name="q"><button>Go</button></form>',
    '<a href="https://example.com" onclick="window.__pwned = 4">a link</a>',
    '<script>window.__pwned = 5</script><iframe src="https://evil.example"></iframe>',
    '<div class="cover">covering everything</div>',
  ].join('\n');
  const reply = (text, extra = {}) => ({ id: 'pv', sessionId: 'ses_1', role: 'assistant', createdAt: Date.now(), completedAt: Date.now(), parts: [{ id: 'pvt', type: 'text', text }], ...extra });
  const ask = { id: 'pu', sessionId: 'ses_1', role: 'user', createdAt: Date.now() - 10, parts: [{ id: 'put', type: 'text', text: 'chart the build times\n\n<!-- opencode-hub: html-preview -->\nPresent the answer as a visual. Reply with one short sentence…' }] };
  const requests = [];
  t.page.on('request', (r) => requests.push(r.url()));

  // While the block is still being written it is plain code: no half-drawn page.
  await t.host({ type: 'state', state: { ...conversation, activity: 'busy', messages: [ask, reply('Here it is:\n\n```html-preview\n' + html.slice(0, 200), { completedAt: undefined })] } });
  await t.page.waitForSelector('[data-message-id="pv"] .code');
  assert.equal(await t.page.$('[data-message-id="pv"] .preview-host'), null);
  // The request shows what the user typed, with a tag instead of the instructions the chat added.
  assert.equal(await t.page.$eval('[data-message-id="pu"] .bubble', (el) => el.childNodes[0].textContent), 'chart the build times');
  assert.equal(await t.text('[data-message-id="pu"] .bubble-tag'), 'HTML preview');

  await t.host({ type: 'state', state: { ...conversation, messages: [ask, reply('Here it is:\n\n```html-preview\n' + html + '\n```\n\nDone.')] } });
  await t.page.waitForSelector('[data-message-id="pv"] .code.previewing .preview-host');
  const seen = await t.page.$eval('[data-message-id="pv"] .preview-host', (host) => {
    const root = host.shadowRoot;
    const q = (sel) => root.querySelectorAll(sel).length;
    const cover = root.querySelector('.cover').getBoundingClientRect();
    const box = host.getBoundingClientRect();
    return {
      title: root.querySelector('h2')?.textContent,
      svg: q('svg rect'),
      table: q('table td'),
      details: q('details summary'),
      scripts: q('script'),
      forms: q('form, input, button, iframe'),
      images: q('img'),
      handlers: [...root.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
      href: q('a[href]'),
      css: [...root.querySelectorAll('style')].map((s) => s.textContent).join('\n'),
      // A fixed element stays inside the preview's own box.
      contained: cover.top >= box.top - 1 && cover.bottom <= box.bottom + 1 && cover.left >= box.left - 1 && cover.right <= box.right + 1,
      contain: getComputedStyle(host).contain,
      sourceHidden: getComputedStyle(host.parentElement.querySelector('pre')).display === 'none',
    };
  });
  assert.equal(seen.title, 'Build times');
  assert.ok(seen.svg === 1 && seen.table === 2 && seen.details === 1, 'HTML, inline SVG, tables and details are drawn');
  assert.deepEqual([seen.scripts, seen.forms, seen.images, seen.handlers, seen.href], [0, 0, 0, 0, 0], 'no scripts, forms, remote images, event handlers or live links');
  assert.ok(!/@import|evil\.example/.test(seen.css), 'nothing is imported or loaded from the network');
  assert.match(seen.css, /\.ohp-body \{ font-family: serif \}/, "a page's body rules apply to the preview");
  assert.ok(seen.contained, 'a fixed-position element cannot leave the preview');
  assert.match(seen.contain, /content|layout/);
  assert.ok(seen.sourceHidden, 'the source is tucked away');
  // The chat's own controls are still on top and clickable.
  const onTop = await t.page.evaluate(() => {
    const b = document.querySelector('.input-box textarea').getBoundingClientRect();
    return document.elementFromPoint(b.left + 5, b.top + 5)?.tagName;
  });
  assert.equal(onTop, 'TEXTAREA');
  await sleep(150);
  assert.equal(await t.page.evaluate(() => window.__pwned), 0, 'nothing in the preview ran');
  assert.deepEqual(requests.filter((u) => u.includes('evil.example')), []);
  await t.shot('27-html-preview-dark');

  // Source and back, expand, and save as a self-contained file.
  const act = (name) => t.page.$eval(`[data-message-id="pv"] .code [data-action="${name}"]`, (el) => el.click());
  await act('preview');
  assert.equal(await t.page.$eval('[data-message-id="pv"] .code', (el) => el.classList.contains('previewing')), false);
  assert.match(await t.text('[data-message-id="pv"] .code pre'), /Build times/);
  await act('preview');
  assert.equal(await t.page.$eval('[data-message-id="pv"] .code', (el) => el.classList.contains('previewing')), true);
  await act('expand');
  assert.equal(await t.page.$eval('[data-message-id="pv"] .code', (el) => el.classList.contains('expanded')), true);
  await t.clearPosted();
  await act('save-html');
  const [saved] = await t.posted('saveHtml');
  assert.match(saved.html, /^<!DOCTYPE html>/);
  assert.match(saved.html, /Build times/);
  assert.ok(!/<script|evil\.example|onerror|<form/.test(saved.html), 'the saved file is the sanitized preview');
  assert.match(saved.html, /--vscode-foreground: #cccccc/, 'with the theme colours it used written out');

  // An ordinary HTML or SVG code block stays code, with a Preview button.
  await t.host({ type: 'state', state: { ...conversation, messages: [reply('```html\n<h3 id="manual">Hello</h3>\n```\n\n```ts\nconst a = 1;\n```')] } });
  await t.page.waitForSelector('[data-message-id="pv"] .code[data-preview="manual"]');
  assert.equal(await t.page.$('[data-message-id="pv"] .preview-host'), null);
  assert.equal(await t.page.$$eval('[data-message-id="pv"] [data-action="preview"]', (els) => els.length), 1, 'only the HTML block offers a preview');
  await act('preview');
  assert.equal(await t.page.$eval('[data-message-id="pv"] .preview-host', (h) => h.shadowRoot.querySelector('#manual').textContent), 'Hello');
  assert.equal(await t.text('[data-message-id="pv"] .code [data-action="preview"]'), 'Source');

  // Markdown's own collapsible sections work in a normal reply too.
  await t.host({ type: 'state', state: { ...conversation, messages: [reply('<details><summary>Steps</summary>\n\nOne, two.\n\n</details>')] } });
  await t.page.waitForSelector('[data-message-id="pv"] details summary');

  // Turned off in settings: the block is shown as code.
  await t.host({ type: 'state', state: { ...conversation, htmlPreview: false, messages: [reply('```html-preview\n<p>plain</p>\n```\n')] } });
  await t.page.waitForSelector('[data-message-id="pv"] .code');
  assert.equal(await t.page.$('[data-message-id="pv"] [data-preview]'), null);
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await test('tokens: model calls, context after a reply, and why a first request can be large', async () => {
  const t = await open('dark', 420, 760);
  const usage = (input, output, extra = {}) => ({ input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...extra });
  // A Claude Code reply that took 6 model calls: the context was read 6 times, mostly from the cache.
  const messages = [
    { id: 'u1', sessionId: 'ses_1', role: 'user', createdAt: 1, parts: [{ id: 'u1p', type: 'text', text: 'fix it' }] },
    { id: 'a1', sessionId: 'ses_1', role: 'assistant', createdAt: 2, completedAt: 3, model: { providerId: 'claude-code', modelId: 'claude-opus-5-5' }, usage: usage(1200, 900, { cacheRead: 310_000, cacheWrite: 52_000, cost: 0.41 }), contextTokens: 64_000, calls: 6, parts: [{ id: 'a1p', type: 'text', text: 'Fixed.' }] },
  ];
  const claude = { ...conversation, engine: 'claude-code', providers: [{ id: 'claude-code', name: 'Claude Code', connected: true, models: [{ providerId: 'claude-code', modelId: 'opus', name: 'Opus 5.5', contextWindow: 200_000 }] }], model: { providerId: 'claude-code', modelId: 'opus' }, messages, sessionUsage: { ...conversation.sessionUsage, engine: 'claude-code', usage: messages[1].usage } };
  await t.host({ type: 'state', state: claude });
  await t.page.waitForSelector('.msg.assistant .meta');
  // The reply names the model that really answered, and keeps cache reads apart from new input.
  assert.equal(await t.text('.msg.assistant .meta'), 'claude-opus-5-553k in310k cached900 out6 calls$0.41');
  assert.match(await t.page.$eval('.msg.assistant .meta', (el) => el.title), /This reply took 6 model calls, and each one reads the conversation again\. Context after this reply: 64,000 tokens\./);
  // The session total does not count the 310k that were only read back.
  assert.equal(await t.text('.pill.session-tokens'), '54k · $0.41');
  // The context meter shows the size of the context (64k of 200k), not six times that.
  assert.match(await t.page.$eval('.context-meter', (e) => e.title), /^Context: about 64k of 200k tokens \(32%\)\.$/);
  // Without a context figure, a multi-call engine's reply says nothing about the context: no meter rather than a wrong one.
  const noContext = JSON.parse(JSON.stringify(claude));
  delete noContext.messages[1].contextTokens;
  await t.host({ type: 'state', state: noContext });
  await t.page.waitForFunction(() => !document.querySelector('.context-meter'));

  // opencode writes one message per model call. A first request that is already huge gets an explanation.
  const big = [
    { id: 'u1', sessionId: 'ses_1', role: 'user', createdAt: 1, parts: [{ id: 'u1p', type: 'text', text: 'why does this fail?' }] },
    { id: 'b1', sessionId: 'ses_1', role: 'assistant', createdAt: 2, completedAt: 3, model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, usage: usage(40, 1200, { cacheWrite: 361_000, cost: 1.83 }), contextTokens: 362_240, calls: 1, parts: [{ id: 'b1p', type: 'text', text: 'Because.' }] },
    { id: 'b2', sessionId: 'ses_1', role: 'assistant', createdAt: 4, completedAt: 5, model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, usage: usage(300, 63, { cacheRead: 362_000, cost: 0.08 }), contextTokens: 362_363, calls: 1, parts: [{ id: 'b2p', type: 'tool', tool: 'bash', callId: 'c', status: 'completed', title: 'ls', output: 'a' }] },
  ];
  await t.host({ type: 'state', state: { ...conversation, messages: big, usage: usageSummary, sessionUsage: { ...conversation.sessionUsage, usage: usage(340, 1263, { cacheRead: 362_000, cacheWrite: 361_000, cost: 1.91 }), messages: 2 } } });
  await t.page.waitForSelector('[data-message-id="b2"] .meta');
  assert.equal(await t.text('[data-message-id="b1"] .meta'), 'claude-opus-5-5361k in1.2k out$1.83');
  // A tool step has no reply text, so it does not repeat the model's name.
  assert.equal(await t.text('[data-message-id="b2"] .meta'), '300 in362k cached63 out$0.08');
  await t.page.click('.usage-btn');
  await t.page.waitForSelector('.sheet .first-request');
  assert.match(await t.text('.sheet .first-request'), /The first request of this session already carried 362k tokens\. That is what opencode sends before your message: its instructions, your project's instruction files \(such as AGENTS\.md or CLAUDE\.md\), the definition of every tool, the tools of 1 connected MCP server included, and anything you attached\..*Turning off MCP servers you do not need here/);
  await t.shot('28-usage-first-request-dark');
  // An ordinary first request gets no such note.
  await t.host({ type: 'state', state: { ...conversation, usage: usageSummary } });
  await t.page.waitForFunction(() => !document.querySelector('.sheet .first-request'));
  assert.deepEqual(t.consoleErrors, []);
  await t.page.close();
});

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${path.relative(root, outDir)}/`);
process.exit(failed ? 1 : 0);
