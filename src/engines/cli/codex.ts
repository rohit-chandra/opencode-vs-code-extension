import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EngineAccount, EngineContext } from '../../core/engine';
import { EngineError } from '../../core/engine';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { findExecutable, runCapture } from '../../core/process';
import type { AuthMode, AuthStatus, EngineCapabilities, McpServerInfo, ModelInfo, ModelRef, ProviderInfo } from '../../shared/types';
import { codexModels } from './modelDiscovery';
import { apiKeySecret, authMode, codexEnv, parseCodexLoginStatus, shellExe } from './auth';
import { CodexStreamTranslator } from './codexStream';
import { StateFile, imageBase64, promptForAgent, runJsonl } from './common';

interface CodexState {
  disabledMcp: string[];
}

/**
 * Codex engine: drives the user's own `codex` CLI (`codex exec --json`). By default it uses
 * the ChatGPT account (Plus / Pro / Team plan) the CLI is signed in with; an API key is used
 * only when the user picks API-key mode.
 */
export class CodexEngine extends LocalEngine {
  readonly id = 'codex' as const;
  readonly capabilities: EngineCapabilities = {
    agents: false,
    fork: false,
    share: false,
    undo: false,
    compact: false,
    images: true,
    mcpToggle: true,
    permissions: false,
    providerAuth: false,
    remoteSessions: false,
  };

  private exe: string | undefined;
  private version = '0';
  private modelCache: { at: number; mode: string; models: ModelInfo[]; defaultName?: string } | undefined;
  private stateFile: StateFile<CodexState>;

  constructor(ctx: EngineContext) {
    super(ctx, 'codex');
    this.stateFile = new StateFile<CodexState>(path.join(ctx.storageDir, 'codex.json'), { disabledMcp: [] });
  }

  private env(): NodeJS.ProcessEnv {
    return this.ctx.env ?? process.env;
  }

  /** Environment for the CLI: without CODEX_API_KEY in subscription mode, with the stored key in API-key mode. */
  private async runEnv(): Promise<NodeJS.ProcessEnv> {
    const mode = this.account.mode();
    return codexEnv(this.env(), mode, mode === 'apiKey' ? await this.ctx.secrets.get(this.account.secretKey) : undefined);
  }

