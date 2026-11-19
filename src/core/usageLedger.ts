import { addUsage, emptyUsage } from '../shared/types';
import type { EngineId, ModelRef, SessionUsage, TokenUsage, UsageRow, UsageSummary } from '../shared/types';

/** Subset of `vscode.Memento` the ledger needs. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

type Tuple = [input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number, cost: number];

interface SessionEntry {
  /** title */
  t: string;
  /** last update */
  at: number;
  /** messageId -> [modelKey, ...usage] */
  m: Record<string, [string, ...Tuple]>;
}

interface LedgerState {
  version: 1;
  since: number;
  /** `${engine}|${provider}|${model}` -> usage + message count */
  models: Record<string, { u: Tuple; n: number }>;
  /** yyyy-mm-dd -> usage */
  days: Record<string, Tuple>;
  /** `${engine}|${sessionId}` */
  sessions: Record<string, SessionEntry>;
  /** Keys of sessions dropped from `sessions`, so re-syncing their history does not double count. */
  pruned: string[];
}

const STORAGE_KEY = 'opencodeHub.usage.v1';
const MAX_SESSIONS = 400;
const MAX_PRUNED = 5000;
const MAX_DAYS = 120;

const toTuple = (u: TokenUsage): Tuple => [u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite, u.cost];
const fromTuple = (t: readonly number[]): TokenUsage => ({ input: t[0] ?? 0, output: t[1] ?? 0, reasoning: t[2] ?? 0, cacheRead: t[3] ?? 0, cacheWrite: t[4] ?? 0, cost: t[5] ?? 0 });
const isZero = (u: TokenUsage): boolean => !u.input && !u.output && !u.reasoning && !u.cacheRead && !u.cacheWrite && !u.cost;

export const modelKey = (engine: EngineId, model: ModelRef): string => `${engine}|${model.providerId}|${model.modelId}`;
export const sessionKey = (engine: EngineId, sessionId: string): string => `${engine}|${sessionId}`;

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseModelKey(key: string): { engine: EngineId; providerId: string; modelId: string } {
  const [engine, providerId, ...rest] = key.split('|');
  return { engine: engine as EngineId, providerId, modelId: rest.join('|') };
}

export interface UsageRecord {
  engine: EngineId;
  sessionId: string;
  messageId: string;
  model: ModelRef;
  usage: TokenUsage;
  /** Message time; defaults to now. */
  at?: number;
  sessionTitle?: string;
}

/**
 * Persistent token accounting.
 *
 * Usage is recorded per assistant message and is idempotent: recording the same message
 * again (history reload, repeated stream events with growing counters) only applies the
 * difference. Totals are kept per engine/provider/model, per day and per session.
 */
