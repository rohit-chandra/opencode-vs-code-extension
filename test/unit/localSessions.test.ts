import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fs, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalSessionStore } from '../../src/core/localSessions';
import type { StoredSession } from '../../src/core/localSessions';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ochub-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const session = (id: string, updatedAt = Date.now(), text = 'hello'): StoredSession => ({
  info: { id, engine: 'claude-code', title: `Session ${id}`, createdAt: updatedAt, updatedAt },
  messages: [{ id: `m_${id}`, sessionId: id, role: 'user', createdAt: updatedAt, parts: [{ id: `p_${id}`, type: 'text', text }] }],
  meta: { claudeSessionId: `cli_${id}` },
});

describe('local session store', () => {
  it('keeps sessions across restarts, per workspace', async () => {
    const dir = tmp();
    const a = new LocalSessionStore(dir, 'claude-code', '/work/a');
    await a.put(session('s1'));
    await a.put(session('s2'));
    await new LocalSessionStore(dir, 'claude-code', '/work/b').put(session('s3'));

    // A fresh store, as after VS Code restarts.
    const again = new LocalSessionStore(dir, 'claude-code', '/work/a');
    expect((await again.list()).map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(await again.get('s1')).toMatchObject({ meta: { claudeSessionId: 'cli_s1' }, messages: [{ id: 'm_s1' }] });
    expect(await again.get('s3')).toBeUndefined();
  });

  it('lists from a small index and loads conversations only when opened, keeping a few in memory', async () => {
    const dir = tmp();
    const store = new LocalSessionStore(dir, 'claude-code', '');
    for (let i = 0; i < 30; i++) await store.put(session(`s${i}`, Date.now() - i * 1000, 'x'.repeat(10_000)));

    const fresh = new LocalSessionStore(dir, 'claude-code', '');
    expect(await fresh.list()).toHaveLength(30);
    expect(fresh.loadedCount).toBe(0);
    for (let i = 0; i < 30; i++) expect((await fresh.get(`s${i}`))?.messages).toHaveLength(1);
    expect(fresh.loadedCount).toBeLessThanOrEqual(8);
    const index = await fs.readFile(path.join(dir, 'sessions', 'claude-code', 'index.json'), 'utf8');
    expect(index.length).toBeLessThan(30 * 400);
    expect(index).not.toContain('xxxxxxxx');
  });

  it('never drops a session that a running turn is writing to', async () => {
    const store = new LocalSessionStore(tmp(), 'claude-code', '');
    await store.put(session('busy'));
    const busy = (await store.get('busy'))!;
    store.pin('busy');
    for (let i = 0; i < 20; i++) await store.put(session(`s${i}`));
    busy.messages.push({ id: 'late', sessionId: 'busy', role: 'assistant', createdAt: Date.now(), parts: [] });
    await store.persist('busy');
    store.unpin('busy');
    const fresh = new LocalSessionStore(store['storageDir'] as string, 'claude-code', '');
    expect((await fresh.get('busy'))?.messages.map((m) => m.id)).toEqual(['m_busy', 'late']);
  });

  it('deletes sessions unused for longer than keepDays (30 by default), and keeps all with 0', async () => {
    const dir = tmp();
    const day = 86_400_000;
    const writer = new LocalSessionStore(dir, 'codex', '', 0);
    await writer.put(session('new', Date.now() - 2 * day));
    await writer.put(session('old', Date.now() - 31 * day));
    expect((await new LocalSessionStore(dir, 'codex', '', 0).list()).map((s) => s.id).sort()).toEqual(['new', 'old']);
    expect((await new LocalSessionStore(dir, 'codex', '').list()).map((s) => s.id)).toEqual(['new']);
    await expect(fs.stat(path.join(dir, 'sessions', 'codex', 'old.json'))).rejects.toThrow();
  });

  it('reads sessions saved by older versions (no index yet)', async () => {
    const dir = tmp();
    const folder = path.join(dir, 'sessions', 'direct');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'legacy.json'), JSON.stringify({ scope: '', ...session('legacy') }));
    const store = new LocalSessionStore(dir, 'direct', '');
    expect((await store.list()).map((s) => s.id)).toEqual(['legacy']);
    expect((await store.get('legacy'))?.messages).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('writes files only the user can read', async () => {
    const dir = tmp();
    const store = new LocalSessionStore(dir, 'claude-code', '');
    await store.put(session('private'));
    expect(statSync(path.join(dir, 'sessions', 'claude-code', 'private.json')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, 'sessions', 'claude-code', 'index.json')).mode & 0o077).toBe(0);
  });
});
