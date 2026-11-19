import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachmentsAsText, mimeForPath, resolveAttachment } from '../../src/core/attachments';
import { newId } from '../../src/core/ids';
import { listPrice, catalogProviderFor } from '../../src/core/listPrices';
import { LocalSessionStore } from '../../src/core/localSessions';
import { sessionDigest } from '../../src/core/sessionDigest';
import { estimateCost } from '../../src/core/usageLedger';
import type { ChatMessage } from '../../src/shared/types';
import { envWithExeDir, findExecutable, quoteWindowsArg, runCapture, terminalCommand, wellKnownDirs } from '../../src/core/process';

describe('attachments', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ochub-att-'));
  it('detects mime types by extension', () => {
    expect(mimeForPath('a/B.PNG')).toBe('image/png');
    expect(mimeForPath('x.jpeg')).toBe('image/jpeg');
    expect(mimeForPath('doc.pdf')).toBe('application/pdf');
    expect(mimeForPath('main.rs')).toBe('text/plain');
  });

  it('reads text files, line ranges, images, directories and skips binaries', async () => {
    const txt = path.join(dir, 'a.txt');
    writeFileSync(txt, 'one\ntwo\nthree\nfour\n');
    const bin = path.join(dir, 'a.bin');
    writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    const png = path.join(dir, 'a.png');
    writeFileSync(png, Buffer.from('fakepng'));

    expect((await resolveAttachment({ id: '1', kind: 'file', name: 'a.txt', mime: 'text/plain', path: txt })).text).toBe('one\ntwo\nthree\nfour\n');
    expect((await resolveAttachment({ id: '2', kind: 'file', name: 'a.txt:2-3', mime: 'text/plain', path: txt, range: { startLine: 2, endLine: 3 } })).text).toBe('two\nthree');
    // A selection carries its own text and wins over the file on disk.
    expect((await resolveAttachment({ id: '3', kind: 'selection', name: 's', mime: 'text/plain', path: txt, text: 'unsaved edit' })).text).toBe('unsaved edit');
    expect((await resolveAttachment({ id: '4', kind: 'file', name: 'a.bin', mime: 'text/plain', path: bin })).note).toMatch(/binary file a.bin was skipped/);
    expect((await resolveAttachment({ id: '5', kind: 'image', name: 'a.png', mime: 'image/png', path: png })).image).toEqual({ mime: 'image/png', data: Buffer.from('fakepng').toString('base64') });
    expect((await resolveAttachment({ id: '6', kind: 'image', name: 'p.png', mime: 'image/png', dataUrl: 'data:image/png;base64,QUJD' })).image).toEqual({ mime: 'image/png', data: 'QUJD' });
    expect((await resolveAttachment({ id: '7', kind: 'file', name: 'dir/', mime: 'application/x-directory', path: dir })).text).toContain('a.txt');
    expect((await resolveAttachment({ id: '8', kind: 'file', name: 'gone.txt', mime: 'text/plain', path: path.join(dir, 'gone.txt') })).note).toMatch(/could not read gone.txt/);
  });

  it('truncates very large text files', async () => {
    const big = path.join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(300 * 1024));
    const r = await resolveAttachment({ id: '1', kind: 'file', name: 'big.txt', mime: 'text/plain', path: big });
    expect(r.text!.length).toBeLessThan(270 * 1024);
    expect(r.text).toMatch(/truncated, \d+ more bytes/);
  });

  it('renders attachment blocks for the prompt', async () => {
    const text = attachmentsAsText([{ attachment: { id: '1', kind: 'file', name: 'a.ts', mime: 'text/plain' }, text: 'code' }, { attachment: { id: '2', kind: 'file', name: 'b.bin', mime: 'text/plain' }, note: '(binary file b.bin was skipped)' }, { attachment: { id: '3', kind: 'image', name: 'c.png', mime: 'image/png' }, image: { mime: 'image/png', data: 'x' } }]);
    expect(text).toBe('<attachment name="a.ts">\ncode\n</attachment>\n\n(binary file b.bin was skipped)');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('LocalSessionStore', () => {
  it('persists sessions per engine and per workspace', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ochub-store-'));
    const a = new LocalSessionStore(dir, 'direct', '/workspace/a', 0);
    const info = { id: 'ses_1', engine: 'direct' as const, title: 'T', createdAt: 1, updatedAt: 2 };
    await a.put({ info, messages: [{ id: 'm', sessionId: 'ses_1', role: 'user', createdAt: 1, parts: [] }], meta: { wire: [1] } });
    await a.put({ info: { ...info, id: 'ses_2', updatedAt: 9 }, messages: [], meta: {} });

    const reopened = new LocalSessionStore(dir, 'direct', '/workspace/a', 0);
    expect((await reopened.list()).map((s) => s.id)).toEqual(['ses_2', 'ses_1']);
    expect((await reopened.get('ses_1'))!.meta).toEqual({ wire: [1] });
    // Other workspaces and other engines do not see them.
    expect(await new LocalSessionStore(dir, 'direct', '/workspace/b', 0).list()).toEqual([]);
    expect(await new LocalSessionStore(dir, 'codex', '/workspace/a', 0).list()).toEqual([]);

    await reopened.delete('ses_1');
    expect((await new LocalSessionStore(dir, 'direct', '/workspace/a', 0).list()).map((s) => s.id)).toEqual(['ses_2']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('serialises concurrent writes of one session', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ochub-store-'));
    const store = new LocalSessionStore(dir, 'direct', '', 0);
    const session = { info: { id: 'ses_x', engine: 'direct' as const, title: 'v0', createdAt: 1, updatedAt: 1 }, messages: [], meta: {} };
    await store.put(session);
    const writes = [];
    for (let i = 1; i <= 20; i++) {
      session.info = { ...session.info, title: `v${i}` };
      writes.push(store.persist('ses_x'));
    }
    await Promise.all(writes);
    expect((await new LocalSessionStore(dir, 'direct', '', 0).get('ses_x'))!.info.title).toBe('v20');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('process helpers', () => {
  it('quotes arguments for cmd.exe only when needed', () => {
    expect(quoteWindowsArg('serve')).toBe('serve');
    expect(quoteWindowsArg('--port')).toBe('--port');
    expect(quoteWindowsArg('C:\\Program Files\\nodejs\\opencode.cmd')).toBe('"C:\\Program Files\\nodejs\\opencode.cmd"');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('a&b')).toBe('"a&b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });

  it('finds executables by explicit path and on PATH, and reports missing ones', async () => {
    expect(await findExecutable('node', process.execPath)).toBe(process.execPath);
    expect(await findExecutable('node', '/definitely/not/here')).toBeUndefined();
    expect(await findExecutable('node', '', { PATH: path.dirname(process.execPath), PATHEXT: '.EXE;.CMD' })).toBeTruthy();
    expect(await findExecutable('surely-not-a-real-binary-name', '', { PATH: path.dirname(process.execPath) })).toBeUndefined();
  });

  it('looks where macOS and Linux installers put CLIs when the editor was started without the shell PATH', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'ochub-home-'));
    const mac = await wellKnownDirs(home, {}, 'darwin');
    expect(mac).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, 'Library', 'pnpm')]));
    const linux = await wellKnownDirs(home, {}, 'linux');
    expect(linux).toEqual(expect.arrayContaining(['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', path.join(home, '.asdf', 'shims'), path.join(home, '.bun', 'bin')]));
    expect(linux).not.toContain('/opt/homebrew/bin');
    const win = await wellKnownDirs(home, { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') }, 'win32');
    expect(win).toEqual(expect.arrayContaining([path.join(home, 'Roaming', 'npm'), path.join(home, 'Local', 'pnpm'), path.join(home, 'scoop', 'shims')]));
    expect(win).not.toContain('/usr/local/bin');

    // nvm keeps one folder per Node version; the newest one wins.
    for (const v of ['v18.20.4', 'v22.11.0', 'v9.0.0']) mkdirSync(path.join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
    const nvm = (await wellKnownDirs(home, {}, 'linux')).filter((d) => d.includes('.nvm'));
    expect(nvm.map((d) => path.basename(path.dirname(d)))).toEqual(['v22.11.0', 'v18.20.4', 'v9.0.0']);
    const custom = path.join(home, 'custom-nvm');
    mkdirSync(path.join(custom, 'versions', 'node', 'v20.1.0', 'bin'), { recursive: true });
    expect(await wellKnownDirs(home, { NVM_DIR: custom }, 'linux')).toContain(path.join(custom, 'versions', 'node', 'v20.1.0', 'bin'));

    if (process.platform !== 'win32') {
      const cli = path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin', 'ochub-fake-cli');
      writeFileSync(cli, '#!/bin/sh\necho ok\n');
      chmodSync(cli, 0o755);
      // Found even though PATH has nothing useful, as in an editor launched from the Dock.
      expect(await findExecutable('ochub-fake-cli', '', { PATH: '/usr/bin:/bin' }, home)).toBe(cli);
      // A file that is not executable is not a CLI.
      const plain = path.join(home, '.local', 'bin', 'ochub-not-exec');
      mkdirSync(path.dirname(plain), { recursive: true });
      writeFileSync(plain, 'text');
      chmodSync(plain, 0o644);
      expect(await findExecutable('ochub-not-exec', '', { PATH: '/usr/bin' }, home)).toBeUndefined();
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('puts the folder of a found CLI on PATH so its "#!/usr/bin/env node" shim can start', () => {
    const exe = path.join(path.sep, 'home', 'u', '.nvm', 'versions', 'node', 'v22.11.0', 'bin', 'claude');
    const dir = path.dirname(exe);
    expect(envWithExeDir(exe, { PATH: '/usr/bin:/bin' }, 'linux').PATH).toBe(`${dir}:/usr/bin:/bin`);
    expect(envWithExeDir(exe, {}, 'linux').PATH).toBe(dir);
    const already = { PATH: `/usr/bin:${dir}` };
    expect(envWithExeDir(exe, already, 'linux')).toBe(already);
    // A bare command name is resolved by the system; nothing to add.
    const bare = { PATH: '/usr/bin' };
    expect(envWithExeDir('claude', bare, 'linux')).toBe(bare);
    // Windows spells the variable "Path" and separates with semicolons.
    const win = envWithExeDir(exe, { Path: 'C:\\Windows' }, 'win32');
    expect(win.Path).toBe(`${dir};C:\\Windows`);
    expect(win.PATH).toBeUndefined();
  });

  it('uses the plain command in a terminal only when the terminal can find it', () => {
    expect(terminalCommand('claude', undefined, { PATH: '/usr/bin' }, 'linux')).toBe('claude');
    expect(terminalCommand('claude', '/usr/local/bin/claude', { PATH: '/usr/bin:/usr/local/bin/' }, 'linux')).toBe('claude');
    expect(terminalCommand('claude', '/home/u/.claude/local/claude', { PATH: '/usr/bin:/usr/local/bin' }, 'linux')).toBe('/home/u/.claude/local/claude');
  });

  it('captures output, exit codes and spawn failures', async () => {
    const ok = await runCapture(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(ok).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
    const echo = await runCapture(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' });
    expect(echo.stdout).toBe('piped');
    const missing = await runCapture('/definitely/not/here', []);
    expect(missing.code).not.toBe(0);
    const slow = await runCapture(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(slow.code).not.toBe(0);
  });
});

describe('ids', () => {
  it('are unique, prefixed and sortable by creation time', () => {
    const ids = Array.from({ length: 2000 }, () => newId('msg'));
    expect(new Set(ids).size).toBe(2000);
    expect(ids.every((id) => /^msg_[0-9a-z]+$/.test(id))).toBe(true);
  });
});

describe('folder-scoped state', () => {
  it('remembers per folder in global storage, reads old workspace values, and clears with undefined', async () => {
    const { folderScopedState } = await import('../../src/core/usageLedger');
    const mk = () => {
      const m = new Map<string, unknown>();
      return { m, get: <T,>(k: string) => m.get(k) as T | undefined, update: (k: string, v: unknown) => void m.set(k, v) };
    };
    const global = mk();
    const old = mk();
    old.m.set('engine', 'codex');
    const where: { folder?: string } = {};
    const state = folderScopedState(global, old, () => where.folder);
    expect(state.get('engine')).toBe('codex');
    state.update('engine', 'claude-code');
    expect(state.get('engine')).toBe('claude-code');
    expect(global.m.get('folder:(no folder):engine')).toBe('claude-code');
    where.folder = '/work/a';
    state.update('session.direct', 'ses_1');
    expect(state.get('session.direct')).toBe('ses_1');
    state.update('session.direct', undefined);
    expect(state.get('session.direct')).toBeUndefined();
  });
});

describe('list prices', () => {
  it('knows the price list of a provider only by its API host', () => {
    expect(catalogProviderFor('https://api.openai.com/v1')).toBe('openai');
    expect(catalogProviderFor('https://api.anthropic.com')).toBe('anthropic');
    expect(catalogProviderFor('https://router.huggingface.co/v1')).toBe('huggingface');
    expect(catalogProviderFor('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('google');
    // A local or self-hosted endpoint has no list price, whatever it is called.
    expect(catalogProviderFor('http://localhost:11434/v1')).toBeUndefined();
    expect(catalogProviderFor('http://gpu-box:8000/v1')).toBeUndefined();
    expect(catalogProviderFor('not a url')).toBeUndefined();
  });

  it('finds a model despite date stamps, case and routing suffixes, and never guesses', () => {
    const gpt = listPrice('openai', 'gpt-5-mini')!;
    expect(gpt.input).toBeGreaterThan(0);
    expect(gpt.output).toBeGreaterThan(gpt.input);
    expect(listPrice('openai', 'GPT-5-mini')).toEqual(gpt);
    expect(listPrice('openai', 'gpt-5-mini-2025-08-07')).toEqual(gpt);
    expect(listPrice('anthropic', 'claude-haiku-4-5-latest')).toEqual(listPrice('anthropic', 'claude-haiku-4-5'));
    expect(listPrice('anthropic', 'claude-haiku-4-5')!.cacheRead).toBeGreaterThan(0);
    expect(listPrice('huggingface', 'deepseek-ai/DeepSeek-V3:fastest')).toEqual(listPrice('huggingface', 'deepseek-ai/DeepSeek-V3'));
    expect(listPrice('openai', 'my-private-finetune')).toBeUndefined();
    expect(listPrice(undefined, 'gpt-5-mini')).toBeUndefined();
    expect(listPrice('nobody', 'gpt-5-mini')).toBeUndefined();
    // One million tokens in and out cost exactly the two list prices.
    expect(estimateCost({ input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, gpt)).toBeCloseTo(gpt.input + gpt.output, 6);
  });
});

describe('session digest', () => {
  const msg = (id: string, role: 'user' | 'assistant', text: string, extra: ChatMessage['parts'] = []): ChatMessage => ({ id, sessionId: 's', role, createdAt: 1, parts: [{ id: `${id}p`, type: 'text', text }, ...extra] });

  it('keeps what was asked and answered, names the tools, and drops tool output and reasoning', () => {
    const d = sessionDigest('Fix the login bug', 'Claude Code', [
      msg('m1', 'user', 'The login form loses the password', [{ id: 'f', type: 'file', filename: 'src/login.ts', mime: 'text/plain' }]),
      msg('m2', 'assistant', 'The handler cleared the field on blur. Fixed in login.ts.', [
        { id: 'r', type: 'reasoning', text: 'SECRET CHAIN OF THOUGHT' },
        { id: 't', type: 'tool', tool: 'edit', callId: 'c', status: 'completed', title: 'src/login.ts', output: 'HUGE TOOL OUTPUT' },
        { id: 't2', type: 'tool', tool: 'bash', callId: 'c2', status: 'error', title: 'npm test', error: 'boom' },
      ]),
      msg('local_msg_1', 'assistant', '**Commands** /help output'),
    ]);
    expect(d.text).toContain('Context from an earlier chat session: "Fix the login bug" (Claude Code)');
    expect(d.text).toContain('### User\nThe login form loses the password\n(attached: src/login.ts)');
    expect(d.text).toContain('The handler cleared the field on blur.');
    expect(d.text).toContain('Tools used: edit (src/login.ts); bash (npm test) [failed]');
    expect(d.text).not.toContain('HUGE TOOL OUTPUT');
    expect(d.text).not.toContain('SECRET CHAIN');
    expect(d.text).not.toContain('/help output');
    expect(d).toMatchObject({ included: 2, total: 2 });
    expect(sessionDigest('Empty', 'opencode', [])).toMatchObject({ included: 0, total: 0 });
  });

  it('keeps the first request and the latest exchanges when a session is long', () => {
    const long: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) long.push(msg(`u${i}`, 'user', `question ${i} ${'x'.repeat(900)}`), msg(`a${i}`, 'assistant', `answer ${i} ${'y'.repeat(1500)}`));
    const d = sessionDigest('Long one', 'opencode', long, 12_000);
    expect(d.text.length).toBeLessThan(14_500);
    expect(d.text).toContain('question 0 ');
    expect(d.text).toContain('answer 39 ');
    expect(d.text).not.toContain('question 20 ');
    expect(d.text).toMatch(/\(… \d+ earlier messages left out …\)/);
    expect(d.included).toBeLessThan(d.total);
    expect(d.total).toBe(80);
  });
});
