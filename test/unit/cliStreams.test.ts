import { describe, expect, it } from 'vitest';
import { AssistantWriter } from '../../src/core/localEngine';
import { ClaudeStreamTranslator, toolTitle } from '../../src/engines/cli/claudeStream';
import { CodexStreamTranslator } from '../../src/engines/cli/codexStream';
import { promptForAgent } from '../../src/engines/cli/common';
import type { ChatMessage, EngineEvent } from '../../src/shared/types';

function writer() {
  const message: ChatMessage = { id: 'm', sessionId: 's', role: 'assistant', createdAt: 0, parts: [] };
  const events: EngineEvent[] = [];
  return { message, events, w: new AssistantWriter(message, (e) => events.push(e)) };
}
const se = (event: Record<string, unknown>, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });

// Event shapes below were captured from Claude Code 2.1.328 (`-p --output-format stream-json --verbose --include-partial-messages`).
describe('ClaudeStreamTranslator', () => {
  it('streams thinking and text from partial events without duplicating the final assistant messages', () => {
    const { message, events, w } = writer();
    const t = new ClaudeStreamTranslator(w);
    const feed = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5', slash_commands: ['review', 'compact'], mcp_servers: [{ name: 'github', status: 'connected' }], claude_code_version: '2.1.328' },
      { type: 'system', subtype: 'status', status: 'requesting' },
      se({ type: 'message_start', message: { id: 'msg_1' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }),
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5-5', content: [{ type: 'thinking', thinking: 'Let me think.' }] }, parent_tool_use_id: null },
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }),
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Hello world' }] }, parent_tool_use_id: null },
      se({ type: 'message_stop' }),
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello world', session_id: 'sess-1', total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 7 } },
    ];
    for (const ev of feed) t.handle(ev);

    expect(message.parts).toMatchObject([
      { type: 'reasoning', text: 'Let me think.' },
      { type: 'text', text: 'Hello world' },
    ]);
    expect(events.filter((e) => e.type === 'part.delta')).toHaveLength(2);
    expect(t.init).toMatchObject({ sessionId: 'sess-1', model: 'claude-sonnet-5-5', slashCommands: ['review', 'compact'], mcpServers: [{ name: 'github', status: 'connected' }], version: '2.1.328' });
    expect(w.usage).toEqual({ input: 100, output: 30, reasoning: 0, cacheRead: 20, cacheWrite: 7, cost: 0.0123 });
    expect(t.finished).toBe(true);
    expect(t.error).toBeUndefined();
  });

  it('uses complete assistant messages when partial events are not available', () => {
    const { message, w } = writer();
    const t = new ClaudeStreamTranslator(w);
    t.handle({ type: 'assistant', message: { id: 'msg_1', model: 'claude-x', content: [{ type: 'text', text: 'First.' }] }, parent_tool_use_id: null });
    t.handle({ type: 'assistant', message: { id: 'msg_2', model: 'claude-x', content: [{ type: 'text', text: 'Second.' }] }, parent_tool_use_id: null });
    t.handle({ type: 'result', subtype: 'success', result: 'Second.' });
    expect(message.parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual(['First.', 'Second.']);
  });

  it('shows tool calls with their results and ignores sub-agent chatter', () => {
    const { message, w } = writer();
    const t = new ClaudeStreamTranslator(w);
    t.handle({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] }, parent_tool_use_id: null });
    t.handle({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__gh__issue', input: { id: 4 } }] }, parent_tool_use_id: null });
    // Output from a sub-agent: its text is not shown, only the parent's Task tool is.
    t.handle(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub-agent text' } }, 'toolu_1'));
    t.handle({ type: 'assistant', message: { id: 'sub_1', model: 'claude-haiku', content: [{ type: 'text', text: 'sub-agent text' }] }, parent_tool_use_id: 'toolu_1' });
    t.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '12 passed' }] }] } });
    t.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'not found', is_error: true }, { type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] } });
    expect(message.parts).toMatchObject([
      { type: 'tool', tool: 'Bash', callId: 'toolu_1', status: 'completed', title: 'npm test', input: { command: 'npm test' }, output: '12 passed' },
      { type: 'tool', tool: 'mcp__gh__issue', callId: 'toolu_2', status: 'error', error: 'not found' },
    ]);
    expect(t.init.model).toBeUndefined();
  });

  it('reports failed runs and prints result-only output of local commands', () => {
    const failed = writer();
    const t1 = new ClaudeStreamTranslator(failed.w);
    t1.handle({ type: 'result', subtype: 'error_max_turns', is_error: true });
    expect(t1.error).toMatch(/maximum number of turns/);
    const t2 = new ClaudeStreamTranslator(writer().w);
    t2.handle({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    expect(t2.error).toBe('Invalid API key · Please run /login');

    const local = writer();
    const t3 = new ClaudeStreamTranslator(local.w);
    t3.handle({ type: 'result', subtype: 'success', is_error: false, result: 'Total cost: $0.42' });
    expect(local.message.parts).toMatchObject([{ type: 'text', text: 'Total cost: $0.42' }]);
  });

  it('summarises tool input for card titles', () => {
    expect(toolTitle('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(toolTitle('Bash', { command: 'echo a\n  && echo b' })).toBe('echo a && echo b');
    expect(toolTitle('X', { command: 'y'.repeat(300) })).toHaveLength(120);
    expect(toolTitle('X', { n: 1 })).toBeUndefined();
    expect(toolTitle('X', undefined)).toBeUndefined();
  });
});

// Event shapes captured from codex-cli 0.170 (`codex exec --json`).
describe('CodexStreamTranslator', () => {
  it('maps messages, reasoning, commands, patches, MCP calls and usage', () => {
    const { message, w } = writer();
    const t = new CodexStreamTranslator(w);
    const feed = [
      { type: 'thread.started', thread_id: '01a1f199-4ddb' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found.' } },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Check the tests first.' } },
      { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'npm test'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'npm test'", aggregated_output: '3 passed\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: 'nope', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }], status: 'completed' } },
      { type: 'item.started', item: { id: 'item_5', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', arguments: { id: 7 }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_5', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', arguments: { id: 7 }, result: { content: [{ type: 'text', text: 'Issue 7: flaky' }] }, error: null, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: 'All done.' } },
      { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 4 } },
    ];
    for (const ev of feed) t.handle(ev);

    expect(t.threadId).toBe('01a1f199-4ddb');
    expect(message.parts).toMatchObject([
      { type: 'notice', level: 'warn', text: 'Model metadata for `x` not found.' },
      { type: 'reasoning', text: 'Check the tests first.' },
      { type: 'tool', tool: 'shell', callId: 'item_2', status: 'completed', title: "bash -lc 'npm test'", output: '3 passed\n' },
      { type: 'tool', tool: 'shell', callId: 'item_3', status: 'error', error: 'nope\n(exit code 1)' },
      { type: 'tool', tool: 'edit', status: 'completed', title: 'src/a.ts, src/b.ts', output: 'update src/a.ts\nadd src/b.ts' },
      { type: 'tool', tool: 'github › get_issue', status: 'completed', input: { id: 7 }, output: 'Issue 7: flaky' },
      { type: 'text', text: 'All done.' },
    ]);
    // input includes cached tokens and output includes reasoning in Codex's report; buckets are exclusive here.
    expect(w.usage).toEqual({ input: 100, output: 26, reasoning: 4, cacheRead: 20, cacheWrite: 0, cost: 0 });
    expect(t.finished).toBe(true);
  });

  it('reports failed turns and stream errors', () => {
    const t = new CodexStreamTranslator(writer().w);
    t.handle({ type: 'error', message: 'stream disconnected' });
    expect(t.error).toBe('stream disconnected');
    expect(t.finished).toBe(false);
    t.handle({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
    expect(t.error).toMatch(/401/);
    expect(t.finished).toBe(true);
  });
});

describe('AssistantWriter', () => {
  it('starts a new text part after a tool call and closes dangling tools on abort', () => {
    const { message, events, w } = writer();
    w.text('before');
    w.tool('c1', { tool: 'bash', status: 'running' });
    w.text('after');
    w.text(' more');
    w.finishOpenTools('Stopped');
    expect(message.parts).toMatchObject([
      { type: 'text', text: 'before' },
      { type: 'tool', status: 'error', error: 'Stopped' },
      { type: 'text', text: 'after more' },
    ]);
    expect(events.map((e) => e.type)).toEqual(['part.updated', 'part.updated', 'part.updated', 'part.delta', 'part.updated']);
    expect(w.usageKnown).toBe(false);
    w.addUsage({ input: 3 });
    w.addUsage({ input: 4, output: 1 });
    expect(w.usage).toMatchObject({ input: 7, output: 1 });
    expect(w.usageKnown).toBe(true);
  });
});

describe('promptForAgent', () => {
  it('references files by path, inlines selections and separates images', () => {
    const out = promptForAgent({
      text: 'review this',
      attachments: [
        { id: '1', kind: 'file', name: 'src/a.ts', mime: 'text/plain', path: '/w/src/a.ts' },
        { id: '2', kind: 'selection', name: 'src/b.ts:4-9', mime: 'text/plain', path: '/w/src/b.ts', text: 'const x = 1;', range: { startLine: 4, endLine: 9 } },
        { id: '3', kind: 'file', name: 'pasted.txt', mime: 'text/plain', text: 'pasted body' },
        { id: '4', kind: 'image', name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
      ],
    });
    expect(out.images.map((a) => a.name)).toEqual(['shot.png']);
    expect(out.text).toBe(
      ['review this', 'Attached files (read them as needed):\n- /w/src/a.ts\n- /w/src/b.ts (lines 4-9)', '<selection file="src/b.ts:4-9">\nconst x = 1;\n</selection>', '<attachment name="pasted.txt">\npasted body\n</attachment>'].join('\n\n'),
    );
  });
});
