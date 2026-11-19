import { Emitter } from './emitter';
import type { Disposable } from './emitter';
import type { Engine, EngineContext } from './engine';
import { errorMessage } from './engine';
import { newId } from './ids';
import { LocalSessionStore } from './localSessions';
import type { StoredSession } from './localSessions';
import { truncate } from './slashCommands';
import { addUsage, emptyUsage } from '../shared/types';
import type {
  AgentInfo,
  ChatMessage,
  EngineCapabilities,
  EngineEvent,
  EngineId,
  EngineStatus,
  McpServerInfo,
  ModelRef,
  Part,
  PermissionReply,
  PermissionRequest,
  PromptInput,
  ProviderInfo,
  SessionActivity,
  SessionInfo,
  SlashCommand,
  TokenUsage,
  ToolStatus,
} from '../shared/types';

/** Helper handed to `runTurn` for building the assistant message while streaming. */
export class AssistantWriter {
  private current: Extract<Part, { type: 'text' | 'reasoning' }> | undefined;
  private tools = new Map<string, Extract<Part, { type: 'tool' }>>();
  usage: TokenUsage = emptyUsage();
  private hasUsage = false;

  constructor(readonly message: ChatMessage, private readonly emit: (event: EngineEvent) => void) {}

  private append(type: 'text' | 'reasoning', delta: string): void {
    if (!delta) return;
    if (!this.current || this.current.type !== type) {
      const part: Extract<Part, { type: 'text' | 'reasoning' }> = { id: newId('prt'), type, text: delta };
      this.current = part;
      this.message.parts.push(part);
      this.emit({ type: 'part.updated', sessionId: this.message.sessionId, messageId: this.message.id, part: { ...part } });
      return;
    }
    this.current.text += delta;
    this.emit({ type: 'part.delta', sessionId: this.message.sessionId, messageId: this.message.id, partId: this.current.id, delta });
  }

  text(delta: string): void {
    this.append('text', delta);
  }

  reasoning(delta: string): void {
    this.append('reasoning', delta);
  }

  /** Close the current text block so the next delta starts a new part. */
  breakText(): void {
    this.current = undefined;
  }

  tool(callId: string, patch: { tool?: string; status?: ToolStatus; title?: string; input?: unknown; output?: string; error?: string }): void {
    this.current = undefined;
    let part = this.tools.get(callId);
    if (!part) {
      part = { id: newId('prt'), type: 'tool', tool: patch.tool ?? 'tool', callId, status: patch.status ?? 'running' };
      this.tools.set(callId, part);
      this.message.parts.push(part);
    }
    Object.assign(part, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    this.emit({ type: 'part.updated', sessionId: this.message.sessionId, messageId: this.message.id, part: { ...part } });
  }

  hasTool(callId: string): boolean {
    return this.tools.has(callId);
  }

  /** Mark tools that never reported a result (aborted turn) so they do not spin forever. */
  finishOpenTools(error: string): void {
    for (const part of this.tools.values()) {
      if (part.status === 'pending' || part.status === 'running') this.tool(part.callId, { status: 'error', error });
    }
  }

  notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.current = undefined;
    const part: Part = { id: newId('prt'), type: 'notice', level, text };
    this.message.parts.push(part);
    this.emit({ type: 'part.updated', sessionId: this.message.sessionId, messageId: this.message.id, part });
  }

  addUsage(u: Partial<TokenUsage>): void {
    this.usage = addUsage(this.usage, u);
    this.hasUsage = true;
  }

  setUsage(u: TokenUsage): void {
    this.usage = u;
    this.hasUsage = true;
  }

  get usageKnown(): boolean {
    return this.hasUsage;
  }
}

export interface Turn {
  session: StoredSession;
  input: PromptInput;
  user: ChatMessage;
  assistant: AssistantWriter;
  signal: AbortSignal;
  model: ModelRef | undefined;
}

/**
 * Base class for engines whose sessions are stored by the extension (direct BYOK, VS Code
 * LM, Claude Code, Codex). Subclasses implement `runTurn`; this class handles session
 * persistence, message bookkeeping, events, aborts, titles and usage reporting.
 */
export abstract class LocalEngine implements Engine {
  abstract readonly id: EngineId;
  abstract readonly capabilities: EngineCapabilities;

