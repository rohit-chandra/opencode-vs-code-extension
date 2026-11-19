import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { toFilePart } from '../../src/engines/opencode/engine';
import { mapCommand, mapMcp, mapMessage, mapPart, mapPermission, mapProvider, mapSession, mapUsage } from '../../src/engines/opencode/mapping';

// Shapes below are copied from a real opencode 1.19 server.
describe('opencode mapping', () => {
  it('maps sessions and hides placeholder titles', () => {
    expect(mapSession({ id: 'ses_1', title: 'New session - 2026-11-19T02:11:06.184Z', time: { created: 5, updated: 9 } })).toEqual({ id: 'ses_1', engine: 'opencode', title: 'New session', createdAt: 5, updatedAt: 9, parentId: undefined, shareUrl: undefined });
    expect(mapSession({ id: 'ses_2', title: 'Fix auth', parentID: 'ses_1', share: { url: 'https://opncd.ai/s/x' }, time: { created: 1 } })).toMatchObject({ title: 'Fix auth', parentId: 'ses_1', shareUrl: 'https://opncd.ai/s/x', updatedAt: 1 });
  });

  it('maps an assistant message with usage, model and parts', () => {
    const m = mapMessage(
      { id: 'msg_a', sessionID: 'ses_1', role: 'assistant', modelID: 'mock-small', providerID: 'mock', agent: 'build', cost: 0.01, tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 20, write: 0 } }, time: { created: 1, completed: 2 } },
      [
        { id: 'p0', sessionID: 'ses_1', messageID: 'msg_a', type: 'step-start' },
        { id: 'p1', sessionID: 'ses_1', messageID: 'msg_a', type: 'reasoning', text: 'hmm' },
        { id: 'p2', sessionID: 'ses_1', messageID: 'msg_a', type: 'text', text: 'hi' },
        { id: 'p3', sessionID: 'ses_1', messageID: 'msg_a', type: 'step-finish' },
      ],
    );
    expect(m).toMatchObject({ id: 'msg_a', role: 'assistant', model: { providerId: 'mock', modelId: 'mock-small' }, agent: 'build', completedAt: 2, usage: { input: 100, output: 25, reasoning: 5, cacheRead: 20, cacheWrite: 0, cost: 0.01 } });
    expect(m.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
  });

  it('reads the model of user messages and gives them no usage', () => {
    const m = mapMessage({ id: 'msg_u', sessionID: 's', role: 'user', model: { providerID: 'p', modelID: 'm' }, tokens: { input: 5 } });
    expect(m.model).toEqual({ providerId: 'p', modelId: 'm' });
    expect(m.usage).toBeUndefined();
  });

  it('surfaces errors but not user aborts', () => {
    expect(mapMessage({ id: 'm', sessionID: 's', role: 'assistant', error: { name: 'APIError', data: { message: 'rate limited' } } }).error).toBe('rate limited');
    expect(mapMessage({ id: 'm', sessionID: 's', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }).error).toBeUndefined();
  });

  it('maps tool states, files, retries and hides synthetic text', () => {
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', title: 'echo hi', input: { command: 'echo hi' }, output: 'hi\n' } })).toEqual({ id: 'p', type: 'tool', tool: 'bash', callId: 'c1', status: 'completed', title: 'echo hi', input: { command: 'echo hi' }, output: 'hi\n', error: undefined });
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'tool', tool: 'x', state: { status: 'error', error: 'denied' } })).toMatchObject({ status: 'error', error: 'denied', callId: 'p' });
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'tool', tool: 'x', state: {} })).toMatchObject({ status: 'pending' });
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'text', text: 'file contents', synthetic: true })).toBeUndefined();
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'file', mime: 'text/plain', url: 'file:///w/My%20File.ts' })).toMatchObject({ type: 'file', filename: 'My File.ts', url: 'file:///w/My%20File.ts' });
    // data: URLs are not kept in the view model (they can be megabytes).
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AAAA' })).toMatchObject({ filename: 'a.png', url: undefined });
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'retry', attempt: 2, error: { data: { message: 'overloaded' } } })).toMatchObject({ type: 'notice', level: 'warn', text: 'Retrying (attempt 2): overloaded' });
    expect(mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'patch' })).toBeUndefined();
  });

  it('clips very large tool output', () => {
    const part = mapPart({ id: 'p', sessionID: 's', messageID: 'm', type: 'tool', tool: 'read', state: { status: 'completed', output: 'x'.repeat(50_000) } });
    expect((part as { output: string }).output.length).toBeLessThan(21_000);
    expect((part as { output: string }).output).toMatch(/30000 more characters/);
  });

  it('treats all-zero token counters as "no usage yet"', () => {
    expect(mapUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0)).toBeUndefined();
    expect(mapUsage(undefined, 1)).toBeUndefined();
  });

  it('maps providers in both the current and the pre-1.x model shape', () => {
    const p = mapProvider(
      {
        id: 'acme',
        name: 'Acme',
        models: {
          b: { id: 'b', name: 'Beta', limit: { context: 200000 }, cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }, capabilities: { reasoning: true, toolcall: true, input: { image: true } } },
          a: { id: 'a', attachment: true, tool_call: true, reasoning: false, limit: { context: 0 }, cost: { input: 0, output: 0 } },
          old: { id: 'old', status: 'deprecated' },
        },
      },
      true,
    );
    expect(p.models.map((m) => m.modelId)).toEqual(['a', 'b']);
    expect(p.models[1]).toMatchObject({ name: 'Beta', contextWindow: 200000, supportsImages: true, supportsTools: true, supportsReasoning: true, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    expect(p.models[0]).toMatchObject({ name: 'a', supportsImages: true, supportsTools: true, contextWindow: undefined, pricing: undefined });
  });

  it('maps MCP status, commands and permission requests', () => {
    expect(mapMcp({ b: { status: 'failed', error: 'spawn ENOENT' }, a: { status: 'connected' }, c: { status: 'disabled' }, d: { status: 'needs_client_registration' }, e: { status: 'something-new' } }).map((m) => [m.name, m.status, m.enabled])).toEqual([
      ['a', 'connected', true],
      ['b', 'failed', true],
      ['c', 'disabled', false],
      ['d', 'needs_auth', true],
      ['e', 'failed', true],
    ]);
    expect(mapCommand({ name: 'greet', description: 'Greet someone', source: 'command', hints: ['$ARGUMENTS'] })).toEqual({ name: 'greet', description: 'Greet someone', source: 'engine', argumentHint: '[arguments]' });
    expect(mapCommand({ name: 'pdf', source: 'skill', hints: [] })).toMatchObject({ source: 'skill', argumentHint: undefined });
    expect(mapPermission({ id: 'per_1', sessionID: 's', permission: 'bash', patterns: ['echo hi'], metadata: { command: 'echo hi' }, tool: { callID: 'c1' } })).toEqual({ id: 'per_1', sessionId: 's', kind: 'bash', title: 'Allow bash: echo hi?', detail: 'echo hi', callId: 'c1' });
    expect(mapPermission({ id: 'per_2', sessionID: 's', permission: 'edit', patterns: ['a.ts', 'b.ts'], metadata: {} })).toMatchObject({ title: 'Allow edit?', detail: 'a.ts\nb.ts' });
  });
});

