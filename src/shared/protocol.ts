import type {
  AgentInfo,
  Attachment,
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

/** Everything the chat view renders. The host owns it; the webview holds a mirror. */
export interface ViewState {
  engine: EngineId;
  engines: EngineStatus[];
  capabilities: EngineCapabilities;
  sessions: SessionInfo[];
  sessionId: string | undefined;
  messages: ChatMessage[];
  activity: SessionActivity;
  activityDetail: string | undefined;
  providers: ProviderInfo[];
  model: ModelRef | undefined;
  agents: AgentInfo[];
  agent: string | undefined;
  commands: SlashCommand[];
  mcp: McpServerInfo[];
  attachments: Attachment[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  sessionUsage: SessionUsage | undefined;
  usage: UsageSummary | undefined;
  avatar: { enabled: boolean; style: 'bot' | 'orb' };
  trusted: boolean;
  /** Bumped when the host wants the webview to open a panel (e.g. from a command). */
  panel: { name: 'none' | 'sessions' | 'mcp' | 'usage' | 'models'; nonce: number };
  notice: { level: 'info' | 'warn' | 'error'; text: string; nonce: number } | undefined;
  loading: boolean;
}

export type HostToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'patch'; patch: Partial<ViewState> }
  | { type: 'event'; event: EngineEvent }
  | { type: 'fileResults'; requestId: number; files: { path: string; relative: string }[] }
  | { type: 'insertText'; text: string }
  | { type: 'focusInput' }
  /** The view was shown or hidden; lets the webview pause animation while nobody can see it. */
  | { type: 'visible'; visible: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'abort' }
  | { type: 'newSession' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'setEngine'; engine: EngineId }
  | { type: 'setModel'; model: ModelRef }
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
  | { type: 'setAvatar'; enabled?: boolean; style?: 'bot' | 'orb' }
  | { type: 'manageProviders' }
  | { type: 'restartEngine' }
  | { type: 'openSettings' }
  /** Sent once the companion is on screen; tells the host which renderer the webview ended up with. */
  | { type: 'avatarReady'; renderer: 'webgl' | '2d' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
