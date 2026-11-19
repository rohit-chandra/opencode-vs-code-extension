import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { Engine } from '../../src/core/engine';
import { UsageLedger } from '../../src/core/usageLedger';
import { ClaudeCodeEngine } from '../../src/engines/cli/claudeCode';
import { CodexEngine } from '../../src/engines/cli/codex';
import { DirectEngine } from '../../src/engines/direct/engine';
import { secretKeyFor } from '../../src/engines/direct/presets';
import { OpencodeEngine } from '../../src/engines/opencode/engine';
import { McpManager } from '../../src/mcp/manager';
import type { McpServerConfig } from '../../src/mcp/manager';
import type { EngineId, Part } from '../../src/shared/types';
import { ChatController } from '../../src/ui/controller';
import { MemoryStore, findBin, makeContext, sleep } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { FakeHost } from '../helpers/fakeHost';
import { makeOpencodeProject } from '../helpers/opencodeProject';
// @ts-expect-error plain ESM fixture without types
import { createMockLlm } from '../fixtures/mock-llm.mjs';

const bin = await findBin('opencode', 'OPENCODE_BIN');
const texts = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text);

/**
 * The full chat flow as the webview drives it: every user action goes through
 * `controller.handleMessage`, and assertions are made on the view state the webview receives.
 */
