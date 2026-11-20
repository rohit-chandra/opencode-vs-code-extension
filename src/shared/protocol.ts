import type { FeedbackKind } from './feedback';
import type {
  AgentInfo,
  ApprovalMode,
  Attachment,
  AuthStatus,
  ChatMessage,
  EngineCapabilities,
  EngineEvent,
  EngineId,
  EngineStatus,
  McpServerInfo,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProviderInfo,
  QuestionRequest,
  SessionActivity,
  SessionInfo,
  SessionUsage,
  SlashCommand,
  UsageSummary,
} from './types';

export type AvatarStyle = 'buddy' | 'dots';

/** Everything the chat view renders. The host owns it; the webview holds a mirror. */
export interface ViewState {
  engine: EngineId;
  engines: EngineStatus[];
  capabilities: EngineCapabilities;
  sessions: SessionInfo[];
  /** Saved sessions of the other engines in this workspace, so the history shows everything. */
  otherSessions: SessionInfo[];
  sessionId: string | undefined;
  messages: ChatMessage[];
  activity: SessionActivity;
  activityDetail: string | undefined;
  providers: ProviderInfo[];
  model: ModelRef | undefined;
  /** Thinking effort chosen for the model (one of its `efforts`); undefined means the model's default. */
  effort: string | undefined;
  agents: AgentInfo[];
  agent: string | undefined;
  commands: SlashCommand[];
  mcp: McpServerInfo[];
  attachments: Attachment[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  sessionUsage: SessionUsage | undefined;
  usage: UsageSummary | undefined;
  avatar: { enabled: boolean; style: AvatarStyle };
  /** Tint the chat's frame with the colour of the model's provider (Claude orange, OpenAI green, …). */
  providerColors: boolean;
  /** The file open in the editor (and its selected lines), offered as context with one click. */
  activeFile: { path: string; name: string; selection?: { startLine: number; endLine: number } } | undefined;
  /** Text scale of the chat (1 = VS Code's font size). */
  zoom: number;
  trusted: boolean;
  /** Bumped when the host wants the webview to open a panel (e.g. from a command). */
  /** The last turn failed or was stopped, so the chat offers to send the message again. */
  canRetry: boolean;
  /** Models picked lately for the active engine, newest first. */
  recentModels: ModelRef[];
  /** Account sign-in of the active engine (Claude Code, Codex); undefined for engines without one. */
  auth: AuthStatus | undefined;
  /** Ask before tools run (default), or proceed without asking. */
  approvals: ApprovalMode;
  panel: { name: 'none' | 'sessions' | 'mcp' | 'usage' | 'models' | 'feedback'; nonce: number };
  /** What the feedback form would attach: versions, OS and engine states. Filled when the form opens. */
  diagnostics: string;
  /** Kind and text the feedback form starts with (from `/feedback <text>` or "Report a problem"). */
  feedbackDraft: { kind: FeedbackKind; text: string } | undefined;
  notice: { level: 'info' | 'warn' | 'error'; text: string; nonce: number } | undefined;
  loading: boolean;
}

export type HostToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'patch'; patch: Partial<ViewState> }
  | { type: 'event'; event: EngineEvent }
  /** Streaming events coalesced by the host (one message per ~frame instead of one per token). */
  | { type: 'events'; events: EngineEvent[] }
  | { type: 'fileResults'; requestId: number; files: { path: string; relative: string }[] }
  | { type: 'insertText'; text: string }
  | { type: 'focusInput' }
  /** The view was shown or hidden; lets the webview pause animation while nobody can see it. */
  | { type: 'visible'; visible: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'abort' }
  | { type: 'retry' }
  | { type: 'newSession' }
  /** `engine`: a session of another engine; the chat switches to that engine first. */
  | { type: 'switchSession'; sessionId: string; engine?: EngineId }
  | { type: 'deleteSession'; sessionId: string; engine?: EngineId }
  /** The history panel opened: reload the other engines' sessions. */
  | { type: 'sessionsRefresh' }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'setEngine'; engine: EngineId }
  | { type: 'setModel'; model: ModelRef }
  | { type: 'setEffort'; effort: string | null }
  | { type: 'setAgent'; agent: string }
  | { type: 'pickFiles' }
  | { type: 'addAttachment'; attachment: Attachment }
  | { type: 'addPaths'; paths: string[] }
  | { type: 'removeAttachment'; id: string }
  | { type: 'searchFiles'; requestId: number; query: string }
  | { type: 'mcpToggle'; name: string; enabled: boolean }
  | { type: 'mcpRefresh' }
  | { type: 'permissionReply'; requestId: string; reply: PermissionReply }
  | { type: 'questionReply'; requestId: string; answers: string[][] | null }
  | { type: 'usageRefresh' }
  | { type: 'usageReset' }
  | { type: 'openFile'; path: string }
  | { type: 'openExternal'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'insertCode'; text: string }
  | { type: 'setAvatar'; enabled?: boolean; style?: AvatarStyle }
  | { type: 'moveView'; to: 'left' | 'right' | 'editor' }
  | { type: 'zoom'; delta: number }
  | { type: 'manageProviders' }
  /** Sign in with the engine's own account (Claude / ChatGPT), in a terminal. */
  | { type: 'signIn'; deviceCode?: boolean }
  /** Store an API key for the active engine and switch it to API-key mode. */
  | { type: 'useApiKey' }
  /** Account options: sign in, API key, sign out. */
  | { type: 'accountMenu' }
  | { type: 'setApprovals'; mode: ApprovalMode }
  | { type: 'restartEngine' }
  /** Attach a condensed copy of a saved session to the next message. */
  | { type: 'attachSession'; sessionId: string; engine?: EngineId }
  /** Close a message the extension wrote itself (/help, /doctor). */
  | { type: 'dismissMessage'; id: string }
  /** Attach the file open in the editor, or its selected lines. */
  | { type: 'addActiveFile' }
  /** Add a model by name (Claude Code, Codex). */
  | { type: 'addModel' }
  /** Open the feedback form. */
  | { type: 'openFeedback'; kind?: FeedbackKind }
  /** Open a pre-filled GitHub issue in the browser. */
  | { type: 'feedback'; kind: FeedbackKind; title: string; description: string; includeDiagnostics: boolean; /** Copy the link instead of opening the browser. */ copyLink?: boolean }
  | { type: 'openSettings' }
  /** Sent once the companion is on screen; tells the host which renderer the webview ended up with. */
  | { type: 'avatarReady'; renderer: 'webgl' | '2d' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Webview messages travel as JSON, which drops keys whose value is `undefined`. A patch that
 * clears a field (no session, no open file, no notice) would then never arrive, and the chat
 * would keep showing the old value. Cleared fields are sent as `null`; the webview's store
 * turns them back into `undefined`.
 */
export function clearedAsNull<T extends object>(patch: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? null : v;
  return out as T;
}