  protected emitter = new Emitter<EngineEvent>();
  protected state: EngineStatus;
  private _store: LocalSessionStore | undefined;
  private running = new Map<string, AbortController>();
  private pendingPermissions = new Map<string, { sessionId: string; resolve: (reply: PermissionReply) => void }>();

  constructor(protected readonly ctx: EngineContext, id: EngineId) {
    this.state = { engine: id, state: 'idle' };
  }

  protected get store(): LocalSessionStore {
    this._store ??= new LocalSessionStore(this.ctx.storageDir, this.id, this.ctx.cwd() ?? '');
    return this._store;
  }

  onEvent(listener: (event: EngineEvent) => void): Disposable {
    return this.emitter.event(listener);
  }

  protected emit = (event: EngineEvent): void => this.emitter.fire(event);

  status(): EngineStatus {
    return this.state;
  }

  protected setStatus(state: EngineStatus['state'], detail?: string, version?: string): EngineStatus {
    this.state = { engine: this.id, state, detail, version: version ?? this.state.version };
    this.emit({ type: 'engine.status', status: this.state });
    return this.state;
  }

  /** Decide whether the engine can be used (CLI present, provider configured, …). */
  protected abstract checkAvailability(): Promise<{ ok: boolean; detail?: string; version?: string }>;
  protected abstract runTurn(turn: Turn): Promise<void>;

  async start(): Promise<EngineStatus> {
    if (this.state.state === 'ready') return this.state;
    this.setStatus('starting');
    try {
      const r = await this.checkAvailability();
      return this.setStatus(r.ok ? 'ready' : 'unavailable', r.detail, r.version);
    } catch (err) {
      return this.setStatus('unavailable', errorMessage(err));
    }
  }

  async restart(): Promise<EngineStatus> {
    this.state = { engine: this.id, state: 'idle' };
    return this.start();
  }

  async dispose(): Promise<void> {
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    this.emitter.dispose();
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.store.list();
  }

  async createSession(title?: string): Promise<SessionInfo> {
    const now = Date.now();
    const info: SessionInfo = { id: newId('ses'), engine: this.id, title: title ?? 'New session', createdAt: now, updatedAt: now };
    await this.store.put({ info, messages: [], meta: {} });
    this.emit({ type: 'session.updated', session: info });
    return info;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.abort();
    await this.store.delete(sessionId);
    this.emit({ type: 'session.deleted', sessionId });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const s = await this.store.get(sessionId);
    if (!s) return;
    s.info = { ...s.info, title, updatedAt: Date.now() };
    s.meta.titled = true;
    await this.store.persist(sessionId);
    this.emit({ type: 'session.updated', session: s.info });
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return (await this.store.get(sessionId))?.messages ?? [];
  }

  async forkSession(sessionId: string): Promise<SessionInfo> {
    const s = await this.store.get(sessionId);
    if (!s) throw new Error('Session not found');
    const now = Date.now();
    const info: SessionInfo = { id: newId('ses'), engine: this.id, title: `${s.info.title} (fork)`, createdAt: now, updatedAt: now, parentId: undefined };
    const messages = (JSON.parse(JSON.stringify(s.messages)) as ChatMessage[]).map((m) => ({ ...m, sessionId: info.id, id: newId('msg'), usage: undefined }));
    await this.store.put({ info, messages, meta: this.forkMeta(JSON.parse(JSON.stringify(s.meta))) });
    this.emit({ type: 'session.updated', session: info });
    return info;
  }

  /** Subclasses can drop engine-private state that must not be shared between forks. */
  protected forkMeta(meta: Record<string, unknown>): Record<string, unknown> {
    return meta;
  }

  abstract listProviders(): Promise<ProviderInfo[]>;

  async defaultModel(): Promise<ModelRef | undefined> {
    const p = (await this.listProviders()).find((x) => x.models.length > 0);
    return p ? { providerId: p.id, modelId: p.models[0].modelId } : undefined;
  }

  async listAgents(): Promise<AgentInfo[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async listMcp(): Promise<McpServerInfo[]> {
    return [];
  }

  async setMcpEnabled(_name: string, _enabled: boolean): Promise<void> {
    throw new Error('This engine cannot toggle MCP servers.');
  }

  /** Engine-defined slash commands are passed through as prompt text by default. */
  runCommand(sessionId: string, name: string, args: string, input: PromptInput): Promise<void> {
    return this.sendPrompt(sessionId, { ...input, text: `/${name}${args ? ' ' + args : ''}` });
  }

  async sendPrompt(sessionId: string, input: PromptInput): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) throw new Error('Session not found');
    if (this.running.has(sessionId)) throw new Error('This session is still responding. Stop it first.');
    const controller = new AbortController();
    this.running.set(sessionId, controller);

