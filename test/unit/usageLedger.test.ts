import { describe, expect, it } from 'vitest';
import { UsageLedger, dayKey, estimateCost } from '../../src/core/usageLedger';
import type { TokenUsage } from '../../src/shared/types';
import { MemoryStore } from '../helpers/context';

const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage => ({ input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...extra });
const model = { providerId: 'openai', modelId: 'gpt-x' };

describe('UsageLedger', () => {
  it('aggregates per model, per session and per day', () => {
    const now = new Date('2026-03-04T10:00:00').getTime();
    const ledger = new UsageLedger(new MemoryStore(), () => now);
    ledger.record({ engine: 'direct', sessionId: 's1', messageId: 'm1', model, usage: usage(100, 20, { cost: 0.01 }), sessionTitle: 'First' });
    ledger.record({ engine: 'direct', sessionId: 's1', messageId: 'm2', model, usage: usage(50, 10, { cacheRead: 5 }) });
    ledger.record({ engine: 'opencode', sessionId: 's2', messageId: 'm3', model: { providerId: 'anthropic', modelId: 'claude' }, usage: usage(7, 3, { reasoning: 2 }) });

    const sum = ledger.summary();
    expect(sum.total).toEqual({ input: 157, output: 33, reasoning: 2, cacheRead: 5, cacheWrite: 0, cost: 0.01 });
    expect(sum.messages).toBe(3);
    expect(sum.byModel.map((r) => `${r.engine}/${r.providerId}/${r.modelId}:${r.messages}`)).toEqual(['direct/openai/gpt-x:2', 'opencode/anthropic/claude:1']);
    expect(sum.byDay).toEqual([{ day: dayKey(now), usage: sum.total }]);

    const s1 = ledger.sessionUsage('direct', 's1')!;
    expect(s1.title).toBe('First');
    expect(s1.usage.input).toBe(150);
    expect(s1.messages).toBe(2);
    expect(ledger.sessionUsage('direct', 'nope')).toBeUndefined();
  });

  it('is idempotent: re-recording a message only applies the difference', () => {
    const ledger = new UsageLedger(new MemoryStore());
    expect(ledger.record({ engine: 'opencode', sessionId: 's', messageId: 'm', model, usage: usage(10, 1) })).toBe(true);
    // Streaming update with larger counters for the same message.
    expect(ledger.record({ engine: 'opencode', sessionId: 's', messageId: 'm', model, usage: usage(10, 9) })).toBe(true);
    // History reload with identical numbers.
    expect(ledger.record({ engine: 'opencode', sessionId: 's', messageId: 'm', model, usage: usage(10, 9) })).toBe(false);
    const sum = ledger.summary();
    expect(sum.total.input).toBe(10);
    expect(sum.total.output).toBe(9);
    expect(sum.messages).toBe(1);
  });

  it('moves usage when a message is re-attributed to another model', () => {
    const ledger = new UsageLedger(new MemoryStore());
    ledger.record({ engine: 'claude-code', sessionId: 's', messageId: 'm', model: { providerId: 'claude-code', modelId: 'default' }, usage: usage(10, 5) });
    ledger.record({ engine: 'claude-code', sessionId: 's', messageId: 'm', model: { providerId: 'claude-code', modelId: 'claude-sonnet' }, usage: usage(10, 5) });
    const rows = ledger.summary().byModel.filter((r) => r.messages > 0 || r.usage.input > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelId).toBe('claude-sonnet');
    expect(ledger.summary().total.input).toBe(10);
  });

  it('persists and restores state', async () => {
    const store = new MemoryStore();
    const a = new UsageLedger(store);
    a.record({ engine: 'direct', sessionId: 's', messageId: 'm', model, usage: usage(42, 8) });
    await a.flush();
    const b = new UsageLedger(store);
    expect(b.summary().total.input).toBe(42);
    expect(b.record({ engine: 'direct', sessionId: 's', messageId: 'm', model, usage: usage(42, 8) })).toBe(false);
  });

  it('keeps totals when old sessions are pruned and ignores their history afterwards', () => {
    let t = 1_000;
    const ledger = new UsageLedger(new MemoryStore(), () => t);
    for (let i = 0; i < 405; i++) {
      t += 1000;
      ledger.record({ engine: 'direct', sessionId: `s${i}`, messageId: 'm', model, usage: usage(1, 1) });
    }
    const sum = ledger.summary(1000);
    expect(sum.total.input).toBe(405);
    expect(sum.sessions.length).toBe(400);
    expect(ledger.sessionUsage('direct', 's0')).toBeUndefined();
    // Re-opening a pruned session must not double count its messages.
    expect(ledger.record({ engine: 'direct', sessionId: 's0', messageId: 'm', model, usage: usage(1, 1) })).toBe(false);
    expect(ledger.summary().total.input).toBe(405);
  });

  it('reset clears everything and notifies listeners', async () => {
    const ledger = new UsageLedger(new MemoryStore());
    let calls = 0;
    ledger.onDidChange(() => calls++);
    ledger.record({ engine: 'direct', sessionId: 's', messageId: 'm', model, usage: usage(1, 1) });
    await ledger.reset();
    expect(ledger.summary().messages).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('estimateCost', () => {
  it('uses per-million prices and falls back to the input price for cache tokens', () => {
    const u = { input: 1_000_000, output: 500_000, reasoning: 500_000, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(estimateCost(u, { input: 2, output: 10 })).toBeCloseTo(2 + 10 + 2);
    expect(estimateCost(u, { input: 2, output: 10, cacheRead: 0.2 })).toBeCloseTo(2 + 10 + 0.2);
    expect(estimateCost(u, undefined)).toBe(0);
  });
});
