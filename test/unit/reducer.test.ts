import { describe, expect, it } from 'vitest';
import { applyMessageEvent, messageText } from '../../src/shared/reducer';
import type { ChatMessage, EngineEvent } from '../../src/shared/types';

const msg = (id: string, createdAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, sessionId: 's', role: 'assistant', createdAt, parts: [], ...extra });
const run = (events: EngineEvent[], start: ChatMessage[] = []) => events.reduce((m, e) => applyMessageEvent(m, e, 's'), start);

describe('applyMessageEvent', () => {
  it('builds a streamed message from header, part and deltas', () => {
    const out = run([
      { type: 'message.updated', message: msg('m1', 1) },
      { type: 'part.updated', sessionId: 's', messageId: 'm1', part: { id: 'p1', type: 'text', text: 'Hel' } },
      { type: 'part.delta', sessionId: 's', messageId: 'm1', partId: 'p1', delta: 'lo' },
      { type: 'part.updated', sessionId: 's', messageId: 'm1', part: { id: 't1', type: 'tool', tool: 'bash', callId: 'c', status: 'running' } },
      { type: 'part.updated', sessionId: 's', messageId: 'm1', part: { id: 't1', type: 'tool', tool: 'bash', callId: 'c', status: 'completed', output: 'ok' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([
      { id: 'p1', type: 'text', text: 'Hello' },
      { id: 't1', type: 'tool', tool: 'bash', callId: 'c', status: 'completed', output: 'ok' },
    ]);
    expect(messageText(out[0])).toBe('Hello');
  });

  it('keeps parts when only the message info changes', () => {
    const start = [msg('m1', 1, { parts: [{ id: 'p', type: 'text', text: 'kept' }] })];
    const usage = { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const out = applyMessageEvent(start, { type: 'message.updated', infoOnly: true, message: msg('m1', 1, { completedAt: 5, usage }) }, 's');
    expect(out[0].parts).toEqual([{ id: 'p', type: 'text', text: 'kept' }]);
    expect(out[0].usage).toEqual(usage);
    // Without infoOnly the message is replaced wholesale.
    expect(applyMessageEvent(start, { type: 'message.updated', message: msg('m1', 1) }, 's')[0].parts).toEqual([]);
  });

  it('creates a placeholder when a part arrives before its message, then completes it', () => {
    const out = run([
      { type: 'part.delta', sessionId: 's', messageId: 'm9', partId: 'p', delta: 'early' },
      { type: 'message.updated', infoOnly: true, message: msg('m9', 3, { role: 'assistant', agent: 'build' }) },
    ]);
    expect(out[0]).toMatchObject({ id: 'm9', agent: 'build', parts: [{ id: 'p', type: 'text', text: 'early' }] });
  });

  it('inserts messages in creation order and removes messages and parts', () => {
    let out = run([
      { type: 'message.updated', message: msg('b', 20) },
      { type: 'message.updated', message: msg('a', 10) },
      { type: 'message.updated', message: msg('c', 30, { parts: [{ id: 'x', type: 'text', text: '1' }, { id: 'y', type: 'text', text: '2' }] }) },
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    out = run(
      [
        { type: 'part.removed', sessionId: 's', messageId: 'c', partId: 'x' },
        { type: 'message.removed', sessionId: 's', messageId: 'a' },
      ],
      out,
    );
    expect(out.map((m) => m.id)).toEqual(['b', 'c']);
    expect(out[1].parts.map((p) => p.id)).toEqual(['y']);
  });

  it('ignores other sessions and returns the same array when nothing changed', () => {
    const start = [msg('m1', 1)];
    expect(applyMessageEvent(start, { type: 'part.delta', sessionId: 'other', messageId: 'm1', partId: 'p', delta: 'x' }, 's')).toBe(start);
    expect(applyMessageEvent(start, { type: 'message.removed', sessionId: 's', messageId: 'nope' }, 's')).toBe(start);
    expect(applyMessageEvent(start, { type: 'mcp.changed' }, 's')).toBe(start);
    // A delta for a tool part is not text and must not corrupt it.
    const withTool = [msg('m1', 1, { parts: [{ id: 't', type: 'tool', tool: 'x', callId: 'c', status: 'running' }] })];
    expect(applyMessageEvent(withTool, { type: 'part.delta', sessionId: 's', messageId: 'm1', partId: 't', delta: 'x' }, 's')).toBe(withTool);
  });

  it('does not mutate its input', () => {
    const start = [msg('m1', 1, { parts: [{ id: 'p', type: 'text', text: 'a' }] })];
    const frozen = JSON.stringify(start);
    applyMessageEvent(start, { type: 'part.delta', sessionId: 's', messageId: 'm1', partId: 'p', delta: 'b' }, 's');
    expect(JSON.stringify(start)).toBe(frozen);
  });
});
