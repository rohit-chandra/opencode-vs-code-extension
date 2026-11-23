import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineAccount, EngineContext } from '../../core/engine';
import { EngineError } from '../../core/engine';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { listedModels } from '../../core/listPrices';
import { findExecutable, runCapture, terminalCommand } from '../../core/process';
import type { StoredSession } from '../../core/localSessions';
import type { AuthMode, AuthStatus, ChatMessage, EngineCapabilities, McpServerInfo, ModelInfo, ModelRef, PermissionReply, PromptInput, ProviderInfo, SlashCommand } from '../../shared/types';
import { FreshList } from './freshList';
import { claudeInitInfo, claudeModelInfo, claudeVersions } from './modelDiscovery';
import type { ClaudeVersion } from './modelDiscovery';
import { apiKeySecret, authMode, claudeEnv, parseClaudeAuthStatus, shellExe } from './auth';
import { APPROVER_SERVER, APPROVER_TOOL, ClaudeApprover } from './claudeApprover';
import { ClaudeStreamTranslator } from './claudeStream';
import { StateFile, imageBase64, promptForAgent, readJsonFile, runJsonl } from './common';
import { repairClaudeCosts } from './usageRepair';

interface ClaudeState {
  slashCommands: string[];
  disabledMcp: string[];
  mcpStatus: Record<string, string>;
}

type McpDefs = Record<string, { command?: string; args?: string[]; url?: string; type?: string; [k: string]: unknown }>;

/** The model families Claude Code always has an alias for (it resolves each to the newest version it knows). */
const FAMILY_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * Models Claude Code accepts with `--model` but leaves out of the list it reports for some
 * accounts. They are offered after the account's own list, so every Claude model can be
 * picked; one that the plan does not include answers with Anthropic's own message.
 *
 * Each is offered by its full id and real name ("Opus 5.5", `claude-opus-5-5`) from the
 * catalogue that ships with the extension, newest first: the name then says which version
 * runs, and it runs that version whatever an older CLI takes a bare `opus` to mean. A family
 * the catalogue does not have yet keeps its alias.
 */
