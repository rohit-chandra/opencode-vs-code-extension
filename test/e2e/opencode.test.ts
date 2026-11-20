import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { OpencodeEngine } from '../../src/engines/opencode/engine';
import { findBin, makeContext, record, sleep } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { makeOpencodeProject } from '../helpers/opencodeProject';
// @ts-expect-error plain ESM fixture without types
import { createMockLlm } from '../fixtures/mock-llm.mjs';

const bin = await findBin('opencode', 'OPENCODE_BIN');
const MODEL = { providerId: 'mock', modelId: 'mock-small' };

describe.skipIf(!bin)('opencode engine (real `opencode serve` + mock LLM)', () => {
  let mock: { listen(): Promise<number>; close(): Promise<void>; log: { path: string; body: { messages?: { role: string; content: unknown }[]; tools?: unknown[] } }[] };
  let project: ReturnType<typeof makeOpencodeProject>;
  let ctx: TestContext;
  let engine: OpencodeEngine;
  const lastRequest = () => mock.log.filter((l) => l.path === '/chat/completions').pop()!;

  beforeAll(async () => {
    mock = createMockLlm();
    project = makeOpencodeProject(await mock.listen());
    ctx = makeContext({ cwd: project.dir, env: project.env, settings: { 'opencode.path': bin } });
    engine = new OpencodeEngine(ctx);
    const status = await engine.start();
    expect(status.detail ?? '').toBe('');
    expect(status.state).toBe('ready');
    expect(status.version).toMatch(/^\d+\.\d+/);
  });

  afterAll(async () => {
    await engine?.dispose();
    await mock?.close();
    await sleep(300);
    project?.cleanup();
    ctx?.cleanup();
  });

  it('starts the server password-protected', async () => {
    const res = await fetch(new URL('/config', (engine as unknown as { client: { conn: { baseUrl: string } } }).client.conn.baseUrl));
    expect(res.status).toBe(401);
  });

  it('lists providers, the default model, agents and commands', async () => {
    const providers = await engine.listProviders();
    const mockProvider = providers.find((p) => p.id === 'mock')!;
    expect(mockProvider.name).toBe('Mock Provider');
    expect(mockProvider.models.map((m) => m.modelId)).toEqual(['mock-large', 'mock-small']);
    expect(await engine.defaultModel()).toEqual(MODEL);
    const agents = (await engine.listAgents()).map((a) => a.name);
    expect(agents).toContain('build');
    expect(agents).toContain('plan');
    expect(agents).not.toContain('title');
    const commands = await engine.listCommands();
    expect(commands.find((c) => c.name === 'greet')).toMatchObject({ description: 'Greet someone', source: 'engine' });
    expect(commands.some((c) => c.name === 'init')).toBe(true);
  });

  it('streams a reply, reports usage and titles the session', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    expect(session.title).toBe('New session');
    await engine.sendPrompt(session.id, { text: 'hello opencode [[think]]', attachments: [], model: MODEL, agent: 'build' });
    await rec.waitIdle(session.id);

    const messages = rec.messages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].parts).toMatchObject([{ type: 'text', text: 'hello opencode [[think]]' }]);
    const assistant = messages[1];
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    expect(assistant.parts[1]).toMatchObject({ text: 'MOCK[mock-small]: hello opencode' });
    expect(assistant.model).toEqual(MODEL);
    expect(assistant.usage).toMatchObject({ input: 100, output: 25, reasoning: 5, cacheRead: 20 });
    expect(rec.events.some((e) => e.type === 'part.delta')).toBe(true);
    expect(rec.events.filter((e) => e.type === 'usage').pop()).toMatchObject({ sessionId: session.id, messageId: assistant.id, model: MODEL, usage: { input: 100, output: 25 } });

    // The same data comes back from history.
    const history = await engine.getMessages(session.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[1].usage).toMatchObject({ input: 100, output: 25, reasoning: 5, cacheRead: 20 });
    expect(history[1].completedAt).toBeGreaterThan(0);

    await rec.waitFor('session.updated', (e) => e.session.id === session.id && e.session.title === 'Mock session title', 20_000).catch(() => undefined);
    const listed = (await engine.listSessions()).find((s) => s.id === session.id)!;
    expect(listed.title).toBe('Mock session title');
  });

  it('offers a model\'s variants as effort levels and sends the chosen one', async () => {
    const models = (await engine.listProviders()).find((p) => p.id === 'mock')!.models;
    const large = models.find((m) => m.modelId === 'mock-large')!;
    expect(large.efforts!.map((e) => e.id)).toEqual(expect.arrayContaining(['low', 'high']));
    const rec = record(engine);
    const session = await engine.createSession();
    const sent = () => mock.log.filter((l) => l.path === '/chat/completions' && JSON.stringify(l.body.messages).includes('effort check')).map((l) => (l.body as { reasoning_effort?: string }).reasoning_effort);
    await engine.sendPrompt(session.id, { text: 'effort check one', attachments: [], model: { providerId: 'mock', modelId: 'mock-large' }, effort: 'high' });
    await rec.waitIdle(session.id);
    expect(sent().at(-1)).toBe('high');
    await engine.sendPrompt(session.id, { text: 'effort check two', attachments: [], model: { providerId: 'mock', modelId: 'mock-large' }, effort: 'low' });
    await rec.waitIdle(session.id);
    expect(sent().at(-1)).toBe('low');
  });

  it('sends attached files and line ranges to the model', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, {
      text: 'what is the secret word?',
      model: MODEL,
      attachments: [{ id: 'a', kind: 'file', name: 'hello.txt', mime: 'text/plain', path: path.join(project.dir, 'hello.txt') }],
    });
    await rec.waitIdle(session.id);
    expect(JSON.stringify(lastRequest().body.messages)).toContain('the secret word is pineapple');
    const user = rec.messages(session.id)[0];
    expect(user.parts.find((p) => p.type === 'file')).toMatchObject({ filename: 'hello.txt' });
    expect(rec.messages(session.id)[1].error).toBeUndefined();
  });

  it('runs a custom slash command through opencode', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.runCommand(session.id, 'greet', 'Rohit', { text: '/greet Rohit', attachments: [], model: MODEL });
    await rec.waitFor('session.status', (e) => e.sessionId === session.id && e.activity === 'idle' && rec.messages(session.id).some((m) => m.role === 'assistant' && !!m.completedAt));
    expect(JSON.stringify(lastRequest().body.messages)).toContain('Say hello to Rohit');
    const assistant = rec.messages(session.id).find((m) => m.role === 'assistant')!;
    expect(assistant.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'MOCK[mock-small]: Say hello to Rohit' });
  });

  it('lists MCP servers and toggles them', async () => {
    let servers = await engine.listMcp();
    expect(servers).toMatchObject([{ name: 'mockmcp', status: 'connected', enabled: true, canToggle: true }]);
    const rec = record(engine);
    await engine.setMcpEnabled('mockmcp', false);
    servers = await engine.listMcp();
    expect(servers).toMatchObject([{ name: 'mockmcp', status: 'disabled', enabled: false }]);
    expect(rec.events.some((e) => e.type === 'mcp.changed')).toBe(true);
    await engine.setMcpEnabled('mockmcp', true);
    expect(await engine.listMcp()).toMatchObject([{ name: 'mockmcp', status: 'connected', enabled: true }]);
  });

  it('runs an MCP tool call end to end', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'use the tool [[tool:mockmcp_add {"a":40,"b":2}]]', attachments: [], model: MODEL });
    await rec.waitIdle(session.id);
    const assistants = rec.messages(session.id).filter((m) => m.role === 'assistant');
    const tool = assistants.flatMap((m) => m.parts).find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'mockmcp_add', status: 'completed', input: { a: 40, b: 2 } });
    expect((tool as { output: string }).output).toContain('42');
    expect(assistants.flatMap((m) => m.parts).filter((p) => p.type === 'text').pop()).toMatchObject({ text: expect.stringContaining('TOOL_RESULT:') });
  });

  it('surfaces permission requests and continues after approval', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const asked = rec.waitFor('permission.asked', (e) => e.request.sessionId === session.id);
    await engine.sendPrompt(session.id, { text: 'run it [[tool:bash {"command":"echo permission-ok","description":"print a word"}]]', attachments: [], model: MODEL });
    const { request } = await asked;
    expect(request.kind).toBe('bash');
    expect(request.detail).toContain('echo permission-ok');
    await engine.replyPermission(session.id, request.id, 'once');
    await rec.waitIdle(session.id);
    const parts = rec.messages(session.id).filter((m) => m.role === 'assistant').flatMap((m) => m.parts);
    const tool = parts.find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'bash', status: 'completed' });
    expect((tool as { output: string }).output).toContain('permission-ok');
    expect(rec.events.some((e) => e.type === 'permission.resolved' && e.requestId === request.id)).toBe(true);
  });

  it('rejecting a permission request fails the tool call', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const asked = rec.waitFor('permission.asked', (e) => e.request.sessionId === session.id);
    await engine.sendPrompt(session.id, { text: 'run it [[tool:bash {"command":"echo should-not-run","description":"nope"}]]', attachments: [], model: MODEL });
    await engine.replyPermission(session.id, (await asked).request.id, 'reject');
    await rec.waitIdle(session.id);
    const tool = rec.messages(session.id).filter((m) => m.role === 'assistant').flatMap((m) => m.parts).find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'bash', status: 'error' });
  });

  it('renames, forks, undoes and deletes sessions', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'first message', attachments: [], model: MODEL });
    await rec.waitIdle(session.id);

    await engine.renameSession(session.id, 'Renamed by test');
    expect((await engine.listSessions()).find((s) => s.id === session.id)!.title).toBe('Renamed by test');

    const fork = await engine.forkSession(session.id);
    expect(fork.id).not.toBe(session.id);
    expect((await engine.getMessages(fork.id)).map((m) => m.role)).toEqual(['user', 'assistant']);

    await engine.undo(session.id);
    await sleep(500);
    expect((await engine.getMessages(session.id)).length).toBeLessThanOrEqual(2);

    await engine.deleteSession(fork.id);
    await engine.deleteSession(session.id);
    const ids = (await engine.listSessions()).map((s) => s.id);
    expect(ids).not.toContain(session.id);
    expect(ids).not.toContain(fork.id);
    expect(rec.events.some((e) => e.type === 'session.deleted' && e.sessionId === session.id)).toBe(true);
  });

  it('reports provider errors', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const errored = rec.waitFor('error', (e) => e.sessionId === session.id, 90_000).catch(() => undefined);
    await engine.sendPrompt(session.id, { text: 'fail please [[error]]', attachments: [], model: MODEL });
    // opencode retries 5xx responses with backoff; abort once the retry state shows up or the error arrives.
    await Promise.race([errored, rec.waitFor('session.status', (e) => e.sessionId === session.id && e.activity === 'retry', 90_000)]);
    await engine.abort(session.id);
    await rec.waitIdle(session.id, 30_000).catch(() => undefined);
    const saw = rec.events.some((e) => (e.type === 'session.status' && e.activity === 'retry' && /mock failure|attempt/i.test(e.detail ?? '')) || e.type === 'error') || rec.messages(session.id).some((m) => m.parts.some((p) => p.type === 'notice'));
    expect(saw).toBe(true);
  });

  it('restart brings up a fresh server', async () => {
    const status = await engine.restart();
    expect(status.state).toBe('ready');
    expect((await engine.listSessions()).length).toBeGreaterThan(0);
  });
});

describe('opencode engine without the CLI', () => {
  it('explains how to install opencode', async () => {
    const ctx = makeContext({ settings: { 'opencode.path': '/nonexistent/opencode' } });
    const engine = new OpencodeEngine(ctx);
    const status = await engine.start();
    expect(status.state).toBe('unavailable');
    expect(status.detail).toMatch(/opencode is not installed/);
    expect(status.detail).toMatch(/npm i -g opencode-ai/);
    await engine.dispose();
    ctx.cleanup();
  });
});
