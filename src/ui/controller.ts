import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, isImageMime, mimeForPath } from '../core/attachments';
import { CatalogCache } from '../core/catalogCache';
import type { Disposable } from '../core/emitter';
import type { Engine, Logger } from '../core/engine';
import { errorMessage } from '../core/engine';
import { newId } from '../core/ids';
import { sessionDigest } from '../core/sessionDigest';
import { BUILTIN_COMMANDS, helpMarkdown, isBuiltin, mergeCommands, parseSlash } from '../core/slashCommands';
import type { KeyValueStore, UsageLedger } from '../core/usageLedger';
import { PROVIDER_PRESETS, presetById, resolveProvider, secretKeyFor } from '../engines/direct/presets';
import type { ProviderConfig } from '../engines/direct/presets';
import { buildIssueUrl, diagnosticsMarkdown, feedbackKind, osLabel } from '../shared/feedback';
import { effortLabel, isCostlyEffort, matchEffort, resolveEffort } from '../shared/effort';
import type { EnvironmentInfo, FeedbackKind } from '../shared/feedback';
import type { AvatarStyle, HostToWebview, ViewState, WebviewToHost } from '../shared/protocol';
import { applyMessageEvent, messageText } from '../shared/reducer';
import { ENGINE_LABELS } from '../shared/types';
import { approvalMode } from '../shared/types';
import type { AgentInfo, ApprovalMode, Attachment, AuthStatus, ChatMessage, EngineEvent, EngineId, ModelInfo, ModelRef, PromptInput, ProviderInfo, SessionInfo, SlashCommand } from '../shared/types';

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
  /** A folder for the extension's own files (the saved model lists). */
  storageDir: string | undefined;
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
  /** Versions and platform, for `/doctor` and the diagnostics a feedback report can include. */
  environment(): EnvironmentInfo;
  /** The editor's file, or its selected lines when there is a selection, as an attachment. */
  activeFileAttachment(): Attachment | undefined;
  /** `owner/repo` on GitHub where feedback is filed, from the extension's package.json. */
  repository(): string | undefined;
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
  /** The user pressed stop during the running turn. */
  private stopRequested = false;
  /** Engine whose sign-in was started in a terminal and is being waited for. */
  private signInPending: EngineId | undefined;
  private signInTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last pre-filled issue link, so it can be opened where another GitHub account is signed in. */
  private lastFeedbackUrl: string | undefined;
  /** Who each account engine was signed in as when last checked, to notice a change. */
  private authIdentities = new Map<EngineId, string>();
  private lastAuthCheck = 0;
  /** How long after a sign-in the models are listed a second time (the tests shorten it). */
  relistAgainMs = 20_000;
  /** How long an engine's model list may go unchecked before the chat coming into view, or a finished reply, asks again. */
  catalogMaxAgeMs = 10 * 60_000;
  /** Opening the model picker asks again, at most this often. */
  modelCheckIntervalMs = 15_000;
  private lastModelCheck = Date.now();
  /** Engine whose providers `state.providers` holds, to tell a new connection from an engine switch. */
  private catalogEngine: EngineId | undefined;
  /** The last model list of each engine, shown at once while the fresh one is fetched. */
  private readonly catalog: CatalogCache;
  /** Renderer the webview's companion is using, once it has mounted. */
  avatarRenderer: 'webgl' | '2d' | undefined;

  constructor(private readonly engines: Map<EngineId, Engine>, private readonly ledger: UsageLedger, private readonly host: ControllerHost) {
    this.catalog = new CatalogCache(host.storageDir ? path.join(host.storageDir, 'catalog') : undefined, host.log);
    const configured = host.config<EngineId>('defaultEngine', 'opencode');
    const saved = host.state.get<EngineId>('engine');
    const engine = saved && engines.has(saved) ? saved : engines.has(configured) ? configured : 'opencode';
    this.state = {
      engine,
      engines: [...engines.values()].map((e) => e.status()),
      capabilities: engines.get(engine)?.capabilities ?? EMPTY_CAPS,
      sessions: [],
      otherSessions: [],
      sessionId: undefined,
      messages: [],
      activity: 'idle',
      activityDetail: undefined,
      providers: [],
      model: undefined,
      effort: undefined,
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
      providerColors: host.config<boolean>('chat.providerColors', true) !== false,
      activeFile: undefined,
      trusted: host.workspaceTrusted(),
      canRetry: false,
      recentModels: [],
      auth: undefined,
      approvals: approvalMode(host.config<string>('approvals', 'ask')),
      panel: { name: 'none', nonce: 0 },
      diagnostics: '',
      feedbackDraft: undefined,
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
    // Show what this engine listed last time straight away, so the model can be picked while the
    // engine starts and its account is asked; the fresh list replaces it below.
    if (this.state.providers.length === 0) {
      const cached = await this.catalog.get(engine.id, this.host.cwd());
      if (run !== this.activation) return;
      if (cached && this.state.providers.length === 0) this.applyCatalog(engine.id, cached.providers, cached.agents, cached.commands, cached.model);
    }
    const status = await engine.start();
    if (run !== this.activation) return;
    if (status.state !== 'ready') {
      this.set({ loading: false, sessions: [], sessionId: undefined, messages: [], providers: [], agents: [], mcp: [], commands: mergeCommands([]), model: undefined, agent: undefined, auth: undefined });
      return;
    }
    this.lastModelCheck = Date.now();
    await Promise.all([this.refreshCatalog(), this.refreshMcp(), this.refreshSessions(), this.refreshAuth(), this.refreshOtherSessions()]);
    if (run !== this.activation) return;
    const last = this.host.state.get<string>(`session.${engine.id}`);
    if (last && this.state.sessions.some((s) => s.id === last)) await this.openSession(last);
    else this.set({ sessionId: undefined, messages: [], permissions: [], questions: [], activity: 'idle' });
    this.set({ loading: false });
    this.pushUsage();
  }

  /** Resolves once what the controller saves in the background (the model lists) is on disk. */
  async flush(): Promise<void> {
    await this.catalog.flush();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.stopSignInWait();
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
    // The retry offer belongs to one conversation; it does not follow you to another.
    if ('sessionId' in patch && patch.sessionId !== this.state.sessionId && this.state.sessionId !== undefined && this.state.canRetry && patch.canRetry === undefined) patch = { ...patch, canRetry: false };
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
    // A provider that became usable since the last listing (a sign-in in a terminal, a key): say so.
    if (this.catalogEngine === engine.id) {
      const before = new Set(this.state.providers.filter((p) => p.models.length > 0).map((p) => p.id));
      const added = providers.filter((p) => p.models.length > 0 && !before.has(p.id));
      if (added.length) this.notify('info', `Connected: ${added.map((p) => `${p.name} (${p.models.length} model${p.models.length === 1 ? '' : 's'})`).join(', ')}. Pick one with the model button.`);
    }
    this.catalogEngine = engine.id;
    const saved = this.host.state.get<ModelRef>(`model.${engine.id}`);
    const known = !!saved && providers.some((p) => p.id === saved.providerId && p.models.some((m) => m.modelId === saved.modelId));
    const fallback = known ? undefined : await engine.defaultModel().catch(() => undefined);
    if (engine !== this.engine) return;
    this.applyCatalog(engine.id, providers, agents, commands, fallback);
    this.catalog.set(engine.id, this.host.cwd(), { at: Date.now(), providers, agents, commands, model: this.state.model });
  }

  /** Put an engine's models, agents and commands on screen, and settle which model and agent are selected. */
  private applyCatalog(engineId: EngineId, providers: ProviderInfo[], agents: AgentInfo[], commands: SlashCommand[], fallback: ModelRef | undefined): void {
    let model = this.host.state.get<ModelRef>(`model.${engineId}`);
    const exists = (m: ModelRef | undefined) => !!m && providers.some((p) => p.id === m.providerId && p.models.some((x) => x.modelId === m.modelId));
    if (!exists(model)) model = exists(fallback) ? fallback : providers.flatMap((p) => p.models)[0];
    let agent = this.host.state.get<string>(`agent.${engineId}`);
    if (!agent || !agents.some((a) => a.name === agent)) agent = agents[0]?.name;
    const recentModels = (this.host.state.get<ModelRef[]>(`recentModels.${engineId}`) ?? []).filter(exists).slice(0, MAX_RECENT_MODELS);
    this.set({ providers, agents, commands: mergeCommands(commands), model, effort: resolveEffort(this.host.state.get<string>(`effort.${engineId}`), findModel(providers, model)), agent, recentModels });
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

  /**
   * Sessions of the other engines, for the one history list. Engines that keep sessions in
   * the extension's storage are read from disk without starting; opencode only while it runs.
   */
  private async refreshOtherSessions(): Promise<void> {
    if (!this.host.workspaceTrusted()) return;
    const active = this.state.engine;
    const lists = await Promise.all(
      [...this.engines.values()]
        .filter((e) => e.id !== active && (!e.capabilities.remoteSessions || e.status().state === 'ready'))
        .map((e) => e.listSessions().catch(() => [] as SessionInfo[])),
    );
    if (active !== this.state.engine) return;
    this.set({ otherSessions: lists.flat().filter((s) => !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300) });
  }

  /** Open a session of any engine: switch to its engine first when needed. */
  async openAnySession(sessionId: string, engine?: EngineId): Promise<void> {
    if (engine && engine !== this.state.engine && this.engines.has(engine)) {
      await this.host.state.update(`session.${engine}`, sessionId);
      await this.setEngine(engine);
      if (this.state.sessionId !== sessionId) await this.openSession(sessionId);
      return;
    }
    await this.openSession(sessionId);
  }

  /** Ask the active engine's CLI whether it is signed in (Claude Code, Codex). */
  private async refreshAuth(): Promise<AuthStatus | undefined> {
    const engine = this.engine;
    const account = engine.account;
    if (!account || engine.status().state !== 'ready') {
      if (this.state.auth) this.set({ auth: undefined });
      return undefined;
    }
    const status = await account.status().catch((e): AuthStatus => (this.host.log.warn(`auth status: ${errorMessage(e)}`), { engine: engine.id, mode: account.mode(), signedIn: undefined }));
    if (engine !== this.engine) return undefined;
    this.set({ auth: { ...status, pending: this.signInPending === engine.id || undefined } });
    // Another account, plan or way of paying means another list of models. This also catches a
    // sign-in or sign-out done outside the chat (in a terminal, or in the CLI itself).
    if (status.signedIn !== undefined) {
      const identity = authIdentity(status);
      const before = this.authIdentities.get(engine.id);
      this.authIdentities.set(engine.id, identity);
      if (before !== undefined && before !== identity) {
        this.host.log.info(`${ENGINE_LABELS[engine.id]}: sign-in changed (${status.signedIn ? status.label ?? 'signed in' : 'signed out'}); listing models again`);
        this.relistModels();
      }
    }
    return status;
  }

  /**
   * Fetch the account's models again, now and once more a little later: right after a sign-in
   * the CLI may not know the plan yet, and would report the generic list.
   */
  private relistModels(): void {
    this.invalidateModels();
    this.debounce('catalog', 300, () => void this.refreshCatalog());
    this.debounce('catalog-again', this.relistAgainMs, () => {
      this.invalidateModels();
      void this.refreshCatalog();
    });
  }

  /**
   * The chat came into view, or the window got the focus back (for example after signing in
   * in the browser or a terminal): check the sign-in again, at most every few seconds.
   */
  onShown(): void {
    this.recheckModels(this.catalogMaxAgeMs);
    if (!this.engine.account || this.engine.status().state !== 'ready' || this.signInPending) return;
    if (Date.now() - this.lastAuthCheck < 10_000) return;
    this.lastAuthCheck = Date.now();
    void this.refreshAuth();
  }

  /** The model picker was opened: make sure what it shows is current. */
  modelsShown(): void {
    this.recheckModels(this.modelCheckIntervalMs);
  }

  /**
   * New models appear without an update of the extension, because every list comes from the
   * engine: the CLI's list for the account, opencode's catalogue, a provider's `/models`,
   * VS Code's model API. This asks the engine again (unless it was asked within `minAgeMs`)
   * so that a window left open for days does not keep showing last week's list.
   */
  private recheckModels(minAgeMs: number): void {
    const engine = this.engine;
    if (!this.host.workspaceTrusted() || engine.status().state !== 'ready') return;
    if (Date.now() - this.lastModelCheck < minAgeMs) return;
    this.lastModelCheck = Date.now();
    // Engines that keep their own copy re-ask in the background and report a change; the others answer live.
    engine.refreshModels?.();
    this.debounce('catalog', 100, () => void this.refreshCatalog());
  }

  /** The list of extra models in settings changed. */
  onModelsConfigChanged(): void {
    this.debounce('catalog', 200, () => void this.refreshCatalog());
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
    if ((event.type === 'session.updated' || event.type === 'session.deleted') && engineId !== this.state.engine) this.debounce('otherSessions', 500, () => void this.refreshOtherSessions());
    // Auto mode: approve right away, for any engine and session (engines that ask in-process do this themselves).
    if (event.type === 'permission.asked' && this.state.approvals === 'auto') {
      const engine = this.engines.get(engineId);
      this.host.log.info(`Auto-approved: ${event.request.title}`);
      void engine?.replyPermission?.(event.request.sessionId, event.request.id, 'once').catch((e) => this.host.log.warn(`auto-approve: ${errorMessage(e)}`));
      return;
    }
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
      case 'session.status': {
        if (event.sessionId !== this.state.sessionId) return;
        const ended = this.state.activity !== 'idle' && event.activity === 'idle';
        const last = this.state.messages[this.state.messages.length - 1];
        // A turn that was stopped, or ended in an error, can be sent again with one click.
        const canRetry = ended ? this.stopRequested || (last?.role === 'assistant' && !!last.error) : event.activity === 'idle' ? this.state.canRetry : false;
        if (ended) this.stopRequested = false;
        this.set({ activity: event.activity, activityDetail: event.detail, canRetry });
        // A failed reply may mean the login expired: show the sign-in prompt if so.
        if (ended && last?.role === 'assistant' && last.error && this.engine.account) void this.refreshAuth();
        // A long-lived window: look for new models now and then, when a reply has just finished.
        if (ended) this.recheckModels(this.catalogMaxAgeMs);
        return;
      }
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

  private async deleteOtherSession(engineId: EngineId, sessionId: string): Promise<void> {
    const engine = this.engines.get(engineId);
    const s = this.state.otherSessions.find((x) => x.id === sessionId);
    if (!engine || !(await this.host.confirm(`Delete session "${s?.title ?? sessionId}"? This cannot be undone.`, 'Delete'))) return;
    await this.guard('Could not delete the session', () => engine.deleteSession(sessionId));
    await this.refreshOtherSessions();
  }

  async pickSession(): Promise<void> {
    await this.host.focusView();
    this.openPanel('sessions');
  }

  /* -------------------------------------------------------------- engines */

  async setEngine(engine: EngineId): Promise<void> {
    if (!this.engines.has(engine) || engine === this.state.engine) return;
    this.set({ engine, capabilities: this.engines.get(engine)!.capabilities, sessions: [], sessionId: undefined, messages: [], permissions: [], questions: [], providers: [], agents: [], mcp: [], model: undefined, effort: undefined, agent: undefined, activity: 'idle', sessionUsage: undefined, commands: mergeCommands([]), canRetry: false, recentModels: [], auth: undefined });
    this.stopSignInWait();
    await this.host.state.update('engine', engine);
    await this.activate();
  }

  async pickEngine(): Promise<void> {
    const picked = await this.host.pick<EngineId>(
      // Engines that sign in with a subscription first; API keys (Direct BYOK) last.
      [...this.state.engines].sort((a, b) => ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine)).map((s) => ({
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
    const same = (m: ModelRef) => m.providerId === model.providerId && m.modelId === model.modelId;
    const recentModels = [model, ...this.state.recentModels.filter((m) => !same(m))].slice(0, MAX_RECENT_MODELS);
    // The effort level is kept per engine; a model without that level falls back to its own default.
    this.set({ model, recentModels, effort: resolveEffort(this.host.state.get<string>(`effort.${this.state.engine}`), findModel(this.state.providers, model)) });
    await this.host.state.update(`model.${this.state.engine}`, model);
    await this.host.state.update(`recentModels.${this.state.engine}`, recentModels);
  }

  /** The model the chat is set to, with what its engine reports about it. */
  private currentModel(): ModelInfo | undefined {
    return findModel(this.state.providers, this.state.model);
  }

  /** Choose how hard the model thinks; `undefined` goes back to the model's own default. */
  async setEffort(effort: string | undefined): Promise<void> {
    const model = this.currentModel();
    if (effort !== undefined && !model?.efforts?.some((e) => e.id === effort)) {
      this.notify('warn', model?.efforts?.length ? `${model.name} has no "${effort}" effort level. It has: ${model.efforts.map((e) => effortLabel(e.id)).join(', ')}.` : NO_EFFORT);
      return;
    }
    this.set({ effort });
    await this.host.state.update(`effort.${this.state.engine}`, effort);
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

  /** The editor's active file changed (or its selection did). Shown as a one-click chip. */
  setActiveFile(file: ViewState['activeFile']): void {
    const a = this.state.activeFile;
    if (a?.path === file?.path && a?.selection?.startLine === file?.selection?.startLine && a?.selection?.endLine === file?.selection?.endLine) return;
    this.set({ activeFile: file });
  }

  /** Attach the file open in the editor, or just its selected lines. */
  async addActiveFile(): Promise<void> {
    const att = this.host.activeFileAttachment();
    if (!att) return this.notify('info', 'Open a file in the editor first.');
    if (att.kind === 'selection') return this.addAttachment(att);
    if (att.path) return this.addPaths([att.path]);
  }

  addAttachment(attachment: Attachment): void {
    if (isImageMime(attachment.mime) && !this.state.capabilities.images) {
      this.notify('warn', `${ENGINE_LABELS[this.state.engine]} does not accept images.`);
      return;
    }
    this.set({ attachments: [...this.state.attachments, { ...attachment, id: attachment.id || newId('att') }] });
  }

  /**
   * Add a condensed copy of another session to the next message, so a new chat can build on
   * an old one. Nothing is carried over unless the user asks for it here.
   */
  async attachSession(sessionId: string, engineId: EngineId = this.state.engine): Promise<void> {
    const engine = this.engines.get(engineId);
    if (!engine) return;
    if (engineId === this.state.engine && sessionId === this.state.sessionId) return this.notify('info', 'That is the session you are in: the model already has it.');
    const info = [...this.state.sessions, ...this.state.otherSessions].find((x) => x.id === sessionId && x.engine === engineId);
    const messages = await this.guard('Could not read that session', () => engine.getMessages(sessionId));
    if (!messages) return;
    const title = info?.title ?? 'Earlier session';
    const digest = sessionDigest(title, ENGINE_LABELS[engineId], messages);
    if (digest.total === 0) return this.notify('warn', `"${title}" has no messages to carry over.`);
    this.addAttachment({ id: '', kind: 'file', name: `Session: ${title}`, mime: 'text/markdown', text: digest.text, size: digest.text.length });
    this.notify('info', `Added "${title}" as context for your next message${digest.included < digest.total ? ` (condensed: ${digest.included} of ${digest.total} messages)` : ''}.`);
  }

  /** `/context`: choose a saved session, from any engine, to carry into this chat. */
  async pickSessionContext(query = ''): Promise<void> {
    await this.refreshOtherSessions().catch(() => undefined);
    const all = [...this.state.sessions, ...this.state.otherSessions].filter((x) => !(x.engine === this.state.engine && x.id === this.state.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt);
    if (all.length === 0) return this.notify('info', 'There is no other saved session to bring in yet.');
    const q = query.toLowerCase();
    const matches = q ? all.filter((x) => x.title.toLowerCase().includes(q)) : [];
    const chosen = matches.length === 1 ? matches[0] : await this.host.pick(all.map((x) => ({ label: x.title, description: ENGINE_LABELS[x.engine], detail: new Date(x.updatedAt).toLocaleString(), value: x })), { title: 'OpenCode Hub: Add a session as context', placeholder: 'A condensed copy is attached to your next message' });
    if (chosen) await this.attachSession(chosen.id, chosen.engine);
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
    if (engine.account && this.state.auth?.signedIn === false) {
      const account = engine.account;
      this.notify('warn', account.mode() === 'apiKey' ? `Add an API key for ${ENGINE_LABELS[engine.id]} first, or sign in with your ${account.accountName} account (/login).` : `Sign in with your ${account.accountName} account first (/login).`);
      return;
    }
    if (!this.state.model) await this.refreshCatalog();
    if (!this.state.model) {
      this.notify('warn', engine.id === 'direct' || engine.id === 'opencode' ? 'No model available. Use /providers to sign in with a subscription (or add an API key), then pick a model.' : 'No model available for this engine.');
      return;
    }
    const sessionId = await this.ensureSession();
    if (!sessionId) return;
    const input: PromptInput = { text, attachments: this.state.attachments, model: this.state.model, agent: this.state.agent, effort: resolveEffort(this.state.effort, this.currentModel()) };
    this.stopRequested = false;
    this.set({ attachments: [], activity: 'busy', activityDetail: undefined, canRetry: false });
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
    if (!this.state.sessionId) return;
    if (this.state.activity !== 'idle') this.stopRequested = true;
    await this.guard('Could not stop', () => this.engine.abort(this.state.sessionId!));
  }

  /** Send the last user message again, after a reply that failed or was stopped. */
  async retry(): Promise<void> {
    if (this.state.activity !== 'idle') return;
    const lastUser = [...this.state.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
    if (!text) {
      this.notify('warn', 'There is no message to send again.');
      return;
    }
    await this.send(text);
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
      case 'doctor':
        return this.doctor();
      case 'feedback': {
        const first = args.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
        if (first === 'link' && args.trim().toLowerCase() === 'link') return this.copyFeedbackLink();
        const kind = first === 'bug' || first === 'idea' || first === 'other' ? first : undefined;
        return this.openFeedback(kind, kind ? args.slice(first.length).trim() : args);
      }
      case 'stop':
        return this.abort();
      case 'attach':
        return this.pickFiles();
      case 'context':
        return this.pickSessionContext(args);
      case 'providers':
        return this.manageProviders();
      case 'login':
        return this.accountMenu();
      case 'auto':
        return this.setApprovals(args.toLowerCase() === 'off' ? 'ask' : 'auto');
      case 'ask':
        return this.setApprovals('ask');
      case 'model': {
        if (!args) return this.openPanel('models');
        const q = args.toLowerCase();
        const all = this.state.providers.flatMap((p) => p.models);
        const match = all.find((m) => m.modelId.toLowerCase() === q || `${m.providerId}/${m.modelId}`.toLowerCase() === q) ?? all.find((m) => m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        if (!match) return this.notify('warn', `No model matches "${args}".`);
        await this.setModel({ providerId: match.providerId, modelId: match.modelId });
        return this.notify('info', `Model: ${match.name}`);
      }
      case 'effort': {
        const model = this.currentModel();
        const levels = model?.efforts ?? [];
        if (levels.length === 0) return this.notify('info', NO_EFFORT);
        const names = levels.map((e) => effortLabel(e.id).toLowerCase()).join(', ');
        const current = this.state.effort ? effortLabel(this.state.effort) : `default${model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : ''}`;
        if (!args) return this.notify('info', `Effort for ${model!.name}: ${current}. Levels: ${names}. Set one with /effort <level>; /effort default goes back to the model's own.`);
        if (/^(default|auto|reset)$/i.test(args)) {
          await this.setEffort(undefined);
          return this.notify('info', `Effort: the model's default${model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : ''}.`);
        }
        const match = matchEffort(args, levels);
        if (!match) return this.notify('warn', `${model!.name} has no "${args}" effort level. It has: ${names}.`);
        await this.setEffort(match.id);
        return this.notify('info', `Effort: ${effortLabel(match.id)}${isCostlyEffort(match.id) ? '. This level uses your limits much faster.' : ''}`);
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
    this.set({ avatar: { enabled: this.host.config<boolean>('avatar.enabled', true), style: avatarStyle(this.host.config<string>('avatar.style', 'buddy')) }, zoom: clampZoom(this.host.config<number>('chat.zoom', 1)), providerColors: this.host.config<boolean>('chat.providerColors', true) !== false, trusted: this.host.workspaceTrusted(), approvals: approvalMode(this.host.config<string>('approvals', 'ask')) });
    if (providersChanged && (this.state.engine === 'direct' || this.state.engine === 'vscode-lm')) this.debounce('config', 400, () => void this.restartEngine());
  }

  showPanel(name: 'mcp' | 'usage' | 'sessions' | 'models' | 'feedback'): void {
    if (name === 'feedback') return this.openFeedback();
    if (name === 'mcp') void this.refreshMcp();
    if (name === 'usage') this.pushUsage();
    this.openPanel(name);
  }

  /* ------------------------------------------------- feedback & diagnostics */

  /** Versions, platform and engine states: what a report needs, with nothing personal in it. */
  diagnostics(): string {
    const s = this.state;
    return diagnosticsMarkdown({
      env: this.host.environment(),
      engine: s.engine,
      engines: [...this.engines.values()].map((e) => e.status()),
      model: s.model,
      approvals: s.approvals,
      avatar: { ...s.avatar, renderer: this.avatarRenderer },
      trusted: s.trusted,
    });
  }

  /** Show the feedback form, optionally started with a kind and some text. */
  openFeedback(kind?: FeedbackKind, text?: string): void {
    this.set({ diagnostics: this.diagnostics(), feedbackDraft: kind || text ? { kind: kind ?? 'bug', text: text ?? '' } : undefined });
    this.openPanel('feedback');
  }

  /**
   * Open a pre-filled issue on GitHub in the user's browser. They review it there and press
   * Submit themselves; the extension sends nothing on its own.
   */
  async submitFeedback(input: { kind: FeedbackKind; title: string; description: string; includeDiagnostics: boolean; copyLink?: boolean }): Promise<void> {
    const slug = this.host.repository();
    if (!slug) return this.notify('error', 'This build does not say where its GitHub repository is, so feedback cannot be opened.');
    const description = input.description.trim();
    if (!description && !input.title.trim()) return this.notify('warn', 'Write a few words first.');
    const url = buildIssueUrl(slug, { kind: feedbackKind(input.kind), title: input.title, description, diagnostics: input.includeDiagnostics ? this.diagnostics() : '' });
    this.lastFeedbackUrl = url;
    this.set({ feedbackDraft: undefined });
    if (input.copyLink) return this.copyFeedbackLink();
    if ((await this.guard('Could not open GitHub', () => this.host.openExternal(url).then(() => true))) !== true) return;
    // A card that stays in the chat: GitHub's own error says nothing about why it refused.
    this.localMessage(
      [
        '**Your feedback is open on GitHub.** Review it there and press **Create**.',
        '',
        `If GitHub answers *Unable to create issue*, that browser is signed in with a company-managed GitHub account (the page says "Users managed by …"). GitHub does not let those accounts post outside their company. Use a personal GitHub account instead: \`/feedback link\` copies the pre-filled link, to paste into a private window or another browser. Or [open it again](${url}).`,
      ].join('\n'),
    );
  }

  /** Copy the link of the last feedback, to open where another GitHub account is signed in. */
  private async copyFeedbackLink(): Promise<void> {
    if (!this.lastFeedbackUrl) return this.notify('info', 'There is no feedback link yet. Type /feedback and fill in the form first.');
    await this.host.copy(this.lastFeedbackUrl);
    this.notify('info', 'Link copied. Paste it into a browser or private window where you are signed in to GitHub with a personal account.');
  }


  /** `/doctor`: what is installed and working, shown in the chat. Nothing leaves the machine. */
  private doctor(): void {
    const env = this.host.environment();
    const statuses = [...this.engines.values()].map((e) => e.status());
    const mark = (state: string) => (state === 'ready' ? 'ready' : state === 'idle' ? 'not started' : state);
    const rows = statuses.map((st) => `| ${ENGINE_LABELS[st.engine]}${st.engine === this.state.engine ? ' (active)' : ''} | ${mark(st.state)} | ${st.version ?? ''} | ${(st.detail ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`);
    const mcpOn = this.state.mcp.filter((m) => m.status === 'connected').length;
    this.localMessage(
      [
        '**OpenCode Hub doctor**',
        '',
        `- Version: ${env.extensionVersion}`,
        `- Editor: ${env.editor} (${env.ui}${env.remote ? `, remote: ${env.remote}` : ''})`,
        `- OS: ${osLabel(env)}`,
        `- Workspace: ${this.host.cwd() ? (this.state.trusted ? 'trusted' : 'not trusted, so engines stay off') : 'no folder open'}`,
        `- Model: ${this.state.model ? `${this.state.model.providerId}/${this.state.model.modelId}` : 'none selected'}`,
        `- MCP servers: ${mcpOn} of ${this.state.mcp.length} connected`,
        `- Companion: ${this.state.avatar.enabled ? `${this.state.avatar.style}${this.avatarRenderer ? ` (${this.avatarRenderer})` : ''}` : 'off'}`,
        '',
        '| Engine | State | Version | Detail |',
        '|---|---|---|---|',
        ...rows,
        '',
        'Engines that are "not started" are checked when you switch to them (`/engine`). If a CLI is installed but not found, set its path in settings, then run *OpenCode Hub: Restart Active Engine*. `/feedback` reports a problem with these details attached.',
      ].join('\n'),
    );
  }

  /* ------------------------------------------------------------ providers */

  async manageProviders(): Promise<void> {
    if (this.engine.account) return this.accountMenu();
    if (this.state.engine === 'opencode' && this.engine.status().state === 'ready') {
      // A subscription first; an API key (billed per token) only as the fallback.
      const choice = await this.host.pick(
        [
          { label: '$(sign-in) Sign in with a subscription…', description: 'recommended', detail: 'ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo and other plans opencode supports. No per-token charges.', value: 'login' as const },
          { label: '$(key) Use an API key instead…', description: 'billed per token', detail: 'For providers without a subscription sign-in. Stored by opencode (auth.json).', value: 'key' as const },
          { label: '$(settings-gear) Manage Direct BYOK providers (no opencode needed)…', value: 'direct' as const },
        ],
        { title: 'OpenCode Hub: Connect opencode to a model provider' },
      );
      if (choice === 'login') return this.signInOpencode();
      if (choice === 'key') return this.connectOpencodeProvider();
      if (choice !== 'direct') return;
    }
    await this.manageDirectProviders();
  }

  /** Providers opencode can connect, with their sign-in methods (subscriptions are `oauth`). */
  private async opencodeProviders(): Promise<ProviderInfo[] | undefined> {
    const engine = this.engine as Engine & { listConnectableProviders?: () => Promise<ProviderInfo[]> };
    if (!engine.listConnectableProviders) return undefined;
    return this.guard('Could not list providers', () => engine.listConnectableProviders!());
  }

  /** Run `opencode auth login` in a terminal, straight to one provider's subscription sign-in when chosen. */
  private runOpencodeLogin(target?: { provider: string; method: string }): void {
    const exe = quoteIfNeeded(this.host.config<string>('opencode.path', '') || 'opencode');
    const args = target ? ` -p ${target.provider} -m "${target.method.replace(/"/g, '')}"` : '';
    this.host.runInTerminal('opencode auth', `${exe} auth login${args}`);
    this.notify('info', 'Finish signing in in the terminal. The new models show up here by themselves.');
  }

  /** Pick a subscription sign-in (ChatGPT, Copilot, …) and run it in a terminal. */
  private async signInOpencode(): Promise<void> {
    const providers = (await this.opencodeProviders()) ?? [];
    type Target = { provider: string; method: string } | 'other';
    const order = ['openai', 'github-copilot', 'anthropic', 'google', 'gitlab'];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    const items: PickItem<Target>[] = providers
      .flatMap((p) => (p.authMethods ?? []).filter((m) => m.type === 'oauth').map((m) => ({ p, m })))
      .sort((x, y) => rank(x.p.id) - rank(y.p.id) || x.p.name.localeCompare(y.p.name))
      .map(({ p, m }) => ({ label: `$(sign-in) ${p.name}`, description: p.connected ? `${m.label} · signed in` : m.label, value: { provider: p.id, method: m.label } }));
    items.push({ label: '$(terminal) Another provider…', detail: 'Choose in the terminal from everything opencode supports.', value: 'other' });
    const target = await this.host.pick(items, { title: 'Sign in to opencode with a subscription', placeholder: 'Your plan is used: no API key, no per-token charges' });
    if (!target) return;
    this.runOpencodeLogin(target === 'other' ? undefined : target);
  }


  /* -------------------------------------------------------------- account */

  /** Sign-in options of the active engine; engines without their own account show the provider options. */
  async accountMenu(): Promise<void> {
    const engine = this.engine;
    const account = engine.account;
    if (!account) {
      if (engine.id === 'opencode' && engine.status().state === 'ready') return this.manageProviders();
      if (engine.id === 'direct') return this.manageDirectProviders();
      return this.notify('info', `${ENGINE_LABELS[engine.id]} signs in through VS Code. Use /engine to pick another engine.`);
    }
    const status = (await this.refreshAuth()) ?? this.state.auth;
    const mode = account.mode();
    const hasKey = !!(await this.host.secrets.get(account.secretKey));
    const plan = engine.id === 'claude-code' ? 'Claude Pro or Max plan' : 'ChatGPT Plus, Pro or Team plan';
    type Action = 'signIn' | 'device' | 'apiKey' | 'useAccount' | 'removeKey' | 'signOut';
    const items: PickItem<Action>[] = [
      { label: `$(sign-in) Sign in with your ${account.accountName} account`, description: mode === 'subscription' && status?.signedIn && status.billing !== 'apiKey' ? 'signed in' : 'recommended', detail: `Uses your ${plan}. No per-token API charges. Opens the browser.`, value: 'signIn' },
    ];
    if (engine.id === 'codex') items.push({ label: '$(device-mobile) Sign in with a device code', detail: 'For remote, SSH, WSL or container setups where the browser cannot reach this machine.', value: 'device' });
    if (mode === 'apiKey') items.push({ label: `$(account) Use my ${account.accountName} account again`, detail: 'Stop using the API key and bill your subscription.', value: 'useAccount' });
    items.push({ label: `$(key) ${hasKey ? 'Replace the API key' : 'Use an API key instead'}`, description: mode === 'apiKey' ? 'in use' : undefined, detail: `Billed per token by ${engine.id === 'claude-code' ? 'Anthropic' : 'OpenAI'}, usually far more than a subscription. Stored in VS Code Secret Storage.`, value: 'apiKey' });
    if (hasKey) items.push({ label: '$(trash) Remove the stored API key', value: 'removeKey' });
    if (mode === 'subscription' && status?.signedIn) items.push({ label: `$(sign-out) Sign out of ${account.accountName}`, detail: 'Signs the CLI out on this computer (also outside VS Code).', value: 'signOut' });
    const now = status?.signedIn ? status.label ?? 'signed in' : status?.signedIn === false ? 'not signed in' : 'sign-in status unknown';
    const action = await this.host.pick(items, { title: `${ENGINE_LABELS[engine.id]}: ${now}` });
    switch (action) {
      case 'signIn':
        return this.signIn(false);
      case 'device':
        return this.signIn(true);
      case 'apiKey':
        return this.useApiKey();
      case 'useAccount':
        await this.host.updateConfig(account.modeSetting, 'subscription');
        await this.refreshAuth();
        if (this.state.auth?.signedIn === false) return this.signIn(false);
        return this.notify('info', `${ENGINE_LABELS[engine.id]} now uses your ${account.accountName} account.`);
      case 'removeKey':
        await this.host.secrets.delete(account.secretKey);
        if (mode === 'apiKey') await this.host.updateConfig(account.modeSetting, 'subscription');
        await this.refreshAuth();
        return this.notify('info', 'API key removed.');
      case 'signOut':
        this.host.runInTerminal(`${ENGINE_LABELS[engine.id]} sign-out`, account.logoutCommand());
        this.debounce('auth', 4000, () => void this.refreshAuth());
        return;
      default:
        return;
    }
  }

  /** Sign in with the engine's own account (Claude / ChatGPT) in a terminal, then wait for it to finish. */
  async signIn(deviceCode = false): Promise<void> {
    const engine = this.engine;
    const account = engine.account;
    if (!account) return this.accountMenu();
    if (engine.status().state !== 'ready') return this.notify('warn', engine.status().detail ?? `${ENGINE_LABELS[engine.id]} is not available.`);
    if (account.mode() !== 'subscription') await this.host.updateConfig(account.modeSetting, 'subscription');
    this.host.runInTerminal(`${ENGINE_LABELS[engine.id]} sign-in`, account.loginCommand({ deviceCode }));
    this.notify('info', `Finish signing in with your ${account.accountName} account in the browser. The chat picks it up by itself.`);
    this.waitForSignIn(engine.id);
  }

  /** Store an API key for the active engine and switch it to API-key mode. */
  async useApiKey(): Promise<void> {
    const engine = this.engine;
    const account = engine.account;
    if (!account) return this.manageProviders();
    const key = await this.host.input({
      title: `${ENGINE_LABELS[engine.id]}: API key`,
      prompt: `Billed per token by ${engine.id === 'claude-code' ? 'Anthropic' : 'OpenAI'}. Stored in VS Code Secret Storage, never in settings. You can switch back to your ${account.accountName} account with /login.`,
      password: true,
      placeholder: engine.id === 'claude-code' ? 'sk-ant-…' : 'sk-…',
    });
    if (!key?.trim()) return;
    await this.host.secrets.set(account.secretKey, key.trim());
    await this.host.updateConfig(account.modeSetting, 'apiKey');
    this.stopSignInWait();
    await this.refreshAuth();
    this.invalidateModels();
    void this.refreshCatalog();
    this.notify('info', `${ENGINE_LABELS[engine.id]} now uses your API key.`);
  }

  private waitForSignIn(engineId: EngineId): void {
    this.stopSignInWait();
    this.signInPending = engineId;
    // Signing in again while signed in (another account, an upgraded plan): the first check
    // would still see the old account, so wait for a change instead of stopping at once.
    const startedAs = this.state.auth?.signedIn && this.state.auth.billing !== 'apiKey' ? authIdentity(this.state.auth) : undefined;
    if (this.state.auth) this.set({ auth: { ...this.state.auth, pending: true } });
    const started = Date.now();
    const tick = async () => {
      this.signInTimer = undefined;
      if (this.signInPending !== engineId || this.state.engine !== engineId) return;
      const status = await this.refreshAuth();
      if (this.signInPending !== engineId) return;
      const signedIn = !!status?.signedIn && status.billing !== 'apiKey';
      const sameAsBefore = signedIn && startedAs !== undefined && authIdentity(status!) === startedAs;
      // The same account after two minutes: the user signed in again as themselves. Done, quietly.
      if (signedIn && (!sameAsBefore || Date.now() - started > 120_000)) {
        this.stopSignInWait();
        this.set({ auth: { ...status!, pending: undefined } });
        if (!sameAsBefore) this.notify('info', `Signed in${status!.label ? `: ${status!.label}` : ''}.`);
        this.relistModels();
        return;
      }
      if (Date.now() - started > 10 * 60_000) {
        this.stopSignInWait();
        if (this.state.auth) this.set({ auth: { ...this.state.auth, pending: undefined } });
        return;
      }
      this.signInTimer = setTimeout(() => void tick(), 2500);
    };
    this.signInTimer = setTimeout(() => void tick(), 2500);
  }


  private stopSignInWait(): void {
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.signInTimer = undefined;
    this.signInPending = undefined;
  }

  /** Ask before tools run, or proceed without asking. Switching to auto also approves what is waiting. */
  async setApprovals(mode: ApprovalMode): Promise<void> {
    const changed = mode !== this.state.approvals;
    this.set({ approvals: mode });
    await this.host.updateConfig('approvals', mode);
    if (mode === 'auto') {
      const waiting = this.state.permissions;
      if (waiting.length) this.set({ permissions: [] });
      for (const p of waiting) await this.guard('Could not approve', async () => this.engine.replyPermission?.(p.sessionId, p.id, 'once'));
    }
    if (changed) this.notify('info', mode === 'auto' ? 'Auto mode: the agent proceeds without asking. /ask switches back.' : 'Ask mode: the agent asks before running tools and changing files.');
  }

  /** The sign-in setting of an engine changed outside the chat. */
  onAuthConfigChanged(): void {
    if (!this.engine.account) return;
    this.invalidateModels();
    this.debounce('auth', 200, () => void Promise.all([this.refreshAuth(), this.refreshCatalog()]));
  }

  /**
   * Add a model by its name for an engine whose CLI takes any model id (Claude Code, Codex):
   * an older version, a preview, anything the CLI's own list leaves out.
   */
  async addCustomModel(): Promise<void> {
    const engine = this.engine;
    const setting = engine.id === 'claude-code' ? 'claudeCode.models' : engine.id === 'codex' ? 'codex.models' : undefined;
    if (!setting) return this.manageProviders();
    const example = engine.id === 'claude-code' ? 'for example claude-opus-5 or claude-sonnet-4-6' : 'for example gpt-5.1-codex';
    const typed = await this.host.input({ title: `${ENGINE_LABELS[engine.id]}: add a model by name`, placeholder: `The model id or alias, ${example}`, prompt: `Passed to the ${engine.id === 'claude-code' ? 'claude' : 'codex'} CLI as --model. If your plan does not include it, the reply will say so.` });
    const id = typed?.trim();
    if (!id) return;
    if (!/^[\w.:[\]/@-]{1,120}$/.test(id)) return this.notify('warn', 'A model name has no spaces: letters, digits, and - . _ : / [ ] only.');
    const current = this.host.config<string[]>(setting, []);
    const list = Array.isArray(current) ? current.filter((x) => typeof x === 'string') : [];
    if (!list.includes(id)) await this.host.updateConfig(setting, [...list, id]);
    await this.refreshCatalog();
    const found = this.state.providers.flatMap((p) => p.models).find((m) => m.modelId === id || m.resolvedId === id);
    if (found) await this.setModel({ providerId: found.providerId, modelId: found.modelId });
    this.notify('info', `${id} added. Remove it under "opencodeHub.${setting}" in settings.`);
  }

  /** Models depend on the account (plan) the engine is signed in with. */
  private invalidateModels(): void {
    const engine = this.engine as Engine & { invalidateModels?: () => void };
    if (engine.account) engine.invalidateModels?.();
  }

  private async connectOpencodeProvider(): Promise<void> {
    const engine = this.engine;
    if (!engine.setProviderApiKey) return;
    const providers = await this.opencodeProviders();
    if (!providers) return;
    const hasPlan = (p: ProviderInfo) => (p.authMethods ?? []).some((m) => m.type === 'oauth');
    const provider = await this.host.pick(providers.map((p) => ({ label: p.name, description: [p.connected ? 'connected' : p.id, hasPlan(p) ? 'subscription sign-in available' : ''].filter(Boolean).join(' · '), value: p })), { title: 'Connect provider', placeholder: 'Search 75+ providers…' });
    if (!provider) return;
    // The provider has a subscription sign-in: offer it before the key.
    const plan = (provider.authMethods ?? []).find((m) => m.type === 'oauth');
    if (plan) {
      const how = await this.host.pick(
        [
          { label: `$(sign-in) ${plan.label}`, description: 'recommended', detail: 'Uses your plan. No per-token charges. Opens a terminal and the browser.', value: 'plan' as const },
          { label: '$(key) Paste an API key', description: 'billed per token', value: 'key' as const },
        ],
        { title: `Connect ${provider.name}` },
      );
      if (!how) return;
      if (how === 'plan') return this.runOpencodeLogin({ provider: provider.id, method: plan.label });
    }
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
    type Choice = { kind: 'subscription' } | { kind: 'existing'; id: string } | { kind: 'preset'; id: string } | { kind: 'custom'; type: 'openai-compatible' | 'anthropic' };
    const items: PickItem<Choice>[] = [{ label: '$(sign-in) Use a subscription instead…', description: 'recommended', detail: 'Claude Code (Claude plan), Codex (ChatGPT plan), opencode (ChatGPT, Copilot and more) or Copilot sign in with your plan. No per-token charges.', value: { kind: 'subscription' } }];
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
    if (choice.kind === 'subscription') return this.pickEngine();

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
      let baseUrl = preset.baseUrl;
      if (preset.askBaseUrl) {
        const url = await this.host.input({ title: `${preset.name}: URL`, prompt: `The endpoint's OpenAI-compatible base URL, e.g. ${preset.baseUrl}`, placeholder: preset.baseUrl });
        if (!url?.trim() || url.includes('<')) return;
        baseUrl = url.trim().replace(/\/+$/, '');
        if (!/\/v1$/.test(baseUrl)) baseUrl += '/v1';
      }
      await this.host.updateConfig('providers', [...configured, { id: preset.id, name: preset.name, type: preset.type, baseUrl }]);
      if (!preset.keyless) await this.promptKey(preset.id, preset.name, preset.keyHint);
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

  private async promptKey(id: string, name: string, hint?: string): Promise<void> {
    const key = await this.host.input({ title: `API key for ${name}`, prompt: `${hint ? `${hint}. ` : ''}Stored in VS Code Secret Storage (your OS keychain), never in settings.`, password: true, placeholder: 'Paste the API key' });
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
      case 'retry':
        return this.retry();
      case 'newSession':
        return this.newSession();
      case 'switchSession':
        return this.openAnySession(msg.sessionId, msg.engine);
      case 'deleteSession':
        if (msg.engine && msg.engine !== this.state.engine) return this.deleteOtherSession(msg.engine, msg.sessionId);
        return this.deleteSession(msg.sessionId);
      case 'sessionsRefresh':
        return this.refreshOtherSessions();
      case 'renameSession':
        await this.guard('Could not rename', () => this.engine.renameSession(msg.sessionId, msg.title));
        return this.refreshSessions();
      case 'setEngine':
        return this.setEngine(msg.engine);
      case 'setModel':
        return this.setModel(msg.model);
      case 'setEffort':
        return this.setEffort(msg.effort ?? undefined);
      case 'modelsShown':
        return this.modelsShown();
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
      case 'signIn':
        return this.signIn(!!msg.deviceCode);
      case 'useApiKey':
        return this.useApiKey();
      case 'accountMenu':
        return this.accountMenu();
      case 'setApprovals':
        return this.setApprovals(msg.mode === 'auto' ? 'auto' : 'ask');
      case 'restartEngine':
        return this.restartEngine();
      case 'attachSession':
        return this.attachSession(msg.sessionId, msg.engine);
      case 'addModel':
        return this.addCustomModel();
      case 'dismissMessage':
        // Only the extension's own messages; replies from a model belong to the session.
        if (typeof msg.id === 'string' && msg.id.startsWith('local_')) this.set({ messages: this.state.messages.filter((m) => m.id !== msg.id) });
        return;
      case 'addActiveFile':
        return this.addActiveFile();
      case 'openFeedback':
        return this.openFeedback(msg.kind ? feedbackKind(msg.kind) : undefined);
      case 'feedback':
        return this.submitFeedback({ kind: feedbackKind(msg.kind), title: String(msg.title ?? ''), description: String(msg.description ?? ''), includeDiagnostics: msg.includeDiagnostics !== false, copyLink: msg.copyLink === true });
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

/** Who is signed in and how it is paid for: a change means another list of models. */
function authIdentity(status: AuthStatus): string {
  return `${status.signedIn ? 'in' : 'out'}|${status.billing ?? ''}|${status.label ?? ''}`;
}

const ENGINE_ORDER: EngineId[] = ['opencode', 'claude-code', 'codex', 'vscode-lm', 'direct'];

const ENGINE_DETAILS: Record<EngineId, string> = {
  opencode: 'Sign in with ChatGPT, GitHub Copilot or another plan, or use any opencode provider. Agents, commands, MCP, undo, share',
  'claude-code': 'Your Claude Code CLI, signed in with your Claude plan (Pro / Max). API key optional.',
  codex: 'Your Codex CLI, signed in with your ChatGPT plan (Plus / Pro). API key optional.',
  'vscode-lm': 'GitHub Copilot (your Copilot plan) and other models exposed through VS Code',
  direct: 'API keys only, billed per token: OpenAI, Anthropic, OpenRouter, or a local model (Ollama, LM Studio)',
};

/** Accepts the pre-release style names too. */
function avatarStyle(value: string): AvatarStyle {
  return value === 'dots' || value === 'orb' ? 'dots' : 'buddy';
}

const MAX_RECENT_MODELS = 5;

const NO_EFFORT = 'This model has no effort setting. For a model that has one, an effort button appears next to the model name.';

function findModel(providers: ProviderInfo[], ref: ModelRef | undefined): ModelInfo | undefined {
  if (!ref) return undefined;
  return providers.find((p) => p.id === ref.providerId)?.models.find((m) => m.modelId === ref.modelId);
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
