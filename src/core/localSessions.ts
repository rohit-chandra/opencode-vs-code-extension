import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, EngineId, SessionInfo } from '../shared/types';

export interface StoredSession {
  info: SessionInfo;
  messages: ChatMessage[];
  /** Engine-private data, e.g. the Claude Code session id used for `--resume`. */
  meta: Record<string, unknown>;
}

/**
 * File-backed session storage for engines that have no session store of their own
 * (direct BYOK, VS Code LM) or whose transcripts we mirror (Claude Code, Codex).
 * One JSON file per session under `<storageDir>/sessions/<engine>/`.
 */
export class LocalSessionStore {
  private cache = new Map<string, StoredSession>();
  private writes = new Map<string, Promise<void>>();
  private loaded = false;

  constructor(private readonly storageDir: string, private readonly engine: EngineId, private readonly scope: string) {}

  private get dir(): string {
    return path.join(this.storageDir, 'sessions', this.engine);
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => {
          try {
            const s = JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8')) as StoredSession & { scope?: string };
            if (s?.info?.id && (s.scope ?? '') === this.scope) this.cache.set(s.info.id, { info: s.info, messages: s.messages ?? [], meta: s.meta ?? {} });
          } catch {
            /* ignore corrupt files */
          }
        }),
    );
  }

  async list(): Promise<SessionInfo[]> {
    await this.load();
    return [...this.cache.values()].map((s) => s.info).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    await this.load();
    return this.cache.get(id);
  }

  async put(session: StoredSession): Promise<void> {
    await this.load();
    this.cache.set(session.info.id, session);
    await this.persist(session.info.id);
  }

  /** Serialise writes per session so a slow disk cannot interleave two snapshots. */
  persist(id: string): Promise<void> {
    const session = this.cache.get(id);
    if (!session) return Promise.resolve();
    const prev = this.writes.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true });
        const tmp = this.file(id) + '.tmp';
        await fs.writeFile(tmp, JSON.stringify({ scope: this.scope, ...session }), 'utf8');
        await fs.rename(tmp, this.file(id));
      });
    this.writes.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.load();
    this.cache.delete(id);
    await (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined);
    await fs.rm(this.file(id), { force: true });
  }
}
