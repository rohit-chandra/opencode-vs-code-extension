import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { UsageLedger } from '../../src/core/usageLedger';
import type { Engine } from '../../src/core/engine';
import { ClaudeCodeEngine } from '../../src/engines/cli/claudeCode';
import { CodexEngine } from '../../src/engines/cli/codex';
import type { EngineId } from '../../src/shared/types';
import { ChatController } from '../../src/ui/controller';
import { multiAttachments } from '../helpers/attachments';
import { MemoryStore, findBin, makeContext, record } from '../helpers/context';
import { FakeHost } from '../helpers/fakeHost';
import type { TestContext } from '../helpers/context';
// @ts-expect-error plain ESM fixture without types
import { createMockLlm } from '../fixtures/mock-llm.mjs';

/**
 * These tests drive the REAL Claude Code and Codex CLIs. Instead of a subscription login
 * they are pointed at the local mock API with a dummy key, which exercises exactly the
 * same CLI flags and output parsing the extension uses with a signed-in CLI.
 */
const claudeBin = await findBin('claude', 'CLAUDE_BIN');
const codexBin = await findBin('codex', 'CODEX_BIN');
const MOCK_MCP = path.resolve('test/fixtures/mock-mcp.mjs');

type Mock = { listen(): Promise<number>; close(): Promise<void>; log: { path: string; body: Record<string, unknown> }[] };

/** Environment for the CLIs under test, without Claude Code variables inherited from a parent agent session. */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_|OPENAI_|CODEX_)/.test(k)) delete env[k];
  return { ...env, ...extra };
}

