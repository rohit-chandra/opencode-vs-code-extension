import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { EngineContext } from '../../src/core/engine';
import { findExecutable } from '../../src/core/process';
import type { KeyValueStore } from '../../src/core/usageLedger';
import type { ChatMessage, EngineEvent } from '../../src/shared/types';
import type { Engine } from '../../src/core/engine';
import { applyMessageEvent } from '../../src/shared/reducer';

export interface TestContext extends EngineContext {
  settings: Record<string, unknown>;
  secretValues: Map<string, string>;
  logs: string[];
  dir: string;
  cleanup(): void;
}

export function makeContext(options: { cwd?: string; settings?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {}): TestContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ochub-test-'));
  const settings: Record<string, unknown> = { ...(options.settings ?? {}) };
  const secretValues = new Map<string, string>();
  const logs: string[] = [];
  const log = (level: string) => (m: string) => {
    logs.push(`${level} ${m}`);
    if (process.env.OCHUB_TEST_VERBOSE) console.log(`[${level}] ${m}`);
  };
  return {
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    cwd: () => options.cwd,
    config: <T>(key: string, fallback: T) => (key in settings ? (settings[key] as T) : fallback),
    secrets: {
      get: async (k) => secretValues.get(k),
      set: async (k, v) => void secretValues.set(k, v),
      delete: async (k) => void secretValues.delete(k),
    },
    storageDir: path.join(dir, 'storage'),
    env: options.env ?? { ...process.env },
    settings,
    secretValues,
    logs,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* best effort: it is a temp directory */
      }
    },
  };
}

export class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): void {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

/** Collect an engine's events and keep a reduced message list per session. */
export function record(engine: Engine): { events: EngineEvent[]; messages(sessionId: string): ChatMessage[]; waitFor<T extends EngineEvent['type']>(type: T, pred?: (e: Extract<EngineEvent, { type: T }>) => boolean, timeoutMs?: number): Promise<Extract<EngineEvent, { type: T }>>; waitIdle(sessionId: string, timeoutMs?: number): Promise<void> } {
  const events: EngineEvent[] = [];
  const bySession = new Map<string, ChatMessage[]>();
  const waiters: { check: (e: EngineEvent) => boolean; resolve: (e: EngineEvent) => void }[] = [];
  engine.onEvent((e) => {
    events.push(e);
    const sid = 'sessionId' in e ? e.sessionId : e.type === 'message.updated' ? e.message.sessionId : undefined;
    if (sid) bySession.set(sid, applyMessageEvent(bySession.get(sid) ?? [], e, sid));
    for (const w of [...waiters]) {
      if (w.check(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  const waitFor = <T extends EngineEvent['type']>(type: T, pred: (e: Extract<EngineEvent, { type: T }>) => boolean = () => true, timeoutMs = 60_000) =>
    new Promise<Extract<EngineEvent, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}. Events: ${events.map((e) => e.type).join(',').slice(-600)}`)), timeoutMs);
      waiters.push({
        check: (e) => e.type === type && pred(e as Extract<EngineEvent, { type: T }>),
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e as Extract<EngineEvent, { type: T }>);
        },
      });
    });
  return {
    events,
    messages: (sessionId) => bySession.get(sessionId) ?? [],
    waitFor,
    waitIdle: async (sessionId, timeoutMs) => {
      await waitFor('session.status', (e) => e.sessionId === sessionId && e.activity === 'idle', timeoutMs);
    },
  };
}

/**
 * Find a CLI for end-to-end tests: explicit env var first, then the same lookup the
 * extension uses (PATH with PATHEXT on Windows, well-known install locations).
 */
export async function findBin(name: string, envVar: string): Promise<string | undefined> {
  const explicit = process.env[envVar];
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const local = path.resolve('node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  if (existsSync(local)) return local;
  return findExecutable(name);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
