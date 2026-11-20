import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CatalogCache } from '../../src/core/catalogCache';
import type { CatalogSnapshot } from '../../src/core/catalogCache';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ochub-catalog-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const snapshot = (name: string, at = Date.now()): CatalogSnapshot => ({
  at,
  providers: [{ id: 'p', name: 'Provider', connected: true, models: [{ providerId: 'p', modelId: 'm', name, efforts: [{ id: 'low' }, { id: 'high' }] }] }],
  agents: [{ name: 'build' }],
  commands: [{ name: 'greet', description: 'Greet', source: 'engine' }],
  model: { providerId: 'p', modelId: 'm' },
});

describe('saved model lists', () => {
  it('gives back what was saved, in the same window and in the next one', async () => {
    const dir = tempDir();
    const first = new CatalogCache(dir);
    expect(await first.get('codex', '/work/app')).toBeUndefined();
    const saved = snapshot('Model One');
    first.set('codex', '/work/app', saved);
    // In memory straight away, before the file is written.
    expect(await first.get('codex', '/work/app')).toBe(saved);
    await first.flush();
    expect(await new CatalogCache(dir).get('codex', '/work/app')).toEqual(saved);
  });

  it('keeps engines and workspace folders apart', async () => {
    const dir = tempDir();
    const cache = new CatalogCache(dir);
    cache.set('codex', '/work/app', snapshot('Codex in app'));
    cache.set('claude-code', '/work/app', snapshot('Claude in app'));
    cache.set('codex', '/work/other', snapshot('Codex in other'));
    cache.set('codex', undefined, snapshot('Codex without a folder'));
    await cache.flush();
    const next = new CatalogCache(dir);
    const name = async (engine: 'codex' | 'claude-code' | 'opencode', folder: string | undefined) => (await next.get(engine, folder))?.providers[0].models[0].name;
    expect(await name('codex', '/work/app')).toBe('Codex in app');
    expect(await name('claude-code', '/work/app')).toBe('Claude in app');
    expect(await name('codex', '/work/other')).toBe('Codex in other');
    expect(await name('codex', undefined)).toBe('Codex without a folder');
    expect(await name('opencode', '/work/app')).toBeUndefined();
    // Folder paths are not readable from the file names.
    expect(readdirSync(dir).every((f) => /^[a-z-]+-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
  });

  it('the last list written wins, also when several arrive quickly', async () => {
    const dir = tempDir();
    const cache = new CatalogCache(dir);
    for (const n of ['one', 'two', 'three']) cache.set('direct', '/w', snapshot(n));
    await cache.flush();
    expect((await new CatalogCache(dir).get('direct', '/w'))!.providers[0].models[0].name).toBe('three');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('ignores a list that is too old, damaged or from another format', async () => {
    const dir = tempDir();
    const cache = new CatalogCache(dir);
    cache.set('codex', '/w', snapshot('old', Date.now() - 40 * 24 * 3600_000));
    cache.set('direct', '/w', snapshot('good'));
    cache.set('opencode', '/w', snapshot('other format'));
    cache.set('claude-code', '/w', snapshot('damaged'));
    await cache.flush();
    const fileOf = (text: string) => path.join(dir, readdirSync(dir).find((f) => readFileSync(path.join(dir, f), 'utf8').includes(text))!);
    writeFileSync(fileOf('other format'), readFileSync(fileOf('other format'), 'utf8').replace('"v":1', '"v":99'));
    writeFileSync(fileOf('damaged'), '{"v":1,"snapshot":{"at":');
    const next = new CatalogCache(dir);
    expect(await next.get('codex', '/w')).toBeUndefined();
    expect(await next.get('opencode', '/w')).toBeUndefined();
    expect(await next.get('claude-code', '/w')).toBeUndefined();
    expect(await cache.get('codex', '/w')).toBeUndefined();
    expect((await next.get('direct', '/w'))!.providers[0].models[0].name).toBe('good');
  });

  it('removes lists of workspaces that have not been opened for months', async () => {
    const dir = tempDir();
    const cache = new CatalogCache(dir);
    cache.set('codex', '/long-gone', snapshot('stale'));
    await cache.flush();
    const [stale] = readdirSync(dir);
    const longAgo = new Date(Date.now() - 120 * 24 * 3600_000);
    utimesSync(path.join(dir, stale), longAgo, longAgo);
    // Pruning happens on the first save of a window.
    const next = new CatalogCache(dir);
    next.set('codex', '/current', snapshot('fresh'));
    await next.flush();
    expect(readdirSync(dir)).not.toContain(stale);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('works without a folder to save in: the list lasts as long as the window', async () => {
    const cache = new CatalogCache(undefined);
    cache.set('codex', '/w', snapshot('memory only'));
    await cache.flush();
    expect((await cache.get('codex', '/w'))!.providers[0].models[0].name).toBe('memory only');
  });
});
