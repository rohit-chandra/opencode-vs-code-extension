import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineAccount, EngineContext } from '../../core/engine';
import { EngineError } from '../../core/engine';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { findExecutable, runCapture } from '../../core/process';
import type { AuthMode, AuthStatus, EngineCapabilities, McpServerInfo, ModelRef, PromptInput, ProviderInfo, SlashCommand } from '../../shared/types';
import { apiKeySecret, authMode, claudeEnv, parseClaudeAuthStatus, shellExe } from './auth';
import { ClaudeStreamTranslator } from './claudeStream';
import { StateFile, imageBase64, promptForAgent, readJsonFile, runJsonl } from './common';

interface ClaudeState {
  slashCommands: string[];
  disabledMcp: string[];
  mcpStatus: Record<string, string>;
}

type McpDefs = Record<string, { command?: string; args?: string[]; url?: string; type?: string; [k: string]: unknown }>;

const DEFAULT_MODELS = ['default', 'opus', 'sonnet', 'haiku'];

/**
 * Claude Code engine: drives the user's own `claude` CLI in print mode with stream-json.
 * By default it uses the Claude account (Pro / Max subscription) the CLI is signed in with;
 * an API key is used only when the user picks API-key mode.
 */
export class ClaudeCodeEngine extends LocalEngine {
  readonly id = 'claude-code' as const;
  readonly capabilities: EngineCapabilities = {
    agents: false,
    fork: true,
    share: false,
    undo: false,
    compact: true,
    images: true,
    mcpToggle: true,
    permissions: false,
    providerAuth: false,
    remoteSessions: false,
  };

  private exe: string | undefined;
  private stateFile: StateFile<ClaudeState>;

  constructor(ctx: EngineContext) {
    super(ctx, 'claude-code');
    this.stateFile = new StateFile<ClaudeState>(path.join(ctx.storageDir, 'claude-code.json'), { slashCommands: [], disabledMcp: [], mcpStatus: {} });
  }

  private env(): NodeJS.ProcessEnv {
    return this.ctx.env ?? process.env;
  }

  /** Environment for the CLI: without API-key variables in subscription mode, with the stored key in API-key mode. */
  private async runEnv(): Promise<NodeJS.ProcessEnv> {
    const mode = this.account.mode();
    return claudeEnv(this.env(), mode, mode === 'apiKey' ? await this.ctx.secrets.get(this.account.secretKey) : undefined);
  }

