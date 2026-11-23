import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { CatalogCache } from '../../src/core/catalogCache';
import type { Engine } from '../../src/core/engine';
import { killTree, spawnCli } from '../../src/core/process';
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
import { multiAttachments } from '../helpers/attachments';
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
  let mock: { listen(): Promise<number>; close(): Promise<void>; log: { path: string; body: Record<string, unknown> }[]; models: string[] };
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

  it('messages the extension wrote itself can be closed; replies from a model cannot', async () => {
    const local = host.view!.messages.at(-1)!;
    expect(local.id.startsWith('local_')).toBe(true);
    const count = host.view!.messages.length;
    const reply = host.view!.messages.find((m) => m.role === 'assistant' && !m.id.startsWith('local_'))!;
    await controller.handleMessage({ type: 'dismissMessage', id: reply.id });
    expect(host.view!.messages).toHaveLength(count);
    await controller.handleMessage({ type: 'dismissMessage', id: local.id });
    expect(host.view!.messages).toHaveLength(count - 1);
    expect(host.view!.messages.some((m) => m.id === local.id)).toBe(false);
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

  it('several attachments added one by one all go out with the next message (opencode)', async () => {
    const { attachments, markers } = multiAttachments(path.join(project.dir, 'multi'));
    await controller.handleMessage({ type: 'addPaths', paths: [attachments[0].path!, attachments[1].path!] });
    await controller.handleMessage({ type: 'addAttachment', attachment: attachments[2] });
    expect(host.view!.attachments.map((a) => a.name)).toEqual(['multi/alpha.ts', 'multi/beta.md', 'gamma.py:2-2']);
    const before = mock.log.length;
    const replies = host.view!.messages.filter((m) => m.role === 'assistant' && m.completedAt).length;
    await controller.handleMessage({ type: 'send', text: 'compare these three' });
    await host.until((v) => v.activity === 'idle' && v.messages.filter((m) => m.role === 'assistant' && m.completedAt).length > replies, 60_000, 'reply');
    expect(host.view!.attachments).toEqual([]);
    const sent = JSON.stringify(mock.log.slice(before).filter((l) => l.path === '/chat/completions').map((l) => l.body.messages));
    expect(sent).toContain('compare these three');
    for (const m of markers) expect(sent, `opencode missing ${m}`).toContain(m);
  });

  it('offers the file open in the editor as context, and its selected lines when there are some', async () => {
    const file = path.join(project.dir, 'hello.txt');
    controller.setActiveFile({ path: file, name: 'hello.txt' });
    expect(host.view!.activeFile).toEqual({ path: file, name: 'hello.txt' });
    host.editorFile = { id: '', kind: 'file', name: 'hello.txt', mime: 'text/plain', path: file };
    await controller.handleMessage({ type: 'addActiveFile' });
    expect(host.view!.attachments).toMatchObject([{ kind: 'file', name: 'hello.txt', path: file }]);
    // Adding it twice does not attach it twice.
    await controller.handleMessage({ type: 'addActiveFile' });
    expect(host.view!.attachments).toHaveLength(1);
    // With a selection, the selected lines go in.
    host.editorFile = { id: '', kind: 'selection', name: 'hello.txt:1-1', mime: 'text/plain', path: file, text: 'the secret word is pineapple', range: { startLine: 1, endLine: 1 } };
    await controller.handleMessage({ type: 'addActiveFile' });
    expect(host.view!.attachments.map((a) => a.name)).toEqual(['hello.txt', 'hello.txt:1-1']);
    for (const a of host.view!.attachments) await controller.handleMessage({ type: 'removeAttachment', id: a.id });
    // No file open: nothing to add, and the user is told.
    host.editorFile = undefined;
    await controller.handleMessage({ type: 'addActiveFile' });
    expect(host.view!.attachments).toHaveLength(0);
    expect(host.view!.notice?.text).toMatch(/Open a file/);
    controller.setActiveFile(undefined);
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

  it('one history for every engine: other engines\' saved sessions are listed and open in their engine', async () => {
    // A Direct BYOK session saved earlier, while opencode is the active engine.
    const direct = engines.get('direct')!;
    const saved = await direct.createSession('Saved with BYOK');
    await controller.handleMessage({ type: 'sessionsRefresh' });
    const v = await host.until((s) => s.otherSessions.some((x) => x.id === saved.id), 10_000, 'other sessions');
    expect(v.otherSessions.find((x) => x.id === saved.id)).toMatchObject({ engine: 'direct', title: 'Saved with BYOK' });
    expect(v.sessions.every((x) => x.engine === 'opencode')).toBe(true);

    await controller.handleMessage({ type: 'switchSession', sessionId: saved.id, engine: 'direct' });
    const opened = await host.until((s) => s.engine === 'direct' && s.sessionId === saved.id && !s.loading, 30_000, 'switch to the BYOK session');
    expect(opened.otherSessions.some((x) => x.engine === 'opencode')).toBe(true);
    await controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    await host.until((s) => s.engine === 'opencode' && !s.loading, 30_000);
    // Leave no BYOK session behind for the tests that follow.
    await direct.deleteSession(saved.id);
    await host.state.update('session.direct', undefined);
  });

  it('carries another session into a new chat as condensed context, only when asked', async () => {
    // A clean source session: earlier tests left mock directives such as [[tool:…]] in the
    // main one, and the mock model would act on them again when they come back as context.
    const original = host.view!.sessionId!;
    await controller.handleMessage({ type: 'newSession' });
    await controller.handleMessage({ type: 'send', text: 'the codename is pineapple' });
    await host.until((x) => x.activity === 'idle' && x.messages.some((m) => m.role === 'assistant' && m.completedAt), 60_000, 'source reply');
    const source = host.view!.sessionId!;
    const sourceTitle = host.view!.sessions.find((x) => x.id === source)!.title;
    // The session you are in is not attached to itself.
    await controller.handleMessage({ type: 'attachSession', sessionId: source });
    expect(host.view!.attachments).toHaveLength(0);

    await controller.handleMessage({ type: 'newSession' });
    expect(host.view!.attachments).toHaveLength(0); // a new chat starts clean
    await controller.handleMessage({ type: 'attachSession', sessionId: source, engine: 'opencode' });
    const v = await host.until((x) => x.attachments.length === 1, 10_000, 'session attachment');
    expect(v.attachments[0].name).toBe(`Session: ${sourceTitle}`);
    expect(v.attachments[0].text).toContain('Context from an earlier chat session');
    expect(v.attachments[0].text).toContain('### User');
    expect(v.attachments[0].text).toContain('### Assistant');
    expect(v.notice?.text).toMatch(/as context for your next message/);

    const calls = mock.log.length;
    await controller.handleMessage({ type: 'send', text: 'continue from there' });
    await host.until((x) => x.activity === 'idle' && x.messages.some((m) => m.role === 'assistant' && m.completedAt), 60_000, 'reply with context');
    // The model received the condensed session together with the new message.
    const sent = JSON.stringify(mock.log.slice(calls).map((l) => l.body));
    expect(sent).toContain('Context from an earlier chat session');
    expect(sent).toContain('the codename is pineapple');
    expect(host.view!.attachments).toHaveLength(0);

    await controller.handleMessage({ type: 'newSession' });
    // /context offers every other saved session in a picker.
    host.picks = [(items) => items.find((i) => (i.value as { id: string }).id === source)?.value];
    await controller.handleMessage({ type: 'send', text: '/context' });
    const w = await host.until((x) => x.attachments.length >= 1, 10_000, '/context attachment');
    expect(w.attachments[0].name).toContain('Session: ');
    await controller.handleMessage({ type: 'removeAttachment', id: w.attachments[0].id });
    await controller.handleMessage({ type: 'switchSession', sessionId: original });
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

  it('effort: chosen in the picker or with /effort, sent with the message, kept per engine', async () => {
    const sent = () => mock.log.filter((l) => l.path === '/chat/completions' && JSON.stringify(l.body.messages).includes('effort probe')).map((l) => l.body.reasoning_effort);
    // mock-large has two levels (opencode calls them variants); mock-small has none.
    await controller.handleMessage({ type: 'setModel', model: { providerId: 'mock', modelId: 'mock-large' } });
    expect(host.view!.providers.find((p) => p.id === 'mock')!.models.find((m) => m.modelId === 'mock-large')!.efforts!.map((e) => e.id)).toEqual(expect.arrayContaining(['low', 'high']));
    expect(host.view!.effort).toBeUndefined();
    await controller.handleMessage({ type: 'setEffort', effort: 'high' });
    expect(host.view!.effort).toBe('high');
    expect(host.state.get('effort.opencode')).toBe('high');
    await controller.handleMessage({ type: 'send', text: 'effort probe one' });
    await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt && texts(m.parts).join('').includes('effort probe one')));
    expect(sent().at(-1)).toBe('high');

    await controller.handleMessage({ type: 'send', text: '/effort low' });
    expect(host.view!.effort).toBe('low');
    expect(host.view!.notice).toMatchObject({ level: 'info', text: 'Effort: Low' });
    await controller.handleMessage({ type: 'send', text: '/effort' });
    expect(host.view!.notice!.text).toMatch(/^Effort for Mock Large: Low\. Levels: .*low.*high/);
    // A level the model does not have is refused, in the picker's message and in the command.
    await controller.handleMessage({ type: 'send', text: '/effort ultra' });
    expect(host.view!.notice).toMatchObject({ level: 'warn' });
    await controller.handleMessage({ type: 'setEffort', effort: 'ultra' });
    expect(host.view!.effort).toBe('low');

    // A model without the setting: nothing is sent, and the choice comes back with the model that has it.
    await controller.handleMessage({ type: 'setModel', model: { providerId: 'mock', modelId: 'mock-small' } });
    expect(host.view!.effort).toBeUndefined();
    await controller.handleMessage({ type: 'send', text: '/effort high' });
    expect(host.view!.notice!.text).toMatch(/has no effort setting/);
    await controller.handleMessage({ type: 'send', text: 'effort probe two' });
    await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt && texts(m.parts).join('').includes('effort probe two')));
    expect(sent().at(-1)).toBeUndefined();
    await controller.handleMessage({ type: 'setModel', model: { providerId: 'mock', modelId: 'mock-large' } });
    expect(host.view!.effort).toBe('low');

    await controller.handleMessage({ type: 'send', text: '/effort default' });
    expect(host.view!.effort).toBeUndefined();
    expect(host.state.get('effort.opencode')).toBeUndefined();
    await controller.handleMessage({ type: 'send', text: 'effort probe three' });
    await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt && texts(m.parts).join('').includes('effort probe three')));
    expect(sent().at(-1)).toBeUndefined();
    await controller.handleMessage({ type: 'setModel', model: { providerId: 'mock', modelId: 'mock-small' } });
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

  it('send later: a message waits for its time, then is sent in its own conversation', async () => {
    controller.scheduleRetryMs = 300;
    await controller.handleMessage({ type: 'newSession' });
    await controller.handleMessage({ type: 'send', text: 'first, right away' });
    let v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt), 60_000, 'first reply');
    const home = v.sessionId!;
    const file = path.join(project.dir, 'later.txt');
    writeFileSync(file, 'LATER_MARKER');
    await controller.handleMessage({ type: 'addPaths', paths: [file] });
    const before = Date.now();
    await controller.handleMessage({ type: 'schedule', text: 'later, please', at: before + 2500 });
    v = host.view!;
    expect(v.scheduled).toMatchObject([{ engine: 'opencode', sessionId: home, text: 'later, please', model: v.model, agent: v.agent }]);
    expect(v.scheduled[0].attachments.map((a) => a.name)).toEqual(['later.txt']);
    expect(v.scheduled[0].sendAt).toBe(before + 2500);
    // The attachment went with it; the message box is free for the next message.
    expect(v.attachments).toEqual([]);
    expect(v.notice!.text).toMatch(/^Scheduled for today at \d\d:\d\d \(in less than a minute\)\. VS Code has to be open then\.$/);
    // Kept in VS Code's storage on this machine, so it survives a restart.
    expect(host.state.get<unknown[]>('sendLater')).toHaveLength(1);
    // Nothing is sent before its time, and the user can go on in another conversation.
    await controller.handleMessage({ type: 'newSession' });
    await controller.handleMessage({ type: 'addPaths', paths: [path.join(project.dir, 'opencode.json')] });
    expect(host.view!.sessionId).toBeUndefined();
    expect(host.view!.scheduled).toHaveLength(1);
    // When the time comes the chat opens that conversation and sends the message, attachment included.
    const sentAt = mock.log.length;
    await host.until((s) => s.scheduled.length === 0 && s.sessionId === home && s.messages.some((m) => m.role === 'user' && texts(m.parts).join('') === 'later, please'), 30_000, 'the scheduled message to be sent');
    expect(Date.now()).toBeGreaterThanOrEqual(before + 2400);
    v = await host.until((s) => s.activity === 'idle' && texts(s.messages.at(-1)!.parts).join('').includes('later, please'), 60_000, 'the reply to it');
    expect(JSON.stringify(mock.log.slice(sentAt).map((l) => l.body))).toContain('LATER_MARKER');
    expect(host.state.get<unknown[]>('sendLater')).toEqual([]);
    // What the user was attaching in the meantime is still in the message box.
    expect(v.attachments.map((a) => a.name)).toEqual(['opencode.json']);
    await controller.handleMessage({ type: 'removeAttachment', id: v.attachments[0].id });
  });

  it('send later: /later, queueing behind a reply, changing the time, editing and cancelling', async () => {
    controller.scheduleRetryMs = 300;
    await controller.handleMessage({ type: 'newSession' });
    // A time the chat cannot read, and a time with no message.
    await controller.handleMessage({ type: 'send', text: '/later sometime do it' });
    expect(host.view!.notice).toMatchObject({ level: 'warn' });
    expect(host.view!.notice!.text).toMatch(/^Start with when to send it/);
    await controller.handleMessage({ type: 'send', text: '/later 30m' });
    expect(host.view!.notice!.text).toMatch(/^Add the message after the time/);
    expect(host.view!.scheduled).toEqual([]);

    // Queue a message behind a reply that is still being written.
    await controller.handleMessage({ type: 'send', text: 'count slowly and carefully from one to twenty please [[slow]]' });
    let v = await host.until((s) => s.activity !== 'idle' && s.messages.some((m) => m.role === 'assistant'), 30_000, 'reply started');
    const session = v.sessionId!;
    await controller.handleMessage({ type: 'send', text: '/later next and now the follow-up' });
    expect(host.view!.notice!.text).toBe('It will be sent when this reply is done.');
    expect(host.view!.scheduled).toMatchObject([{ text: 'and now the follow-up', sessionId: session }]);
    // Still the first reply: nothing was interrupted.
    expect(host.view!.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    v = await host.until((s) => s.messages.filter((m) => m.role === 'user').length === 2 && s.scheduled.length === 0, 60_000, 'the queued message to follow');
    expect(texts(v.messages.filter((m) => m.role === 'user')[1].parts).join('')).toBe('and now the follow-up');
    // It was sent after the first reply had finished, not into it.
    expect(v.messages.filter((m) => m.role === 'assistant')[0].completedAt).toBeDefined();
    await host.until((s) => s.activity === 'idle', 60_000, 'the follow-up to finish');

    // Stop means stop: a message queued behind a reply the user stops waits for the user.
    await controller.handleMessage({ type: 'send', text: 'count slowly and carefully from one to twenty please [[slow]]' });
    await host.until((s) => s.activity !== 'idle', 30_000, 'second slow reply');
    await controller.handleMessage({ type: 'schedule', text: 'do not send this by yourself', at: Date.now() });
    await controller.handleMessage({ type: 'abort' });
    v = await host.until((s) => s.activity === 'idle' && !!s.scheduled[0]?.problem, 30_000, 'the queued message to be held');
    expect(v.scheduled[0].problem).toBe('You stopped the reply it was waiting for.');
    await sleep(900);
    expect(host.view!.scheduled).toHaveLength(1);
    const users = host.view!.messages.filter((m) => m.role === 'user').length;
    // Send now sends it.
    await controller.handleMessage({ type: 'scheduledSendNow', id: v.scheduled[0].id });
    await host.until((s) => s.scheduled.length === 0 && s.messages.filter((m) => m.role === 'user').length === users + 1, 30_000, 'send now');
    await host.until((s) => s.activity === 'idle', 60_000, 'its reply');

    // Later today: change the time, take it back into the message box, cancel another.
    await controller.handleMessage({ type: 'send', text: '/later 2h run the nightly checks' });
    await controller.handleMessage({ type: 'send', text: '/later tomorrow 9am write the summary' });
    v = host.view!;
    expect(v.scheduled.map((m) => m.text)).toEqual(['run the nightly checks', 'write the summary']);
    const [nightly, summary] = v.scheduled;
    expect(Math.abs(nightly.sendAt - (Date.now() + 2 * 3600_000))).toBeLessThan(5000);
    expect(new Date(summary.sendAt).getHours()).toBe(9);
    await controller.handleMessage({ type: 'scheduledReschedule', id: nightly.id, at: summary.sendAt + 3600_000 });
    // Soonest first.
    expect(host.view!.scheduled.map((m) => m.text)).toEqual(['write the summary', 'run the nightly checks']);
    const posted = host.posted.length;
    await controller.handleMessage({ type: 'scheduledEdit', id: summary.id });
    expect(host.posted.slice(posted)).toContainEqual({ type: 'insertText', text: 'write the summary' });
    await controller.handleMessage({ type: 'scheduledCancel', id: nightly.id });
    expect(host.view!.scheduled).toEqual([]);
    expect(host.state.get<unknown[]>('sendLater')).toEqual([]);
    // Too far away, and not in an untrusted workspace.
    await controller.handleMessage({ type: 'schedule', text: 'far', at: Date.now() + 90 * 86_400_000 });
    expect(host.view!.notice!.text).toMatch(/more than 60 days away/);
    expect(host.view!.scheduled).toEqual([]);
    await controller.handleMessage({ type: 'send', text: '/later' });
    expect(host.view!.notice!.text).toMatch(/^Send a message later with \/later <when> <message>/);
  });

  it('send later: scheduled messages come back after a restart, and missed ones wait when that is the setting', async () => {
    const now = Date.now();
    const saved = [
      { id: 'later_missed', engine: 'opencode', text: 'was due an hour ago', attachments: [], sendAt: now - 3600_000, createdAt: now - 7200_000 },
      { id: 'later_future', engine: 'opencode', text: 'due tomorrow', attachments: [], sendAt: now + 86_400_000, createdAt: now },
      { id: 'later_gone', engine: 'not-an-engine', text: 'engine removed', attachments: [], sendAt: now + 1000, createdAt: now },
      { nonsense: true },
    ];
    const restart = (sendMissed: boolean) => {
      const store = new MemoryStore();
      void store.update('sendLater', saved);
      const h = new FakeHost(ctx);
      h.state = store;
      ctx.settings['chat.sendLater.sendMissed'] = sendMissed;
      const c = new ChatController(engines, new UsageLedger(new MemoryStore()), h);
      const scheduled = c.viewState.scheduled;
      c.dispose();
      delete ctx.settings['chat.sendLater.sendMissed'];
      return scheduled;
    };
    // By default a missed message is sent when the chat is running again: it is simply due.
    expect(restart(true).map((m) => [m.id, m.held])).toEqual([['later_missed', undefined], ['later_future', undefined]]);
    // Turned off: it waits under Scheduled until the user sends it.
    expect(restart(false).map((m) => [m.id, m.held])).toEqual([['later_missed', true], ['later_future', undefined]]);
  });

  it('/preview asks for a visual answer: the instructions go to the model, the chat shows the request', async () => {
    await controller.handleMessage({ type: 'newSession' });
    await controller.handleMessage({ type: 'send', text: '/preview' });
    expect(host.view!.notice!.text).toMatch(/^Ask for a visual answer with \/preview <request>/);
    const before = mock.log.length;
    await controller.handleMessage({ type: 'send', text: '/preview a chart of the build times' });
    const v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => m.role === 'assistant' && !!m.completedAt), 60_000, 'reply');
    const sent = texts(v.messages[0].parts).join('');
    expect(sent.startsWith('a chart of the build times\n\n<!-- opencode-hub: html-preview -->')).toBe(true);
    expect(JSON.stringify(mock.log.slice(before).map((l) => l.body))).toContain('fenced code block whose language is `html-preview`');
    expect(v.htmlPreview).toBe(true);
    // Saving a preview goes through the host's save dialog.
    await controller.handleMessage({ type: 'saveHtml', html: '<!DOCTYPE html><p>x</p>' });
    expect(host.saved.at(-1)).toEqual({ name: 'preview.html', content: '<!DOCTYPE html><p>x</p>' });
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

    // The model asks before it goes on: the questions show up in the chat, and the answers
    // (a typed one here) go back to it. Nothing is asked for approval on the way.
    const ask = { questions: [{ question: 'Which port?', header: 'Port', options: [{ label: '3000' }, { label: '8080' }] }, { question: 'TLS?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
    await controller.handleMessage({ type: 'send', text: `set it up [[tool:ask_user ${JSON.stringify(ask)}]]` });
    v = await host.until((s) => s.questions.length === 1, 20_000, 'question from the model');
    expect(v.questions[0].questions.map((q) => q.question)).toEqual(['Which port?', 'TLS?']);
    expect(v.permissions).toEqual([]);
    expect(v.activity).not.toBe('idle');
    await controller.handleMessage({ type: 'questionReply', requestId: v.questions[0].id, answers: [['4321, it is the only free one'], ['Yes']] });
    v = await host.until((s) => s.activity === 'idle' && s.questions.length === 0 && s.messages.some((m) => texts(m.parts).join('').includes('TOOL_RESULT')), 20_000, 'answer read back');
    expect(texts(v.messages.at(-1)!.parts).join('')).toBe('TOOL_RESULT: Q: Which port?\nA: 4321, it is the only free one\n\nQ: TLS?\nA: Yes');

    await controller.handleMessage({ type: 'send', text: '/undo' });
    expect(host.view!.notice!.text).toMatch(/not supported by the Direct BYOK engine/);

    await controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    v = await host.until((s) => s.engine === 'opencode' && !s.loading, 20_000, 'back to opencode');
    expect(v.sessions.length).toBeGreaterThan(0);
    expect(host.state.get('engine')).toBe('opencode');
  });

  it('shows the models an engine listed last time at once, and replaces them when the fresh list arrives', async () => {
    // Hold back an engine's answer, to see what the chat shows while it is still asking.
    const hold = (engine: Engine) => {
      const real = engine.listProviders.bind(engine);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let asked = 0;
      engine.listProviders = async () => {
        asked++;
        await gate;
        return real();
      };
      return { release, asked: () => asked, restore: () => void (engine.listProviders = real) };
    };

    // Switching to an engine used before: its models and the selected one are there while it is still being asked.
    const direct = engines.get('direct')!;
    let held = hold(direct);
    let switching = controller.handleMessage({ type: 'setEngine', engine: 'direct' });
    let v = await host.until((s) => s.engine === 'direct' && s.providers.some((p) => p.id === 'mockoai' && p.models.length > 0) && !!s.model, 10_000, 'saved Direct BYOK models');
    expect(v.loading).toBe(true);
    expect(v.model).toEqual({ providerId: 'mockoai', modelId: 'mock-large' });
    held.release();
    await switching;
    held.restore();
    expect(held.asked()).toBeGreaterThan(0);
    expect(host.view!.loading).toBe(false);
    expect(host.view!.providers.map((p) => p.id)).toEqual(['mockoai']);

    const opencode = engines.get('opencode')!;
    held = hold(opencode);
    switching = controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    v = await host.until((s) => s.engine === 'opencode' && s.providers.some((p) => p.id === 'mock') && !!s.model && s.agents.length > 0, 10_000, 'saved opencode models');
    expect(v.loading).toBe(true);
    expect(v.commands.some((c) => c.name === 'greet')).toBe(true);
    held.release();
    await switching;
    held.restore();

    // A new window (new controller, new engine object, nothing in memory) reads the saved list from disk.
    await controller.flush();
    const host2 = new FakeHost(ctx);
    await host2.state.update('engine', 'direct');
    const direct2 = new DirectEngine(ctx, mcp);
    held = hold(direct2);
    const controller2 = new ChatController(new Map<EngineId, Engine>([['direct', direct2]]), new UsageLedger(new MemoryStore()), host2);
    try {
      await controller2.handleMessage({ type: 'ready' });
      const activating = controller2.activate();
      const v2 = await host2.until((s) => s.providers.some((p) => p.id === 'mockoai' && p.models.some((m) => m.modelId === 'mock-small')) && !!s.model, 10_000, 'models from the saved list');
      expect(v2.loading).toBe(true);
      // No model was chosen in this window, so the one that was selected when the list was saved is.
      expect(v2.model).toEqual({ providerId: 'mockoai', modelId: 'mock-large' });
      held.release();
      await activating;
      expect(host2.view!.loading).toBe(false);
      expect(host2.view!.providers.map((p) => p.id)).toEqual(['mockoai']);
    } finally {
      held.release();
      controller2.dispose();
      await direct2.dispose();
    }
  });

  it('picks up a model its provider has just released, and lets go of one it retired, without a restart', async () => {
    const direct = engines.get('direct') as DirectEngine;
    const ids = (v = host.view!) => v.providers.flatMap((p) => p.models.map((m) => m.modelId));
    await controller.handleMessage({ type: 'setEngine', engine: 'direct' });
    expect(ids()).toEqual(['mock-large', 'mock-small']);
    await controller.handleMessage({ type: 'setModel', model: { providerId: 'mockoai', modelId: 'mock-large' } });
    const asked = () => mock.log.filter((l) => l.path === '/models').length;
    try {
      // The provider releases a model. Nothing happens by itself within the same few seconds…
      mock.models.push('mock-next');
      let before = asked();
      await controller.handleMessage({ type: 'modelsShown' });
      await new Promise((r) => setTimeout(r, 400));
      expect(asked()).toBe(before);
      expect(ids()).not.toContain('mock-next');

      // …but opening the model picker a little later asks the provider again.
      direct.modelRecheckMs = 0;
      controller.modelCheckIntervalMs = 0;
      await controller.handleMessage({ type: 'modelsShown' });
      let v = await host.until((s) => ids(s).includes('mock-next'), 10_000, 'the new model in the picker');
      expect(ids(v)).toEqual(['mock-large', 'mock-next', 'mock-small']);
      expect(v.model).toEqual({ providerId: 'mockoai', modelId: 'mock-large' });
      expect(asked()).toBe(before + 1);
      // It can be used straight away.
      await controller.handleMessage({ type: 'setModel', model: { providerId: 'mockoai', modelId: 'mock-next' } });
      await controller.handleMessage({ type: 'send', text: 'hello new model' });
      v = await host.until((s) => s.activity === 'idle' && s.messages.some((m) => texts(m.parts).join('') === 'MOCK[mock-next]: hello new model'), 20_000, 'a reply from the new model');

      // So does a window that was simply left open: the next time it comes into view after a while…
      mock.models.push('mock-later');
      controller.catalogMaxAgeMs = 0;
      controller.onShown();
      await host.until((s) => ids(s).includes('mock-later'), 10_000, 'the model released while the window was open');
      // …or when a reply finishes.
      mock.models.push('mock-latest');
      await controller.handleMessage({ type: 'send', text: 'and one more' });
      await host.until((s) => ids(s).includes('mock-latest'), 20_000, 'the model released during a conversation');

      // The provider retires the selected model: it leaves the list and another one is selected.
      mock.models.splice(mock.models.indexOf('mock-next'), 1);
      await host.until((s) => s.activity === 'idle');
      await controller.handleMessage({ type: 'modelsShown' });
      v = await host.until((s) => !ids(s).includes('mock-next'), 10_000, 'the retired model gone');
      expect(ids(v)).toEqual(['mock-large', 'mock-later', 'mock-latest', 'mock-small']);
      expect(v.model).toEqual({ providerId: 'mockoai', modelId: 'mock-large' });

      // A provider that cannot be reached keeps the list it had.
      before = asked();
      const real = ctx.settings['providers'];
      ctx.settings['providers'] = (real as { id: string; baseUrl: string }[]).map((p) => (p.id === 'mockoai' ? { ...p, baseUrl: 'http://127.0.0.1:9/v1' } : p));
      await controller.handleMessage({ type: 'modelsShown' });
      await new Promise((r) => setTimeout(r, 600));
      ctx.settings['providers'] = real;
      expect(ids()).toEqual(['mock-large', 'mock-later', 'mock-latest', 'mock-small']);

      // The saved copy that the next window starts from has the new list too.
      await controller.handleMessage({ type: 'modelsShown' });
      await host.until(() => asked() > before, 10_000, 'the provider asked again');
      await controller.flush();
      const saved = await new CatalogCache(path.join(ctx.storageDir, 'catalog')).get('direct', host.cwd());
      expect(saved!.providers.flatMap((p) => p.models.map((m) => m.modelId))).toEqual(['mock-large', 'mock-later', 'mock-latest', 'mock-small']);
    } finally {
      mock.models.splice(0, mock.models.length, 'mock-small', 'mock-large');
      direct.modelRecheckMs = 10_000;
      controller.modelCheckIntervalMs = 15_000;
      controller.catalogMaxAgeMs = 10 * 60_000;
      direct.invalidateModels();
      await controller.handleMessage({ type: 'setEngine', engine: 'opencode' });
    }
  });

  it('opencode: opening the model picker asks the server again, so its catalogue is never a stale copy', async () => {
    const opencode = engines.get('opencode')!;
    const real = opencode.listProviders.bind(opencode);
    let asked = 0;
    // The server now reports one more model than a moment ago, as it does after its catalogue updates.
    opencode.listProviders = async () => {
      asked++;
      const providers = await real();
      return providers.map((p) => (p.id === 'mock' ? { ...p, models: [...p.models, { providerId: 'mock', modelId: 'mock-brand-new', name: 'Mock Brand New' }] } : p));
    };
    controller.modelCheckIntervalMs = 0;
    try {
      await controller.handleMessage({ type: 'modelsShown' });
      const v = await host.until((s) => s.providers.some((p) => p.models.some((m) => m.modelId === 'mock-brand-new')), 10_000, 'the model the server now lists');
      expect(asked).toBeGreaterThan(0);
      expect(v.model).toEqual(host.state.get('model.opencode'));
    } finally {
      opencode.listProviders = real;
      await controller.handleMessage({ type: 'modelsShown' });
      await host.until((s) => !s.providers.some((p) => p.models.some((m) => m.modelId === 'mock-brand-new')), 10_000, 'back to the real list');
      controller.modelCheckIntervalMs = 15_000;
    }
  });

  it('/feedback opens the form with diagnostics, and sending it opens a pre-filled GitHub issue', async () => {
    host.opened = [];
    await controller.handleMessage({ type: 'send', text: '/feedback idea a cape for Oki' });
    let v = await host.until((x) => x.panel.name === 'feedback', 5000, 'feedback panel');
    expect(v.feedbackDraft).toEqual({ kind: 'idea', text: 'a cape for Oki' });
    expect(v.diagnostics).toContain('- OpenCode Hub: 9.9.9');
    expect(v.diagnostics).toContain('- OS: Linux x64 (6.0.0-test)');
    expect(v.diagnostics).not.toContain(project.dir);

    await controller.handleMessage({ type: 'feedback', kind: 'idea', title: '', description: 'a cape for Oki', includeDiagnostics: true });
    const url = new URL(host.opened[0]);
    expect(url.origin + url.pathname).toBe('https://github.com/example/opencode-hub/issues/new');
    expect(url.searchParams.get('template')).toBe('feature_request.yml');
    expect(url.searchParams.get('title')).toBe('Idea: a cape for Oki');
    expect(url.searchParams.get('diagnostics')).toContain('- OpenCode Hub: 9.9.9');
    // A card stays in the chat: what to do next, and what GitHub's bare "Unable to create issue" means.
    v = await host.until((x) => texts(x.messages.at(-1)?.parts ?? []).join('').includes('Your feedback is open on GitHub'), 5000, 'confirmation card');
    expect(v.feedbackDraft).toBeUndefined();
    const card = v.messages.at(-1)!;
    expect(card.id.startsWith('local_')).toBe(true);
    const cardText = texts(card.parts).join('');
    expect(cardText).toContain('company-managed GitHub account');
    expect(cardText).toContain(`(${host.opened[0]})`);
    // "/feedback link" copies the same pre-filled link, for a browser with another account.
    host.copied = [];
    await controller.handleMessage({ type: 'send', text: '/feedback link' });
    expect(host.copied).toEqual([host.opened[0]]);
    expect(host.view!.notice?.text).toMatch(/Link copied/);
    await controller.handleMessage({ type: 'dismissMessage', id: card.id });

    // "Copy link" in the form: nothing opens, the link goes to the clipboard.
    host.opened = [];
    host.copied = [];
    await controller.handleMessage({ type: 'feedback', kind: 'bug', title: 'Managed account', description: 'cannot post', includeDiagnostics: false, copyLink: true });
    expect(host.opened).toEqual([]);
    expect(new URL(host.copied[0]).searchParams.get('title')).toBe('Bug: Managed account');

    // Without diagnostics nothing about the setup is attached, and empty feedback goes nowhere.
    host.opened = [];
    await controller.handleMessage({ type: 'feedback', kind: 'bug', title: 'Broken', description: '', includeDiagnostics: false });
    expect(new URL(host.opened[0]).searchParams.has('diagnostics')).toBe(false);
    host.opened = [];
    await controller.handleMessage({ type: 'feedback', kind: 'bug', title: ' ', description: ' ', includeDiagnostics: true });
    expect(host.opened).toEqual([]);

    // "Report a problem" under a failed reply opens the bug form.
    await controller.handleMessage({ type: 'openFeedback', kind: 'bug' });
    v = await host.until((x) => x.panel.name === 'feedback' && x.feedbackDraft?.kind === 'bug', 5000, 'bug form');
    expect(v.feedbackDraft?.text).toBe('');
  });

  it('/doctor reports versions and every engine without calling the model', async () => {
    const calls = mock.log.length;
    const before = host.view!.messages.length;
    await controller.handleMessage({ type: 'send', text: '/doctor' });
    const v = await host.until((x) => x.messages.length > before, 5000, 'doctor output');
    const text = texts(v.messages[v.messages.length - 1].parts).join('');
    expect(text).toContain('OpenCode Hub doctor');
    expect(text).toContain('Version: 9.9.9');
    expect(text).toMatch(/\| opencode.*\| ready \|/);
    expect(text).toMatch(/\| Claude Code \|/);
    expect(mock.log.length).toBe(calls);
  });

  it('shows the models of a subscription signed in from a terminal, without a restart', async () => {
    // What `opencode auth login` writes after a ChatGPT sign-in, from its own process, while
    // the server the extension started keeps running.
    const engine = engines.get('opencode') as OpencodeEngine;
    const file = engine.credentialsFile();
    expect(file).toBe(path.join(project.env.XDG_DATA_HOME!, 'opencode', 'auth.json'));
    expect(host.view!.providers.some((p) => p.id === 'openai' && p.models.length > 0)).toBe(false);
    const model = host.view!.model;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ openai: { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 3_600_000 } }));
    try {
      const v = await host.until((x) => x.providers.some((p) => p.id === 'openai' && p.models.length > 0), 20_000, 'OpenAI models after the terminal sign-in');
      expect(v.providers.find((p) => p.id === 'openai')!.models.some((m) => /gpt/i.test(m.modelId))).toBe(true);
      expect(v.notice?.text).toMatch(/^Connected: OpenAI \(\d+ models\)/);
      // The model the user had picked stays picked.
      expect(v.model).toEqual(model);
    } finally {
      // Signing out in the terminal takes the models away again.
      rmSync(file, { force: true });
      await host.until((x) => !x.providers.some((p) => p.id === 'openai' && p.models.length > 0), 20_000, 'OpenAI gone after sign-out');
    }
  });

  it('shows the models of an integration sign-in (OpenCode Console, newer CLIs) made in another opencode process', async () => {
    // Newer opencode CLIs keep sign-ins as "integrations" in opencode's database, not in
    // auth.json. A second opencode process in the same data folder stands in for the
    // terminal where the user ran `opencode auth login`.
    const already = host.view!.providers.some((p) => p.id === 'deepseek');
    // spawnCli: on Windows npm installs opencode as a .cmd shim, which needs a shell.
    const other = spawnCli(bin!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project.dir, env: project.env });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`second opencode did not start: ${out}`)), 45_000);
        other.stdout.on('data', (d) => {
          out += String(d);
          const m = /listening on\s+(https?:\/\/\S+)/i.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
      });
      // Two opencode processes share one SQLite database, which can be busy for a moment: retry.
      let res: Response | undefined;
      let why = '';
      for (let i = 0; i < 10; i++) {
        res = await fetch(`${url}/api/integration/deepseek/connect/key?directory=${encodeURIComponent(project.dir)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sk-console-login' }) }).catch((e: unknown) => ((why = String(e)), undefined));
        if (res && (res.ok || res.status === 404)) break;
        if (res) why = `${res.status} ${await res.text().catch(() => '')}`;
        await sleep(500);
      }
      if (res?.status === 404) return; // this opencode has no integrations yet: nothing to check
      expect(res?.ok, `connecting the integration failed: ${why}`).toBe(true);
      const v = await host.until((x) => x.providers.some((p) => p.id === 'deepseek' && p.models.length > 0), 20_000, 'models of the integration sign-in');
      if (already) return;
      // Another notice may already have replaced it on screen; it was shown.
      const notices = host.posted.flatMap((m) => (m.type === 'patch' && m.patch.notice ? [m.patch.notice.text] : []));
      expect(notices.some((t) => /Connected: .*DeepSeek/.test(t))).toBe(true);
      // Providers from opencode.json are still listed next to the integration ones.
      expect(v.providers.some((p) => p.id === 'mock')).toBe(true);
    } finally {
      killTree(other);
    }
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

  it('offers a subscription sign-in first, straight to the chosen plan, and the API key last', async () => {
    let menu: string[] = [];
    host.picks.push((items) => {
      menu = items.map((i) => i.label);
      return items[0].value;
    });
    let plans: string[] = [];
    host.picks.push((items) => {
      plans = items.map((i) => `${i.label} | ${i.description ?? ''}`);
      return items.find((i) => /ChatGPT Pro\/Plus \(browser\)/.test(i.description ?? ''))?.value;
    });
    await controller.manageProviders();
    expect(menu[0]).toMatch(/Sign in with a subscription/);
    expect(menu[1]).toMatch(/API key/);
    // opencode's own list of subscription logins, ChatGPT and Copilot at the top.
    expect(plans[0]).toMatch(/OpenAI \| ChatGPT Pro\/Plus/);
    expect(plans.some((p) => /GitHub Copilot/.test(p))).toBe(true);
    expect(plans.at(-1)).toMatch(/Another provider/);
    expect(host.terminals.pop()!.command).toMatch(/opencode(\.cmd|\.exe)?"? auth login -p openai -m "ChatGPT Pro\/Plus \(browser\)"$/i);

    // Connecting a provider that has a plan offers the plan before the key.
    let how: string[] = [];
    host.picks.push((items) => items.find((i) => /API key/.test(i.label))?.value);
    host.picks.push((items) => items.find((i) => (i.value as { id: string }).id === 'openai')?.value);
    host.picks.push((items) => {
      how = items.map((i) => i.label);
      return items[0].value;
    });
    await controller.manageProviders();
    expect(how[0]).toMatch(/ChatGPT Pro\/Plus/);
    expect(how[1]).toMatch(/Paste an API key/);
    expect(host.terminals.pop()!.command).toMatch(/auth login -p openai -m "ChatGPT Pro\/Plus \(browser\)"$/);
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
