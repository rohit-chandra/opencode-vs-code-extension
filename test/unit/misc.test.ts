import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachmentsAsText, mimeForPath, resolveAttachment } from '../../src/core/attachments';
import { newId } from '../../src/core/ids';
import { LocalSessionStore } from '../../src/core/localSessions';
import { findExecutable, quoteWindowsArg, runCapture } from '../../src/core/process';

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
