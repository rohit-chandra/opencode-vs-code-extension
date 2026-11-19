import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Emitter } from '../../core/emitter';
import type { Disposable } from '../../core/emitter';
import type { Engine, EngineContext } from '../../core/engine';
import { EngineError, errorMessage } from '../../core/engine';
import { readSse } from '../../core/sse';
import type {
  AgentInfo,
  Attachment,
  ChatMessage,
  EngineCapabilities,
  EngineEvent,
  EngineStatus,
  McpServerInfo,
  ModelRef,
  PermissionReply,
  PromptInput,
  ProviderInfo,
  SessionActivity,
  SessionInfo,
  SlashCommand,
} from '../../shared/types';
import { OpencodeClient } from './client';
import { mapCommand, mapMcp, mapMessage, mapPart, mapPermission, mapProvider, mapQuestion, mergeProviderLists, mapSession, mapUsage } from './mapping';
import type { OcApiModel, OcMessageInfo, OcPart, OcProvider, OcSession } from './mapping';
import { startOpencodeServer } from './server';
import type { RunningServer } from './server';

interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Primary engine: talks to `opencode serve` over HTTP and its SSE event bus.
 * opencode owns sessions, tools, permissions, MCP and provider credentials; this class
 * only translates between its API and the normalized model in `shared/types`.
 */
/** How often the credentials file is checked for a sign-in made outside the extension. */
const CREDENTIAL_POLL_MS = 1500;

export class OpencodeEngine implements Engine {
  readonly id = 'opencode' as const;
  readonly capabilities: EngineCapabilities = {
    agents: true,
    fork: true,
    share: true,
    undo: true,
    compact: true,
    images: true,
    mcpToggle: true,
    permissions: true,
    providerAuth: true,
    remoteSessions: true,
  };

