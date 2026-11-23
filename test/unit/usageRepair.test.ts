import { describe, expect, it } from 'vitest';
import { codexTotals, codexTurnUsage, continues, repairClaudeCosts, repairCodexUsage } from '../../src/engines/cli/usageRepair';
import type { ChatMessage, TokenUsage } from '../../src/shared/types';

const usage = (u: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...u });
const reply = (id: string, u: Partial<TokenUsage> | undefined): ChatMessage => ({ id, sessionId: 's', role: 'assistant', createdAt: 0, parts: [], usage: u ? usage(u) : undefined });
const user = (id: string): ChatMessage => ({ id, sessionId: 's', role: 'user', createdAt: 0, parts: [] });

// What `codex exec resume` printed for three turns that each used the same tokens (codex-cli 0.171):
// the thread's running total, every time.
const T1 = { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 4 };
const T2 = { input_tokens: 240, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 8 };
const T3 = { input_tokens: 360, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 90, reasoning_output_tokens: 12 };
const ONE_TURN = { input: 100, output: 26, reasoning: 4, cacheRead: 20, cacheWrite: 0, cost: 0 };

describe('Codex usage per turn', () => {
  it('gives each turn of a resumed thread only what it used', () => {
    expect(codexTurnUsage(codexTotals(T1), undefined)).toEqual(ONE_TURN);
    expect(codexTurnUsage(codexTotals(T2), codexTotals(T1))).toEqual(ONE_TURN);
    expect(codexTurnUsage(codexTotals(T3), codexTotals(T2))).toEqual(ONE_TURN);
  });

  it('takes the totals as they are when the thread started again from zero', () => {
    expect(continues(codexTotals(T1), codexTotals(T3))).toBe(false);
    expect(codexTurnUsage(codexTotals(T1), codexTotals(T3))).toEqual(ONE_TURN);
  });

  it('puts right a session that was saved with running totals', () => {
    // As earlier versions stored them: each reply holds everything up to that point, cost included.
    const messages = [
      user('u1'),
      reply('a1', { ...ONE_TURN, cost: 0.01 }),
      user('u2'),
      reply('a2', { input: 200, output: 52, reasoning: 8, cacheRead: 40, cost: 0.02 }),
      user('u3'),
      reply('a3', { input: 300, output: 78, reasoning: 12, cacheRead: 60, cost: 0.03 }),
      user('u4'),
      // The reply being written has no usage yet.
      reply('a4', undefined),
    ];
    const reached = repairCodexUsage(messages);
    expect(reached).toEqual(codexTotals(T3));
    for (const id of ['a1', 'a2', 'a3']) {
      const m = messages.find((x) => x.id === id)!;
      expect({ ...m.usage!, cost: Math.round(m.usage!.cost * 1000) / 1000 }, id).toEqual({ ...ONE_TURN, cost: 0.01 });
    }
    expect(messages.at(-1)!.usage).toBeUndefined();
    // The next turn continues from what the thread had reached.
    expect(codexTurnUsage({ input: 480, cached: 80, cacheWrite: 0, output: 120, reasoning: 16 }, reached)).toEqual(ONE_TURN);
  });

  it('leaves a reply alone when the thread behind it was a new one', () => {
    const messages = [reply('a1', { input: 300, output: 78, reasoning: 12, cacheRead: 60, cost: 0.03 }), reply('a2', { ...ONE_TURN, cost: 0.01 })];
    repairCodexUsage(messages);
    expect(messages[1].usage).toEqual({ ...ONE_TURN, cost: 0.01 });
  });

  it('has nothing to do in a session without usage', () => {
    expect(repairCodexUsage([user('u1'), reply('a1', undefined)])).toBeUndefined();
  });
});

describe('Claude Code cost per turn', () => {
  it('turns a conversation\'s running cost into the cost of each reply', () => {
    // total_cost_usd of three turns of one resumed conversation (Claude Code 2.1.330).
    const messages = [user('u1'), reply('a1', { input: 200, output: 60, cost: 0.002008 }), user('u2'), reply('a2', { input: 100, output: 30, cost: 0.003012 }), reply('a3', { input: 100, output: 30, cost: 0.004016 })];
    expect(repairClaudeCosts(messages)).toBeCloseTo(0.004016, 9);
    expect(messages.filter((m) => m.usage).map((m) => Math.round(m.usage!.cost * 1e6) / 1e6)).toEqual([0.002008, 0.001004, 0.001004]);
    // The tokens were the turn's own all along.
    expect(messages[3].usage).toMatchObject({ input: 100, output: 30 });
  });

  it('keeps a cost that went down: that conversation was started again', () => {
    const messages = [reply('a1', { cost: 0.5 }), reply('a2', { cost: 0.1 }), reply('a3', { cost: 0.15 })];
    expect(repairClaudeCosts(messages)).toBe(0.15);
    expect(messages.map((m) => Math.round(m.usage!.cost * 100) / 100)).toEqual([0.5, 0.1, 0.05]);
  });
});