describe.skipIf(!claudeBin)('Claude Code engine (real `claude` CLI + mock Anthropic API)', () => {
  let mock: Mock;
  let ctx: TestContext;
  let engine: ClaudeCodeEngine;
  let project: string;

  beforeAll(async () => {
    mock = createMockLlm();
    const port = await mock.listen();
    const base = makeContext();
    project = path.join(base.dir, 'project');
    const home = path.join(base.dir, 'home');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { mockmcp: { command: process.execPath, args: [MOCK_MCP] }, other: { command: process.execPath, args: [MOCK_MCP] } } }));
    ctx = Object.assign(base, {
      cwd: () => project,
      env: cleanEnv({ HOME: home, USERPROFILE: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-mock', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' }),
    });
    ctx.settings['claudeCode.path'] = claudeBin;
    // The mock is reached with a dummy API key, so these tests run in API-key mode (key from the environment).
    ctx.settings['claudeCode.auth'] = 'apiKey';
    engine = new ClaudeCodeEngine(ctx);
    const status = await engine.start();
    expect(status.state).toBe('ready');
    expect(status.version).toMatch(/^\d+\./);
  });

  afterAll(async () => {
    await engine?.dispose();
    await mock?.close();
    ctx?.cleanup();
  });

  it('streams a reply with thinking, usage and cost, and learns the real model name', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'hello claude [[think]]', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session.id, 100_000);
    const assistant = rec.messages(session.id)[1];
    expect(assistant.error).toBeUndefined();
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    // The CLI may prepend its own <system-reminder> blocks to the user turn, which the mock echoes back.
    expect((assistant.parts[1] as { text: string }).text).toMatch(/^MOCK\[claude-[\w.-]+\]: [\s\S]*hello claude$/);
    expect(assistant.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20, cacheWrite: 0 });
    expect(assistant.usage!.cost).toBeGreaterThan(0);
    // One model call: the context after it is what that call read and wrote.
    expect(assistant).toMatchObject({ contextTokens: 150, calls: 1 });
    // The reply names the model that answered, not the alias that was asked for.
    expect(assistant.model!.modelId).toMatch(/^claude-sonnet-\d/);
    expect(rec.events.filter((e) => e.type === 'part.delta').length).toBeGreaterThan(3);
    // Slash commands are learned from the CLI's init message.
    const commands = await engine.listCommands();
    expect(commands.length).toBeGreaterThan(3);
    expect(commands.every((c) => c.source === 'engine')).toBe(true);
  });

  it('passes several attachments to Claude Code with the prompt', async () => {
    const { attachments, paths } = multiAttachments(path.join(project, 'multi'));
    const rec = record(engine);
    const session = await engine.createSession();
    const before = mock.log.length;
    await engine.sendPrompt(session.id, { text: 'compare these three', attachments, model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session.id, 100_000);
    expect(rec.messages(session.id)[1].error).toBeUndefined();
    // Claude Code reads files with its own tools: it gets their paths, and the selected lines inline.
    const sent = JSON.stringify(mock.log.slice(before).filter((l) => l.path === '/messages').map((l) => l.body.messages));
    expect(sent).toContain('compare these three');
    for (const p of paths) expect(sent).toContain(JSON.stringify(p).slice(1, -1));
    expect(sent).toContain('GAMMA_MARKER');
  });

  it('resumes the same Claude Code conversation on the next turn', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'claude-code', modelId: 'default' };
    await engine.sendPrompt(session.id, { text: 'turn one', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    await engine.sendPrompt(session.id, { text: 'turn two', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    const messages = rec.messages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[3].error).toBeUndefined();
    // The second API request carries the first exchange, proving --resume worked.
    const last = mock.log.filter((l) => l.path === '/messages' && JSON.stringify(l.body.messages).includes('turn two')).pop()!;
    expect(JSON.stringify(last.body.messages)).toContain('turn one');
    // "default" is replaced by the model the CLI actually used.
    expect(messages[3].model!.modelId).toMatch(/^claude-/);
  });

  it('runs an MCP tool through Claude Code and shows it as a tool card', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    ctx.settings['claudeCode.permissionMode'] = 'bypassPermissions';
    await engine.sendPrompt(session.id, { text: 'add numbers [[tool!:mcp__mockmcp__add {"a":20,"b":22}]]', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session.id, 100_000);
    ctx.settings['claudeCode.permissionMode'] = 'acceptEdits';
    const assistant = rec.messages(session.id)[1];
    expect(assistant.error).toBeUndefined();
    const tool = assistant.parts.find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'mcp__mockmcp__add', status: 'completed', input: { a: 20, b: 22 } });
    expect((tool as { output: string }).output).toContain('42');
    expect((assistant.parts.at(-1) as { text: string }).text).toContain('TOOL_RESULT:');
    // Two API round trips are summed by the CLI.
    expect(assistant.usage!.output).toBe(60);
    // The context is one round trip's worth, not the sum: that is what the context meter shows.
    expect(assistant).toMatchObject({ contextTokens: 150, calls: 2 });
  });

  it('charges each reply of a resumed conversation its own cost', async () => {
    // Claude Code reports `total_cost_usd` for the whole conversation, so the second and third
    // turns of a resumed session would each be charged everything before them as well.
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'claude-code', modelId: 'sonnet' };
    for (const text of ['cost one', 'cost two', 'cost three']) {
      await engine.sendPrompt(session.id, { text, attachments: [], model });
      await rec.waitIdle(session.id, 100_000);
    }
    const replies = rec.messages(session.id).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.error)).toEqual([undefined, undefined, undefined]);
    // The mock bills every call the same, so every reply costs the same.
    for (const m of replies) expect(m.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20 });
    const [first, second, third] = replies.map((m) => m.usage!.cost);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeCloseTo(first, 6);
    expect(third).toBeCloseTo(first, 6);
    // And a session saved by an earlier version, with the running cost in every reply, is put right when opened.
    const stored = await engine.getMessages(session.id);
    const saved = stored.filter((m) => m.role === 'assistant');
    saved[1].usage = { ...saved[1].usage!, cost: first * 2 };
    saved[2].usage = { ...saved[2].usage!, cost: first * 3 };
    const internals = engine as unknown as { store: { get(id: string): Promise<{ meta: Record<string, unknown> }> } };
    const meta = (await internals.store.get(session.id)).meta;
    delete meta.costPerTurn;
    delete meta.claudeCostTotal;
    const repaired = (await engine.getMessages(session.id)).filter((m) => m.role === 'assistant').map((m) => m.usage!.cost);
    for (const cost of repaired) expect(cost).toBeCloseTo(first, 6);
    expect(meta.claudeCostTotal).toBeCloseTo(first * 3, 6);
  });

  it('lists the models the account can use, with their real names', async () => {
    const [provider] = await engine.listProviders();
    const models = provider.models;
    expect(models[0]).toMatchObject({ modelId: 'default' });
    expect(models[0].name).toMatch(/^Default \(\w+ \d/);
    // Aliases stay the ids the CLI takes, but are shown by model and version (e.g. "Opus 5.5").
    const opus = models.find((m) => m.modelId === 'opus')!;
    expect(opus.name).toMatch(/^Opus \d/);
    expect(opus.resolvedId).toMatch(/^claude-opus-/);
    expect(models.every((m) => !/\$/.test(m.description ?? ''))).toBe(true);
    expect(models.length).toBeGreaterThanOrEqual(3);
    // Nothing twice, and Opus Plan Mode (an alias the CLI takes but does not list) is offered too.
    expect(new Set(models.map((m) => m.modelId)).size).toBe(models.length);
    expect(models.find((m) => m.modelId === 'opusplan')).toMatchObject({ name: 'Opus Plan Mode' });
    for (const family of ['fable', 'opus', 'sonnet', 'haiku']) expect(models.some((m) => m.modelId === family), family).toBe(true);
  });

  it('runs a model the CLI does not list: Opus Plan Mode and a model added by name', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const sent = () => mock.log.filter((l) => l.path.endsWith('/messages')).map((l) => String(l.body.model));
    let before = sent().length;
    await engine.sendPrompt(session.id, { text: 'plan mode alias', attachments: [], model: { providerId: 'claude-code', modelId: 'opusplan' } });
    await rec.waitIdle(session.id, 90_000);
    expect(rec.messages(session.id).at(-1)!.error).toBeUndefined();
    // Outside plan mode the alias runs on Sonnet.
    expect(sent().slice(before).some((m) => /^claude-sonnet-/.test(m))).toBe(true);

    ctx.settings['claudeCode.models'] = ['claude-opus-5'];
    try {
      const [provider] = await engine.listProviders();
      expect(provider.models.find((m) => m.modelId === 'claude-opus-5')).toMatchObject({ name: 'Opus 5', description: 'Added by you' });
      expect(provider.models.filter((m) => m.modelId === 'claude-opus-5')).toHaveLength(1);
      before = sent().length;
      await engine.sendPrompt(session.id, { text: 'an earlier version', attachments: [], model: { providerId: 'claude-code', modelId: 'claude-opus-5' } });
      await rec.waitIdle(session.id, 90_000);
      expect(rec.messages(session.id).at(-1)!.error).toBeUndefined();
      expect(sent().slice(before)).toContain('claude-opus-5');
    } finally {
      delete ctx.settings['claudeCode.models'];
    }
  });

  it('asks before a tool runs, in the chat: allow, always allow, deny', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'claude-code', modelId: 'sonnet' };
    // acceptEdits (the default) lets Claude Code edit files, but an MCP tool needs approval.
    const asked = rec.waitFor('permission.asked', (e) => e.request.sessionId === session.id, 60_000);
    await engine.sendPrompt(session.id, { text: 'add please [[tool!:mcp__mockmcp__add {"a":1,"b":2}]]', attachments: [], model });
    const { request } = await asked;
    expect(request).toMatchObject({ kind: 'mcp', title: 'Allow add (mockmcp MCP server)?' });
    expect(JSON.parse(request.detail!)).toEqual({ a: 1, b: 2 });
    await engine.replyPermission(session.id, request.id, 'always');
    await rec.waitIdle(session.id, 100_000);
    let tool = rec.messages(session.id)[1].parts.find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'mcp__mockmcp__add', status: 'completed' });
    expect((tool as { output: string }).output).toContain('3');

    // "Always allow" holds for the rest of the session: no second prompt.
    const asks = () => rec.events.filter((e) => e.type === 'permission.asked').length;
    const before = asks();
    await engine.sendPrompt(session.id, { text: 'again [[tool!:mcp__mockmcp__add {"a":5,"b":5}]]', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    expect(asks()).toBe(before);
    tool = rec.messages(session.id)[3].parts.find((p) => p.type === 'tool')!;
    expect((tool as { output: string }).output).toContain('10');

    // Deny: the tool does not run, and Claude Code is told why.
    const other = await engine.createSession();
    const asked2 = rec.waitFor('permission.asked', (e) => e.request.sessionId === other.id, 60_000);
    await engine.sendPrompt(other.id, { text: 'echo [[tool!:mcp__mockmcp__echo {"text":"secret"}]]', attachments: [], model });
    await engine.replyPermission(other.id, (await asked2).request.id, 'reject');
    await rec.waitIdle(other.id, 100_000);
    tool = rec.messages(other.id)[1].parts.find((p) => p.type === 'tool')!;
    expect(tool).toMatchObject({ status: 'error' });
    expect(JSON.stringify(tool)).toMatch(/denied/i);
    expect(JSON.stringify(tool)).not.toContain('ECHO: secret');
  });

  it('auto mode runs tools without asking', async () => {
    ctx.settings.approvals = 'auto';
    try {
      const rec = record(engine);
      const session = await engine.createSession();
      await engine.sendPrompt(session.id, { text: 'auto [[tool!:mcp__mockmcp__add {"a":40,"b":2}]]', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
      await rec.waitIdle(session.id, 100_000);
      expect(rec.events.some((e) => e.type === 'permission.asked')).toBe(false);
      const tool = rec.messages(session.id)[1].parts.find((p) => p.type === 'tool')!;
      expect(tool).toMatchObject({ status: 'completed' });
      expect((tool as { output: string }).output).toContain('42');
    } finally {
      delete ctx.settings.approvals;
    }
  });

  it('sends the chosen effort level to the model', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'claude-code', modelId: 'sonnet' };
    const efforts = () => mock.log.filter((l) => l.path.includes('messages') && JSON.stringify(l.body.messages ?? '').includes('effort check')).map((l) => (l.body.output_config as { effort?: string } | undefined)?.effort);
    await engine.sendPrompt(session.id, { text: 'effort check one', attachments: [], model, effort: 'low' });
    await rec.waitIdle(session.id, 100_000);
    expect(rec.messages(session.id)[1].error).toBeUndefined();
    expect(efforts().at(-1)).toBe('low');
    await engine.sendPrompt(session.id, { text: 'effort check two', attachments: [], model, effort: 'max' });
    await rec.waitIdle(session.id, 100_000);
    expect(efforts().at(-1)).toBe('max');
    // Without a choice the flag is left out and the CLI's own default applies again.
    await engine.sendPrompt(session.id, { text: 'effort check three', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    expect(efforts()).toHaveLength(3);
    expect(efforts().at(-1)).not.toBe('max');
    // The levels offered in the picker are the ones the CLI lists for the model.
    const listed = (await engine.listProviders())[0].models;
    for (const m of listed.filter((x) => x.efforts)) expect(m.efforts!.map((e) => e.id)).toEqual(expect.arrayContaining(['low', 'high']));
  });

  it("shows Claude's questions in the chat and returns the answers, typed ones included", async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'claude-code', modelId: 'sonnet' };
    const ask = { questions: [{ question: 'Which library?', header: 'Library', options: [{ label: 'React', description: 'r' }, { label: 'Vue', description: 'v' }], multiSelect: false }, { question: 'Which features?', header: 'Features', options: [{ label: 'Auth', description: 'a' }, { label: 'Billing', description: 'b' }], multiSelect: true }] };
    const asked = rec.waitFor('question.asked', (e) => e.request.sessionId === session.id, 60_000);
    await engine.sendPrompt(session.id, { text: `ask me [[tool!:AskUserQuestion ${JSON.stringify(ask)}]]`, attachments: [], model });
    const { request } = await asked;
    expect(request.questions).toEqual([
      { question: 'Which library?', header: 'Library', options: [{ label: 'React', description: 'r' }, { label: 'Vue', description: 'v' }] },
      { question: 'Which features?', header: 'Features', options: [{ label: 'Auth', description: 'a' }, { label: 'Billing', description: 'b' }], multiple: true },
    ]);
    // A question is not a permission: no approval card for it.
    expect(rec.events.some((e) => e.type === 'permission.asked' && e.request.sessionId === session.id)).toBe(false);
    await engine.replyQuestion(session.id, request.id, [['Svelte, the one I already use'], ['Auth', 'Billing']]);
    await rec.waitIdle(session.id, 100_000);
    const tool = rec.messages(session.id)[1].parts.find((p) => p.type === 'tool') as { tool: string; status: string; output: string };
    expect(tool).toMatchObject({ tool: 'AskUserQuestion', status: 'completed' });
    expect(tool.output).toContain('Svelte, the one I already use');
    expect(tool.output).toContain('Auth, Billing');
    expect(rec.events.some((e) => e.type === 'question.resolved' && e.requestId === request.id)).toBe(true);

    // Skipping tells Claude to carry on without the answers.
    const other = await engine.createSession();
    const asked2 = rec.waitFor('question.asked', (e) => e.request.sessionId === other.id, 60_000);
    await engine.sendPrompt(other.id, { text: `ask again [[tool!:AskUserQuestion ${JSON.stringify(ask)}]]`, attachments: [], model });
    await engine.replyQuestion(other.id, (await asked2).request.id, null);
    await rec.waitIdle(other.id, 100_000);
    expect(JSON.stringify(rec.messages(other.id)[1].parts)).toContain('skipped the questions');
  });

  it('still shows questions when Claude Code permissions are bypassed', async () => {
    ctx.settings['claudeCode.permissionMode'] = 'bypassPermissions';
    try {
      const rec = record(engine);
      const session = await engine.createSession();
      const ask = { questions: [{ question: 'Which library?', header: 'Library', options: [{ label: 'React', description: 'r' }, { label: 'Vue', description: 'v' }] }] };
      const asked = rec.waitFor('question.asked', (e) => e.request.sessionId === session.id, 60_000);
      await engine.sendPrompt(session.id, { text: `ask me [[tool!:AskUserQuestion ${JSON.stringify(ask)}]]`, attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
      await engine.replyQuestion(session.id, (await asked).request.id, [['Vue']]);
      await rec.waitIdle(session.id, 100_000);
      expect(JSON.stringify(rec.messages(session.id)[1].parts)).toContain('Vue');
      expect(rec.events.some((e) => e.type === 'permission.asked')).toBe(false);
    } finally {
      ctx.settings['claudeCode.permissionMode'] = 'acceptEdits';
    }
  });

  it('lists MCP servers from .mcp.json and honours the toggle', async () => {
    expect((await engine.listMcp()).map((s) => [s.name, s.enabled, s.source])).toEqual([
      ['mockmcp', true, '.mcp.json'],
      ['other', true, '.mcp.json'],
    ]);
    await engine.setMcpEnabled('mockmcp', false);
    expect((await engine.listMcp()).find((s) => s.name === 'mockmcp')).toMatchObject({ enabled: false, status: 'disabled' });

    // With the server switched off, Claude Code no longer has the tool: the call fails instead of running.
    ctx.settings['claudeCode.permissionMode'] = 'bypassPermissions';
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'try [[tool!:mcp__mockmcp__add {"a":1,"b":1}]]', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session.id, 100_000);
    const off = rec.messages(session.id)[1].parts.find((p) => p.type === 'tool')!;
    expect(off).toMatchObject({ tool: 'mcp__mockmcp__add', status: 'error' });

    // The server that stayed enabled still works in the same configuration.
    const session2 = await engine.createSession();
    await engine.sendPrompt(session2.id, { text: 'try [[tool!:mcp__other__add {"a":1,"b":1}]]', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session2.id, 100_000);
    expect(rec.messages(session2.id)[1].parts.find((p) => p.type === 'tool')).toMatchObject({ tool: 'mcp__other__add', status: 'completed', output: '2' });
    ctx.settings['claudeCode.permissionMode'] = 'acceptEdits';
    await engine.setMcpEnabled('mockmcp', true);
  });

  it('uses the Claude account by default: an API key in the environment never reaches the API', async () => {
    ctx.settings['claudeCode.auth'] = 'subscription';
    try {
      // The test HOME has no Claude login, and ANTHROPIC_API_KEY is removed for the CLI.
      expect(await engine.account.status()).toMatchObject({ engine: 'claude-code', mode: 'subscription', signedIn: false });
      const before = mock.log.length;
      const rec = record(engine);
      const session = await engine.createSession();
      await engine.sendPrompt(session.id, { text: 'should not be billed', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
      await rec.waitIdle(session.id, 60_000);
      const assistant = rec.messages(session.id)[1];
      expect(`${assistant.error ?? ''} ${(assistant.parts.at(-1) as { text?: string } | undefined)?.text ?? ''}`).toMatch(/log ?in|auth/i);
      expect(mock.log.slice(before).filter((r) => (r as { headers?: Record<string, unknown> }).headers?.['x-api-key'] === 'sk-mock')).toEqual([]);
    } finally {
      ctx.settings['claudeCode.auth'] = 'apiKey';
    }
  });

  it('uses the API key from Secret Storage in API-key mode', async () => {
    await ctx.secrets.set(engine.account.secretKey, 'sk-stored');
    try {
      expect(await engine.account.status()).toMatchObject({ mode: 'apiKey', signedIn: true, billing: 'apiKey', label: 'API key' });
      const before = mock.log.length;
      const rec = record(engine);
      const session = await engine.createSession();
      await engine.sendPrompt(session.id, { text: 'stored key please', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
      await rec.waitIdle(session.id, 100_000);
      const keys = mock.log.slice(before).map((r) => (r as { headers?: Record<string, unknown> }).headers?.['x-api-key']).filter(Boolean);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys)).toEqual(new Set(['sk-stored']));
    } finally {
      await ctx.secrets.delete(engine.account.secretKey);
    }
  });

  it('reports a failing API as an error on the message', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const env = ctx.env!;
    const saved = env.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    env.CLAUDE_CODE_MAX_RETRIES = '0';
    await engine.sendPrompt(session.id, { text: 'unreachable', attachments: [], model: { providerId: 'claude-code', modelId: 'sonnet' } });
    await rec.waitIdle(session.id, 110_000);
    env.ANTHROPIC_BASE_URL = saved;
    delete env.CLAUDE_CODE_MAX_RETRIES;
    const assistant = rec.messages(session.id)[1];
    expect(assistant.error ?? (assistant.parts.at(-1) as { text?: string } | undefined)?.text ?? '').toMatch(/error|connect|unable|fail/i);
  });
});

describe.skipIf(!codexBin)('Codex engine (real `codex` CLI + mock Responses API)', () => {
  let mock: Mock;
  let ctx: TestContext;
  let engine: CodexEngine;

  beforeAll(async () => {
    mock = createMockLlm();
    const port = await mock.listen();
    const base = makeContext();
    const project = path.join(base.dir, 'project');
    const codexHome = path.join(base.dir, 'codex-home');
    mkdirSync(project, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model = "mock-small"',
        'model_provider = "mock"',
        '',
        '[model_providers.mock]',
        'name = "Mock"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'env_key = "MOCK_KEY"',
        'wire_api = "responses"',
        '',
        '[mcp_servers.mockmcp]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(MOCK_MCP)}]`,
        '',
      ].join('\n'),
    );
    ctx = Object.assign(base, { cwd: () => project, env: cleanEnv({ CODEX_HOME: codexHome, MOCK_KEY: 'sk-mock' }) });
    ctx.settings['codex.path'] = codexBin;
    ctx.settings['codex.sandbox'] = 'read-only';
    engine = new CodexEngine(ctx);
    const status = await engine.start();
    expect(status.state).toBe('ready');
    expect(status.version).toMatch(/^\d+\./);
  });

  afterAll(async () => {
    await engine?.dispose();
    await mock?.close();
    ctx?.cleanup();
  });

  it('returns the reply and token usage', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'hello codex', attachments: [], model: { providerId: 'codex', modelId: 'default' } });
    await rec.waitIdle(session.id, 100_000);
    const assistant = rec.messages(session.id)[1];
    expect(assistant.error).toBeUndefined();
    expect(assistant.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'MOCK[mock-small]: hello codex' });
    expect(assistant.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20, reasoning: 0 });
  });

  it('passes several attachments to Codex with the prompt', async () => {
    const { attachments, paths } = multiAttachments(path.join(ctx.cwd()!, 'multi'));
    const rec = record(engine);
    const session = await engine.createSession();
    const before = mock.log.length;
    await engine.sendPrompt(session.id, { text: 'compare these three', attachments, model: { providerId: 'codex', modelId: 'default' } });
    await rec.waitIdle(session.id, 100_000);
    expect(rec.messages(session.id)[1].error).toBeUndefined();
    const sent = JSON.stringify(mock.log.slice(before).map((l) => l.body));
    expect(sent).toContain('compare these three');
    for (const p of paths) expect(sent).toContain(JSON.stringify(p).slice(1, -1));
    expect(sent).toContain('GAMMA_MARKER');
  });

  it('sends the chosen reasoning effort to the model, and lists the levels of each model', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const efforts = () => mock.log.filter((l) => l.path.includes('responses') && JSON.stringify(l.body.input ?? '').includes('effort check')).map((l) => (l.body.reasoning as { effort?: string } | undefined)?.effort);
    await engine.sendPrompt(session.id, { text: 'effort check one', attachments: [], model: { providerId: 'codex', modelId: 'default' }, effort: 'high' });
    await rec.waitIdle(session.id, 100_000);
    expect(rec.messages(session.id)[1].error).toBeUndefined();
    expect(efforts().at(-1)).toBe('high');
    await engine.sendPrompt(session.id, { text: 'effort check two', attachments: [], model: { providerId: 'codex', modelId: 'default' }, effort: 'low' });
    await rec.waitIdle(session.id, 100_000);
    expect(efforts().at(-1)).toBe('low');
    // Codex lists the levels per model; whatever it lists is what the picker offers.
    for (const m of (await engine.listProviders())[0].models.filter((x) => x.efforts)) {
      expect(m.efforts!.length).toBeGreaterThan(0);
      if (m.defaultEffort) expect(m.efforts!.map((e) => e.id)).toContain(m.defaultEffort);
    }
  });

  it('resumes the same Codex thread on the next turn', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    const model = { providerId: 'codex', modelId: 'default' };
    await engine.sendPrompt(session.id, { text: 'codex turn one', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    await engine.sendPrompt(session.id, { text: 'codex turn two', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    const messages = rec.messages(session.id);
    expect(messages[3].error).toBeUndefined();
    expect(messages[3].parts.find((p) => p.type === 'text')).toMatchObject({ text: 'MOCK[mock-small]: codex turn two' });
    const last = mock.log.filter((l) => l.path === '/responses').pop()!;
    expect(JSON.stringify(last.body.input)).toContain('codex turn one');
    // Codex reports a resumed thread's running total. Each reply still gets only its own turn:
    // the mock bills every call the same, so the second reply must not show twice the first.
    await engine.sendPrompt(session.id, { text: 'codex turn three', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    const replies = rec.messages(session.id).filter((m) => m.role === 'assistant');
    for (const m of replies) expect(m.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20, reasoning: 0 });
    // A session saved by an earlier version, with the running total in every reply, is put right when opened.
    const saved = (await engine.getMessages(session.id)).filter((m) => m.role === 'assistant');
    saved[1].usage = { ...saved[1].usage!, input: 200, output: 60, cacheRead: 40 };
    saved[2].usage = { ...saved[2].usage!, input: 300, output: 90, cacheRead: 60 };
    const internals = engine as unknown as { store: { get(id: string): Promise<{ meta: Record<string, unknown> }> } };
    const meta = (await internals.store.get(session.id)).meta;
    delete meta.usagePerTurn;
    delete meta.codexUsageTotal;
    for (const m of (await engine.getMessages(session.id)).filter((x) => x.role === 'assistant')) expect(m.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20 });
    expect(meta.codexUsageTotal).toEqual({ input: 360, cached: 60, cacheWrite: 0, output: 90, reasoning: 0 });
    // The turn after that continues from the repaired total.
    await engine.sendPrompt(session.id, { text: 'codex turn four', attachments: [], model });
    await rec.waitIdle(session.id, 100_000);
    expect(rec.messages(session.id).at(-1)!.usage).toMatchObject({ input: 100, output: 30, cacheRead: 20 });
  });

  it('lists MCP servers from the Codex config and passes the toggle to the CLI', async () => {
    expect(await engine.listMcp()).toMatchObject([{ name: 'mockmcp', enabled: true, status: 'connected', transport: 'stdio' }]);
    await engine.setMcpEnabled('mockmcp', false);
    expect(await engine.listMcp()).toMatchObject([{ name: 'mockmcp', enabled: false, status: 'disabled' }]);
    await engine.setMcpEnabled('mockmcp', true);
    expect(await engine.listMcp()).toMatchObject([{ name: 'mockmcp', enabled: true }]);
  });

  it('reports a failed turn', async () => {
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'x', attachments: [], model: { providerId: 'codex', modelId: 'definitely-not-a-model' } });
    await rec.waitIdle(session.id, 100_000);
    // The mock accepts any model name, so this still succeeds; the point is that -m is passed through.
    const last = mock.log.filter((l) => l.path === '/responses').pop()!;
    expect(last.body.model).toBe('definitely-not-a-model');
  });

  it('lists the account\'s models, and the configured default first', async () => {
    const [provider] = await engine.listProviders();
    expect(provider.models[0]).toMatchObject({ modelId: 'default', name: 'Default (mock-small)' });
    expect(provider.models.filter((m) => m.modelId !== 'default').every((m) => m.name && m.modelId)).toBe(true);
  });

  it('reports the ChatGPT sign-in state, and the stored key in API-key mode', async () => {
    // CODEX_HOME holds no login: subscription mode is "not signed in".
    expect(await engine.account.status()).toMatchObject({ engine: 'codex', mode: 'subscription', signedIn: false });
    expect(engine.account.loginCommand()).toMatch(/codex(\.cmd|\.exe)?"? login$/i);
    expect(engine.account.loginCommand({ deviceCode: true })).toMatch(/ login --device-auth$/);
    ctx.settings['codex.auth'] = 'apiKey';
    try {
      expect(await engine.account.status()).toMatchObject({ mode: 'apiKey', signedIn: false });
      await ctx.secrets.set(engine.account.secretKey, 'sk-stored');
      expect(await engine.account.status()).toMatchObject({ mode: 'apiKey', signedIn: true, billing: 'apiKey' });
    } finally {
      delete ctx.settings['codex.auth'];
      await ctx.secrets.delete(engine.account.secretKey);
    }
  });
});