  private emitter = new Emitter<EngineEvent>();
  private state: EngineStatus = { engine: 'opencode', state: 'idle' };
  private server: RunningServer | undefined;
  private client: OpencodeClient | undefined;
  private starting: Promise<EngineStatus> | undefined;
  private sseAbort: AbortController | undefined;
  private disposed = false;
  /** Role of each message we have seen, so part events can be attributed. */
  private roles = new Map<string, 'user' | 'assistant'>();
  private lastUserMessage = new Map<string, string>();
  /** Watches opencode's credentials file, so a sign-in made in a terminal shows up here. */
  private credentialWatch: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ctx: EngineContext) {}

  onEvent(listener: (event: EngineEvent) => void): Disposable {
    return this.emitter.event(listener);
  }

  status(): EngineStatus {
    return this.state;
  }

  private setStatus(state: EngineStatus['state'], detail?: string): EngineStatus {
    this.state = { engine: 'opencode', state, detail, version: this.server?.version };
    this.emitter.fire({ type: 'engine.status', status: this.state });
    return this.state;
  }

  start(): Promise<EngineStatus> {
    if (this.state.state === 'ready') return Promise.resolve(this.state);
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(): Promise<EngineStatus> {
    this.setStatus('starting', 'Starting opencode…');
    try {
      const directory = this.ctx.cwd() ?? this.ctx.storageDir;
      this.server = await startOpencodeServer(this.ctx, directory);
      this.client = new OpencodeClient(this.server.connection);
      this.server.onExit((reason) => {
        if (this.disposed || !this.client) return;
        this.ctx.log.warn(reason);
        this.teardown();
        this.setStatus('unavailable', reason);
      });
      this.listen();
      if (this.server.owned) await this.watchCredentials();
      return this.setStatus('ready');
    } catch (err) {
      this.teardown();
      const hint = err instanceof EngineError && err.hint ? ` ${err.hint}` : '';
      this.ctx.log.error(`opencode engine failed to start: ${errorMessage(err)}${hint}`);
      return this.setStatus('unavailable', errorMessage(err) + hint);
    }
  }

  async restart(): Promise<EngineStatus> {
    this.teardown();
    this.state = { engine: 'opencode', state: 'idle' };
    return this.start();
  }

  /** opencode's data folder: `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`, on every platform (Windows included). */
  dataDir(): string {
    const env = this.ctx.env ?? process.env;
    const data = env.XDG_DATA_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.local', 'share');
    return path.join(data, 'opencode');
  }

  /** Where keys saved the older way (`opencode auth login` before integrations, `PUT /auth`) live. */
  credentialsFile(): string {
    return path.join(this.dataDir(), 'auth.json');
  }

  /**
   * Sign-ins happen in a terminal, as their own process: `opencode auth login` (ChatGPT,
   * Copilot, the OpenCode Console account, API keys) and `opencode console login`. Older
   * CLIs write `auth.json`; newer ones store "integrations" in opencode's database. The server
   * we started does not notice either: keys in `auth.json` need a reload, and the chat has
   * to list the models again in both cases.
   *
   * So: a cheap check of the files every couple of seconds; when one changed, ask the server
   * which providers are connected now, and only if that changed, reload and list again. The
   * database also changes with every chat message, which is why the second step is needed.
   */
  private async watchCredentials(): Promise<void> {
    this.stopCredentialWatch();
    const dir = this.dataDir();
    const files = async () => {
      try {
        const names = (await fs.readdir(dir)).filter((n) => n === 'auth.json' || /^opencode.*\.db(-wal)?$/.test(n)).sort();
        const stats = await Promise.all(names.map(async (n) => [n, await fs.stat(path.join(dir, n)).then((st) => `${st.mtimeMs}:${st.size}`).catch(() => '-')]));
        return Object.fromEntries(stats) as Record<string, string>;
      } catch {
        return {} as Record<string, string>;
      }
    };
    const authKey = (f: Record<string, string>) => f['auth.json'] ?? 'missing';
    let lastFiles = await files();
    let lastConnections = await this.connections();
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        const now = await files();
        if (JSON.stringify(now) === JSON.stringify(lastFiles) || timer !== this.credentialWatch) return;
        const authChanged = authKey(now) !== authKey(lastFiles);
        lastFiles = now;
        const connections = await this.connections();
        const integrationsChanged = connections !== lastConnections;
        lastConnections = connections;
        if (!authChanged && !integrationsChanged) return;
        this.ctx.log.info(`opencode sign-in changed (${authChanged ? 'auth.json' : 'integrations'}); listing models again`);
        // Keys in auth.json are read when the instance starts; integrations are read live.
        if (authChanged) await this.reloadProviders();
        else this.emitter.fire({ type: 'catalog.changed' });
      })().finally(() => (busy = false));
    }, CREDENTIAL_POLL_MS);
    timer.unref?.();
    this.credentialWatch = timer;
  }

  /** Connected integrations, as a comparable string. Empty on opencode versions without integrations. */
  private async connections(): Promise<string> {
    if (!this.client) return '';
    const res = await this.client.get<{ data?: { id: string; connections?: unknown[] }[] }>('api/integration').catch(() => undefined);
    return (res?.data ?? [])
      .filter((i) => Array.isArray(i.connections) && i.connections.length > 0)
      .map((i) => `${i.id}:${JSON.stringify(i.connections)}`)
      .sort()
      .join('|');
  }

  private stopCredentialWatch(): void {
    if (this.credentialWatch) clearInterval(this.credentialWatch);
    this.credentialWatch = undefined;
  }

  /** Make the running server read its credentials again, then have the chat list models again. */
  async reloadProviders(): Promise<void> {
    if (!this.client) return;
    await this.api()
      .post('instance/dispose')
      .catch((err) => this.ctx.log.warn(`opencode could not reload its providers: ${errorMessage(err)}`));
    this.emitter.fire({ type: 'catalog.changed' });
  }

  private teardown(): void {
    this.stopCredentialWatch();
    this.sseAbort?.abort();
    this.sseAbort = undefined;
    this.server?.stop();
    this.server = undefined;
    this.client = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.teardown();
    this.emitter.dispose();
  }

  private api(): OpencodeClient {
    if (!this.client) throw new EngineError(this.state.detail ?? 'opencode is not running.');
    return this.client;
  }

  /* ------------------------------------------------------------------ events */

  private listen(): void {
    const client = this.api();
    const abort = new AbortController();
    this.sseAbort = abort;
    void (async () => {
      let delay = 500;
      let first = true;
      while (!abort.signal.aborted) {
        try {
          const res = await fetch(client.url('event'), { headers: client.headers({ accept: 'text/event-stream' }), signal: abort.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          delay = 500;
          if (!first) this.setStatus('ready'); // tells the controller to re-sync after a reconnect
          first = false;
          for await (const msg of readSse(res, abort.signal)) {
            if (!msg.data) continue;
            let event: OcEvent;
            try {
              event = JSON.parse(msg.data) as OcEvent;
            } catch {
              continue;
            }
            // `/global/event` style envelopes wrap the event in `payload`.
            const payload = (event as unknown as { payload?: OcEvent }).payload;
            try {
              this.handleEvent(payload?.type ? payload : event);
            } catch (err) {
              this.ctx.log.warn(`Failed to handle opencode event ${event.type}: ${errorMessage(err)}`);
            }
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          this.ctx.log.debug(`opencode event stream interrupted: ${errorMessage(err)}`);
        }
        if (abort.signal.aborted) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    })();
  }

  private handleEvent(event: OcEvent): void {
    const p = event.properties ?? {};
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = p.info as OcSession | undefined;
        if (info?.id) this.emitter.fire({ type: 'session.updated', session: mapSession(info) });
        break;
      }
      case 'session.deleted': {
        const id = (p.info as OcSession | undefined)?.id ?? (p.sessionID as string | undefined);
        if (id) this.emitter.fire({ type: 'session.deleted', sessionId: id });
        break;
      }
      case 'message.updated': {
        const info = p.info as OcMessageInfo | undefined;
        if (!info?.id) break;
        this.roles.set(info.id, info.role);
        if (info.role === 'user') this.lastUserMessage.set(info.sessionID, info.id);
        const message = mapMessage(info);
        this.emitter.fire({ type: 'message.updated', message, infoOnly: true });
        if (message.usage && message.model) {
          this.emitter.fire({ type: 'usage', sessionId: message.sessionId, messageId: message.id, model: message.model, usage: message.usage });
        }
        break;
      }
      case 'message.removed':
        if (p.sessionID && p.messageID) this.emitter.fire({ type: 'message.removed', sessionId: p.sessionID as string, messageId: p.messageID as string });
        break;
      case 'message.part.updated': {
        const part = p.part as OcPart | undefined;
        if (!part?.id) break;
        const mapped = mapPart(part);
        if (mapped) this.emitter.fire({ type: 'part.updated', sessionId: part.sessionID, messageId: part.messageID, part: mapped });
        break;
      }
      case 'message.part.delta':
        if (p.field === 'text' && typeof p.delta === 'string') {
          this.emitter.fire({ type: 'part.delta', sessionId: p.sessionID as string, messageId: p.messageID as string, partId: p.partID as string, delta: p.delta });
        }
        break;
      case 'message.part.removed':
        if (p.sessionID && p.messageID && p.partID) this.emitter.fire({ type: 'part.removed', sessionId: p.sessionID as string, messageId: p.messageID as string, partId: p.partID as string });
        break;
      case 'session.status': {
        const st = p.status as { type?: string; message?: string; attempt?: number } | undefined;
        const activity = st?.type === 'busy' ? 'busy' : st?.type === 'retry' ? 'retry' : 'idle';
        this.emitter.fire({ type: 'session.status', sessionId: p.sessionID as string, activity, detail: st?.type === 'retry' ? `Retrying (attempt ${st.attempt ?? '?'}): ${st.message ?? ''}` : undefined });
        break;
      }
      case 'session.idle':
        this.emitter.fire({ type: 'session.status', sessionId: p.sessionID as string, activity: 'idle' });
        break;
      case 'session.error': {
        const err = p.error as { name?: string; data?: { message?: string } } | undefined;
        if (err?.name === 'MessageAbortedError') break;
        this.emitter.fire({ type: 'error', sessionId: p.sessionID as string | undefined, message: err?.data?.message ?? err?.name ?? 'opencode reported an error' });
        break;
      }
      case 'permission.asked':
      case 'permission.updated':
        if (p.id && p.sessionID) this.emitter.fire({ type: 'permission.asked', request: mapPermission(p as never) });
        break;
      case 'permission.replied':
        this.emitter.fire({ type: 'permission.resolved', sessionId: p.sessionID as string, requestId: (p.requestID ?? p.permissionID) as string });
        break;
      case 'question.asked':
        if (p.id && p.sessionID) this.emitter.fire({ type: 'question.asked', request: mapQuestion(p as never) });
        break;
      case 'question.replied':
      case 'question.rejected':
        this.emitter.fire({ type: 'question.resolved', sessionId: p.sessionID as string, requestId: p.requestID as string });
        break;
      case 'mcp.tools.changed':
        this.emitter.fire({ type: 'mcp.changed' });
        break;
      case 'catalog.updated':
      case 'integration.updated':
      case 'integration.connection.updated':
        this.emitter.fire({ type: 'catalog.changed' });
        break;
      case 'server.instance.disposed':
      case 'global.disposed':
        this.emitter.fire({ type: 'catalog.changed' });
        this.emitter.fire({ type: 'mcp.changed' });
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- sessions */

  async listSessions(): Promise<SessionInfo[]> {
    const sessions = await this.api().get<OcSession[]>('session', { roots: true });
    return sessions
      .filter((s) => !s.parentID)
      .map(mapSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(title?: string): Promise<SessionInfo> {
    return mapSession(await this.api().post<OcSession>('session', title ? { title } : {}));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.api().request('DELETE', `session/${sessionId}`);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.api().request('PATCH', `session/${sessionId}`, { body: { title } });
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.api().get<{ info: OcMessageInfo; parts: OcPart[] }[]>(`session/${sessionId}/message`);
    const messages = raw.map((m) => mapMessage(m.info, m.parts));
    for (const m of raw) {
      this.roles.set(m.info.id, m.info.role);
      if (m.info.role === 'user') this.lastUserMessage.set(sessionId, m.info.id);
    }
    // Surface requests that were raised before we connected (or while another session was open).
    void this.replayPending(sessionId);
    return messages;
  }

  private async replayPending(sessionId: string): Promise<void> {
    try {
      const perms = await this.api().get<{ id: string; sessionID: string }[]>('permission');
      for (const p of perms ?? []) if (p.sessionID === sessionId) this.emitter.fire({ type: 'permission.asked', request: mapPermission(p as never) });
    } catch {
      /* endpoint missing on older servers */
    }
    try {
      const questions = await this.api().get<{ id: string; sessionID: string }[]>('question');
      for (const q of questions ?? []) if (q.sessionID === sessionId) this.emitter.fire({ type: 'question.asked', request: mapQuestion(q as never) });
    } catch {
      /* endpoint missing on older servers */
    }
  }

  /* ------------------------------------------------------------- catalog */

  async listProviders(): Promise<ProviderInfo[]> {
    const api = this.api();
    const [{ providers }, models, names] = await Promise.all([
      api.get<{ providers: OcProvider[] }>('config/providers'),
      // Newer opencode only: providers connected through integrations (OpenCode Console and
      // other sign-ins from recent CLIs) are listed here and not in config/providers.
      api.get<{ data?: OcApiModel[] }>('api/model').then((r) => (Array.isArray(r?.data) ? r.data : undefined)).catch(() => undefined),
      api
        .get<{ data?: { id: string; name?: string }[] }>('api/provider')
        .then((r) => Object.fromEntries((r?.data ?? []).filter((p) => p?.id).map((p) => [p.id, p.name || p.id])))
        .catch(() => ({}) as Record<string, string>),
    ]);
    return mergeProviderLists(providers.map((p) => mapProvider(p, true)), models, names);
  }

  /** Every provider opencode knows (connected or not) with the ways to sign in. Used by the connect flow. */
  async listConnectableProviders(): Promise<ProviderInfo[]> {
    const [all, auth] = await Promise.all([
      this.api().get<{ all: OcProvider[]; connected: string[] }>('provider'),
      this.api()
        .get<Record<string, { type: 'api' | 'oauth'; label: string }[]>>('provider/auth')
        .catch(() => ({}) as Record<string, { type: 'api' | 'oauth'; label: string }[]>),
    ]);
    const connected = new Set(all.connected ?? []);
    return (all.all ?? []).map((p) => mapProvider(p, connected.has(p.id), auth[p.id] ?? [{ type: 'api', label: 'API key' }])).sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.api().request('PUT', `auth/${encodeURIComponent(providerId)}`, { body: { type: 'api', key: apiKey } });
    // Make the running instance pick up the new credential.
    await this.reloadProviders();
  }

  async defaultModel(): Promise<ModelRef | undefined> {
    const api = this.api();
    const [config, catalog] = await Promise.all([api.get<{ model?: string }>('config').catch(() => ({}) as { model?: string }), api.get<{ providers: OcProvider[]; default: Record<string, string> }>('config/providers')]);
    if (config.model?.includes('/')) {
      const [providerId, ...rest] = config.model.split('/');
      return { providerId, modelId: rest.join('/') };
    }
    for (const p of catalog.providers) {
      const modelId = catalog.default?.[p.id] ?? Object.keys(p.models ?? {})[0];
      if (modelId) return { providerId: p.id, modelId };
    }
    return undefined;
  }

  async listAgents(): Promise<AgentInfo[]> {
    const agents = await this.api().get<{ name: string; description?: string; mode?: string; hidden?: boolean }[]>('agent');
    return agents.filter((a) => a.mode !== 'subagent' && !a.hidden).map((a) => ({ name: a.name, description: a.description }));
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      return (await this.api().get<{ name: string; description?: string; source?: string; hints?: string[] }[]>('command')).map(mapCommand);
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------- prompting */

  async sendPrompt(sessionId: string, input: PromptInput): Promise<void> {
    const parts: unknown[] = [];
    if (input.text) parts.push({ type: 'text', text: input.text });
    parts.push(...input.attachments.map(toFilePart));
    if (parts.length === 0) return;
    await this.api().post(`session/${sessionId}/prompt_async`, {
      parts,
      model: input.model ? { providerID: input.model.providerId, modelID: input.model.modelId } : undefined,
      agent: input.agent,
    });
  }

  async runCommand(sessionId: string, name: string, args: string, input: PromptInput): Promise<void> {
    this.emitter.fire({ type: 'session.status', sessionId, activity: 'busy' });
    // This call only returns once the command's turn has finished, so do not block on it;
    // progress arrives through the event stream.
    this.api()
      .post(
        `session/${sessionId}/command`,
        {
          command: name,
          arguments: args,
          agent: input.agent,
          model: input.model ? `${input.model.providerId}/${input.model.modelId}` : undefined,
          parts: input.attachments.length ? input.attachments.map(toFilePart) : undefined,
        },
        { timeoutMs: 0 },
      )
      .catch((err) => {
        this.emitter.fire({ type: 'error', sessionId, message: errorMessage(err) });
        this.emitter.fire({ type: 'session.status', sessionId, activity: 'idle' });
      });
  }

  async abort(sessionId: string): Promise<void> {
    await this.api().post(`session/${sessionId}/abort`);
  }

  async sessionActivity(sessionId: string): Promise<SessionActivity> {
    const all = await this.api()
      .get<Record<string, { type?: string }>>('session/status')
      .catch(() => ({}) as Record<string, { type?: string }>);
    const type = all[sessionId]?.type;
    return type === 'busy' ? 'busy' : type === 'retry' ? 'retry' : 'idle';
  }

  async replyPermission(sessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    try {
      await this.api().post(`permission/${requestId}/reply`, { reply });
    } catch (err) {
      // opencode < 1.1 used a session-scoped endpoint.
      await this.api()
        .post(`session/${sessionId}/permissions/${requestId}`, { response: reply })
        .catch(() => {
          throw err;
        });
    }
    this.emitter.fire({ type: 'permission.resolved', sessionId, requestId });
  }

  async replyQuestion(sessionId: string, requestId: string, answers: string[][] | null): Promise<void> {
    if (answers === null) await this.api().post(`question/${requestId}/reject`);
    else await this.api().post(`question/${requestId}/reply`, { answers });
    this.emitter.fire({ type: 'question.resolved', sessionId, requestId });
  }

  async forkSession(sessionId: string, messageId?: string): Promise<SessionInfo> {
    return mapSession(await this.api().post<OcSession>(`session/${sessionId}/fork`, messageId ? { messageID: messageId } : {}));
  }

  async shareSession(sessionId: string, share: boolean): Promise<SessionInfo> {
    const s = share ? await this.api().post<OcSession>(`session/${sessionId}/share`) : await this.api().request<OcSession>('DELETE', `session/${sessionId}/share`);
    return mapSession(s);
  }

  async compactSession(sessionId: string, model?: ModelRef): Promise<void> {
    const m = model ?? (await this.defaultModel());
    if (!m) throw new EngineError('Pick a model before compacting.');
    this.emitter.fire({ type: 'session.status', sessionId, activity: 'busy' });
    this.api()
      .post(`session/${sessionId}/summarize`, { providerID: m.providerId, modelID: m.modelId }, { timeoutMs: 0 })
      .catch((err) => this.emitter.fire({ type: 'error', sessionId, message: errorMessage(err) }))
      .finally(() => this.emitter.fire({ type: 'session.status', sessionId, activity: 'idle' }));
  }

  async undo(sessionId: string): Promise<void> {
    let messageId = this.lastUserMessage.get(sessionId);
    if (!messageId) {
      await this.getMessages(sessionId);
      messageId = this.lastUserMessage.get(sessionId);
    }
    if (!messageId) throw new EngineError('Nothing to undo.');
    await this.api().post(`session/${sessionId}/revert`, { messageID: messageId });
  }

  async redo(sessionId: string): Promise<void> {
    await this.api().post(`session/${sessionId}/unrevert`);
  }

  /* ------------------------------------------------------------------- mcp */

  async listMcp(): Promise<McpServerInfo[]> {
    // opencode reports connection status per server; it does not expose per-server tool lists.
    return mapMcp((await this.api().get<Record<string, { status?: string; error?: string }>>('mcp')) ?? {});
  }

  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    await this.api().post(`mcp/${encodeURIComponent(name)}/${enabled ? 'connect' : 'disconnect'}`);
    this.emitter.fire({ type: 'mcp.changed' });
  }
}

/** Convert an attachment into an opencode `FilePartInput`. */
export function toFilePart(a: Attachment): { type: 'file'; mime: string; filename: string; url: string } {
  if (a.dataUrl) return { type: 'file', mime: a.mime, filename: a.name, url: a.dataUrl };
  // Text that has no file on disk: an unsaved selection, a file dropped from outside the editor, a session digest.
  if (a.text !== undefined && !a.path) {
    return { type: 'file', mime: 'text/plain', filename: a.name, url: `data:text/plain;base64,${Buffer.from(a.text, 'utf8').toString('base64')}` };
  }
  const url = pathToFileURL(a.path ?? a.name);
  if (a.range) {
    url.searchParams.set('start', String(a.range.startLine));
    url.searchParams.set('end', String(a.range.endLine));
  }
  // opencode reads text files itself; it expects text/plain (or application/x-directory) for file:// URLs.
  const mime = a.mime === 'application/x-directory' || a.mime.startsWith('image/') || a.mime === 'application/pdf' ? a.mime : 'text/plain';
  return { type: 'file', mime, filename: a.name, url: url.toString() };
}

export { mapUsage };