    const now = Date.now();
    const user: ChatMessage = {
      id: newId('msg'),
      sessionId,
      role: 'user',
      createdAt: now,
      completedAt: now,
      model: input.model,
      parts: [
        ...(input.text ? [{ id: newId('prt'), type: 'text' as const, text: input.text }] : []),
        ...input.attachments.map((a) => ({ id: newId('prt'), type: 'file' as const, filename: a.name, mime: a.mime, url: a.path })),
      ],
    };
    const assistantMessage: ChatMessage = { id: newId('msg'), sessionId, role: 'assistant', createdAt: now + 1, parts: [], model: input.model, agent: input.agent };
    session.messages.push(user, assistantMessage);
    if (!session.meta.titled && session.messages.length <= 2 && input.text) {
      session.info = { ...session.info, title: truncate(input.text, 60) };
    }
    session.info = { ...session.info, updatedAt: now };
    this.emit({ type: 'session.updated', session: session.info });
    this.emit({ type: 'message.updated', message: structuredClone(user) });
    this.emit({ type: 'message.updated', message: structuredClone(assistantMessage) });
    this.emit({ type: 'session.status', sessionId, activity: 'busy' });

    const writer = new AssistantWriter(assistantMessage, this.emit);
    // Run detached: callers get control back as soon as the turn has started.
    void (async () => {
      try {
        await this.runTurn({ session, input, user, assistant: writer, signal: controller.signal, model: input.model });
      } catch (err) {
        if (!controller.signal.aborted) {
          assistantMessage.error = errorMessage(err);
          this.ctx.log.error(`[${this.id}] turn failed: ${errorMessage(err)}`);
        }
      } finally {
        this.running.delete(sessionId);
        this.cancelPermissions(sessionId);
        if (controller.signal.aborted) {
          writer.finishOpenTools('Stopped');
          writer.notice('info', 'Stopped');
        }
        assistantMessage.completedAt = Date.now();
        if (writer.usageKnown) assistantMessage.usage = writer.usage;
        session.info = { ...session.info, updatedAt: assistantMessage.completedAt };
        await this.store.persist(sessionId).catch((e) => this.ctx.log.warn(`Could not save session: ${errorMessage(e)}`));
        this.emit({ type: 'message.updated', message: structuredClone(assistantMessage) });
        if (assistantMessage.usage && assistantMessage.model) {
          this.emit({ type: 'usage', sessionId, messageId: assistantMessage.id, model: assistantMessage.model, usage: assistantMessage.usage });
        }
        this.emit({ type: 'session.updated', session: session.info });
        this.emit({ type: 'session.status', sessionId, activity: 'idle' });
      }
    })();
  }

  async abort(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.abort();
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  async sessionActivity(sessionId: string): Promise<SessionActivity> {
    return this.running.has(sessionId) ? 'busy' : 'idle';
  }

  /* ------------------------------------------------------------ permissions */

  /** Ask the user before running a tool. Resolves to 'reject' when the turn is aborted. */
  protected askPermission(sessionId: string, request: Omit<PermissionRequest, 'id' | 'sessionId'>, signal: AbortSignal): Promise<PermissionReply> {
    const id = newId('per');
    return new Promise<PermissionReply>((resolve) => {
      const done = (reply: PermissionReply) => {
        if (!this.pendingPermissions.delete(id)) return;
        signal.removeEventListener('abort', onAbort);
        this.emit({ type: 'permission.resolved', sessionId, requestId: id });
        resolve(reply);
      };
      const onAbort = () => done('reject');
      this.pendingPermissions.set(id, { sessionId, resolve: done });
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'permission.asked', request: { ...request, id, sessionId } });
    });
  }

  async replyPermission(_sessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    this.pendingPermissions.get(requestId)?.resolve(reply);
  }

  private cancelPermissions(sessionId: string): void {
    for (const p of [...this.pendingPermissions.values()]) if (p.sessionId === sessionId) p.resolve('reject');
  }
}
