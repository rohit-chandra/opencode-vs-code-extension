import type { WireMessage } from './wire';

/**
 * Keeping a long Direct BYOK conversation inside the model's context window.
 *
 * The extension does not know every model's window, so by default it sends the whole
 * conversation and reacts when the provider says it no longer fits: the oldest turns are
 * left out and the request is sent again. `opencodeHub.direct.maxContextTokens` sets a
 * budget up front instead, which is useful for local servers that cut the prompt silently.
 */

/** Rough size of a transcript in tokens: about four characters per token, images counted flat. */
export function estimateTokens(messages: WireMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += 16; // role and message framing
    for (const b of m.blocks) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'image') images++;
      else if (b.type === 'tool_call') chars += b.name.length + b.args.length + 24;
      else chars += b.name.length + b.text.length + 24;
    }
  }
  return Math.ceil(chars / 4) + images * 1000;
}

/** Whether a provider's error says the request was larger than the model's context window. */
export function isContextOverflow(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return (
    /context[ _-]?(length|window|size|limit)|maximum context|context overflow|context_length_exceeded/i.test(text) ||
    /prompt is too long|too many (input )?tokens|input is too long|reduce the length|request too large|too large for model/i.test(text) ||
    /(token count|tokens?|input length).{0,80}exceeds?/i.test(text) ||
    /\(413\)/.test(text)
  );
}

/**
 * Indexes where a turn starts: a user message with something the user said. A user message
 * holding only tool results belongs to the turn before it and must never be separated from
 * the tool calls it answers.
 */
export function turnStarts(messages: WireMessage[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image')) out.push(i);
  });
  return out;
}

/**
 * First index to send so that the rest fits in `budget` tokens, never earlier than `from`
 * and never later than the start of the newest turn (which is always sent whole).
 */
export function startForBudget(messages: WireMessage[], budget: number, from = 0): number {
  const starts = turnStarts(messages).filter((i) => i >= from);
  if (starts.length === 0) return from;
  for (const i of starts) if (estimateTokens(messages.slice(i)) <= budget) return i;
  return starts[starts.length - 1];
}

/**
 * After the provider rejected `messages.slice(from)` as too long: where to start instead.
 * Drops about half of what was sent, in whole turns. Returns `from` when only the newest
 * turn is left, which means that turn alone does not fit.
 */
export function dropOldestTurns(messages: WireMessage[], from: number): number {
  const sent = estimateTokens(messages.slice(from));
  const next = startForBudget(messages, Math.floor(sent / 2), from);
  if (next > from) return next;
  // Halving found nothing smaller (one huge old turn): drop just that turn.
  return turnStarts(messages).find((i) => i > from) ?? from;
}