export class UsageLedger {
  private state: LedgerState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly store: KeyValueStore, private readonly now: () => number = Date.now) {
    const saved = store.get<LedgerState>(STORAGE_KEY);
    this.state = saved && saved.version === 1 ? saved : this.fresh();
    this.state.pruned ??= [];
  }

  private fresh(): LedgerState {
    return { version: 1, since: this.now(), models: {}, days: {}, sessions: {}, pruned: [] };
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** @returns true when the totals changed. */
  record(rec: UsageRecord): boolean {
    const sKey = sessionKey(rec.engine, rec.sessionId);
    if (this.state.pruned.includes(sKey)) return false;
    const mKey = modelKey(rec.engine, rec.model);
    const at = rec.at ?? this.now();
    let session = this.state.sessions[sKey];
    const prev = session?.m[rec.messageId];
    const prevUsage = prev ? fromTuple(prev.slice(1) as number[]) : emptyUsage();
    const delta = addUsage(rec.usage, prevUsage, -1);
    const modelChanged = prev !== undefined && prev[0] !== mKey;
    if (isZero(delta) && !modelChanged) {
      if (session && rec.sessionTitle && session.t !== rec.sessionTitle) {
        session.t = rec.sessionTitle;
        this.schedule();
      }
      return false;
    }
    if (!session) {
      session = this.state.sessions[sKey] = { t: rec.sessionTitle ?? '', at, m: {} };
    }
    if (rec.sessionTitle) session.t = rec.sessionTitle;
    session.at = Math.max(session.at, at);

    if (modelChanged && prev) {
      // The message was re-attributed to another model: move the old amount.
      this.bump(prev[0], prevUsage, -1, -1);
      this.bump(mKey, rec.usage, 1, 1);
    } else {
      this.bump(mKey, delta, 1, prev ? 0 : 1);
    }
    const day = dayKey(at);
    this.state.days[day] = toTuple(addUsage(fromTuple(this.state.days[day] ?? []), delta));
    session.m[rec.messageId] = [mKey, ...toTuple(rec.usage)];
    this.prune();
    this.schedule();
    return true;
  }

  private bump(mKey: string, usage: TokenUsage, sign: number, messages: number): void {
    const entry = (this.state.models[mKey] ??= { u: toTuple(emptyUsage()), n: 0 });
    entry.u = toTuple(addUsage(fromTuple(entry.u), usage, sign));
    entry.n = Math.max(0, entry.n + messages);
  }

  setSessionTitle(engine: EngineId, sessionId: string, title: string): void {
    const s = this.state.sessions[sessionKey(engine, sessionId)];
    if (s && s.t !== title) {
      s.t = title;
      this.schedule();
    }
  }

  private prune(): void {
    const keys = Object.keys(this.state.sessions);
    if (keys.length > MAX_SESSIONS) {
      keys.sort((a, b) => this.state.sessions[a].at - this.state.sessions[b].at);
      for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) {
        delete this.state.sessions[k];
        this.state.pruned.push(k);
      }
      if (this.state.pruned.length > MAX_PRUNED) this.state.pruned = this.state.pruned.slice(-MAX_PRUNED);
    }
    const days = Object.keys(this.state.days);
    if (days.length > MAX_DAYS) {
      days.sort();
      for (const d of days.slice(0, days.length - MAX_DAYS)) delete this.state.days[d];
    }
  }

  sessionUsage(engine: EngineId, sessionId: string): SessionUsage | undefined {
    const entry = this.state.sessions[sessionKey(engine, sessionId)];
    return entry ? this.toSessionUsage(sessionKey(engine, sessionId), entry) : undefined;
  }

  private toSessionUsage(key: string, entry: SessionEntry): SessionUsage {
    const sep = key.indexOf('|');
    const engine = key.slice(0, sep) as EngineId;
    const sessionId = key.slice(sep + 1);
    const rows = new Map<string, UsageRow>();
    let total = emptyUsage();
    let messages = 0;
    for (const [mKey, ...t] of Object.values(entry.m)) {
      const usage = fromTuple(t);
      total = addUsage(total, usage);
      messages++;
      const row = rows.get(mKey) ?? { ...parseModelKey(mKey), usage: emptyUsage(), messages: 0 };
      row.usage = addUsage(row.usage, usage);
      row.messages++;
      rows.set(mKey, row);
    }
    return { engine, sessionId, title: entry.t, updatedAt: entry.at, usage: total, messages, byModel: [...rows.values()] };
  }

  summary(maxSessions = 50): UsageSummary {
    let total = emptyUsage();
    let messages = 0;
    const byModel: UsageRow[] = Object.entries(this.state.models).map(([key, v]) => {
      const usage = fromTuple(v.u);
      total = addUsage(total, usage);
      messages += v.n;
      return { ...parseModelKey(key), usage, messages: v.n };
    });
    const weight = (r: UsageRow) => r.usage.input + r.usage.output + r.usage.reasoning + r.usage.cacheRead + r.usage.cacheWrite;
    byModel.sort((a, b) => weight(b) - weight(a));
    const byDay = Object.entries(this.state.days)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, t]) => ({ day, usage: fromTuple(t) }));
    const sessions = Object.entries(this.state.sessions)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, maxSessions)
      .map(([k, e]) => this.toSessionUsage(k, e));
    return { since: this.state.since, total, messages, byModel, byDay, sessions };
  }

  async reset(): Promise<void> {
    this.state = this.fresh();
    await this.flush();
    this.notify();
  }

  private schedule(): void {
    this.notify();
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.store.update(STORAGE_KEY, this.state);
  }
}

/** Estimate cost from per-million-token prices. */
export function estimateCost(usage: Omit<TokenUsage, 'cost'>, pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number {
  if (!pricing) return 0;
  const m = 1_000_000;
  return (
    (usage.input * pricing.input) / m +
    ((usage.output + usage.reasoning) * pricing.output) / m +
    (usage.cacheRead * (pricing.cacheRead ?? pricing.input)) / m +
    (usage.cacheWrite * (pricing.cacheWrite ?? pricing.input)) / m
  );
}
