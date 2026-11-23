import type { ChatMessage, TokenUsage } from '../../shared/types';

/**
 * Claude Code and Codex count some of what they report for the whole conversation, not for
 * the turn that just ended:
 *
 *  - Codex (`codex exec resume`): every token counter of `turn.completed` is the thread's
 *    running total, so the third reply reports the tokens of all three.
 *  - Claude Code (`claude --resume`): the tokens are the turn's, but `total_cost_usd` is the
 *    conversation's cost so far.
 *
 * Verified against codex-cli 0.171 and Claude Code 2.1.330 with a model server that bills
 * every call the same. The engines subtract what the conversation had reached before a turn;
 * the functions here do the same for replies that were saved before they did, so sessions
 * from earlier versions show each reply's own share and the usage totals come out right.
 */

/** Codex's own counters: input includes the cached tokens, output includes the reasoning tokens. */
export interface CodexTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

const KEYS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning'] as const;

export function codexTotals(u: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }): CodexTotals {
  return { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0 };
}

/** `now` continues `before` when no counter went down (a new thread starts again from zero). */
export function continues(now: CodexTotals, before: CodexTotals | undefined): before is CodexTotals {
  return !!before && KEYS.every((k) => now[k] >= before[k]);
}

/** What one turn used: the thread's totals now, less what they were before the turn. */
export function codexTurnUsage(now: CodexTotals, before: CodexTotals | undefined): TokenUsage {
  const t = continues(now, before) ? (Object.fromEntries(KEYS.map((k) => [k, now[k] - before[k]])) as unknown as CodexTotals) : now;
  return {
    input: Math.max(0, t.input - t.cached - t.cacheWrite),
    output: Math.max(0, t.output - t.reasoning),
    reasoning: t.reasoning,
    cacheRead: t.cached,
    cacheWrite: t.cacheWrite,
    cost: 0,
  };
}

/** The counters a saved reply was built from (the inverse of `codexTurnUsage` for a first turn). */
function totalsOf(u: TokenUsage): CodexTotals {
  return { input: u.input + u.cacheRead + u.cacheWrite, cached: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output + u.reasoning, reasoning: u.reasoning };
}

/**
 * Rewrite the replies of a Codex session saved with running totals so that each holds its
 * own turn. Returns the thread's totals after the last reply (to continue from), or
 * undefined when the session has no usage at all. Costs are estimates from list prices and
 * so proportional to the tokens: they are reduced the same way.
 */
export function repairCodexUsage(messages: ChatMessage[]): CodexTotals | undefined {
  let before: CodexTotals | undefined;
  let costBefore = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    const now = totalsOf(m.usage);
    const cost = m.usage.cost;
    const same = continues(now, before);
    m.usage = { ...codexTurnUsage(now, before), cost: same && cost >= costBefore ? cost - costBefore : cost };
    before = now;
    costBefore = cost;
  }
  return before;
}

/**
 * Rewrite the replies of a Claude Code session saved with the conversation's running cost so
 * that each holds its own. Returns the conversation's cost after the last reply.
 */
export function repairClaudeCosts(messages: ChatMessage[]): number {
  let before = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    const total = m.usage.cost;
    // A cost that went down belongs to a conversation that was started again: it stands as it is.
    if (before > 0 && total >= before) m.usage = { ...m.usage, cost: total - before };
    before = total;
  }
  return before;
}
