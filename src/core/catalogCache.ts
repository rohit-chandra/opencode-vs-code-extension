import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentInfo, EngineId, ModelRef, ProviderInfo, SlashCommand } from '../shared/types';

/** What an engine listed the last time it was asked: its models, agents and commands. */
export interface CatalogSnapshot {
  at: number;
  providers: ProviderInfo[];
  agents: AgentInfo[];
  commands: SlashCommand[];
  /** The model that was selected then (the saved choice, or the engine's default). */
  model?: ModelRef;
}

const VERSION = 1;
/** An older copy is not shown: after this long the account or the catalogue has probably moved on. */
const MAX_AGE_MS = 30 * 24 * 3600_000;
/** Copies of workspaces that have not been opened for this long are removed. */
const PRUNE_AFTER_MS = 90 * 24 * 3600_000;

/**
 * Listing an engine's models takes from a few hundred milliseconds to several seconds: a CLI
 * has to start and ask the account, opencode's server has to boot, a BYOK endpoint has to
 * answer. The list itself rarely changes, so the last one is kept (in memory, and on disk per
 * engine and workspace folder) and shown at once while the fresh one is fetched.
 *
 * Only what the model picker shows is stored: names and capabilities, never keys or tokens.
 * Nothing here asks an engine anything, so no engine is contacted before the user picks it.
 */
export class CatalogCache {
  private memory = new Map<string, CatalogSnapshot>();
  private writes = new Map<string, Promise<void>>();
  private pruned = false;

  /** `dir` is where the copies live; without one the cache only lasts as long as the window. */
  constructor(private readonly dir: string | undefined, private readonly log?: { debug(message: string): void }) {}

  private key(engine: EngineId, folder: string | undefined): string {
    return `${engine}-${createHash('sha1').update(folder ?? '').digest('hex').slice(0, 16)}`;
  }

  private file(key: string): string {
    return path.join(this.dir!, `${key}.json`);
  }

  async get(engine: EngineId, folder: string | undefined, now = Date.now()): Promise<CatalogSnapshot | undefined> {
    const key = this.key(engine, folder);
    let snapshot = this.memory.get(key);
    if (!snapshot && this.dir) {
      // A write still under way holds what is being saved, so wait for it rather than read half a file.
      await this.writes.get(key)?.catch(() => undefined);
      snapshot = this.memory.get(key) ?? (await this.read(key));
      if (snapshot) this.memory.set(key, snapshot);
    }
    return snapshot && now - snapshot.at <= MAX_AGE_MS ? snapshot : undefined;
  }

  private async read(key: string): Promise<CatalogSnapshot | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(key), 'utf8')) as { v?: number; snapshot?: CatalogSnapshot };
      const s = raw.snapshot;
      if (raw.v !== VERSION || !s || typeof s.at !== 'number' || !Array.isArray(s.providers) || !Array.isArray(s.agents) || !Array.isArray(s.commands)) return undefined;
      if (!s.providers.every((p) => p && typeof p.id === 'string' && Array.isArray(p.models))) return undefined;
      return s;
    } catch {
      // No copy yet, or one that cannot be read: the engine is simply asked, as before.
      return undefined;
    }
  }

  /** Keep a list. Returns once it is in memory; the file is written in the background. */
  set(engine: EngineId, folder: string | undefined, snapshot: CatalogSnapshot): void {
    const key = this.key(engine, folder);
    this.memory.set(key, snapshot);
    if (!this.dir) return;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.write(key, snapshot))
      .catch((err) => this.log?.debug(`Could not save the model list for ${engine}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.writes.get(key) === next) this.writes.delete(key);
      });
    this.writes.set(key, next);
  }

  private async write(key: string, snapshot: CatalogSnapshot): Promise<void> {
    // A newer list may have arrived while this one waited its turn.
    if (this.memory.get(key) !== snapshot) return;
    await fs.mkdir(this.dir!, { recursive: true });
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: VERSION, snapshot }), 'utf8');
    await fs.rename(tmp, file);
    if (!this.pruned) {
      this.pruned = true;
      await this.prune().catch(() => undefined);
    }
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    for (const name of await fs.readdir(this.dir!)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const file = path.join(this.dir!, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && now - stat.mtimeMs > PRUNE_AFTER_MS) await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Wait for pending writes (tests, and shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()].map((w) => w.catch(() => undefined)));
  }
}