describe.skipIf(!bin)('ChatController with the real opencode engine', () => {
  let mock: { listen(): Promise<number>; close(): Promise<void>; log: { path: string; body: Record<string, unknown> }[] };
  let project: ReturnType<typeof makeOpencodeProject>;
  let ctx: TestContext;
  let host: FakeHost;
  let engines: Map<EngineId, Engine>;
  let ledger: UsageLedger;
  let ledgerStore: MemoryStore;
  let controller: ChatController;
  let mcp: McpManager;

  beforeAll(async () => {
    mock = createMockLlm();
    const port = await mock.listen();
    project = makeOpencodeProject(port);
    ctx = makeContext({
      cwd: project.dir,
      env: project.env,
      settings: {
        'opencode.path': bin,
        'claudeCode.path': '/nonexistent/claude',
        'codex.path': '/nonexistent/codex',
        providers: [{ id: 'mockoai', name: 'Mock OpenAI', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` }],
        'mcp.servers': { localmcp: { command: process.execPath, args: [path.resolve('test/fixtures/mock-mcp.mjs')] } } as Record<string, McpServerConfig>,
      },
    });
    await ctx.secrets.set(secretKeyFor('mockoai'), 'k');
    host = new FakeHost(ctx);
    mcp = new McpManager({
      log: ctx.log,
      cwd: ctx.cwd,
      readConfig: () => ctx.settings['mcp.servers'] as Record<string, McpServerConfig>,
      writeEnabled: async (name, enabled) => {
        const servers = ctx.settings['mcp.servers'] as Record<string, McpServerConfig>;
        ctx.settings['mcp.servers'] = { ...servers, [name]: { ...servers[name], enabled } };
      },
    });
    engines = new Map<EngineId, Engine>([
      ['opencode', new OpencodeEngine(ctx)],
      ['direct', new DirectEngine(ctx, mcp)],
      ['claude-code', new ClaudeCodeEngine(ctx)],
      ['codex', new CodexEngine(ctx)],
    ]);
    ledgerStore = new MemoryStore();
    ledger = new UsageLedger(ledgerStore);
    controller = new ChatController(engines, ledger, host);
    await controller.handleMessage({ type: 'ready' });
    await controller.activate();
  });

  afterAll(async () => {
    controller?.dispose();
    for (const e of engines?.values() ?? []) await e.dispose();
    await mcp?.dispose();
    await mock?.close();
    await sleep(300);
    project?.cleanup();
    ctx?.cleanup();
  });

  it('boots with opencode ready, a default model, agents, MCP servers and merged commands', () => {
    const v = host.view!;
    expect(v.engine).toBe('opencode');
    expect(v.loading).toBe(false);
    expect(v.engines.find((e) => e.engine === 'opencode')).toMatchObject({ state: 'ready' });
    expect(v.model).toEqual({ providerId: 'mock', modelId: 'mock-small' });
    expect(v.agent).toBe('build');
    expect(v.mcp).toMatchObject([{ name: 'mockmcp', status: 'connected' }]);
    expect(v.commands[0]).toMatchObject({ name: 'new', source: 'builtin' });
    expect(v.commands.find((c) => c.name === 'greet')).toMatchObject({ source: 'engine' });
    expect(v.capabilities).toMatchObject({ mcpToggle: true, permissions: true, undo: true });
    expect(v.sessionId).toBeUndefined();
  });

  it('sends a message: session is created lazily, text streams in, usage is recorded', async () => {
    await controller.handleMessage({ type: 'send', text: 'hello from the controller' });
    const v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt), 60_000, 'assistant reply');
    expect(v.sessionId).toMatch(/^ses/);
    expect(v.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(texts(v.messages[1].parts)).toEqual(['MOCK[mock-small]: hello from the controller']);
    expect(host.posted.some((m) => (m.type === 'event' && m.event.type === 'part.delta') || (m.type === 'events' && m.events.some((e) => e.type === 'part.delta')))).toBe(true);

    const withUsage = await host.until((s) => !!s.sessionUsage && s.sessionUsage.usage.input > 0, 10_000, 'session usage');
    expect(withUsage.sessionUsage).toMatchObject({ engine: 'opencode', messages: 1, usage: { input: 100, output: 30, cacheRead: 20 } });
    expect(withUsage.sessionUsage!.byModel).toMatchObject([{ providerId: 'mock', modelId: 'mock-small', messages: 1 }]);
    expect(withUsage.usage!.total.input).toBe(100);
    expect(withUsage.usage!.byModel[0]).toMatchObject({ engine: 'opencode', providerId: 'mock', modelId: 'mock-small' });
    await host.until((s) => s.sessions.some((x) => x.id === s.sessionId && x.title === 'Mock session title'), 20_000, 'session title');
  });

  it('a second message adds to the same session and the totals', async () => {
    await controller.handleMessage({ type: 'send', text: 'second message' });
    await host.until((s) => s.activity === 'idle' && s.messages.filter((m) => m.role === 'assistant' && m.completedAt).length === 2);
    const v = await host.until((s) => s.sessionUsage?.messages === 2, 10_000, 'usage of two messages');
    expect(v.sessionUsage!.usage).toMatchObject({ input: 200, output: 60, cacheRead: 40 });
    expect(ledger.summary().total.input).toBe(200);
  });

  it('/help lists built-in and engine commands without calling the model', async () => {
    const before = mock.log.length;
    await controller.handleMessage({ type: 'send', text: '/help' });
    const last = host.view!.messages.at(-1)!;
    expect(last.id.startsWith('local_')).toBe(true);
    expect(texts(last.parts)[0]).toContain('`/mcp`');
    expect(texts(last.parts)[0]).toContain('`/greet');
    expect(mock.log.length).toBe(before);
  });

  it('runs an opencode custom command typed as /greet', async () => {
    const count = host.view!.messages.filter((m) => m.role === 'assistant' && !m.id.startsWith('local_')).length;
    await controller.handleMessage({ type: 'send', text: '/greet Ada' });
    const v = await host.until((s) => s.activity === 'idle' && s.messages.filter((m) => m.role === 'assistant' && !m.id.startsWith('local_') && m.completedAt).length === count + 1, 60_000, 'greet reply');
    expect(texts(v.messages.filter((m) => m.role === 'assistant').at(-1)!.parts)).toEqual(['MOCK[mock-small]: Say hello to Ada']);
  });

  it('attaches files (picker, drop URI, selection) and sends them', async () => {
    const file = path.join(project.dir, 'hello.txt');
    host.filesToPick = [file];
    await controller.handleMessage({ type: 'send', text: '/attach' });
    expect(host.view!.attachments).toMatchObject([{ kind: 'file', name: 'hello.txt', path: file }]);
    // Dropping the same file again (as a file:// URI) does not duplicate it.
    await controller.handleMessage({ type: 'addPaths', paths: [new URL(`file://${file}`).toString()] });
    expect(host.view!.attachments).toHaveLength(1);
    controller.addAttachment({ id: '', kind: 'selection', name: 'hello.txt:1-1', mime: 'text/plain', path: file, text: 'the secret word is pineapple', range: { startLine: 1, endLine: 1 } });
    expect(host.view!.attachments).toHaveLength(2);
    await controller.handleMessage({ type: 'removeAttachment', id: host.view!.attachments[1].id });
    expect(host.view!.attachments).toHaveLength(1);

    const count = host.view!.messages.filter((m) => m.role === 'assistant' && m.completedAt && !m.id.startsWith('local_')).length;
    await controller.handleMessage({ type: 'send', text: 'read the attachment' });
    expect(host.view!.attachments).toEqual([]);
    await host.until((s) => s.activity === 'idle' && s.messages.filter((m) => m.role === 'assistant' && m.completedAt && !m.id.startsWith('local_')).length === count + 1);
    const req = mock.log.filter((l) => l.path === '/chat/completions').pop()!;
    expect(JSON.stringify(req.body.messages)).toContain('the secret word is pineapple');
  });

  it('answers @-mention file searches', async () => {
    host.files = [{ path: path.join(project.dir, 'hello.txt'), relative: 'hello.txt' }];
    await controller.handleMessage({ type: 'searchFiles', requestId: 7, query: 'hel' });
    expect(host.posted.filter((m) => m.type === 'fileResults').pop()).toEqual({ type: 'fileResults', requestId: 7, files: host.files });
  });

  it('toggles an MCP server from the panel', async () => {
    await controller.handleMessage({ type: 'send', text: '/mcp' });
    expect(host.view!.panel.name).toBe('mcp');
    await controller.handleMessage({ type: 'mcpToggle', name: 'mockmcp', enabled: false });
    expect(host.view!.mcp).toMatchObject([{ name: 'mockmcp', status: 'disabled', enabled: false }]);
    await controller.handleMessage({ type: 'mcpToggle', name: 'mockmcp', enabled: true });
    expect(host.view!.mcp).toMatchObject([{ name: 'mockmcp', status: 'connected', enabled: true }]);
  });

  it('shows a permission request and continues after the user allows it', async () => {
    await controller.handleMessage({ type: 'send', text: 'go [[tool:bash {"command":"echo from-controller","description":"echo"}]]' });
    const asked = await host.until((s) => s.permissions.length === 1, 60_000, 'permission request');
    expect(asked.permissions[0]).toMatchObject({ kind: 'bash' });
    await controller.handleMessage({ type: 'permissionReply', requestId: asked.permissions[0].id, reply: 'once' });
    const v = await host.until((s) => s.activity === 'idle' && s.permissions.length === 0 && s.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.status === 'completed')), 60_000, 'tool completion');
    const tool = v.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').pop()!;
    expect(tool).toMatchObject({ tool: 'bash', status: 'completed' });
  });

  it('auto mode approves opencode permission requests without showing them', async () => {
    await controller.handleMessage({ type: 'setApprovals', mode: 'auto' });
    expect(host.view!.approvals).toBe('auto');
    expect(ctx.settings.approvals).toBe('auto');
    try {
      const tools = () => host.view!.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length;
      const before = tools();
      const posted = host.posted.length;
      await controller.handleMessage({ type: 'send', text: 'auto [[tool:bash {"command":"echo auto-ok","description":"echo"}]]' });
      const v = await host.until((s) => s.activity === 'idle' && s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length > before && s.messages.at(-1)?.role === 'assistant' && !!s.messages.at(-1)?.completedAt, 60_000, 'auto tool');
      const tool = v.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').pop()!;
      expect(tool).toMatchObject({ tool: 'bash', status: 'completed' });
      expect(host.posted.slice(posted).some((m) => m.type === 'patch' && (m.patch.permissions?.length ?? 0) > 0)).toBe(false);
    } finally {
      await controller.handleMessage({ type: 'send', text: '/ask' });
    }
    expect(host.view!.approvals).toBe('ask');
  });

  it('switches sessions, restores history and keeps usage per session', async () => {
    const first = host.view!.sessionId!;
    await controller.handleMessage({ type: 'newSession' });
    expect(host.view!).toMatchObject({ sessionId: undefined, messages: [], sessionUsage: undefined });
    await controller.handleMessage({ type: 'send', text: 'another session' });
    const v2 = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt));
    const second = v2.sessionId!;
    expect(second).not.toBe(first);
    await host.until((s) => s.sessionUsage?.messages === 1, 10_000);
    expect(host.view!.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([first, second]));

    await controller.handleMessage({ type: 'switchSession', sessionId: first });
    const back = host.view!;
    expect(back.sessionId).toBe(first);
    expect(back.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(4);
    expect(back.sessionUsage!.messages).toBeGreaterThanOrEqual(4);
    expect(host.state.get('session.opencode')).toBe(first);

    // Re-opening history must not double count.
    const total = ledger.summary().total.input;
    await controller.handleMessage({ type: 'switchSession', sessionId: second });
    await controller.handleMessage({ type: 'switchSession', sessionId: first });
    expect(ledger.summary().total.input).toBe(total);
  });

  it('renames with /rename, exports with /export and deletes after confirmation', async () => {
    const id = host.view!.sessionId!;
    await controller.handleMessage({ type: 'send', text: '/rename Controller test' });
    await host.until((s) => s.sessions.find((x) => x.id === id)?.title === 'Controller test', 10_000, 'rename');
    await controller.handleMessage({ type: 'send', text: '/export' });
    expect(host.saved[0].name).toBe('Controller-test.md');
    expect(host.saved[0].content).toContain('# Controller test');
    expect(host.saved[0].content).toContain('MOCK[mock-small]: hello from the controller');
    expect(host.saved[0].content).toContain('**bash**');

    host.confirms.push(false);
    await controller.handleMessage({ type: 'deleteSession', sessionId: id });
    expect(host.view!.sessions.some((s) => s.id === id)).toBe(true);
    host.confirms.push(true);
    await controller.handleMessage({ type: 'deleteSession', sessionId: id });
    expect(host.view!.sessions.some((s) => s.id === id)).toBe(false);
    expect(host.view!.sessionId).toBeUndefined();
    // Usage history survives deleting the session.
    expect(ledger.summary().total.input).toBeGreaterThan(0);
  });

  it('/model and /agent change the selection and persist it per engine', async () => {
    await controller.handleMessage({ type: 'send', text: '/model large' });
    expect(host.view!.model).toEqual({ providerId: 'mock', modelId: 'mock-large' });
    expect(host.state.get('model.opencode')).toEqual({ providerId: 'mock', modelId: 'mock-large' });
    await controller.handleMessage({ type: 'send', text: '/agent plan' });
    expect(host.view!.agent).toBe('plan');
    await controller.handleMessage({ type: 'send', text: '/model nothing-like-this' });
    expect(host.view!.notice).toMatchObject({ level: 'warn' });
    await controller.handleMessage({ type: 'send', text: 'which model?' });
    const v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt));
    // The plan agent appends its read-only reminder to the prompt, which the mock echoes: proof that /agent took effect.
    expect(texts(v.messages[1].parts)[0]).toMatch(/^MOCK\[mock-large\]: which model\?/);
    expect(texts(v.messages[1].parts)[0]).toMatch(/plan mode/i);
    expect(v.messages[1].agent).toBe('plan');
    const row = (await host.until((s) => !!s.usage?.byModel.some((r) => r.modelId === 'mock-large'), 10_000)).usage!.byModel.find((r) => r.modelId === 'mock-large')!;
    expect(row).toMatchObject({ engine: 'opencode', providerId: 'mock', messages: 1 });
    await controller.handleMessage({ type: 'send', text: '/agent build' });
    await controller.handleMessage({ type: 'send', text: '/model mock-small' });
  });

  it('/avatar toggles the companion and writes the setting', async () => {
    expect(host.view!.avatar).toEqual({ enabled: true, style: 'buddy' });
    await controller.handleMessage({ type: 'send', text: '/avatar off' });
    expect(host.view!.avatar.enabled).toBe(false);
    expect(ctx.settings['avatar.enabled']).toBe(false);
    await controller.handleMessage({ type: 'send', text: '/avatar dots' });
    expect(host.view!.avatar).toEqual({ enabled: true, style: 'dots' });
    await controller.handleMessage({ type: 'setAvatar', style: 'buddy' });
    expect(ctx.settings['avatar.style']).toBe('buddy');
  });

  it('offers Retry after a stopped reply and sends the same message again', async () => {
    await controller.handleMessage({ type: 'newSession' });
    expect(host.view!.canRetry).toBe(false);
    await controller.handleMessage({ type: 'send', text: 'count slowly and carefully from one to twenty please [[slow]]' });
    await host.until((s) => s.activity !== 'idle' && s.messages.some((m) => m.role === 'assistant'), 30_000, 'reply started');
    await controller.handleMessage({ type: 'abort' });
    const stopped = await host.until((s) => s.activity === 'idle', 30_000, 'stopped');
    expect(stopped.canRetry).toBe(true);
    const users = stopped.messages.filter((m) => m.role === 'user').length;
    await controller.handleMessage({ type: 'retry' });
    expect(host.view!.canRetry).toBe(false);
    const again = await host.until((s) => s.messages.filter((m) => m.role === 'user').length === users + 1, 30_000, 'message sent again');
    expect(texts(again.messages.filter((m) => m.role === 'user').pop()!.parts).join('')).toContain('count slowly');
    await controller.handleMessage({ type: 'abort' });
    await host.until((s) => s.activity === 'idle', 30_000, 'stopped again');
    // The offer belongs to this conversation only.
    await controller.handleMessage({ type: 'newSession' });
    expect(host.view!.canRetry).toBe(false);
  });

  it('remembers recently used models, newest first', async () => {
    const all = host.view!.providers.flatMap((p) => p.models);
    const [a, b] = [all.find((m) => m.modelId === 'mock-large')!, all.find((m) => m.modelId === 'mock-small')!];
    await controller.handleMessage({ type: 'setModel', model: { providerId: a.providerId, modelId: a.modelId } });
    await controller.handleMessage({ type: 'setModel', model: { providerId: b.providerId, modelId: b.modelId } });
    expect(host.view!.recentModels.slice(0, 2).map((m) => m.modelId)).toEqual(['mock-small', 'mock-large']);
    await controller.handleMessage({ type: 'setModel', model: { providerId: b.providerId, modelId: b.modelId } });
    expect(host.view!.recentModels.filter((m) => m.modelId === 'mock-small')).toHaveLength(1);
  });

  it('/zoom scales the chat text within limits and /move docks the chat', async () => {
    expect(host.view!.zoom).toBe(1);
    await controller.handleMessage({ type: 'send', text: '/zoom in' });
    await controller.handleMessage({ type: 'zoom', delta: 0.1 });
    expect(host.view!.zoom).toBe(1.2);
    expect(ctx.settings['chat.zoom']).toBe(1.2);
    await controller.handleMessage({ type: 'send', text: '/zoom 150%' });
    expect(host.view!.zoom).toBe(1.5);
    await controller.handleMessage({ type: 'send', text: '/zoom 9' });
    expect(host.view!.zoom).toBe(1.6);
    await controller.handleMessage({ type: 'send', text: '/zoom out' });
    expect(host.view!.zoom).toBe(1.5);
    await controller.handleMessage({ type: 'send', text: '/zoom reset' });
    expect(host.view!.zoom).toBe(1);

    await controller.handleMessage({ type: 'send', text: '/move right' });
    await controller.handleMessage({ type: 'moveView', to: 'editor' });
    host.pickByLabel(/Left side bar/);
    await controller.handleMessage({ type: 'send', text: '/move' });
    expect(host.moved).toEqual(['right', 'editor', 'left']);
  });

  it('batches streamed tokens instead of posting one message per token', async () => {
    await controller.handleMessage({ type: 'newSession' });
    const before = host.posted.length;
    await controller.handleMessage({ type: 'send', text: 'a reasonably long message so that the reply streams back in many small chunks of text' });
    const v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt));
    const sent = host.posted.slice(before);
    const batches = sent.filter((m) => m.type === 'events');
    const streamed = sent.reduce((n, m) => n + (m.type === 'events' ? m.events.length : m.type === 'event' ? 1 : 0), 0);
    expect(batches.length).toBeGreaterThan(0);
    expect(streamed).toBeGreaterThan(sent.filter((m) => m.type === 'events' || m.type === 'event').length);
    // Nothing is lost or reordered by batching.
    expect(texts(v.messages[1].parts)).toEqual(['MOCK[mock-small]: a reasonably long message so that the reply streams back in many small chunks of text']);
  });

  it('switches to the Direct BYOK engine and back, keeping separate sessions and combined usage', async () => {
    await controller.handleMessage({ type: 'send', text: '/engine byok' });
    let v = await host.until((s) => s.engine === 'direct' && !s.loading, 20_000, 'direct engine');
    expect(v.providers.map((p) => p.id)).toEqual(['mockoai']);
    expect(v.model).toEqual({ providerId: 'mockoai', modelId: 'mock-large' });
    expect(v.sessions).toEqual([]);
    expect(v.capabilities).toMatchObject({ undo: false, share: false, mcpToggle: true });
    expect(v.commands.some((c) => c.name === 'greet')).toBe(false);
    await host.until((s) => s.mcp.some((m) => m.name === 'localmcp' && m.status === 'connected'), 20_000, 'local MCP').catch(async () => {
      await controller.handleMessage({ type: 'mcpRefresh' });
      await host.until((s) => s.mcp.some((m) => m.name === 'localmcp' && m.status === 'connected'), 20_000, 'local MCP after refresh');
    });

    await controller.handleMessage({ type: 'send', text: 'direct hello' });
    v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt));
    expect(texts(v.messages[1].parts)).toEqual(['MOCK[mock-large]: direct hello']);
    v = await host.until((s) => !!s.usage?.byModel.some((r) => r.engine === 'direct'), 10_000, 'direct usage row');
    expect(v.usage!.byModel.map((r) => r.engine)).toEqual(expect.arrayContaining(['opencode', 'direct']));
    expect(v.sessionUsage).toMatchObject({ engine: 'direct', messages: 1 });

    await controller.handleMessage({ type: 'send', text: '/undo' });
    expect(host.view!.notice!.text).toMatch(/not supported by the Direct BYOK engine/);

    await controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    v = await host.until((s) => s.engine === 'opencode' && !s.loading, 20_000, 'back to opencode');
    expect(v.sessions.length).toBeGreaterThan(0);
    expect(host.state.get('engine')).toBe('opencode');
  });

  it('explains what to do when an engine is not installed', async () => {
    await controller.handleMessage({ type: 'setEngine', engine: 'claude-code' });
    const v = await host.until((s) => s.engine === 'claude-code' && !s.loading, 20_000);
    expect(v.engines.find((e) => e.engine === 'claude-code')).toMatchObject({ state: 'unavailable' });
    await controller.handleMessage({ type: 'send', text: 'hi' });
    expect(host.view!.notice).toMatchObject({ level: 'error' });
    expect(host.view!.notice!.text).toMatch(/Claude Code CLI not found/);
    expect(host.view!.messages).toEqual([]);
    await controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    await host.until((s) => s.engine === 'opencode' && !s.loading, 20_000);
  });

  it('refuses to send in an untrusted workspace', async () => {
    host.trusted = false;
    await controller.handleMessage({ type: 'newSession' });
    await controller.handleMessage({ type: 'send', text: 'should not go out' });
    expect(host.view!.notice!.text).toMatch(/untrusted workspaces/);
    expect(host.view!.messages).toEqual([]);
    host.trusted = true;
  });

  it('adds a BYOK provider through the quick-pick flow and stores the key as a secret', async () => {
    host.pickByLabel(/Manage Direct BYOK/);
    host.pickByLabel(/OpenRouter/);
    host.inputs.push('sk-or-secret');
    await controller.manageProviders();
    const providers = ctx.settings.providers as { id: string; baseUrl: string }[];
    expect(providers.find((p) => p.id === 'openrouter')).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1' });
    expect(await ctx.secrets.get(secretKeyFor('openrouter'))).toBe('sk-or-secret');
    expect(JSON.stringify(ctx.settings)).not.toContain('sk-or-secret');
    (ctx.settings.providers as object[]).pop();
  });

  it('offers the terminal sign-in for subscription logins', async () => {
    host.pickByLabel(/Sign in with a subscription/);
    await controller.manageProviders();
    expect(host.terminals.pop()!.command).toMatch(/opencode(\.cmd|\.exe)?"? auth login$/i); // npm installs a .cmd shim on Windows
  });

  it('persists the usage ledger and resets it on request', async () => {
    await ledger.flush();
    const restored = new UsageLedger(ledgerStore);
    expect(restored.summary().total.input).toBe(ledger.summary().total.input);
    expect(restored.summary().byModel.length).toBeGreaterThanOrEqual(3);
    host.confirms.push(true);
    await controller.handleMessage({ type: 'usageReset' });
    expect(host.view!.usage!.total.input).toBe(0);
    expect(host.view!.usage!.byModel).toEqual([]);
  });
});

