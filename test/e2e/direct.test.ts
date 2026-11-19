import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import { DirectEngine } from '../../src/engines/direct/engine';
import { secretKeyFor } from '../../src/engines/direct/presets';
import { McpManager } from '../../src/mcp/manager';
import type { McpServerConfig } from '../../src/mcp/manager';
import { makeContext, record } from '../helpers/context';
import type { TestContext } from '../helpers/context';
// @ts-expect-error plain ESM fixture without types
import { createMockLlm } from '../fixtures/mock-llm.mjs';


describe('Direct BYOK engine (mock OpenAI-compatible + Anthropic servers)', () => {
  let mock: { listen(): Promise<number>; close(): Promise<void>; log: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] };
  let port: number;
  let ctx: TestContext;
  let mcp: McpManager;
  let engine: DirectEngine;

  beforeAll(async () => {
    mock = createMockLlm();
    port = await mock.listen();
    ctx = makeContext({
      cwd: process.cwd(),
      settings: {
        providers: [
          { id: 'mockoai', name: 'Mock OpenAI', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, pricing: { 'mock-small': { input: 1, output: 2 } } },
          { id: 'mockant', name: 'Mock Anthropic', type: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, models: ['claude-mock'] },
        ],
        // ${workspaceFolder} is expanded like in VS Code launch configs.
        'mcp.servers': { mockmcp: { command: process.execPath, args: ['${workspaceFolder}/test/fixtures/mock-mcp.mjs'] } } as Record<string, McpServerConfig>,
      },
    });
    await ctx.secrets.set(secretKeyFor('mockoai'), 'sk-openai-test');
    await ctx.secrets.set(secretKeyFor('mockant'), 'sk-ant-test');
    mcp = new McpManager({
      log: ctx.log,
      cwd: ctx.cwd,
      readConfig: () => ctx.settings['mcp.servers'] as Record<string, McpServerConfig>,
      writeEnabled: async (name, enabled) => {
        const servers = ctx.settings['mcp.servers'] as Record<string, McpServerConfig>;
        ctx.settings['mcp.servers'] = { ...servers, [name]: { ...servers[name], enabled } };
      },
    });
    engine = new DirectEngine(ctx, mcp);
    expect((await engine.start()).state).toBe('ready');
  });

  afterAll(async () => {
    await engine.dispose();
    await mcp.dispose();
    await mock.close();
    ctx.cleanup();
  });

  it('discovers models from /models and uses configured model lists', async () => {
    const providers = await engine.listProviders();
    expect(providers.map((p) => [p.id, p.connected, p.models.map((m) => m.modelId)])).toEqual([
      ['mockoai', true, ['mock-large', 'mock-small']],
      ['mockant', true, ['claude-mock']],
    ]);
  });

  it('streams an OpenAI-compatible reply with reasoning, usage and estimated cost', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'hello there [[think]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitIdle(session.id);

    const [user, assistant] = rec.messages(session.id);
    expect(user.role).toBe('user');
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    expect(assistant.parts[1]).toMatchObject({ type: 'text', text: 'MOCK[mock-small]: hello there' });
    expect(assistant.completedAt).toBeGreaterThan(0);
    // prompt 120 incl. 20 cached; completion 30 incl. 5 reasoning.
    expect(assistant.usage).toMatchObject({ input: 100, output: 25, reasoning: 5, cacheRead: 20, cacheWrite: 0 });
    expect(assistant.usage!.cost).toBeCloseTo((100 * 1 + 30 * 2 + 20 * 1) / 1_000_000, 10);
    expect(rec.events.filter((e) => e.type === 'part.delta').length).toBeGreaterThan(2);
    const usageEvent = rec.events.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({ sessionId: session.id, messageId: assistant.id, model: { providerId: 'mockoai', modelId: 'mock-small' } });

    const req = mock.log.filter((l) => l.path === '/chat/completions').pop()!;
    expect(req.headers.authorization).toBe('Bearer sk-openai-test');
    expect((req.body.messages as { role: string }[])[0].role).toBe('system');

    // Title comes from the first prompt and the session is persisted.
    const stored = (await engine.listSessions()).find((s) => s.id === session.id)!;
    expect(stored.title).toBe('hello there [[think]]');
    expect(await engine.getMessages(session.id)).toHaveLength(2);
  });

  it('keeps conversation history across turns', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'mockoai', modelId: 'mock-large' };
    await engine.sendPrompt(session.id, { text: 'first', attachments: [], model });
    await rec.waitIdle(session.id);
    await engine.sendPrompt(session.id, { text: 'second', attachments: [], model });
    await rec.waitIdle(session.id);
    const req = mock.log.filter((l) => l.path === '/chat/completions').pop()!;
    expect((req.body.messages as { role: string; content: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(rec.messages(session.id)).toHaveLength(4);
  });

  it('talks to an Anthropic-style endpoint with x-api-key and inlines attachments', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const file = path.join(ctx.dir, 'notes.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await engine.sendPrompt(session.id, {
      text: 'summarise',
      model: { providerId: 'mockant', modelId: 'claude-mock' },
      attachments: [
        { id: 'a1', kind: 'file', name: 'notes.txt', mime: 'text/plain', path: file },
        { id: 'a2', kind: 'selection', name: 'notes.txt:2-2', mime: 'text/plain', path: file, text: 'beta', range: { startLine: 2, endLine: 2 } },
        { id: 'a3', kind: 'image', name: 'pixel.png', mime: 'image/png', dataUrl: `data:image/png;base64,${png}` },
      ],
    });
    await rec.waitIdle(session.id);
    const [user, assistant] = rec.messages(session.id);
    expect(user.parts.filter((p) => p.type === 'file')).toHaveLength(3);
    expect(assistant.error).toBeUndefined();
    expect(assistant.parts.at(-1)).toMatchObject({ type: 'text' });
    expect(assistant.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20 });

    const req = mock.log.filter((l) => l.path === '/messages').pop()!;
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    const content = (req.body.messages as { content: { type: string; text?: string; source?: { data: string } }[] }[])[0].content;
    expect(content[0].text).toContain('<attachment name="notes.txt">\nalpha\nbeta\ngamma');
    expect(content[0].text).toContain('<attachment name="notes.txt:2-2">\nbeta\n</attachment>');
    expect(content.find((c) => c.type === 'image')!.source!.data).toBe(png);
    expect(typeof req.body.system).toBe('string');
  });

  it('runs MCP tools after the user approves, and feeds the result back to the model', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const servers = await engine.listMcp();
    expect(servers.map((s) => s.name)).toEqual(['mockmcp']);

    const asked = rec.waitFor('permission.asked');
    await engine.sendPrompt(session.id, { text: 'please [[tool:mockmcp__add {"a":2,"b":40}]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    const { request } = await asked;
    expect(request.title).toBe('Allow mockmcp › add?');
    expect(JSON.parse(request.detail!)).toEqual({ a: 2, b: 40 });
    await engine.replyPermission(session.id, request.id, 'always');
    await rec.waitIdle(session.id);

    const assistant = rec.messages(session.id)[1];
    const tool = assistant.parts.find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ type: 'tool', tool: 'mockmcp › add', status: 'completed', output: '42' });
    expect(assistant.parts.at(-1)).toMatchObject({ type: 'text', text: 'TOOL_RESULT: 42' });
    // Two model calls -> usage is summed.
    expect(assistant.usage).toMatchObject({ input: 200, output: 60 });
    expect((await engine.listMcp())[0]).toMatchObject({ status: 'connected', toolCount: 2, enabled: true });

    // "always" is remembered: the next call runs without asking.
    const before = rec.events.filter((e) => e.type === 'permission.asked').length;
    await engine.sendPrompt(session.id, { text: 'again [[tool:mockmcp__echo {"text":"hi"}]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    const p2 = await Promise.race([rec.waitFor('permission.asked', (e) => e.request.title.includes('echo')), rec.waitIdle(session.id).then(() => undefined)]);
    if (p2) {
      // echo is a different tool, so it asks once more; decline it this time.
      await engine.replyPermission(session.id, p2.request.id, 'reject');
      await rec.waitIdle(session.id);
      const last = rec.messages(session.id).at(-1)!;
      expect(last.parts.find((p) => p.type === 'tool')).toMatchObject({ status: 'error', error: 'The user declined this tool call.' });
    }
    expect(rec.events.filter((e) => e.type === 'permission.asked').length).toBe(before + 1);
  });

  it('auto mode runs MCP tools without asking', async () => {
    ctx.settings.approvals = 'auto';
    try {
      const rec = record(engine);
      const session = await engine.createSession();
      await engine.sendPrompt(session.id, { text: 'auto [[tool:mockmcp__echo {"text":"no prompt"}]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
      await rec.waitIdle(session.id);
      expect(rec.events.some((e) => e.type === 'permission.asked')).toBe(false);
      expect(rec.messages(session.id)[1].parts.find((p) => p.type === 'tool')).toMatchObject({ status: 'completed' });
    } finally {
      delete ctx.settings.approvals;
    }
  });

  it('Hugging Face: uses HF_TOKEN / HUGGINGFACE_HUB_TOKEN when no key is stored', async () => {
    const hfCtx = makeContext({ settings: { providers: [{ id: 'huggingface', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` }] }, env: { HUGGINGFACE_HUB_TOKEN: 'hf_test_token' } });
    const hf = new DirectEngine(hfCtx, mcp);
    try {
      expect((await hf.start()).state).toBe('ready');
      const [provider] = await hf.listProviders();
      expect(provider).toMatchObject({ id: 'huggingface', name: 'Hugging Face', connected: true });
      expect(provider.models.length).toBeGreaterThan(0);
      const rec = record(hf);
      const session = await hf.createSession();
      const before = mock.log.length;
      await hf.sendPrompt(session.id, { text: 'hello hub', attachments: [], model: { providerId: 'huggingface', modelId: provider.models[0].modelId } });
      await rec.waitIdle(session.id);
      expect(rec.messages(session.id)[1].error).toBeUndefined();
      expect(mock.log.slice(before).map((r) => (r as { headers?: { authorization?: string } }).headers?.authorization)).toContain('Bearer hf_test_token');
    } finally {
      await hf.dispose();
      hfCtx.cleanup();
    }
  });

  it('toggling an MCP server off removes its tools from requests', async () => {
    await engine.setMcpEnabled('mockmcp', false);
    expect((await engine.listMcp())[0]).toMatchObject({ status: 'disabled', enabled: false });
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'no tools [[tool:mockmcp__add {"a":1,"b":1}]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitIdle(session.id);
    const req = mock.log.filter((l) => l.path === '/chat/completions').pop()!;
    expect(req.body.tools).toBeUndefined();
    expect(rec.messages(session.id)[1].parts.some((p) => p.type === 'tool')).toBe(false);

    await engine.setMcpEnabled('mockmcp', true);
    await mcp.sync();
    expect((await engine.listMcp())[0]).toMatchObject({ status: 'connected', enabled: true });
  });

  it('reports provider errors on the assistant message', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'boom [[error]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitIdle(session.id);
    expect(rec.messages(session.id)[1].error).toMatch(/failed \(500\): mock failure/);
  });

  it('rejects unknown providers and missing keys with actionable messages', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'x', attachments: [], model: { providerId: 'nope', modelId: 'm' } });
    await rec.waitIdle(session.id);
    expect(rec.messages(session.id)[1].error).toMatch(/not configured/);

    // Local endpoints need no key; remote ones do.
    (ctx.settings.providers as object[]).push({ id: 'remote', name: 'Remote Co', type: 'openai-compatible', baseUrl: 'https://api.example.invalid/v1', models: ['m1'] });
    expect((await engine.listProviders()).find((p) => p.id === 'remote')!.connected).toBe(false);
    await engine.sendPrompt(session.id, { text: 'y', attachments: [], model: { providerId: 'remote', modelId: 'm1' } });
    await rec.waitIdle(session.id);
    expect(rec.messages(session.id).at(-1)!.error).toMatch(/No API key stored for Remote Co/);
    (ctx.settings.providers as object[]).pop();
  });

  it('abort stops a running turn', async () => {
    const slow = createMockLlm({ delayMs: 150 });
    const slowPort = await slow.listen();
    (ctx.settings.providers as { id: string; type: string; baseUrl: string }[]).push({ id: 'slow', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${slowPort}/v1` });
    await ctx.secrets.set(secretKeyFor('slow'), 'k');
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'a fairly long message that takes a while to stream back in small chunks', attachments: [], model: { providerId: 'slow', modelId: 'mock-small' } });
    await rec.waitFor('part.delta');
    expect(engine.isRunning(session.id)).toBe(true);
    await engine.abort(session.id);
    await rec.waitIdle(session.id);
    const assistant = rec.messages(session.id)[1];
    expect(assistant.error).toBeUndefined();
    expect(assistant.parts.at(-1)).toMatchObject({ type: 'notice', text: 'Stopped' });
    expect(engine.isRunning(session.id)).toBe(false);
    await slow.close();
  });

  it('is unavailable until a provider is configured', async () => {
    const empty = makeContext();
    const m = new McpManager({ log: empty.log, cwd: empty.cwd, readConfig: () => ({}), writeEnabled: async () => undefined });
    const e = new DirectEngine(empty, m);
    const status = await e.start();
    expect(status.state).toBe('unavailable');
    expect(status.detail).toMatch(/Manage BYOK Providers/);
    await e.dispose();
    empty.cleanup();
  });
});