/** The chat as the webview drives it, with a Claude Code CLI that is not signed in. */
describe.skipIf(!claudeBin)('Signing in to Claude Code from the chat', () => {
  let ctx: TestContext;
  let host: FakeHost;
  let controller: ChatController;
  let engine: ClaudeCodeEngine;

  beforeAll(async () => {
    ctx = makeContext({ settings: { defaultEngine: 'claude-code' } });
    const home = path.join(ctx.dir, 'home');
    mkdirSync(home, { recursive: true });
    // An API key in the environment must not count as being signed in.
    ctx.env = cleanEnv({ HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: 'sk-env', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });
    ctx.settings['claudeCode.path'] = claudeBin;
    ctx.cwd = () => ctx.dir;
    host = new FakeHost(ctx);
    engine = new ClaudeCodeEngine(ctx);
    controller = new ChatController(new Map<EngineId, Engine>([['claude-code', engine]]), new UsageLedger(new MemoryStore()), host);
    await controller.handleMessage({ type: 'ready' });
    await controller.activate();
  });

  afterAll(async () => {
    controller?.dispose();
    await engine?.dispose();
    ctx?.cleanup();
  });

  it('shows the Claude account sign-in first and does not send while signed out', async () => {
    const v = await host.until((s) => !s.loading && !!s.auth, 30_000, 'auth status');
    expect(v.auth).toMatchObject({ engine: 'claude-code', mode: 'subscription', signedIn: false });
    await controller.handleMessage({ type: 'send', text: 'hello' });
    expect(host.view!.notice?.text).toMatch(/Sign in with your Claude account/);
    expect(host.view!.messages).toEqual([]);
  });

  it('signs in with the Claude account in a terminal and waits for it', async () => {
    await controller.handleMessage({ type: 'signIn' });
    expect(host.terminals.at(-1)?.command).toMatch(/ auth login --claudeai$/);
    expect(host.view!.auth?.pending).toBe(true);
    expect(ctx.settings['claudeCode.auth'] ?? 'subscription').toBe('subscription');
  });

  it('switches to an API key on request, and back to the account', async () => {
    host.inputs.push('sk-ant-from-user');
    await controller.handleMessage({ type: 'useApiKey' });
    expect(ctx.settings['claudeCode.auth']).toBe('apiKey');
    expect(await ctx.secrets.get(engine.account.secretKey)).toBe('sk-ant-from-user');
    expect(host.view!.auth).toMatchObject({ mode: 'apiKey', signedIn: true, billing: 'apiKey' });
    expect(host.view!.auth?.pending).toBeUndefined();

    host.pickByLabel(/Use my Claude account again/);
    await controller.handleMessage({ type: 'send', text: '/login' });
    expect(ctx.settings['claudeCode.auth']).toBe('subscription');
    // Still not signed in, so it goes straight to the sign-in.
    expect(host.terminals.at(-1)?.command).toMatch(/ auth login --claudeai$/);
  });
});

describe('CLI engines without the CLIs', () => {
  it('explain how to install them', async () => {
    const ctx = makeContext({ settings: { 'claudeCode.path': '/nonexistent/claude', 'codex.path': '/nonexistent/codex' } });
    const claude = new ClaudeCodeEngine(ctx);
    const codex = new CodexEngine(ctx);
    expect((await claude.start()).detail).toMatch(/npm i -g @anthropic-ai\/claude-code/);
    expect((await codex.start()).detail).toMatch(/npm i -g @openai\/codex/);
    expect(await codex.listMcp()).toEqual([]);
    await claude.dispose();
    await codex.dispose();
    ctx.cleanup();
  });
});
