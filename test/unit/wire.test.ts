import { describe, expect, it } from 'vitest';
import { resolveProvider } from '../../src/engines/direct/presets';
import { joinUrl, normalizeOpenAiUsage, toAnthropicMessages, toOpenAiMessages } from '../../src/engines/direct/wire';
import type { WireMessage } from '../../src/engines/direct/wire';
import { exposedName } from '../../src/mcp/manager';

const transcript: WireMessage[] = [
  { role: 'user', blocks: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAAA' }] },
  { role: 'assistant', blocks: [{ type: 'text', text: 'calling' }, { type: 'tool_call', id: 'c1', name: 'srv__add', args: '{"a":1}' }] },
  { role: 'user', blocks: [{ type: 'tool_result', id: 'c1', name: 'srv__add', text: '2' }] },
  { role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
];

describe('toOpenAiMessages', () => {
  it('maps text, images, tool calls and tool results', () => {
    expect(toOpenAiMessages('sys', transcript)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'srv__add', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '2' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('uses a plain string for text-only user turns and null content for pure tool calls', () => {
    const out = toOpenAiMessages(undefined, [
      { role: 'user', blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'c', name: 't', args: '' }] },
    ]) as { role: string; content: unknown; tool_calls?: { function: { arguments: string } }[] }[];
    expect(out[0]).toEqual({ role: 'user', content: 'a\n\nb' });
    expect(out[1].content).toBeNull();
    expect(out[1].tool_calls![0].function.arguments).toBe('{}');
  });
});

describe('toAnthropicMessages', () => {
  it('maps blocks and puts tool results first in a user turn', () => {
    const out = toAnthropicMessages([...transcript.slice(0, 2), { role: 'user', blocks: [{ type: 'text', text: 'and also' }, { type: 'tool_result', id: 'c1', name: 'srv__add', text: 'boom', isError: true }] }]) as { role: string; content: { type: string }[] }[];
    expect(out[0].content).toEqual([{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    expect(out[1].content[1]).toEqual({ type: 'tool_use', id: 'c1', name: 'srv__add', input: { a: 1 } });
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }, { type: 'text', text: 'and also' }]);
  });

  it('merges consecutive turns of one role and survives malformed tool arguments', () => {
    const out = toAnthropicMessages([
      { role: 'user', blocks: [{ type: 'text', text: 'one' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'two' }] },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'c', name: 't', args: '{not json' }] },
      { role: 'assistant', blocks: [] },
    ]) as { role: string; content: { input?: unknown }[] }[];
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[0].content).toHaveLength(2);
    expect(out[1].content[0].input).toEqual({});
  });
});

describe('usage and URL helpers', () => {
  it('splits OpenAI usage into exclusive buckets', () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.002 })).toEqual({ input: 100, output: 25, reasoning: 5, cacheRead: 20, cacheWrite: 0, cost: 0.002 });
    expect(normalizeOpenAiUsage({})).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    // Never negative, even if a provider reports inconsistent numbers.
    expect(normalizeOpenAiUsage({ prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 9 } }).input).toBe(0);
  });

  it('joins URLs without doubling slashes', () => {
    expect(joinUrl('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUrl('http://localhost:11434/v1', 'models')).toBe('http://localhost:11434/v1/models');
  });

  it('exposes MCP tools under provider-safe names', () => {
    expect(exposedName('my server', 'do.thing')).toBe('my_server__do_thing');
    expect(exposedName('s', 'x'.repeat(100))).toHaveLength(64);
    expect(exposedName('git-hub', 'create_issue')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('resolveProvider', () => {
  it('fills presets and detects local endpoints that need no key', () => {
    expect(resolveProvider({ id: 'openai', type: 'openai-compatible' })).toMatchObject({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', keyless: false });
    expect(resolveProvider({ id: 'ollama', type: 'openai-compatible' })).toMatchObject({ baseUrl: 'http://localhost:11434/v1', keyless: true });
    expect(resolveProvider({ id: 'mine', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1' }).keyless).toBe(true);
    expect(resolveProvider({ id: 'mine', type: 'openai-compatible', baseUrl: 'https://llm.corp.example/v1' }).keyless).toBe(false);
    expect(resolveProvider({ id: 'x', type: 'anthropic' }).baseUrl).toBe('https://api.anthropic.com');
    // A user-supplied URL wins over the preset.
    expect(resolveProvider({ id: 'openai', type: 'openai-compatible', baseUrl: 'https://proxy.example/v1' }).baseUrl).toBe('https://proxy.example/v1');
  });
});