describe('ChatController in an untrusted workspace', () => {
  it('starts no engine until the workspace is trusted', async () => {
    const mock = createMockLlm();
    const port = await mock.listen();
    const ctx = makeContext({ cwd: process.cwd(), settings: { defaultEngine: 'direct', providers: [{ id: 'mockoai', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` }] } });
    const host = new FakeHost(ctx);
    host.trusted = false;
    const mcp = new McpManager({ log: ctx.log, cwd: ctx.cwd, readConfig: () => ({}), writeEnabled: async () => undefined });
    const direct = new DirectEngine(ctx, mcp);
    let starts = 0;
    const start = direct.start.bind(direct);
    direct.start = () => (starts++, start());
    const controller = new ChatController(new Map<EngineId, Engine>([['direct', direct]]), new UsageLedger(new MemoryStore()), host);
    await controller.handleMessage({ type: 'ready' });
    await controller.activate();
    expect(starts).toBe(0);
    expect(host.view).toMatchObject({ trusted: false, loading: false, providers: [], sessions: [] });
    await controller.restartEngine();
    await controller.handleMessage({ type: 'send', text: 'hi' });
    expect(starts).toBe(0);
    expect(mock.log.length).toBe(0);

    host.trusted = true;
    await controller.onTrustChanged();
    expect(starts).toBe(1);
    expect(host.view).toMatchObject({ trusted: true, loading: false });
    expect(host.view!.providers.map((p) => p.id)).toEqual(['mockoai']);
    await controller.handleMessage({ type: 'send', text: 'now it works' });
    await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt));
    controller.dispose();
    await direct.dispose();
    await mcp.dispose();
    await mock.close();
    ctx.cleanup();
  });
});