export function moreModels(listed: ModelInfo[], reported: boolean, catalogue: ClaudeVersion[] = claudeVersions(listedModels('anthropic'))): ModelInfo[] {
  const has = (id: string) => listed.some((m) => m.modelId === id || m.resolvedId === id);
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  const base = { providerId: 'claude-code', supportsImages: true, supportsTools: true };
  const missing = reported ? 'Not in the list Claude Code reports for your account. It may need a higher plan or usage credits' : undefined;
  const newest: ModelInfo[] = [];
  const earlier: ModelInfo[] = [];
  const families = [...new Set([...FAMILY_ALIASES, ...catalogue.map((v) => v.family)])];
  for (const family of families) {
    const versions = catalogue.filter((v) => v.family === family);
    if (versions.length === 0) {
      // No version of this family is known here: its alias, which the CLI resolves itself.
      if (!has(family)) newest.push({ ...base, modelId: family, name: `${cap(family)} (newest your Claude Code knows)`, description: missing });
      continue;
    }
    versions.forEach((v, i) => {
      if (has(v.id)) return;
      // The account's own entry for the family (`opus`) already runs its newest version.
      if (i === 0 && listed.some((m) => m.modelId === family && !m.resolvedId)) return;
      if (i === 0) newest.push({ ...base, modelId: v.id, name: v.name, description: missing ?? `Newest ${cap(family)}` });
      else earlier.push({ ...base, modelId: v.id, name: v.name, description: `Earlier ${cap(family)} version${reported ? '. Not every plan includes it' : ''}` });
    });
  }
  const plan: ModelInfo[] = has('opusplan') ? [] : [{ ...base, modelId: 'opusplan', name: 'Opus Plan Mode', description: 'Opus while planning, Sonnet for the rest' }];
  return [...newest, ...plan, ...earlier];
}

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
    // Asked through the --permission-prompt-tool bridge (see claudeApprover.ts).
    permissions: true,
    providerAuth: false,
    remoteSessions: false,
  };

  private exe: string | undefined;
  private stateFile: StateFile<ClaudeState>;
  private approver: ClaudeApprover;
  /** The account's models as the CLI reports them; kept fresh in the background (see FreshList). */
  private models = new FreshList<ModelInfo[]>(() => this.fetchAccountModels(), { isEmpty: (m) => m.length === 0, onChange: () => this.emit({ type: 'catalog.changed' }) });
  /** Tools the user chose "Always allow" for, per session (until VS Code restarts). */
  private alwaysAllowed = new Map<string, Set<string>>();

  constructor(ctx: EngineContext) {
    super(ctx, 'claude-code');
    this.stateFile = new StateFile<ClaudeState>(path.join(ctx.storageDir, 'claude-code.json'), { slashCommands: [], disabledMcp: [], mcpStatus: {} });
    this.approver = new ClaudeApprover(ctx.storageDir);
  }

  override async dispose(): Promise<void> {
    this.approver.dispose();
    await super.dispose();
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
    loginCommand: () => `${shellExe(this.ctx.config<string>('claudeCode.path', ''), terminalCommand('claude', this.exe, this.env()))} auth login --claudeai`,
    logoutCommand: () => `${shellExe(this.ctx.config<string>('claudeCode.path', ''), terminalCommand('claude', this.exe, this.env()))} auth logout`,
  };

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string; version?: string }> {
    this.models.invalidate();
    this.exe = await findExecutable('claude', this.ctx.config<string>('claudeCode.path', ''), this.env());
    if (!this.exe) {
      return { ok: false, detail: 'Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) or set "opencodeHub.claudeCode.path", then sign in with your Claude account.' };
    }
    const v = await runCapture(this.exe, ['--version'], { env: this.env(), timeoutMs: 15_000 });
    return { ok: true, version: v.stdout.trim().split(/\s+/)[0] || undefined };
  }

  /** Forget the cached model list (after signing in, or switching between account and API key). */
  invalidateModels(): void {
    this.models.invalidate();
  }

  /** Minimum age of the list before `refreshModels` asks the CLI again. */
  modelRecheckMs = 10_000;

  /** Ask the CLI for the account's models again, in the background (see `Engine.refreshModels`). */
  refreshModels(): void {
    this.models.refresh(this.account.mode(), this.modelRecheckMs);
  }

  /** The models the signed-in account can use, with their real names (e.g. "Opus 5.5"), as the CLI reports them. */
  private accountModels(): Promise<ModelInfo[]> {
    return this.models.get(this.account.mode());
  }

  private async fetchAccountModels(): Promise<ModelInfo[]> {
    if (!this.exe) return [];
    const env = await this.runEnv().catch(() => undefined);
    const info = env ? await claudeInitInfo(this.exe, env, this.ctx.cwd()) : undefined;
    const models: ModelInfo[] = [];
    for (const m of (info?.models ?? []).map(claudeModelInfo)) if (!models.some((x) => x.modelId === m.modelId)) models.push(m);
    if (info?.commands.length) {
      const state = await this.stateFile.read();
      if (state.slashCommands.length === 0) {
        await this.stateFile.update({ slashCommands: info.commands });
        this.emit({ type: 'catalog.changed' });
      }
    }
    if (models.length) this.ctx.log.info(`Claude Code reports ${models.length} models for this account: ${models.map((m) => m.modelId).join(', ')}`);
    else this.ctx.log.warn('Claude Code did not report its models; showing the standard aliases.');
    return models;
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const extra = this.ctx.config<string[]>('claudeCode.models', []);
    let models = [...(await this.accountModels())];
    const reported = models.length > 0;
    if (!reported) models = [{ providerId: 'claude-code', modelId: 'default', name: 'Default (from Claude Code settings)', supportsImages: true, supportsTools: true }];
    // Models the CLI did not list run through the same CLI, so they take the same effort levels.
    const efforts = models.find((m) => m.modelId === 'default')?.efforts ?? models.find((m) => m.efforts)?.efforts;
    const listed = models.length;
    // Models the user added by name come right after the account's own, ahead of the catalogue's.
    for (const id of Array.isArray(extra) ? extra : []) {
      if (typeof id === 'string' && id.trim() && !models.some((m) => m.modelId === id.trim() || m.resolvedId === id.trim())) models.push({ providerId: 'claude-code', modelId: id.trim(), name: claudeVersions([id.trim()])[0]?.name ?? id.trim(), description: 'Added by you', supportsImages: true, supportsTools: true });
    }
    models.push(...moreModels(models, reported));
    if (efforts) for (const m of models.slice(listed)) m.efforts = efforts;
    return [{ id: 'claude-code', name: 'Claude Code', connected: true, models }];
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

  /** Opening a session saved by an earlier version puts its replies' cost right (see `usageRepair.ts`). */
  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const session = await this.store.get(sessionId);
    if (!session) return [];
    if (!session.meta.costPerTurn && !this.isRunning(sessionId) && session.messages.some((m) => m.usage)) {
      costSoFar(session);
      await this.store.persist(sessionId).catch(() => undefined);
    }
    return session.messages;
  }

  /* ------------------------------------------------------------------ turn */

  protected async runTurn(turn: Turn): Promise<void> {
    if (!this.exe) throw new EngineError('Claude Code CLI not found.');
    const { session, input, assistant, signal } = turn;
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'];
    const mode = this.ctx.config<string>('claudeCode.permissionMode', 'acceptEdits');
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    if (input.model && input.model.modelId !== 'default') args.push('--model', input.model.modelId);
    if (input.effort && /^[A-Za-z0-9_-]+$/.test(input.effort)) args.push('--effort', input.effort);
    const resume = session.meta.claudeSessionId as string | undefined;
    if (resume) {
      args.push('--resume', resume);
      if (session.meta.forkPending) args.push('--fork-session');
    }

    const env = await this.runEnv();
    const state = await this.stateFile.read();
    const servers: McpDefs = {};
    const strict = state.disabledMcp.length > 0;
    if (strict) {
      const { defs } = await this.mcpDefinitions();
      Object.assign(servers, Object.fromEntries(Object.entries(defs).filter(([name]) => !state.disabledMcp.includes(name))));
    }
    // Tool approvals and questions: Claude Code asks our bridge, which shows the request in the chat
    // (or approves it straight away in Auto mode). With permissions bypassed nothing needs approval,
    // but Claude's questions still come through the bridge, so it is opened either way.
    const sid = session.info.id;
    const always = this.alwaysAllowed.get(sid) ?? new Set<string>();
    this.alwaysAllowed.set(sid, always);
    const approver = await this.approver.open(
      (req) => (mode === 'bypassPermissions' ? Promise.resolve<PermissionReply>('once') : this.askPermission(sid, req, signal)),
      always,
      (questions) => this.askQuestions(sid, questions, signal),
    );
    servers[APPROVER_SERVER] = approver.server as McpDefs[string];
    args.push('--permission-prompt-tool', APPROVER_TOOL);
    // A prompt waits for the user; don't let Claude Code time it out.
    env.MCP_TOOL_TIMEOUT ??= String(24 * 3600_000);
    const mcpFile = path.join(this.ctx.storageDir, `claude-mcp-${session.info.id}.json`);
    await fs.mkdir(this.ctx.storageDir, { recursive: true });
    await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: servers }), 'utf8');
    if (strict) args.push('--strict-mcp-config');
    args.push('--mcp-config', mcpFile);

    // Claude Code reports a resumed conversation's cost from its first turn on; what it had
    // reached is kept with the session, so each reply is charged only its own part.
    const translator = new ClaudeStreamTranslator(assistant, resume ? costSoFar(session) : 0);
    try {
      const { code, stderr } = await runJsonl({
        file: this.exe,
        args,
        cwd: this.ctx.cwd() ?? this.ctx.storageDir,
        env,
        stdin: (await userLine(input)) + '\n',
        signal,
        onEvent: (ev) => {
          translator.handle(ev);
          // Keep the CLI's session id from the first event, so --resume works even if VS Code closes mid-reply.
          if (translator.init.sessionId && session.meta.claudeSessionId !== translator.init.sessionId) {
            session.meta.claudeSessionId = translator.init.sessionId;
            delete session.meta.forkPending;
          }
        },
        onText: (line) => this.ctx.log.debug(`[claude] ${line}`),
      });
      if (signal.aborted) return;
      if (translator.init.sessionId) {
        session.meta.claudeSessionId = translator.init.sessionId;
        delete session.meta.forkPending;
      }
      if (translator.costTotal !== undefined) {
        session.meta.claudeCostTotal = translator.costTotal;
        session.meta.costPerTurn = true;
      }
      // The model that actually answered (`claude-opus-5-5`), not the alias that was asked for
      // (`opus`, `default`): the reply's footer and the usage panel then name the real version.
      if (translator.init.model && turn.assistant.message.model) {
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
      // The CLI has just talked to Anthropic and knows the account's plan now: check the model list again.
      this.models.refresh(this.account.mode(), 20_000);
      if (translator.error) throw new Error(translator.error);
      if (!translator.finished) {
        throw new Error(`Claude Code exited (code ${code ?? '?'}) before finishing.${stderr.trim() ? ' ' + stderr.trim().slice(-500) : ''}${/login|auth|credential|api key/i.test(stderr) ? ' Use /login to sign in with your Claude account.' : ''}`);
      }
    } finally {
      approver.close();
      await fs.rm(mcpFile, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * What a Claude Code conversation had cost before the turn that is starting. Sessions from
 * before this was tracked have no total; there the last reply's cost is it, because every
 * reply used to be stored with the conversation's running total.
 */
function costSoFar(session: StoredSession): number {
  if (!session.meta.costPerTurn) {
    // The reply being written has no usage yet, so it is not touched.
    const reached = repairClaudeCosts(session.messages);
    session.meta.costPerTurn = true;
    if (typeof session.meta.claudeCostTotal !== 'number') session.meta.claudeCostTotal = reached;
  }
  const kept = session.meta.claudeCostTotal;
  return typeof kept === 'number' && kept >= 0 ? kept : 0;
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
