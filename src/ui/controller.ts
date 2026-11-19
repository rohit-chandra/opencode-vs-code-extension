import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, isImageMime, mimeForPath } from '../core/attachments';
import type { Disposable } from '../core/emitter';
import type { Engine, Logger } from '../core/engine';
import { errorMessage } from '../core/engine';
import { newId } from '../core/ids';
import { BUILTIN_COMMANDS, helpMarkdown, isBuiltin, mergeCommands, parseSlash } from '../core/slashCommands';
import type { KeyValueStore, UsageLedger } from '../core/usageLedger';
import { PROVIDER_PRESETS, presetById, resolveProvider, secretKeyFor } from '../engines/direct/presets';
import type { ProviderConfig } from '../engines/direct/presets';
import type { AvatarStyle, HostToWebview, ViewState, WebviewToHost } from '../shared/protocol';
import { applyMessageEvent, messageText } from '../shared/reducer';
import { ENGINE_LABELS } from '../shared/types';
import type { Attachment, ChatMessage, EngineEvent, EngineId, ModelRef, SessionInfo } from '../shared/types';

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

/** UI and workspace services the controller needs. VS Code in production, fakes in tests. */
export interface ControllerHost {
  log: Logger;
  post(message: HostToWebview): void;
  /** Per-workspace persistence (active engine, session, model). */
  state: KeyValueStore;
  secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  config<T>(key: string, fallback: T): T;
  updateConfig(key: string, value: unknown): Promise<void>;
  workspaceTrusted(): boolean;
  cwd(): string | undefined;
  info(message: string): void;
  error(message: string): void;
  pick<T>(items: PickItem<T>[], options: { title: string; placeholder?: string }): Promise<T | undefined>;
  input(options: { title: string; prompt?: string; value?: string; password?: boolean; placeholder?: string }): Promise<string | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  pickFiles(): Promise<string[]>;
  findFiles(query: string, limit: number): Promise<{ path: string; relative: string }[]>;
  openFile(file: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  insertIntoEditor(text: string): Promise<void>;
  saveText(defaultName: string, content: string): Promise<void>;
  openSettings(query: string): Promise<void>;
  runInTerminal(name: string, command: string): void;
  focusView(): Promise<void>;
  /** Dock the chat in the left side bar, the right (secondary) side bar, or open it as an editor tab. */
  moveView(to: 'left' | 'right' | 'editor'): Promise<void>;
}

const EMPTY_CAPS = { agents: false, fork: false, share: false, undo: false, compact: false, images: false, mcpToggle: false, permissions: false, providerAuth: false, remoteSessions: false };

/**
 * Glue between engines, the usage ledger and the chat view. Owns the view state, reduces
 * engine events into it and executes everything the webview or a VS Code command asks for.
 */
export class ChatController {
  private state: ViewState;
  private subscriptions: Disposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private nonce = 0;
  private activation = 0;
  private webviewReady = false;
  /** Renderer the webview's companion is using, once it has mounted. */
  avatarRenderer: 'webgl' | '2d' | undefined;

  constructor(private readonly engines: Map<EngineId, Engine>, private readonly ledger: UsageLedger, private readonly host: ControllerHost) {
    const configured = host.config<EngineId>('defaultEngine', 'opencode');
    const saved = host.state.get<EngineId>('engine');
    const engine = saved && engines.has(saved) ? saved : engines.has(configured) ? configured : 'opencode';
    this.state = {
      engine,
      engines: [...engines.values()].map((e) => e.status()),
      capabilities: engines.get(engine)?.capabilities ?? EMPTY_CAPS,
      sessions: [],
      sessionId: undefined,
      messages: [],
      activity: 'idle',
      activityDetail: undefined,
      providers: [],
      model: undefined,
      agents: [],
      agent: undefined,
      commands: BUILTIN_COMMANDS,
      mcp: [],
      attachments: [],
      permissions: [],
      questions: [],
      sessionUsage: undefined,
      usage: undefined,
      avatar: { enabled: host.config<boolean>('avatar.enabled', true), style: avatarStyle(host.config<string>('avatar.style', 'buddy')) },
      zoom: clampZoom(host.config<number>('chat.zoom', 1)),
      trusted: host.workspaceTrusted(),
      panel: { name: 'none', nonce: 0 },
      notice: undefined,
      loading: true,
    };
    for (const [id, e] of engines) this.subscriptions.push(e.onEvent((ev) => this.onEngineEvent(id, ev)));
    this.subscriptions.push(this.ledger.onDidChange(() => this.debounce('usage', 250, () => this.pushUsage())));
  }

  /* ------------------------------------------------------------- lifecycle */

  get viewState(): Readonly<ViewState> {
    return this.state;
  }

  private get engine(): Engine {
    return this.engines.get(this.state.engine)!;
  }

