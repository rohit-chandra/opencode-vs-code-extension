import type { TokenUsage } from '../../src/shared/types';

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function money(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

/*
 * How token counts are shown everywhere in the chat.
 *
 * A model call reads the whole conversation again. Providers keep what they have already
 * seen in a prompt cache and charge a small fraction for reading it back, so a reply that
 * took ten tool calls "reads" its context ten times without costing ten times as much.
 * Adding those reads to the tokens a reply really used makes one question look like
 * hundreds of thousands of tokens, so they are counted apart:
 *
 *  - in:     input the model processed at full price (new text, and text stored in the cache)
 *  - cached: input read back from the cache
 *  - out:    what the model wrote, thinking included
 */
export const tokensIn = (u: TokenUsage): number => u.input + u.cacheWrite;
export const tokensCached = (u: TokenUsage): number => u.cacheRead;
export const tokensOut = (u: TokenUsage): number => u.output + u.reasoning;
/** Tokens used, without what was only read back from the cache. */
export const tokensAll = (u: TokenUsage): number => tokensIn(u) + tokensOut(u);


/** The long form of one reply's or one session's usage, for tooltips. */
export function usageDetail(u: TokenUsage): string {
  const n = (x: number) => x.toLocaleString();
  return [
    `${n(u.input)} new input tokens`,
    u.cacheWrite > 0 ? `${n(u.cacheWrite)} stored in the prompt cache` : '',
    u.cacheRead > 0 ? `${n(u.cacheRead)} read back from the prompt cache (context the model had already seen, charged at a fraction of the price)` : '',
    `${n(u.output)} output tokens`,
    u.reasoning > 0 ? `${n(u.reasoning)} thinking tokens` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Tokens in the model's context after a reply, when that can be told: the engine said so, or
 * the reply was a single model call. A reply of several calls without that figure has the
 * context counted once per call in its usage, which says nothing about its size.
 */
export function contextAfter(m: { contextTokens?: number; calls?: number; usage?: TokenUsage }, engine: string): number | undefined {
  if (m.contextTokens) return m.contextTokens;
  if (!m.usage || engine === 'claude-code' || engine === 'codex') return undefined;
  return m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output + m.usage.reasoning;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
