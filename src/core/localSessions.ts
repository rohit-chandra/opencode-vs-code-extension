import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, EngineId, SessionInfo } from '../shared/types';

export interface StoredSession {
  info: SessionInfo;
  messages: ChatMessage[];
  /** Engine-private data, e.g. the Claude Code session id used for `--resume`. */
  meta: Record<string, unknown>;
}

interface IndexEntry {
  info: SessionInfo;
  scope: string;
}

/** Conversations kept in memory at once. Others stay on disk until opened. */
const MAX_LOADED = 8;
/** Owner-only access on macOS and Linux (Windows ignores modes; the user's profile folder is already private). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Session storage on the user's own disk, for engines that have no session store of their
 * own (Direct BYOK, VS Code LM) or whose transcripts we mirror (Claude Code, Codex).
 *
 * Layout under `<storageDir>/sessions/<engine>/`: one JSON file per session plus
 * `index.json` with only the titles and dates. Listing reads the index; a conversation's
 * messages are read when it is opened, and only the few most recent stay in memory, so
 * memory use does not grow with the number of sessions kept.
 */
export class LocalSessionStore {
  /** Every session's info, by id (all scopes). */
  private index = new Map<string, IndexEntry>();
  /** Loaded conversations, oldest first (LRU). */
  private loadedSessions = new Map<string, StoredSession>();
  /** Sessions that must stay loaded (a turn is running). */
  private pinned = new Set<string>();
  private writes = new Map<string, Promise<void>>();
  private indexWrite: Promise<void> = Promise.resolve();
  private loading: Promise<void> | undefined;

  /**
   * @param keepDays Sessions not updated for this many days are deleted when the store is
   *   first read (once per VS Code session). 0 keeps everything. Default 30, like Claude Code.
   */
  constructor(private readonly storageDir: string, private readonly engine: EngineId, private readonly scope: string, private readonly keepDays = 30) {}

  private get dir(): string {
    return path.join(this.storageDir, 'sessions', this.engine);
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private load(): Promise<void> {
    this.loading ??= this.readIndex().then(() => this.prune());
    return this.loading;
  }

  /** Delete sessions older than `keepDays` (every workspace's, since they share the folder). */
  private async prune(): Promise<void> {
    if (!(this.keepDays > 0)) return;
    const cutoff = Date.now() - this.keepDays * 86_400_000;
    const old = [...this.index.values()].filter((e) => e.info.updatedAt < cutoff && !this.pinned.has(e.info.id) && !this.loadedSessions.has(e.info.id));
    if (!old.length) return;
    for (const e of old) {
      this.index.delete(e.info.id);
      await fs.rm(this.file(e.info.id), { force: true }).catch(() => undefined);
    }
    await this.writeIndex();
  }

  private async readIndex(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as { version?: number; sessions?: IndexEntry[] };
      for (const e of raw.sessions ?? []) if (e?.info?.id) this.index.set(e.info.id, { info: e.info, scope: e.scope ?? '' });
      return;
    } catch {
      /* no index yet: build it from the session files (sessions saved by older versions) */
    }
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith('.json') || n === 'index.json') continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8')) as StoredSession & { scope?: string };
        if (s?.info?.id) this.index.set(s.info.id, { info: s.info, scope: s.scope ?? '' });
      } catch {
        /* ignore corrupt files */
      }
    }
    if (this.index.size) await this.writeIndex();
  }

  private writeIndex(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, sessions: [...this.index.values()] });
    this.indexWrite = this.indexWrite
      .catch(() => undefined)
      .then(() => atomicWrite(this.dir, this.indexFile, snapshot));
    return this.indexWrite;
  }

  /** Sessions of this workspace, newest first. Reads only the index. */
  async list(): Promise<SessionInfo[]> {
    await this.load();
    return [...this.index.values()]
      .filter((e) => e.scope === this.scope)
      .map((e) => e.info)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    await this.load();
    const loaded = this.loadedSessions.get(id);
    if (loaded) {
      this.touch(id, loaded);
      return loaded;
    }
    const entry = this.index.get(id);
    if (!entry || entry.scope !== this.scope) return undefined;
    try {
      const s = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as StoredSession;
      // Another call may have loaded it while we were reading.
      const again = this.loadedSessions.get(id);
      if (again) return again;
      const session: StoredSession = { info: entry.info, messages: s.messages ?? [], meta: s.meta ?? {} };
      this.touch(id, session);
      return session;
    } catch {
      return undefined;
    }
  }

  async put(session: StoredSession): Promise<void> {
    await this.load();
    this.touch(session.info.id, session);
    await this.persist(session.info.id);
  }

  /** Keep a session in memory while a turn writes to it. */
  pin(id: string): void {
    this.pinned.add(id);
  }

  unpin(id: string): void {
    this.pinned.delete(id);
    this.evict();
  }

  private touch(id: string, session: StoredSession): void {
    this.loadedSessions.delete(id);
    this.loadedSessions.set(id, session);
    this.evict();
  }

  private evict(): void {
    for (const id of this.loadedSessions.keys()) {
      if (this.loadedSessions.size <= MAX_LOADED) break;
      if (this.pinned.has(id) || this.writes.has(id)) continue;
      this.loadedSessions.delete(id);
    }
  }

  /** Save a loaded session (serialised per session, so a slow disk cannot interleave two snapshots). */
  persist(id: string): Promise<void> {
    const session = this.loadedSessions.get(id);
    if (!session) return Promise.resolve();
    this.index.set(id, { info: session.info, scope: this.scope });
    const prev = this.writes.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        // Snapshot at write time, so the latest state is what lands on disk.
        await atomicWrite(this.dir, this.file(id), JSON.stringify({ scope: this.scope, ...session }));
        await this.writeIndex();
      })
      .finally(() => {
        if (this.writes.get(id) === next) {
          this.writes.delete(id);
          this.evict();
        }
      });
    this.writes.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.load();
    this.loadedSessions.delete(id);
    this.pinned.delete(id);
    await (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined);
    this.index.delete(id);
    await fs.rm(this.file(id), { force: true });
    await this.writeIndex();
  }

  /** Wait for every pending write (used when VS Code shuts down). */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()].map((w) => w.catch(() => undefined)));
    await this.indexWrite.catch(() => undefined);
  }

  /** How many conversations are in memory right now (for tests). */
  get loadedCount(): number {
    return this.loadedSessions.size;
  }
}

async function atomicWrite(dir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode: FILE_MODE });
  await fs.rename(tmp, file);
}

/**
 * Sessions an engine saved for a workspace, read from disk without starting the engine.
 * Used to show every engine's history in one list.
 */
export async function listStoredSessions(storageDir: string, engine: EngineId, scope: string): Promise<SessionInfo[]> {
  return new LocalSessionStore(storageDir, engine, scope).list();
}