  readonly account: EngineAccount = {
    accountName: 'ChatGPT',
    modeSetting: 'codex.auth',
    secretKey: apiKeySecret('codex'),
    mode: (): AuthMode => authMode(this.ctx.config<string>('codex.auth', 'subscription')),
    status: async (): Promise<AuthStatus> => {
      const mode = this.account.mode();
      if (mode === 'apiKey') {
        const stored = await this.ctx.secrets.get(this.account.secretKey);
        const env = this.env();
        const key = stored || env.CODEX_API_KEY || env.OPENAI_API_KEY;
        return { engine: 'codex', mode, signedIn: !!key, billing: 'apiKey', label: key ? `API key${stored ? '' : ' (from the environment)'}` : undefined };
      }
      if (!this.exe) return { engine: 'codex', mode, signedIn: undefined };
      const res = await runCapture(this.exe, ['login', 'status'], { env: await this.runEnv(), timeoutMs: 20_000 }).catch(() => undefined);
      return { engine: 'codex', mode, ...(res ? parseCodexLoginStatus(`${res.stdout}\n${res.stderr}`, res.code) : { signedIn: undefined }) };
    },
    loginCommand: (options) => `${shellExe(this.ctx.config<string>('codex.path', ''), 'codex')} login${options?.deviceCode ? ' --device-auth' : ''}`,
    logoutCommand: () => `${shellExe(this.ctx.config<string>('codex.path', ''), 'codex')} logout`,
  };

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string; version?: string }> {
    this.modelCache = undefined;
    this.exe = await findExecutable('codex', this.ctx.config<string>('codex.path', ''), this.env());
    if (!this.exe) {
      return { ok: false, detail: 'Codex CLI not found. Install it (npm i -g @openai/codex) or set "opencodeHub.codex.path", then sign in with your ChatGPT account.' };
    }
    const v = await runCapture(this.exe, ['--version'], { env: this.env(), timeoutMs: 15_000 });
    const version = v.stdout.trim().split(/\s+/).pop() || undefined;
    this.version = version ?? '0';
    return { ok: true, version };
  }

  /** Forget the cached model list (after signing in, or switching between account and API key). */
  invalidateModels(): void {
    this.modelCache = undefined;
  }

  /** The models the signed-in account (ChatGPT plan or API key) can use, from `codex app-server`. */
  private async accountModels(): Promise<{ models: ModelInfo[]; defaultName?: string }> {
    const mode = this.account.mode();
    const cached = this.modelCache;
    if (cached && cached.mode === mode && Date.now() - cached.at < (cached.models.length ? 10 * 60_000 : 30_000)) return cached;
    const models: ModelInfo[] = [];
    let defaultName: string | undefined;
    if (this.exe) {
      const env = await this.runEnv().catch(() => undefined);
      const list = env ? await codexModels(this.exe, env, this.ctx.cwd(), this.version) : undefined;
      for (const m of list ?? []) {
        const id = m.model ?? m.id;
        if (!id || m.hidden || models.some((x) => x.modelId === id)) continue;
        models.push({ providerId: 'codex', modelId: id, name: m.displayName ?? id, description: m.description, supportsImages: !m.inputModalities || m.inputModalities.includes('image'), supportsTools: true });
        if (m.isDefault) defaultName = m.displayName ?? id;
      }
      if (!list) this.ctx.log.warn('Codex did not report its models; set extra ones under "opencodeHub.codex.models".');
    }
    this.modelCache = { at: Date.now(), mode, models, defaultName };
    return this.modelCache;
  }

  /** `model = "…"` from config.toml, which Codex uses when no model is given. */
  private async configuredModel(): Promise<string | undefined> {
    const env = this.env();
    const home = env.CODEX_HOME || path.join(env.HOME ?? env.USERPROFILE ?? '', '.codex');
    const toml = await fs.readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '');
    // Only the top-level key: stop at the first [table].
    const top = toml.split(/^\s*\[/m)[0];
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1];
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const extra = this.ctx.config<string[]>('codex.models', []);
    const [{ models: found, defaultName }, configured] = await Promise.all([this.accountModels(), this.configuredModel()]);
    const configuredName = configured ? found.find((m) => m.modelId === configured)?.name ?? configured : undefined;
    const current = configuredName ?? defaultName;
    const models: ModelInfo[] = [{ providerId: 'codex', modelId: 'default', name: current ? `Default (${current})` : 'Default (from ~/.codex/config.toml)', description: configured ? 'The model set in ~/.codex/config.toml' : 'The recommended model for your plan', supportsImages: true, supportsTools: true }, ...found];
    for (const id of Array.isArray(extra) ? extra : []) {
      if (typeof id === 'string' && !models.some((m) => m.modelId === id)) models.push({ providerId: 'codex', modelId: id, name: id, supportsImages: true, supportsTools: true });
    }
    return [{ id: 'codex', name: 'Codex', connected: true, models }];
  }

  override async defaultModel(): Promise<ModelRef | undefined> {
    return { providerId: 'codex', modelId: 'default' };
  }

  override async listMcp(): Promise<McpServerInfo[]> {
    if (!this.exe) return [];
    const [res, state] = await Promise.all([runCapture(this.exe, ['mcp', 'list', '--json'], { env: this.env(), cwd: this.ctx.cwd(), timeoutMs: 15_000 }), this.stateFile.read()]);
    let servers: { name: string; enabled?: boolean; transport?: { type?: string }; auth_status?: string }[] = [];
    try {
      const start = res.stdout.indexOf('[');
      servers = start >= 0 ? JSON.parse(res.stdout.slice(start)) : [];
    } catch {
      this.ctx.log.warn('Could not parse `codex mcp list --json` output.');
    }
    return servers
      .map((s) => {
        const enabled = s.enabled !== false && !state.disabledMcp.includes(s.name);
        const status: McpServerInfo['status'] = !enabled ? 'disabled' : s.auth_status === 'not_logged_in' ? 'needs_auth' : 'connected';
        return { name: s.name, enabled, status, transport: s.transport?.type === 'stdio' ? ('stdio' as const) : ('http' as const), source: '~/.codex/config.toml', canToggle: true };
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

  protected async runTurn(turn: Turn): Promise<void> {
    if (!this.exe) throw new EngineError('Codex CLI not found.');
    const { session, input, assistant, signal } = turn;
    const threadId = session.meta.codexThreadId as string | undefined;
    const args = threadId ? ['exec', 'resume', threadId] : ['exec'];
    args.push('--json', '--skip-git-repo-check');
    // No quotes: Codex takes a value that is not valid TOML as a literal string, and bare
    // words survive every shell (the CLI is a .cmd shim on Windows).
    const sandbox = this.ctx.config<string>('codex.sandbox', 'workspace-write');
    args.push('-c', `sandbox_mode=${['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox) ? sandbox : 'workspace-write'}`);
    if (input.model && input.model.modelId !== 'default') args.push('-m', input.model.modelId);
    const state = await this.stateFile.read();
    // Explicit overrides both ways, so a server disabled in config.toml can be switched on from the UI.
    for (const s of await this.listMcp().catch(() => [])) {
      if (/^[A-Za-z0-9_-]+$/.test(s.name)) args.push('-c', `mcp_servers.${s.name}.enabled=${!state.disabledMcp.includes(s.name) && s.enabled}`);
    }

    const env = await this.runEnv();
    const { text, images } = promptForAgent(input);
    const temp: string[] = [];
    for (const a of images) {
      if (a.path) {
        args.push('-i', a.path);
        continue;
      }
      const img = await imageBase64(a);
      if (!img) continue;
      const dir = path.join(this.ctx.storageDir, 'tmp');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${a.id}.${img.mime.split('/')[1] ?? 'png'}`);
      await fs.writeFile(file, Buffer.from(img.data, 'base64'));
      temp.push(file);
      args.push('-i', file);
    }
    args.push('-'); // prompt comes from stdin, which avoids shell quoting on every platform

    const translator = new CodexStreamTranslator(assistant);
    try {
      const { code, stderr } = await runJsonl({
        file: this.exe,
        args,
        cwd: this.ctx.cwd() ?? this.ctx.storageDir,
        env,
        stdin: text,
        signal,
        onEvent: (ev) => translator.handle(ev),
        onText: (line) => this.ctx.log.debug(`[codex] ${line}`),
      });
      if (signal.aborted) return;
      if (translator.threadId) session.meta.codexThreadId = translator.threadId;
      if (translator.error) throw new Error(translator.error);
      if (!translator.finished) {
        throw new Error(`Codex exited (code ${code ?? '?'}) before finishing.${stderr.trim() ? ' ' + stderr.trim().slice(-500) : ''}${/login|auth|401/i.test(stderr) ? ' Use /login to sign in with your ChatGPT account.' : ''}`);
      }
    } finally {
      await Promise.all(temp.map((f) => fs.rm(f, { force: true }).catch(() => undefined)));
    }
  }
}