  /** Start the active engine and load its catalog and sessions. Safe to call repeatedly. */
  async activate(): Promise<void> {
    const run = ++this.activation;
    const engine = this.engine;
    if (!this.host.workspaceTrusted()) {
      // Starting an engine runs executables and loads project configuration (MCP servers,
      // plugins), so nothing is started until the user trusts the workspace.
      this.set({ loading: false, trusted: false, capabilities: engine.capabilities, sessions: [], sessionId: undefined, messages: [], providers: [], agents: [], mcp: [], commands: mergeCommands([]) });
      return;
    }
    this.set({ loading: true, trusted: true, capabilities: engine.capabilities });
    const status = await engine.start();
    if (run !== this.activation) return;
    if (status.state !== 'ready') {
      this.set({ loading: false, sessions: [], sessionId: undefined, messages: [], providers: [], agents: [], mcp: [], commands: mergeCommands([]), model: undefined, agent: undefined });
      return;
    }
    await Promise.all([this.refreshCatalog(), this.refreshMcp(), this.refreshSessions()]);
    if (run !== this.activation) return;
    const last = this.host.state.get<string>(`session.${engine.id}`);
    if (last && this.state.sessions.some((s) => s.id === last)) await this.openSession(last);
    else this.set({ sessionId: undefined, messages: [], permissions: [], questions: [], activity: 'idle' });
    this.set({ loading: false });
    this.pushUsage();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.eventTimer) clearTimeout(this.eventTimer);
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
  }

