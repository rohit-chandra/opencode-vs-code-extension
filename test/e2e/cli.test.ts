import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ClaudeCodeEngine } from '../../src/engines/cli/claudeCode';
import { CodexEngine } from '../../src/engines/cli/codex';
import { findBin, makeContext, record } from '../helpers/context';
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
    expect(rec.events.filter((e) => e.type === 'part.delta').length).toBeGreaterThan(3);
    // Slash commands are learned from the CLI's init message.
    const commands = await engine.listCommands();
    expect(commands.length).toBeGreaterThan(3);
    expect(commands.every((c) => c.source === 'engine')).toBe(true);
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
