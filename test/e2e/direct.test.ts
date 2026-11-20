import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import { DirectEngine } from '../../src/engines/direct/engine';
import { secretKeyFor } from '../../src/engines/direct/presets';
import { McpManager } from '../../src/mcp/manager';
import type { McpServerConfig } from '../../src/mcp/manager';
import { multiAttachments } from '../helpers/attachments';
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
          // Models that refuse an effort level, or tools, the way some real ones do.
          { id: 'mockpicky', name: 'Mock Picky', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock-noeffort', 'mock-notools'] },
        ],
        // ${workspaceFolder} is expanded like in VS Code launch configs.
        'mcp.servers': { mockmcp: { command: process.execPath, args: ['${workspaceFolder}/test/fixtures/mock-mcp.mjs'] } } as Record<string, McpServerConfig>,
      },
    });
    await ctx.secrets.set(secretKeyFor('mockoai'), 'sk-openai-test');
    await ctx.secrets.set(secretKeyFor('mockant'), 'sk-ant-test');
    await ctx.secrets.set(secretKeyFor('mockpicky'), 'sk-picky-test');
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
      ['mockpicky', true, ['mock-noeffort', 'mock-notools']],
    ]);
    // Effort levels are the ones each kind of API takes.
    expect(providers[0].models[0].efforts!.map((e) => e.id)).toEqual(['low', 'medium', 'high']);
    expect(providers[1].models[0].efforts!.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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

  it('leaves out the oldest turns when the conversation outgrows the context window, and keeps going', async () => {
    for (const model of [
      { providerId: 'mockoai', modelId: 'mock-ctx400' },
      { providerId: 'mockant', modelId: 'claude-mock-ctx400' },
    ]) {
      const path_ = model.providerId === 'mockant' ? '/messages' : '/chat/completions';
      const rec = record(engine);
      const session = await engine.createSession();
      const filler = 'lorem ipsum dolor '.repeat(25); // about 110 tokens
      for (const n of ['one', 'two', 'three', 'four', 'five']) {
        await engine.sendPrompt(session.id, { text: `turn ${n} ${filler}`, attachments: [], model });
        await rec.waitIdle(session.id);
      }
      const messages = rec.messages(session.id);
      // Every turn got an answer, none failed, and the whole conversation is still on screen.
      expect(messages).toHaveLength(10);
      expect(messages.filter((m) => m.role === 'assistant').every((m) => !m.error && m.completedAt)).toBe(true);
      expect(messages.at(-1)!.parts.some((p) => p.type === 'text' && p.text.includes('turn five'))).toBe(true);
      const notices = messages.flatMap((m) => m.parts).filter((p) => p.type === 'notice');
      expect(notices.length).toBeGreaterThan(0);
      expect(notices[0]).toMatchObject({ level: 'info' });
      expect(JSON.stringify(notices[0])).toMatch(/oldest messages were left out/);

      const sent = mock.log.filter((l) => l.path === path_ && l.body.model === model.modelId);
      const last = JSON.stringify(sent.at(-1)!.body.messages);
      expect(last).toContain('turn five');
      expect(last).not.toContain('turn one');
      // The cut is remembered: the turn after an overflow does not have to fail first again.
      const before = sent.length;
      await engine.sendPrompt(session.id, { text: 'short follow-up', attachments: [], model });
      await rec.waitIdle(session.id);
      expect(mock.log.filter((l) => l.path === path_ && l.body.model === model.modelId).length - before).toBe(1);
      // A request starts with something the user said, never with an orphaned reply.
      const first = (mock.log.filter((l) => l.path === path_ && l.body.model === model.modelId).at(-1)!.body.messages as { role: string }[]).find((m) => m.role !== 'system')!;
      expect(first.role).toBe('user');
    }
  });

  it('says so when a single message is larger than the context window', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'x'.repeat(4000), attachments: [], model: { providerId: 'mockoai', modelId: 'mock-ctx400' } });
    await rec.waitIdle(session.id);
    const assistant = rec.messages(session.id).at(-1)!;
    expect(assistant.error).toMatch(/maximum context length is 400 tokens/);
    expect(assistant.error).toMatch(/larger than the model's context window on its own/);
  });

  it('honours a token budget set in settings before the provider has to complain', async () => {
    ctx.settings['direct.maxContextTokens'] = 150;
    try {
      const rec = record(engine);
      const session = await engine.createSession();
      const model = { providerId: 'mockoai', modelId: 'mock-large' };
      for (const n of ['alpha', 'beta', 'gamma']) {
        await engine.sendPrompt(session.id, { text: `budget ${n} ${'word '.repeat(60)}`, attachments: [], model });
        await rec.waitIdle(session.id);
      }
      const last = JSON.stringify(mock.log.filter((l) => l.path === '/chat/completions').at(-1)!.body.messages);
      expect(last).toContain('budget gamma');
      expect(last).not.toContain('budget alpha');
      expect(rec.messages(session.id).every((m) => !m.error)).toBe(true);
    } finally {
      delete ctx.settings['direct.maxContextTokens'];
    }
  });

  it('sends several attachments with the prompt, to OpenAI-compatible and Anthropic providers alike', async () => {
    const { attachments, markers } = multiAttachments(path.join(ctx.dir, 'multi'));
    for (const [model, route] of [
      [{ providerId: 'mockoai', modelId: 'mock-small' }, '/chat/completions'],
      [{ providerId: 'mockant', modelId: 'claude-mock' }, '/messages'],
    ] as const) {
      const rec = record(engine);
      const session = await engine.createSession();
      await engine.sendPrompt(session.id, { text: 'compare these three', attachments, model });
      await rec.waitIdle(session.id);
      const [user, assistant] = rec.messages(session.id);
      expect(assistant.error).toBeUndefined();
      // The chat shows the three as chips on the user's message.
      expect(user.parts.filter((p) => p.type === 'file').map((p) => (p as { filename: string }).filename)).toEqual(['alpha.ts', 'beta.md', 'gamma.py:2-2']);
      // And the model got all three inside the same user turn as the question.
      const body = mock.log.filter((l) => l.path === route).at(-1)!.body as { messages: { role: string; content: unknown }[] };
      const lastUser = JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1));
      expect(lastUser).toContain('compare these three');
      for (const m of markers) expect(lastUser, `${model.providerId} missing ${m}`).toContain(m);
    }
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

  it('sends the chosen effort level in the form each API takes', async () => {
    const rec = record(engine);
    const oai = await engine.createSession();
    await engine.sendPrompt(oai.id, { text: 'effort for openai', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' }, effort: 'high' });
    await rec.waitIdle(oai.id);
    expect(mock.log.filter((l) => l.path === '/chat/completions').pop()!.body.reasoning_effort).toBe('high');
    await engine.sendPrompt(oai.id, { text: 'no effort chosen', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitIdle(oai.id);
    expect(mock.log.filter((l) => l.path === '/chat/completions').pop()!.body.reasoning_effort).toBeUndefined();

    const ant = await engine.createSession();
    await engine.sendPrompt(ant.id, { text: 'effort for anthropic', attachments: [], model: { providerId: 'mockant', modelId: 'claude-mock' }, effort: 'max' });
    await rec.waitIdle(ant.id);
    const req = mock.log.filter((l) => l.path === '/messages').pop()!;
    expect(req.body.output_config).toEqual({ effort: 'max' });
    // Thinking counts toward max_tokens, so the top levels get more room.
    expect(req.body.max_tokens).toBe(64_000);
    await engine.sendPrompt(ant.id, { text: 'low effort', attachments: [], model: { providerId: 'mockant', modelId: 'claude-mock' }, effort: 'low' });
    await rec.waitIdle(ant.id);
    expect(mock.log.filter((l) => l.path === '/messages').pop()!.body).toMatchObject({ output_config: { effort: 'low' }, max_tokens: 8192 });
  });

  it('answers without the effort level when the model refuses it, says so once, and remembers', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'mockpicky', modelId: 'mock-noeffort' };
    const requests = () => mock.log.filter((l) => l.path === '/chat/completions' && l.body.model === 'mock-noeffort');
    const before = requests().length;
    await engine.sendPrompt(session.id, { text: 'think hard', attachments: [], model, effort: 'high' });
    await rec.waitIdle(session.id);
    const first = rec.messages(session.id)[1];
    expect(first.error).toBeUndefined();
    expect(first.parts.find((p) => p.type === 'notice')).toMatchObject({ level: 'info', text: 'mock-noeffort did not accept the "high" effort level, so this reply uses the model\'s default.' });
    expect(first.parts.at(-1)).toMatchObject({ type: 'text', text: 'MOCK[mock-noeffort]: think hard' });
    expect(requests().slice(before).map((l) => l.body.reasoning_effort)).toEqual(['high', undefined]);

    // The next message does not try again, and does not repeat the notice.
    await engine.sendPrompt(session.id, { text: 'again', attachments: [], model, effort: 'high' });
    await rec.waitIdle(session.id);
    expect(requests().slice(before)).toHaveLength(3);
    expect(requests().at(-1)!.body.reasoning_effort).toBeUndefined();
    expect(rec.messages(session.id)[3].parts.some((p) => p.type === 'notice')).toBe(false);
  });

  it('lets the model ask questions in the chat and reads the answers back to it', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'mockoai', modelId: 'mock-small' };
    const ask = { questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, 'SQLite'] }, { question: 'Which extras?', options: [{ label: 'Auth' }, { label: 'Search' }], multiple: true }] };
    const asked = rec.waitFor('question.asked', (e) => e.request.sessionId === session.id);
    await engine.sendPrompt(session.id, { text: `build it [[tool:ask_user ${JSON.stringify(ask)}]]`, attachments: [], model });
    const { request } = await asked;
    expect(request.questions).toEqual([
      { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] },
      { question: 'Which extras?', options: [{ label: 'Auth' }, { label: 'Search' }], multiple: true },
    ]);
    // Asking is not a permission, so Ask mode shows no approval card for it.
    expect(rec.events.some((e) => e.type === 'permission.asked' && e.request.sessionId === session.id)).toBe(false);
    expect(await engine.sessionActivity(session.id)).toBe('busy');
    await engine.replyQuestion(session.id, request.id, [['MySQL, we already run it'], ['Auth', 'Search']]);
    await rec.waitIdle(session.id);
    const parts = rec.messages(session.id)[1].parts;
    expect(parts.find((p) => p.type === 'tool')).toMatchObject({ tool: 'Question', status: 'completed', output: 'Q: Which database?\nA: MySQL, we already run it\n\nQ: Which extras?\nA: Auth, Search' });
    expect(parts.at(-1)).toMatchObject({ type: 'text', text: 'TOOL_RESULT: Q: Which database?\nA: MySQL, we already run it\n\nQ: Which extras?\nA: Auth, Search' });

    // Skipped questions tell the model to carry on; stopping the turn closes the card.
    const skipped = await engine.createSession();
    const asked2 = rec.waitFor('question.asked', (e) => e.request.sessionId === skipped.id);
    await engine.sendPrompt(skipped.id, { text: `again [[tool:ask_user ${JSON.stringify(ask)}]]`, attachments: [], model });
    await engine.replyQuestion(skipped.id, (await asked2).request.id, null);
    await rec.waitIdle(skipped.id);
    expect(JSON.stringify(rec.messages(skipped.id)[1].parts)).toContain('skipped the questions');

    const stopped = await engine.createSession();
    const asked3 = rec.waitFor('question.asked', (e) => e.request.sessionId === stopped.id);
    await engine.sendPrompt(stopped.id, { text: `once more [[tool:ask_user ${JSON.stringify(ask)}]]`, attachments: [], model });
    const pending = (await asked3).request.id;
    await engine.abort(stopped.id);
    await rec.waitIdle(stopped.id);
    expect(rec.events.some((e) => e.type === 'question.resolved' && e.requestId === pending)).toBe(true);
  });

  it('keeps working with a model that takes no tools: the question tool is dropped for it', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'mockpicky', modelId: 'mock-notools' };
    await mcp.setEnabled('mockmcp', false);
    try {
      const requests = () => mock.log.filter((l) => l.path === '/chat/completions' && l.body.model === 'mock-notools');
      await engine.sendPrompt(session.id, { text: 'hello there', attachments: [], model });
      await rec.waitIdle(session.id);
      expect(rec.messages(session.id)[1].error).toBeUndefined();
      expect(rec.messages(session.id)[1].parts).toMatchObject([{ type: 'text', text: 'MOCK[mock-notools]: hello there' }]);
      expect(requests().map((l) => !!l.body.tools)).toEqual([true, false]);
      await engine.sendPrompt(session.id, { text: 'and again', attachments: [], model });
      await rec.waitIdle(session.id);
      expect(requests().map((l) => !!l.body.tools)).toEqual([true, false, false]);
    } finally {
      await mcp.setEnabled('mockmcp', true);
      await mcp.sync();
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

  it('keeps a conversation when VS Code closes in the middle of a reply', async () => {
    const first = new DirectEngine(ctx, mcp);
    expect((await first.start()).state).toBe('ready');
    const rec = record(first);
    const session = await first.createSession();
    await first.sendPrompt(session.id, { text: 'a long answer please [[slow]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitFor('part.delta', (e) => e.sessionId === session.id);
    await first.dispose(); // what deactivate() does on shutdown

    const second = new DirectEngine(ctx, mcp);
    expect((await second.start()).state).toBe('ready');
    expect((await second.listSessions()).map((s) => s.id)).toContain(session.id);
    const messages = await second.getMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].parts[0]).toMatchObject({ type: 'text', text: 'a long answer please [[slow]]' });
    expect(messages[1].completedAt).toBeDefined();
    await second.dispose();
  });

  it('toggling an MCP server off removes its tools from requests', async () => {
    await engine.setMcpEnabled('mockmcp', false);
    expect((await engine.listMcp())[0]).toMatchObject({ status: 'disabled', enabled: false });
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'no tools [[tool:mockmcp__add {"a":1,"b":1}]]', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
    await rec.waitIdle(session.id);
    const req = mock.log.filter((l) => l.path === '/chat/completions').pop()!;
    // Only the built-in question tool is left.
    expect((req.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['ask_user']);
    expect(rec.messages(session.id)[1].parts.some((p) => p.type === 'tool')).toBe(false);
    // With that switched off as well, the request carries no tools at all.
    ctx.settings['chat.askQuestions'] = false;
    try {
      await engine.sendPrompt(session.id, { text: 'still no tools', attachments: [], model: { providerId: 'mockoai', modelId: 'mock-small' } });
      await rec.waitIdle(session.id);
      expect(mock.log.filter((l) => l.path === '/chat/completions').pop()!.body.tools).toBeUndefined();
    } finally {
      delete ctx.settings['chat.askQuestions'];
    }

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