  private set(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.webviewReady) return;
    this.flushEvents(); // keep ordering: streamed events first, then the patch that follows them
    this.host.post({ type: 'patch', patch });
  }

  private pendingEvents: EngineEvent[] = [];
  private eventTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Streaming events are sent to the webview in small batches (about one per frame). A fast
   * model emits far more tokens per second than the screen can show, and one postMessage
   * per token keeps both sides busy for nothing.
   */
  private queueEvent(event: EngineEvent): void {
    this.pendingEvents.push(event);
    this.eventTimer ??= setTimeout(() => this.flushEvents(), 16);
  }

  private flushEvents(): void {
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = undefined;
    }
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    if (this.webviewReady) this.host.post(events.length === 1 ? { type: 'event', event: events[0] } : { type: 'events', events });
  }

  private notify(level: 'info' | 'warn' | 'error', text: string): void {
    if (level === 'error') this.host.log.error(text);
    this.set({ notice: { level, text, nonce: ++this.nonce } });
  }

  private openPanel(name: ViewState['panel']['name']): void {
    this.set({ panel: { name, nonce: ++this.nonce } });
  }

  private async guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.notify('error', `${what}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /* ----------------------------------------------------------- refreshers */

  private async refreshCatalog(): Promise<void> {
    const engine = this.engine;
    if (engine.status().state !== 'ready') return;
    const [providers, agents, commands] = await Promise.all([
      engine.listProviders().catch((e) => (this.host.log.warn(`listProviders: ${errorMessage(e)}`), [])),
      engine.listAgents().catch(() => []),
      engine.listCommands().catch(() => []),
    ]);
    if (engine !== this.engine) return;
    let model = this.host.state.get<ModelRef>(`model.${engine.id}`);
    const exists = (m: ModelRef | undefined) => !!m && providers.some((p) => p.id === m.providerId && p.models.some((x) => x.modelId === m.modelId));
    if (!exists(model)) {
      const fallback = await engine.defaultModel().catch(() => undefined);
      model = exists(fallback) ? fallback : providers.flatMap((p) => p.models)[0];
    }
    let agent = this.host.state.get<string>(`agent.${engine.id}`);
    if (!agent || !agents.some((a) => a.name === agent)) agent = agents[0]?.name;
    this.set({ providers, agents, commands: mergeCommands(commands), model, agent });
  }

  private async refreshMcp(): Promise<void> {
    const engine = this.engine;
    if (engine.status().state !== 'ready') return;
    const mcp = await engine.listMcp().catch((e) => (this.host.log.warn(`listMcp: ${errorMessage(e)}`), []));
    if (engine === this.engine) this.set({ mcp });
  }

  private async refreshSessions(): Promise<void> {
    const engine = this.engine;
    if (engine.status().state !== 'ready') return;
    const sessions = await engine.listSessions().catch((e) => (this.host.log.warn(`listSessions: ${errorMessage(e)}`), []));
    if (engine === this.engine) this.set({ sessions });
  }

  private pushUsage(): void {
    this.set({
      usage: this.ledger.summary(40),
      sessionUsage: this.state.sessionId ? this.ledger.sessionUsage(this.state.engine, this.state.sessionId) : undefined,
    });
  }

  /* --------------------------------------------------------------- events */

  private onEngineEvent(engineId: EngineId, event: EngineEvent): void {
    if (event.type === 'usage') {
      const title = engineId === this.state.engine ? this.state.sessions.find((s) => s.id === event.sessionId)?.title : undefined;
      this.ledger.record({ engine: engineId, sessionId: event.sessionId, messageId: event.messageId, model: event.model, usage: event.usage, sessionTitle: title });
      return;
    }
    if (event.type === 'engine.status') {
      const before = this.state.engines.find((s) => s.engine === engineId);
      this.set({ engines: this.state.engines.map((s) => (s.engine === engineId ? event.status : s)) });
      // A reconnect of the active engine: reload what may have changed while we were away.
      if (engineId === this.state.engine && event.status.state === 'ready' && before?.state === 'ready' && !this.state.loading) {
        this.debounce('resync', 300, () => void this.resync());
      }
      if (engineId === this.state.engine && event.status.state === 'unavailable' && before?.state === 'ready') {
        this.set({ activity: 'idle', activityDetail: undefined });
        this.notify('error', event.status.detail ?? `${ENGINE_LABELS[engineId]} stopped.`);
      }
      return;
    }
    if (event.type === 'session.updated') this.ledger.setSessionTitle(engineId, event.session.id, event.session.title);
    if (engineId !== this.state.engine) return;

    switch (event.type) {
      case 'session.updated': {
        if (event.session.parentId) return;
        const others = this.state.sessions.filter((s) => s.id !== event.session.id);
        this.set({ sessions: [event.session, ...others].sort((a, b) => b.updatedAt - a.updatedAt) });
        return;
      }
      case 'session.deleted': {
        const patch: Partial<ViewState> = { sessions: this.state.sessions.filter((s) => s.id !== event.sessionId) };
        if (this.state.sessionId === event.sessionId) Object.assign(patch, { sessionId: undefined, messages: [], permissions: [], questions: [], activity: 'idle', sessionUsage: undefined });
        this.set(patch);
        return;
      }
      case 'session.status':
        if (event.sessionId === this.state.sessionId) this.set({ activity: event.activity, activityDetail: event.detail });
        return;
      case 'message.updated':
      case 'message.removed':
      case 'part.updated':
      case 'part.delta':
      case 'part.removed': {
        if (!this.state.sessionId) return;
        const next = applyMessageEvent(this.state.messages, event, this.state.sessionId);
        if (next === this.state.messages) return;
        // Streaming updates go to the webview as events (cheap); it runs the same reducer.
        this.state = { ...this.state, messages: next };
        if (this.webviewReady) this.queueEvent(event);
        return;
      }
      case 'permission.asked':
        if (!this.state.permissions.some((p) => p.id === event.request.id)) this.set({ permissions: [...this.state.permissions, event.request] });
        return;
      case 'permission.resolved':
        this.set({ permissions: this.state.permissions.filter((p) => p.id !== event.requestId) });
        return;
      case 'question.asked':
        if (!this.state.questions.some((q) => q.id === event.request.id)) this.set({ questions: [...this.state.questions, event.request] });
        return;
      case 'question.resolved':
        this.set({ questions: this.state.questions.filter((q) => q.id !== event.requestId) });
        return;
      case 'mcp.changed':
        this.debounce('mcp', 300, () => void this.refreshMcp());
        return;
      case 'catalog.changed':
        this.debounce('catalog', 500, () => void this.refreshCatalog());
        return;
      case 'error':
        if (!event.sessionId || event.sessionId === this.state.sessionId) this.notify('error', event.message);
        return;
      default:
        return;
    }
  }

  private async resync(): Promise<void> {
    await Promise.all([this.refreshCatalog(), this.refreshMcp(), this.refreshSessions()]);
    if (this.state.sessionId) await this.openSession(this.state.sessionId);
  }

  /* ------------------------------------------------------------- sessions */

  async openSession(sessionId: string): Promise<void> {
    const engine = this.engine;
    const messages = await this.guard('Could not load the session', () => engine.getMessages(sessionId));
    if (!messages || engine !== this.engine) return;
    const title = this.state.sessions.find((s) => s.id === sessionId)?.title;
    for (const m of messages) {
      if (m.role === 'assistant' && m.usage && m.model) {
        this.ledger.record({ engine: engine.id, sessionId, messageId: m.id, model: m.model, usage: m.usage, at: m.completedAt ?? m.createdAt, sessionTitle: title });
      }
    }
    const activity = (await engine.sessionActivity?.(sessionId).catch(() => 'idle' as const)) ?? 'idle';
    if (engine !== this.engine) return;
    this.set({
      sessionId,
      messages,
      activity,
      activityDetail: undefined,
      permissions: this.state.permissions.filter((p) => p.sessionId === sessionId),
      questions: this.state.questions.filter((q) => q.sessionId === sessionId),
      sessionUsage: this.ledger.sessionUsage(engine.id, sessionId),
    });
    await this.host.state.update(`session.${engine.id}`, sessionId);
  }

  async newSession(): Promise<void> {
    // Sessions are created lazily on the first message, so "new" just clears the view.
    this.set({ sessionId: undefined, messages: [], permissions: [], questions: [], activity: 'idle', activityDetail: undefined, sessionUsage: undefined, attachments: [] });
    await this.host.state.update(`session.${this.state.engine}`, undefined);
    this.host.post({ type: 'focusInput' });
  }

  private async ensureSession(): Promise<string | undefined> {
    if (this.state.sessionId) return this.state.sessionId;
    const session = await this.guard('Could not create a session', () => this.engine.createSession());
    if (!session) return undefined;
    this.set({ sessionId: session.id, sessions: [session, ...this.state.sessions.filter((s) => s.id !== session.id)], messages: this.state.messages.filter((m) => m.id.startsWith('local_')) });
    await this.host.state.update(`session.${this.state.engine}`, session.id);
    return session.id;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const s = this.state.sessions.find((x) => x.id === sessionId);
    if (!(await this.host.confirm(`Delete session "${s?.title ?? sessionId}"? This cannot be undone.`, 'Delete'))) return;
    await this.guard('Could not delete the session', () => this.engine.deleteSession(sessionId));
    await this.refreshSessions();
    if (this.state.sessionId === sessionId) await this.newSession();
  }

  async pickSession(): Promise<void> {
    await this.host.focusView();
    this.openPanel('sessions');
  }

  /* -------------------------------------------------------------- engines */

  async setEngine(engine: EngineId): Promise<void> {
    if (!this.engines.has(engine) || engine === this.state.engine) return;
    this.set({ engine, capabilities: this.engines.get(engine)!.capabilities, sessions: [], sessionId: undefined, messages: [], permissions: [], questions: [], providers: [], agents: [], mcp: [], model: undefined, agent: undefined, activity: 'idle', sessionUsage: undefined, commands: mergeCommands([]) });
    await this.host.state.update('engine', engine);
    await this.activate();
  }

  async pickEngine(): Promise<void> {
    const picked = await this.host.pick<EngineId>(
      this.state.engines.map((s) => ({
        label: `${s.engine === this.state.engine ? '$(check) ' : ''}${ENGINE_LABELS[s.engine]}`,
        description: s.state === 'ready' ? `ready${s.version ? ` · v${s.version}` : ''}` : s.state === 'unavailable' ? 'not available' : '',
        detail: s.state === 'unavailable' ? s.detail : ENGINE_DETAILS[s.engine],
        value: s.engine,
      })),
      { title: 'OpenCode Hub: Select Engine', placeholder: 'Which backend should answer in this workspace?' },
    );
    if (picked) await this.setEngine(picked);
  }

  async restartEngine(): Promise<void> {
    if (!this.host.workspaceTrusted()) return;
    const engine = this.engine;
    if ('invalidateModels' in engine && typeof engine.invalidateModels === 'function') (engine.invalidateModels as () => void)();
    this.set({ loading: true });
    await engine.restart();
    await this.activate();
  }

  async setModel(model: ModelRef): Promise<void> {
    this.set({ model });
    await this.host.state.update(`model.${this.state.engine}`, model);
  }

  async pickModel(): Promise<void> {
    const items = this.state.providers.flatMap((p) => p.models.map((m) => ({ label: m.name, description: p.name, detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined, value: { providerId: m.providerId, modelId: m.modelId } as ModelRef })));
    if (items.length === 0) {
      this.notify('warn', 'No models available for this engine yet. Use /providers to connect one.');
      return;
    }
    const picked = await this.host.pick(items, { title: 'OpenCode Hub: Select Model', placeholder: 'Model for this workspace' });
    if (picked) await this.setModel(picked);
  }

  async setAgent(agent: string): Promise<void> {
    this.set({ agent });
    await this.host.state.update(`agent.${this.state.engine}`, agent);
  }

  /* ---------------------------------------------------------- attachments */

  async addPaths(paths: string[]): Promise<void> {
    const cwd = this.host.cwd();
    const added: Attachment[] = [];
    for (const raw of paths) {
      // Webview drops deliver file:// URIs; commands deliver plain paths.
      let p = raw;
      try {
        if (raw.startsWith('file://')) p = fileURLToPath(raw);
      } catch {
        continue;
      }
      if (this.state.attachments.some((a) => a.path === p && !a.range) || added.some((a) => a.path === p)) continue;
      try {
        const st = await fs.stat(p);
        const rel = cwd ? path.relative(cwd, p) : '';
        const name = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(p);
        if (st.isDirectory()) {
          added.push({ id: newId('att'), kind: 'file', name: name + '/', mime: 'application/x-directory', path: p });
          continue;
        }
        const mime = mimeForPath(p);
        const att: Attachment = { id: newId('att'), kind: isImageMime(mime) ? 'image' : 'file', name, mime, path: p, size: st.size };
        if (att.kind === 'image') {
          if (st.size > MAX_IMAGE_BYTES) {
            this.notify('warn', `${name} is larger than 5 MB and was not attached.`);
            continue;
          }
          att.dataUrl = `data:${mime};base64,${(await fs.readFile(p)).toString('base64')}`;
        }
        added.push(att);
      } catch (err) {
        this.notify('warn', `Could not attach ${p}: ${errorMessage(err)}`);
      }
    }
    if (added.length) this.set({ attachments: [...this.state.attachments, ...added] });
  }

  addAttachment(attachment: Attachment): void {
    if (isImageMime(attachment.mime) && !this.state.capabilities.images) {
      this.notify('warn', `${ENGINE_LABELS[this.state.engine]} does not accept images.`);
      return;
    }
    this.set({ attachments: [...this.state.attachments, { ...attachment, id: attachment.id || newId('att') }] });
  }

  async pickFiles(): Promise<void> {
    const files = await this.host.pickFiles();
    if (files.length) await this.addPaths(files);
  }

  /* ---------------------------------------------------------------- send */

  async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text && this.state.attachments.length === 0) return;
    const slash = parseSlash(text);
    if (slash && isBuiltin(slash.name)) {
      await this.runBuiltin(slash.name, slash.args);
      return;
    }
    if (!this.host.workspaceTrusted()) {
      this.notify('warn', 'Chat is disabled in untrusted workspaces because agents can run tools here. Trust the workspace to continue.');
      return;
    }
    const engine = this.engine;
    if (engine.status().state !== 'ready') {
      const status = await engine.start();
      if (status.state !== 'ready') {
        this.notify('error', status.detail ?? `${ENGINE_LABELS[engine.id]} is not available.`);
        return;
      }
      await this.activate();
    }
    if (this.state.activity !== 'idle') {
      this.notify('warn', 'Still working on the previous message. Stop it first (/stop) or wait.');
      return;
    }
    if (!this.state.model) await this.refreshCatalog();
    if (!this.state.model) {
      this.notify('warn', engine.id === 'direct' || engine.id === 'opencode' ? 'No model available. Use /providers to connect a provider, then pick a model.' : 'No model available for this engine.');
      return;
    }
    const sessionId = await this.ensureSession();
    if (!sessionId) return;
    const input = { text, attachments: this.state.attachments, model: this.state.model, agent: this.state.agent };
    this.set({ attachments: [], activity: 'busy', activityDetail: undefined });
    try {
      const engineCommand = slash && this.state.commands.find((c) => c.name === slash.name && c.source !== 'builtin');
      if (slash && engineCommand) await engine.runCommand(sessionId, slash.name, slash.args, input);
      else await engine.sendPrompt(sessionId, input);
    } catch (err) {
      this.set({ activity: 'idle', attachments: input.attachments });
      this.notify('error', errorMessage(err));
    }
  }

  async abort(): Promise<void> {
    if (this.state.sessionId) await this.guard('Could not stop', () => this.engine.abort(this.state.sessionId!));
  }

  private localMessage(markdown: string): void {
    const now = Date.now();
    const message: ChatMessage = { id: newId('local_msg'), sessionId: this.state.sessionId ?? 'local', role: 'assistant', createdAt: now, completedAt: now, parts: [{ id: newId('prt'), type: 'text', text: markdown }] };
    this.set({ messages: [...this.state.messages, message] });
  }

  private async runBuiltin(name: string, args: string): Promise<void> {
    const engine = this.engine;
    const caps = engine.capabilities;
    const unsupported = () => this.notify('warn', `/${name} is not supported by the ${ENGINE_LABELS[engine.id]} engine.`);
    const needSession = (): string | undefined => {
      if (!this.state.sessionId) this.notify('warn', `/${name} needs an active session.`);
      return this.state.sessionId;
    };
    switch (name) {
      case 'new':
      case 'clear':
        return this.newSession();
      case 'sessions':
        return this.openPanel('sessions');
      case 'mcp':
        void this.refreshMcp();
        return this.openPanel('mcp');
      case 'usage':
        this.pushUsage();
        return this.openPanel('usage');
      case 'help':
        return this.localMessage(helpMarkdown(this.state.commands));
      case 'stop':
        return this.abort();
      case 'attach':
        return this.pickFiles();
      case 'providers':
        return this.manageProviders();
      case 'model': {
        if (!args) return this.openPanel('models');
        const q = args.toLowerCase();
        const all = this.state.providers.flatMap((p) => p.models);
        const match = all.find((m) => m.modelId.toLowerCase() === q || `${m.providerId}/${m.modelId}`.toLowerCase() === q) ?? all.find((m) => m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        if (!match) return this.notify('warn', `No model matches "${args}".`);
        await this.setModel({ providerId: match.providerId, modelId: match.modelId });
        return this.notify('info', `Model: ${match.name}`);
      }
      case 'agent': {
        if (!caps.agents || this.state.agents.length === 0) return unsupported();
        const match = args ? this.state.agents.find((a) => a.name.toLowerCase() === args.toLowerCase()) : await this.host.pick(this.state.agents.map((a) => ({ label: a.name, detail: a.description, value: a })), { title: 'OpenCode Hub: Select Agent' });
        if (!match) return args ? this.notify('warn', `No agent named "${args}".`) : undefined;
        await this.setAgent(match.name);
        return this.notify('info', `Agent: ${match.name}`);
      }
      case 'engine': {
        if (!args) return this.pickEngine();
        const q = args.toLowerCase();
        const id = (Object.keys(ENGINE_LABELS) as EngineId[]).find((e) => e === q || ENGINE_LABELS[e].toLowerCase().includes(q) || (q === 'byok' && e === 'direct') || (q === 'copilot' && e === 'vscode-lm') || (q === 'claude' && e === 'claude-code') || (q === 'chatgpt' && e === 'codex'));
        return id ? this.setEngine(id) : this.notify('warn', `Unknown engine "${args}".`);
      }
      case 'avatar': {
        const a = args.toLowerCase();
        if (a === 'buddy' || a === 'dots' || a === 'bot' || a === 'orb') return this.setAvatar({ enabled: true, style: avatarStyle(a) });
        return this.setAvatar({ enabled: a === 'on' ? true : a === 'off' ? false : !this.state.avatar.enabled });
      }
      case 'move': {
        const a = args.toLowerCase();
        const to = a === 'left' || a === 'right' || a === 'editor' ? a : await this.host.pick([{ label: 'Right side bar', detail: 'Next to the editor, like other chat views', value: 'right' as const }, { label: 'Left side bar', value: 'left' as const }, { label: 'Editor tab', detail: 'A full-size chat you can split or move to its own window', value: 'editor' as const }], { title: 'OpenCode Hub: Where should the chat live?' });
        if (to) await this.guard('Could not move the chat', () => this.host.moveView(to));
        return;
      }
      case 'zoom': {
        const a = args.toLowerCase().replace('%', '');
        if (a === 'in' || a === '+') return this.zoom(0.1);
        if (a === 'out' || a === '-') return this.zoom(-0.1);
        const n = Number(a);
        // 10 and above is a percentage ("/zoom 125"); smaller numbers are a multiplier ("/zoom 1.25").
        return this.setZoom(a === '' || a === 'reset' || !Number.isFinite(n) ? 1 : n >= 10 ? n / 100 : n);
      }
      case 'rename': {
        const id = needSession();
        if (!id) return;
        const title = args || (await this.host.input({ title: 'Rename session', value: this.state.sessions.find((s) => s.id === id)?.title }));
        if (title) await this.guard('Could not rename', () => engine.renameSession(id, title));
        return;
      }
      case 'export':
        return this.exportSession();
      case 'compact': {
        const id = needSession();
        if (!id) return;
        if (!caps.compact || !engine.compactSession) return unsupported();
        await this.guard('Could not compact', () => engine.compactSession!(id, this.state.model));
        return;
      }
      case 'undo':
      case 'redo': {
        const id = needSession();
        if (!id) return;
        const fn = name === 'undo' ? engine.undo : engine.redo;
        if (!caps.undo || !fn) return unsupported();
        await this.guard(`Could not ${name}`, () => fn.call(engine, id));
        await this.openSession(id);
        return;
      }
      case 'share':
      case 'unshare': {
        const id = needSession();
        if (!id) return;
        if (!caps.share || !engine.shareSession) return unsupported();
        const session = await this.guard(`Could not ${name}`, () => engine.shareSession!(id, name === 'share'));
        if (session?.shareUrl) {
          await this.host.copy(session.shareUrl);
          this.localMessage(`Share link copied to the clipboard: ${session.shareUrl}`);
        } else if (session) this.notify('info', 'Share link removed.');
        return;
      }
      case 'fork': {
        const id = needSession();
        if (!id) return;
        if (!caps.fork || !engine.forkSession) return unsupported();
        const forked = await this.guard('Could not fork', () => engine.forkSession!(id));
        if (forked) {
          await this.refreshSessions();
          await this.openSession(forked.id);
        }
        return;
      }
      default:
        return;
    }
  }

  private async exportSession(): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === this.state.sessionId);
    if (!session) return this.notify('warn', '/export needs an active session.');
    const lines = [`# ${session.title}`, '', `_${ENGINE_LABELS[session.engine]} · ${new Date(session.createdAt).toISOString()}_`, ''];
    for (const m of this.state.messages) {
      if (m.id.startsWith('local_')) continue;
      lines.push(`## ${m.role === 'user' ? 'User' : `Assistant${m.model ? ` (${m.model.providerId}/${m.model.modelId})` : ''}`}`, '');
      for (const p of m.parts) {
        if (p.type === 'text') lines.push(p.text, '');
        else if (p.type === 'tool') lines.push(`> **${p.tool}**${p.title ? ` — ${p.title}` : ''} _(${p.status})_`, '');
        else if (p.type === 'file') lines.push(`> Attached: ${p.filename}`, '');
      }
      if (m.usage) lines.push(`_Tokens: ${m.usage.input} in · ${m.usage.output} out${m.usage.cost ? ` · $${m.usage.cost.toFixed(4)}` : ''}_`, '');
    }
    await this.host.saveText(`${session.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'session'}.md`, lines.join('\n'));
  }

  /** Change the chat's text size by a step (0.1 = 10 %). */
  zoom(delta: number): Promise<void> {
    return this.setZoom(this.state.zoom + delta);
  }

  async setZoom(value: number): Promise<void> {
    const zoom = clampZoom(value);
    this.set({ zoom });
    await this.host.updateConfig('chat.zoom', zoom);
  }

  async setAvatar(patch: { enabled?: boolean; style?: AvatarStyle }): Promise<void> {
    const avatar = { ...this.state.avatar, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.set({ avatar });
    if (patch.enabled !== undefined) await this.host.updateConfig('avatar.enabled', avatar.enabled);
    if (patch.style !== undefined) await this.host.updateConfig('avatar.style', avatar.style);
  }

  /** The user trusted the workspace: engines may start now. */
  async onTrustChanged(): Promise<void> {
    this.set({ trusted: this.host.workspaceTrusted() });
    await this.activate();
  }

  /** Settings changed outside the chat view. */
  onConfigChanged(providersChanged = true): void {
    this.set({ avatar: { enabled: this.host.config<boolean>('avatar.enabled', true), style: avatarStyle(this.host.config<string>('avatar.style', 'buddy')) }, zoom: clampZoom(this.host.config<number>('chat.zoom', 1)), trusted: this.host.workspaceTrusted() });
    if (providersChanged && (this.state.engine === 'direct' || this.state.engine === 'vscode-lm')) this.debounce('config', 400, () => void this.restartEngine());
  }

  showPanel(name: 'mcp' | 'usage' | 'sessions' | 'models'): void {
    if (name === 'mcp') void this.refreshMcp();
    if (name === 'usage') this.pushUsage();
    this.openPanel(name);
  }

  /* ------------------------------------------------------------ providers */

  async manageProviders(): Promise<void> {
    if (this.state.engine === 'opencode' && this.engine.status().state === 'ready') {
      const choice = await this.host.pick(
        [
          { label: '$(key) Connect an opencode provider with an API key…', detail: 'Stores the key in opencode (auth.json) and makes its models available.', value: 'key' as const },
          { label: '$(sign-in) Sign in with a subscription in the terminal…', detail: 'Runs `opencode auth login` — ChatGPT Plus/Pro, GitHub Copilot and other OAuth logins.', value: 'login' as const },
          { label: '$(settings-gear) Manage Direct BYOK providers (no opencode needed)…', value: 'direct' as const },
        ],
        { title: 'OpenCode Hub: Providers' },
      );
      if (choice === 'key') return this.connectOpencodeProvider();
      if (choice === 'login') {
        this.host.runInTerminal('opencode auth', `${quoteIfNeeded(this.host.config<string>('opencode.path', '') || 'opencode')} auth login`);
        this.notify('info', 'Finish signing in in the terminal, then run "OpenCode Hub: Restart Active Engine".');
        return;
      }
      if (choice !== 'direct') return;
    }
    await this.manageDirectProviders();
  }

  private async connectOpencodeProvider(): Promise<void> {
    const engine = this.engine as Engine & { listConnectableProviders?: () => Promise<{ id: string; name: string; connected: boolean }[]> };
    if (!engine.listConnectableProviders || !engine.setProviderApiKey) return;
    const providers = await this.guard('Could not list providers', () => engine.listConnectableProviders!());
    if (!providers) return;
    const provider = await this.host.pick(providers.map((p) => ({ label: p.name, description: p.connected ? 'connected' : p.id, value: p })), { title: 'Connect provider', placeholder: 'Search 75+ providers…' });
    if (!provider) return;
    const key = await this.host.input({ title: `API key for ${provider.name}`, password: true, placeholder: 'Paste the API key' });
    if (!key) return;
    await this.guard('Could not store the key', () => engine.setProviderApiKey!(provider.id, key.trim()));
    this.notify('info', `${provider.name} connected.`);
    this.debounce('catalog', 800, () => void this.refreshCatalog());
  }

  private directProviders(): ProviderConfig[] {
    const list = this.host.config<ProviderConfig[]>('providers', []);
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
  }

  private async manageDirectProviders(): Promise<void> {
    const configured = this.directProviders();
    type Choice = { kind: 'existing'; id: string } | { kind: 'preset'; id: string } | { kind: 'custom'; type: 'openai-compatible' | 'anthropic' };
    const items: PickItem<Choice>[] = [];
    for (const p of configured) {
      const r = resolveProvider(p);
      const hasKey = !!(await this.host.secrets.get(secretKeyFor(p.id)));
      items.push({ label: `$(check) ${r.name}`, description: r.keyless ? 'local · no key needed' : hasKey ? 'API key stored' : 'no API key', detail: r.baseUrl, value: { kind: 'existing', id: p.id } });
    }
    for (const preset of PROVIDER_PRESETS) {
      if (configured.some((p) => p.id === preset.id)) continue;
      items.push({ label: `$(add) ${preset.name}`, description: preset.description, detail: preset.baseUrl, value: { kind: 'preset', id: preset.id } });
    }
    items.push({ label: '$(add) Custom OpenAI-compatible endpoint…', description: 'vLLM, llama.cpp, LiteLLM, Azure, any /chat/completions server', value: { kind: 'custom', type: 'openai-compatible' } });
    items.push({ label: '$(add) Custom Anthropic-compatible endpoint…', description: 'Any /v1/messages server', value: { kind: 'custom', type: 'anthropic' } });
    const choice = await this.host.pick(items, { title: 'OpenCode Hub: BYOK Providers', placeholder: 'Add a provider or manage an existing one' });
    if (!choice) return;

    if (choice.kind === 'existing') {
      const action = await this.host.pick(
        [
          { label: '$(key) Set API key', value: 'set' as const },
          { label: '$(trash) Remove API key', value: 'unset' as const },
          { label: '$(close) Remove provider', value: 'remove' as const },
          { label: '$(settings-gear) Edit in settings.json', value: 'edit' as const },
        ],
        { title: `Provider: ${choice.id}` },
      );
      if (action === 'set') await this.promptKey(choice.id, resolveProvider(configured.find((p) => p.id === choice.id)!).name);
      else if (action === 'unset') await this.host.secrets.delete(secretKeyFor(choice.id));
      else if (action === 'remove') {
        await this.host.secrets.delete(secretKeyFor(choice.id));
        await this.host.updateConfig('providers', configured.filter((p) => p.id !== choice.id));
      } else if (action === 'edit') return this.host.openSettings('opencodeHub.providers');
      else return;
    } else if (choice.kind === 'preset') {
      const preset = presetById(choice.id)!;
      await this.host.updateConfig('providers', [...configured, { id: preset.id, name: preset.name, type: preset.type, baseUrl: preset.baseUrl }]);
      if (!preset.keyless) await this.promptKey(preset.id, preset.name);
    } else {
      const baseUrl = await this.host.input({ title: 'Base URL', prompt: choice.type === 'anthropic' ? 'e.g. https://my-gateway.example.com' : 'e.g. http://localhost:8000/v1', placeholder: 'https://…' });
      if (!baseUrl) return;
      const id = await this.host.input({ title: 'Provider id', prompt: 'Short unique name, e.g. "my-vllm"', value: safeId(baseUrl) });
      if (!id) return;
      if (configured.some((p) => p.id === id)) return this.notify('warn', `A provider named "${id}" already exists.`);
      const models = await this.host.input({ title: 'Model ids (optional)', prompt: 'Comma-separated. Leave empty to discover them from the /models endpoint.' });
      await this.host.updateConfig('providers', [...configured, { id, type: choice.type, baseUrl: baseUrl.trim(), ...(models?.trim() ? { models: models.split(',').map((m) => m.trim()).filter(Boolean) } : {}) }]);
      if (!resolveProvider({ id, type: choice.type, baseUrl }).keyless) await this.promptKey(id, id);
    }
    if (this.state.engine === 'direct') await this.restartEngine();
    else this.notify('info', 'Provider saved. Switch to the Direct BYOK engine with /engine byok to use it.');
  }

  private async promptKey(id: string, name: string): Promise<void> {
    const key = await this.host.input({ title: `API key for ${name}`, prompt: 'Stored in VS Code Secret Storage (your OS keychain), never in settings.', password: true, placeholder: 'Paste the API key' });
    if (key?.trim()) await this.host.secrets.set(secretKeyFor(id), key.trim());
  }

  /* -------------------------------------------------------------- webview */

  async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pendingEvents = [];
        this.webviewReady = true;
        this.host.post({ type: 'state', state: this.state });
        return;
      case 'send':
        return this.send(msg.text);
      case 'abort':
        return this.abort();
      case 'newSession':
        return this.newSession();
      case 'switchSession':
        return this.openSession(msg.sessionId);
      case 'deleteSession':
        return this.deleteSession(msg.sessionId);
      case 'renameSession':
        await this.guard('Could not rename', () => this.engine.renameSession(msg.sessionId, msg.title));
        return this.refreshSessions();
      case 'setEngine':
        return this.setEngine(msg.engine);
      case 'setModel':
        return this.setModel(msg.model);
      case 'setAgent':
        return this.setAgent(msg.agent);
      case 'pickFiles':
        return this.pickFiles();
      case 'addAttachment':
        return this.addAttachment(msg.attachment);
      case 'addPaths':
        return this.addPaths(msg.paths);
      case 'removeAttachment':
        return this.set({ attachments: this.state.attachments.filter((a) => a.id !== msg.id) });
      case 'searchFiles':
        this.host.post({ type: 'fileResults', requestId: msg.requestId, files: await this.host.findFiles(msg.query, 30).catch(() => []) });
        return;
      case 'mcpToggle':
        // Optimistic: flip the switch now, the refresh that follows shows the real status.
        this.set({ mcp: this.state.mcp.map((s) => (s.name === msg.name ? { ...s, enabled: msg.enabled, status: msg.enabled ? 'connecting' : 'disabled' } : s)) });
        await this.guard(`Could not ${msg.enabled ? 'enable' : 'disable'} ${msg.name}`, () => this.engine.setMcpEnabled(msg.name, msg.enabled));
        return this.refreshMcp();
      case 'mcpRefresh':
        return this.refreshMcp();
      case 'permissionReply': {
        const req = this.state.permissions.find((p) => p.id === msg.requestId);
        if (!req || !this.engine.replyPermission) return;
        this.set({ permissions: this.state.permissions.filter((p) => p.id !== msg.requestId) });
        await this.guard('Could not answer the permission request', () => this.engine.replyPermission!(req.sessionId, req.id, msg.reply));
        return;
      }
      case 'questionReply': {
        const q = this.state.questions.find((x) => x.id === msg.requestId);
        if (!q || !this.engine.replyQuestion) return;
        this.set({ questions: this.state.questions.filter((x) => x.id !== msg.requestId) });
        await this.guard('Could not answer', () => this.engine.replyQuestion!(q.sessionId, q.id, msg.answers));
        return;
      }
      case 'usageRefresh':
        return this.pushUsage();
      case 'usageReset':
        return this.resetUsage();
      case 'openFile':
        return this.host.openFile(msg.path).catch((e) => this.notify('warn', errorMessage(e)));
      case 'openExternal':
        if (/^https?:\/\//i.test(msg.url)) await this.host.openExternal(msg.url);
        return;
      case 'copy':
        return this.host.copy(msg.text);
      case 'insertCode':
        return this.host.insertIntoEditor(msg.text);
      case 'setAvatar':
        return this.setAvatar(msg);
      case 'moveView':
        await this.guard('Could not move the chat', () => this.host.moveView(msg.to));
        return;
      case 'zoom':
        return msg.delta === 0 ? this.setZoom(1) : this.zoom(msg.delta);
      case 'manageProviders':
        return this.manageProviders();
      case 'restartEngine':
        return this.restartEngine();
      case 'openSettings':
        return this.host.openSettings('opencodeHub');
      case 'avatarReady':
        this.avatarRenderer = msg.renderer;
        this.host.log.debug(`Companion renderer: ${msg.renderer}`);
        return;
      case 'log':
        this.host.log[msg.level](`[webview] ${msg.message}`);
        return;
      default:
        return;
    }
  }

  webviewDisposed(): void {
    this.webviewReady = false;
    this.avatarRenderer = undefined;
  }

  get isWebviewReady(): boolean {
    return this.webviewReady;
  }

  async resetUsage(): Promise<void> {
    if (!(await this.host.confirm('Reset all token usage statistics?', 'Reset'))) return;
    await this.ledger.reset();
    this.pushUsage();
  }

  /** Current session's messages as text; used by tests and the export command. */
  transcript(): string {
    return this.state.messages.map((m) => `${m.role}: ${messageText(m)}`).join('\n');
  }

  activeSession(): SessionInfo | undefined {
    return this.state.sessions.find((s) => s.id === this.state.sessionId);
  }
}

const ENGINE_DETAILS: Record<EngineId, string> = {
  opencode: 'opencode server — every opencode provider, agents, custom commands, MCP, undo, share',
  direct: 'Your own API keys: OpenAI, Anthropic, OpenRouter, Ollama, any OpenAI-compatible endpoint',
  'claude-code': 'Your installed Claude Code CLI and its login (Claude subscription or API key)',
  codex: 'Your installed Codex CLI and its login (ChatGPT subscription or API key)',
  'vscode-lm': 'GitHub Copilot and other models exposed through VS Code',
};

/** Accepts the pre-release style names too. */
function avatarStyle(value: string): AvatarStyle {
  return value === 'dots' || value === 'orb' ? 'dots' : 'buddy';
}

function clampZoom(value: number): number {
  const n = Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(1.6, Math.max(0.8, n)) * 100) / 100;
}

function safeId(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\.|^api\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'custom';
  } catch {
    return 'custom';
  }
}

function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}
