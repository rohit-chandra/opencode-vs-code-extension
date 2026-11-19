import type {
  AgentInfo,
  AuthMode,
  AuthStatus,
  ChatMessage,
  EngineCapabilities,
  EngineEvent,
  EngineId,
  EngineStatus,
  McpServerInfo,
  ModelRef,
  PermissionReply,
  PromptInput,
  ProviderInfo,
  SessionActivity,
  SessionInfo,
  SlashCommand,
} from '../shared/types';
import type { Disposable } from './emitter';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Everything an engine needs from its host. Implemented with VS Code APIs in production and plain objects in tests. */
export interface EngineContext {
  log: Logger;
  /** Workspace folder the agent should work in. */
  cwd(): string | undefined;
  /** Read an `opencodeHub.*` setting. */
  config<T>(key: string, fallback: T): T;
  secrets: SecretStore;
  /** Directory for extension-owned files (sessions of local engines). */
  storageDir: string;
  /** Environment for spawned processes and API-key fallbacks (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface Engine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  onEvent(listener: (event: EngineEvent) => void): Disposable;
  status(): EngineStatus;
  /** Idempotent. Resolves when the engine is usable or definitively unavailable. */
  start(): Promise<EngineStatus>;
  restart(): Promise<EngineStatus>;
  dispose(): Promise<void>;

  listSessions(): Promise<SessionInfo[]>;
  createSession(title?: string): Promise<SessionInfo>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;

  listProviders(): Promise<ProviderInfo[]>;
  defaultModel(): Promise<ModelRef | undefined>;
  listAgents(): Promise<AgentInfo[]>;
  listCommands(): Promise<SlashCommand[]>;

  sendPrompt(sessionId: string, input: PromptInput): Promise<void>;
  /** Run an engine-defined slash command. */
  runCommand(sessionId: string, name: string, args: string, input: PromptInput): Promise<void>;
  abort(sessionId: string): Promise<void>;

  listMcp(): Promise<McpServerInfo[]>;
  setMcpEnabled(name: string, enabled: boolean): Promise<void>;

  /** Whether a session is still working (it may have been started before this view opened it). */
  sessionActivity?(sessionId: string): Promise<SessionActivity>;
  replyPermission?(sessionId: string, requestId: string, reply: PermissionReply): Promise<void>;
  replyQuestion?(sessionId: string, requestId: string, answers: string[][] | null): Promise<void>;
  forkSession?(sessionId: string, messageId?: string): Promise<SessionInfo>;
  shareSession?(sessionId: string, share: boolean): Promise<SessionInfo>;
  compactSession?(sessionId: string, model?: ModelRef): Promise<void>;
  undo?(sessionId: string): Promise<void>;
  redo?(sessionId: string): Promise<void>;
  /** opencode only: store an API key for one of its providers. */
  setProviderApiKey?(providerId: string, apiKey: string): Promise<void>;
  /** Engines whose CLI has its own account (Claude Code, Codex). */
  account?: EngineAccount;
}

/** Sign-in for engines that drive a CLI with its own account (Claude Code, Codex). */
export interface EngineAccount {
  /** Display name of the account, e.g. "Claude" or "ChatGPT". */
  readonly accountName: string;
  /** Settings key (under `opencodeHub.`) that holds the chosen `AuthMode`. */
  readonly modeSetting: string;
  mode(): AuthMode;
  status(): Promise<AuthStatus>;
  /** Shell command that signs in with the account in a terminal (opens the browser). */
  loginCommand(options?: { deviceCode?: boolean }): string;
  logoutCommand(): string;
  /** Secret Storage key of the API key used in `apiKey` mode. */
  readonly secretKey: string;
}

export class EngineError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
