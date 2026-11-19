import { describe, expect, it } from 'vitest';
import { dropOldestTurns, estimateTokens, isContextOverflow, startForBudget, turnStarts } from '../../src/engines/direct/context';
import type { WireMessage } from '../../src/engines/direct/wire';

const user = (text: string): WireMessage => ({ role: 'user', blocks: [{ type: 'text', text }] });
const reply = (text: string): WireMessage => ({ role: 'assistant', blocks: [{ type: 'text', text }] });
const call = (id: string): WireMessage => ({ role: 'assistant', blocks: [{ type: 'tool_call', id, name: 'read', args: '{"path":"a"}' }] });
const result = (id: string, text: string): WireMessage => ({ role: 'user', blocks: [{ type: 'tool_result', id, name: 'read', text }] });

describe('Direct BYOK context window', () => {
  it('recognises the "too long" errors of the common providers, and nothing else', () => {
    for (const message of [
      "Chat request failed (400): This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
      'Chat request failed (400): prompt is too long: 208310 tokens > 200000 maximum.',
      'Chat request failed (400): input length and `max_tokens` exceed context limit: 199000 + 8192 > 200000.',
      'Chat request failed (400): The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      'Chat request failed (400): the request exceeds the available context size, try increasing it.',
      "Chat request failed (400): This endpoint's maximum context length is 131072 tokens.",
      'Chat request failed (400): Please reduce the length of the messages or completion.',
      'Chat request failed (413): Request too large for model.',
      'Chat request failed (400): Prompt contains 40000 tokens, too large for model with 32768 maximum context length.',
      'context_length_exceeded',
    ]) expect(isContextOverflow(new Error(message)), message).toBe(true);
    for (const message of ['Chat request failed (401): Incorrect API key provided.', 'Chat request failed (429): Rate limit reached for requests.', 'Chat request failed (404): The model `x` does not exist.', 'Chat request failed (500): mock failure.', 'fetch failed']) expect(isContextOverflow(new Error(message)), message).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });

  it('estimates size from text, tool traffic and images', () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([user('x'.repeat(400))])).toBe(104);
    const withImage = estimateTokens([{ role: 'user', blocks: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'A'.repeat(50_000) }] }]);
    expect(withImage).toBeGreaterThan(1000);
    expect(withImage).toBeLessThan(1100);
    expect(estimateTokens([call('c1'), result('c1', 'y'.repeat(800))])).toBeGreaterThan(200);
  });

  it('starts turns at what the user said, never at tool results', () => {
    const wire = [user('a'), call('c1'), result('c1', 'r'), reply('b'), user('c'), reply('d')];
    expect(turnStarts(wire)).toEqual([0, 4]);
  });

  it('cuts at a turn boundary so tool calls keep their results', () => {
    const big = 'w'.repeat(2000); // about 500 tokens
    const wire = [user(`one ${big}`), reply(big), user(`two ${big}`), call('c1'), result('c1', big), reply('done'), user('three'), reply('ok'), user('four')];
    expect(startForBudget(wire, 100_000)).toBe(0);
    expect(startForBudget(wire, 1200)).toBe(2);
    expect(startForBudget(wire, 100)).toBe(6);
    // Nothing fits: still send the newest turn whole rather than nothing.
    expect(startForBudget(wire, 1)).toBe(8);
    expect(startForBudget(wire, 100_000, 6)).toBe(6);

    const first = dropOldestTurns(wire, 0);
    expect(first).toBeGreaterThan(0);
    expect(turnStarts(wire)).toContain(first);
    // Keeps dropping whole turns until only the newest one is left, then stops.
    let at = first;
    for (let i = 0; i < 10; i++) at = dropOldestTurns(wire, at);
    expect(at).toBe(8);
    expect(dropOldestTurns(wire, 8)).toBe(8);
    expect(dropOldestTurns([user('only')], 0)).toBe(0);
  });
});