  readonly account: EngineAccount = {
    accountName: 'Claude',
    modeSetting: 'claudeCode.auth',
    secretKey: apiKeySecret('claude-code'),
    mode: (): AuthMode => authMode(this.ctx.config<string>('claudeCode.auth', 'subscription')),
    status: async (): Promise<AuthStatus> => {
      const mode = this.account.mode();
      if (mode === 'apiKey') {
        const stored = await this.ctx.secrets.get(this.account.secretKey);
        const key = stored || this.env().ANTHROPIC_API_KEY;
        return { engine: 'claude-code', mode, signedIn: !!key, billing: 'apiKey', label: key ? `API key${stored ? '' : ' (ANTHROPIC_API_KEY)'}` : undefined };
      }
      if (!this.exe) return { engine: 'claude-code', mode, signedIn: undefined };
      const res = await runCapture(this.exe, ['auth', 'status', '--json'], { env: await this.runEnv(), timeoutMs: 20_000 }).catch(() => undefined);
      return { engine: 'claude-code', mode, ...(res ? parseClaudeAuthStatus(res.stdout) : { signedIn: undefined }) };
    },
    loginCommand: () => `${shellExe(this.ctx.config<string>('claudeCode.path', ''), 'claude')} auth login --claudeai`,
    logoutCommand: () => `${shellExe(this.ctx.config<string>('claudeCode.path', ''), 'claude')} auth logout`,
  };

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string; version?: string }> {
    this.exe = await findExecutable('claude', this.ctx.config<string>('claudeCode.path', ''), this.env());
    if (!this.exe) {
      return { ok: false, detail: 'Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) or set "opencodeHub.claudeCode.path", then sign in with your Claude account.' };
    }
    const v = await runCapture(this.exe, ['--version'], { env: this.env(), timeoutMs: 15_000 });
    return { ok: true, version: v.stdout.trim().split(/\s+/)[0] || undefined };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const extra = this.ctx.config<string[]>('claudeCode.models', []);
    const ids = [...new Set([...DEFAULT_MODELS, ...(Array.isArray(extra) ? extra : [])])];
    return [
      {
        id: 'claude-code',
        name: 'Claude Code',
        connected: true,
        models: ids.map((id) => ({ providerId: 'claude-code', modelId: id, name: id === 'default' ? 'Default (from Claude Code settings)' : id, supportsImages: true, supportsTools: true })),
      },
    ];
  }

  override async defaultModel(): Promise<ModelRef | undefined> {
    return { providerId: 'claude-code', modelId: 'default' };
  }

  override async listCommands(): Promise<SlashCommand[]> {
    const { slashCommands } = await this.stateFile.read();
    return slashCommands.map((name) => ({ name, description: 'Claude Code command', source: 'engine' as const }));
  }

  async compactSession(sessionId: string, model?: ModelRef): Promise<void> {
    await this.sendPrompt(sessionId, { text: '/compact', attachments: [], model });
  }

  protected override forkMeta(meta: Record<string, unknown>): Record<string, unknown> {
    // Continue from the same Claude Code conversation, but under a new session id.
    return { ...meta, forkPending: true };
  }

  /* ------------------------------------------------------------------- mcp */

  private async mcpDefinitions(): Promise<{ defs: McpDefs; sources: Record<string, string> }> {
    const env = this.env();
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
    const userFile = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
    const cwd = this.ctx.cwd();
    const user = await readJsonFile<{ mcpServers?: McpDefs; projects?: Record<string, { mcpServers?: McpDefs }> }>(userFile);
    const project = cwd ? await readJsonFile<{ mcpServers?: McpDefs }>(path.join(cwd, '.mcp.json')) : undefined;
    const defs: McpDefs = {};
    const sources: Record<string, string> = {};
    const add = (m: McpDefs | undefined, source: string) => {
      for (const [name, def] of Object.entries(m ?? {})) {
        defs[name] = def;
        sources[name] = source;
      }
    };
    add(user?.mcpServers, '~/.claude.json');
    // Claude Code stores project keys with forward slashes on every platform.
    if (cwd) add((user?.projects?.[cwd] ?? user?.projects?.[cwd.replace(/\\/g, '/')])?.mcpServers, '~/.claude.json (project)');
    add(project?.mcpServers, '.mcp.json');
    return { defs, sources };
  }

  override async listMcp(): Promise<McpServerInfo[]> {
    const [{ defs, sources }, state] = await Promise.all([this.mcpDefinitions(), this.stateFile.read()]);
    return Object.entries(defs)
      .map(([name, def]) => {
        const enabled = !state.disabledMcp.includes(name);
        const last = state.mcpStatus[name];
        const status: McpServerInfo['status'] = !enabled ? 'disabled' : last === 'failed' ? 'failed' : last === 'needs-auth' ? 'needs_auth' : 'connected';
        return { name, enabled, status, transport: def.url ? ('http' as const) : ('stdio' as const), source: sources[name], canToggle: true, error: last === 'failed' ? 'Failed to connect in the last run' : undefined };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  override async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const state = await this.stateFile.read();
    const disabled = new Set(state.disabledMcp);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.stateFile.update({ disabledMcp: [...disabled] });
    this.emit({ type: 'mcp.changed' });
  }

  /* ------------------------------------------------------------------ turn */

  protected async runTurn(turn: Turn): Promise<void> {
    if (!this.exe) throw new EngineError('Claude Code CLI not found.');
    const { session, input, assistant, signal } = turn;
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'];
    const mode = this.ctx.config<string>('claudeCode.permissionMode', 'acceptEdits');
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    if (input.model && input.model.modelId !== 'default') args.push('--model', input.model.modelId);
    const resume = session.meta.claudeSessionId as string | undefined;
    if (resume) {
      args.push('--resume', resume);
      if (session.meta.forkPending) args.push('--fork-session');
    }

    const state = await this.stateFile.read();
    let mcpFile: string | undefined;
    if (state.disabledMcp.length > 0) {
      const { defs } = await this.mcpDefinitions();
      const enabled = Object.fromEntries(Object.entries(defs).filter(([name]) => !state.disabledMcp.includes(name)));
      mcpFile = path.join(this.ctx.storageDir, `claude-mcp-${session.info.id}.json`);
      await fs.mkdir(this.ctx.storageDir, { recursive: true });
      await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: enabled }), 'utf8');
      args.push('--strict-mcp-config', '--mcp-config', mcpFile);
    }

    const env = await this.runEnv();
    const translator = new ClaudeStreamTranslator(assistant);
    try {
      const { code, stderr } = await runJsonl({
        file: this.exe,
        args,
        cwd: this.ctx.cwd() ?? this.ctx.storageDir,
        env,
        stdin: (await userLine(input)) + '\n',
        signal,
        onEvent: (ev) => translator.handle(ev),
        onText: (line) => this.ctx.log.debug(`[claude] ${line}`),
      });
      if (signal.aborted) return;
      if (translator.init.sessionId) {
        session.meta.claudeSessionId = translator.init.sessionId;
        delete session.meta.forkPending;
      }
      if (translator.init.model && turn.assistant.message.model?.modelId === 'default') {
        turn.assistant.message.model = { providerId: 'claude-code', modelId: translator.init.model };
      }
      const patch: Partial<ClaudeState> = {};
      if (translator.init.slashCommands?.length) patch.slashCommands = translator.init.slashCommands;
      if (translator.init.mcpServers) patch.mcpStatus = Object.fromEntries(translator.init.mcpServers.map((s) => [s.name, s.status]));
      if (Object.keys(patch).length) {
        await this.stateFile.update(patch);
        this.emit({ type: 'catalog.changed' });
        this.emit({ type: 'mcp.changed' });
      }
      if (translator.error) throw new Error(translator.error);
      if (!translator.finished) {
        throw new Error(`Claude Code exited (code ${code ?? '?'}) before finishing.${stderr.trim() ? ' ' + stderr.trim().slice(-500) : ''}${/login|auth|credential|api key/i.test(stderr) ? ' Use /login to sign in with your Claude account.' : ''}`);
      }
    } finally {
      if (mcpFile) await fs.rm(mcpFile, { force: true }).catch(() => undefined);
    }
  }
}

/** One stream-json user message with text and image blocks. */
async function userLine(input: PromptInput): Promise<string> {
  const { text, images } = promptForAgent(input);
  const content: unknown[] = [];
  if (text) content.push({ type: 'text', text });
  for (const a of images) {
    const img = await imageBase64(a);
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
