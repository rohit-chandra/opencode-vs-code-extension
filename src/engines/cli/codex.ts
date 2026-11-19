import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EngineContext } from '../../core/engine';
import { EngineError } from '../../core/engine';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { findExecutable, runCapture } from '../../core/process';
import type { EngineCapabilities, McpServerInfo, ModelRef, ProviderInfo } from '../../shared/types';
import { CodexStreamTranslator } from './codexStream';
import { StateFile, imageBase64, promptForAgent, runJsonl } from './common';

interface CodexState {
  disabledMcp: string[];
}

/**
 * Codex engine: drives the user's own `codex` CLI (`codex exec --json`), so it uses the
 * ChatGPT login or API key that CLI is configured with.
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
  private stateFile: StateFile<CodexState>;

  constructor(ctx: EngineContext) {
    super(ctx, 'codex');
    this.stateFile = new StateFile<CodexState>(path.join(ctx.storageDir, 'codex.json'), { disabledMcp: [] });
  }

  private env(): NodeJS.ProcessEnv {
    return this.ctx.env ?? process.env;
  }

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string; version?: string }> {
    this.exe = await findExecutable('codex', this.ctx.config<string>('codex.path', ''), this.env());
    if (!this.exe) {
      return { ok: false, detail: 'Codex CLI not found. Install it (npm i -g @openai/codex), sign in with `codex login`, or set "opencodeHub.codex.path".' };
    }
    const v = await runCapture(this.exe, ['--version'], { env: this.env(), timeoutMs: 15_000 });
    return { ok: true, version: v.stdout.trim().split(/\s+/).pop() || undefined };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const extra = this.ctx.config<string[]>('codex.models', []);
    const ids = ['default', ...new Set(Array.isArray(extra) ? extra : [])];
    return [
      {
        id: 'codex',
        name: 'Codex',
        connected: true,
        models: ids.map((id) => ({ providerId: 'codex', modelId: id, name: id === 'default' ? 'Default (from ~/.codex/config.toml)' : id, supportsImages: true, supportsTools: true })),
      },
    ];
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
        env: this.env(),
        stdin: text,
        signal,
        onEvent: (ev) => translator.handle(ev),
        onText: (line) => this.ctx.log.debug(`[codex] ${line}`),
      });
      if (signal.aborted) return;
      if (translator.threadId) session.meta.codexThreadId = translator.threadId;
      if (translator.error) throw new Error(translator.error);
      if (!translator.finished) {
        throw new Error(`Codex exited (code ${code ?? '?'}) before finishing.${stderr.trim() ? ' ' + stderr.trim().slice(-500) : ''}${/login|auth|401/i.test(stderr) ? ' Run `codex login` in a terminal to sign in.' : ''}`);
      }
    } finally {
      await Promise.all(temp.map((f) => fs.rm(f, { force: true }).catch(() => undefined)));
    }
  }
}