describe('toFilePart', () => {
  const file = process.platform === 'win32' ? 'C:\\work\\src\\a b.ts' : '/work/src/a b.ts';
  it('references workspace files by file:// URL with an optional line range', () => {
    expect(toFilePart({ id: '1', kind: 'file', name: 'src/a b.ts', mime: 'text/x-typescript', path: file })).toEqual({ type: 'file', mime: 'text/plain', filename: 'src/a b.ts', url: pathToFileURL(file).toString() });
    const ranged = toFilePart({ id: '2', kind: 'selection', name: 'src/a b.ts:3-9', mime: 'text/plain', path: file, text: 'x', range: { startLine: 3, endLine: 9 } });
    expect(ranged.url).toBe(`${pathToFileURL(file).toString()}?start=3&end=9`);
  });

  it('sends images and unsaved text inline', () => {
    expect(toFilePart({ id: '3', kind: 'image', name: 'p.png', mime: 'image/png', path: file, dataUrl: 'data:image/png;base64,AAAA' }).url).toBe('data:image/png;base64,AAAA');
    const inline = toFilePart({ id: '4', kind: 'selection', name: 'Untitled-1:1-2', mime: 'text/plain', text: 'héllo' });
    expect(inline.url).toBe(`data:text/plain;base64,${Buffer.from('héllo').toString('base64')}`);
    expect(toFilePart({ id: '5', kind: 'file', name: 'src/', mime: 'application/x-directory', path: file }).mime).toBe('application/x-directory');
  });
});
