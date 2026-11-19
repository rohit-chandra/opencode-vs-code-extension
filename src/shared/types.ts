/**
 * Normalized data model shared by the extension host and the webview.
 * Every engine (opencode, direct BYOK, Claude Code, Codex, VS Code LM) maps its own
 * wire format onto these types, so the UI and the usage ledger never care which
 * backend produced a message.
 *
 * This file must stay free of `vscode` and Node imports.
 */

export type EngineId = 'opencode' | 'direct' | 'claude-code' | 'codex' | 'vscode-lm';

export const ENGINE_LABELS: Record<EngineId, string> = {
  opencode: 'opencode',
  direct: 'Direct BYOK',
  'claude-code': 'Claude Code',
  codex: 'Codex (ChatGPT)',
  'vscode-lm': 'Copilot / VS Code models',
};

export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD. 0 when the engine cannot tell. */
  cost: number;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function addUsage(a: TokenUsage, b: Partial<TokenUsage>, sign = 1): TokenUsage {
  return {
    input: a.input + sign * (b.input ?? 0),
    output: a.output + sign * (b.output ?? 0),
    reasoning: a.reasoning + sign * (b.reasoning ?? 0),
    cacheRead: a.cacheRead + sign * (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + sign * (b.cacheWrite ?? 0),
    cost: a.cost + sign * (b.cost ?? 0),
  };
}

export const totalTokens = (u: TokenUsage): number => u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite;

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelInfo extends ModelRef {
  name: string;
  contextWindow?: number;
  supportsImages?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  /** USD per million tokens, when known. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  models: ModelInfo[];
  /** How this provider can be connected from the UI (opencode engine). */
  authMethods?: { type: 'api' | 'oauth'; label: string }[];
}

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface SessionInfo {
  id: string;
  engine: EngineId;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  shareUrl?: string;
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

export type Part =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'tool'; tool: string; callId: string; status: ToolStatus; title?: string; input?: unknown; output?: string; error?: string }
  | { id: string; type: 'file'; filename: string; mime: string; url?: string }
  | { id: string; type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  completedAt?: number;
  parts: Part[];
  model?: ModelRef;
  agent?: string;
  usage?: TokenUsage;
  error?: string;
}

export interface Attachment {
  id: string;
  kind: 'file' | 'image' | 'selection';
  /** Display name, e.g. "src/app.ts" or "src/app.ts:10-24". */
  name: string;
  mime: string;
  /** Absolute file-system path, when the attachment is a workspace file. */
  path?: string;
  /** data: URL for pasted/dropped content that has no file on disk. */
  dataUrl?: string;
  /** Inline text (selections). */
  text?: string;
  range?: { startLine: number; endLine: number };
  size?: number;
}

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  /** Short label, e.g. "bash" or "edit". */
  kind: string;
  title: string;
  detail?: string;
  /** Tool call this request belongs to, if known. */
  callId?: string;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  questions: { header?: string; question: string; options: { label: string; description?: string }[]; multiple?: boolean }[];
}

export type McpStatus = 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'connecting';

export interface McpServerInfo {
  name: string;
  status: McpStatus;
  enabled: boolean;
  error?: string;
  toolCount?: number;
  transport?: 'stdio' | 'http' | 'unknown';
  /** Where the definition lives, e.g. "opencode.json", ".mcp.json", "settings". */
  source?: string;
  /** False when the engine cannot switch this server on/off. */
  canToggle: boolean;
}

export type CommandSource = 'builtin' | 'engine' | 'mcp' | 'skill';

export interface SlashCommand {
  name: string;
  description: string;
  source: CommandSource;
  argumentHint?: string;
}

export interface EngineCapabilities {
  agents: boolean;
  fork: boolean;
  share: boolean;
  undo: boolean;
  compact: boolean;
  images: boolean;
  mcpToggle: boolean;
  permissions: boolean;
  providerAuth: boolean;
  /** Engine keeps sessions itself (true) or the extension stores them locally (false). */
  remoteSessions: boolean;
}

export type EngineState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'error';

export interface EngineStatus {
  engine: EngineId;
  state: EngineState;
  detail?: string;
  version?: string;
}

export type SessionActivity = 'idle' | 'busy' | 'retry';

export type EngineEvent =
  | { type: 'engine.status'; status: EngineStatus }
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.status'; sessionId: string; activity: SessionActivity; detail?: string }
  /** `infoOnly`: metadata changed; keep the parts already known for this message. */
  | { type: 'message.updated'; message: ChatMessage; infoOnly?: boolean }
  | { type: 'message.removed'; sessionId: string; messageId: string }
  | { type: 'part.updated'; sessionId: string; messageId: string; part: Part }
  | { type: 'part.delta'; sessionId: string; messageId: string; partId: string; delta: string }
  | { type: 'part.removed'; sessionId: string; messageId: string; partId: string }
  | { type: 'permission.asked'; request: PermissionRequest }
  | { type: 'permission.resolved'; sessionId: string; requestId: string }
  | { type: 'question.asked'; request: QuestionRequest }
  | { type: 'question.resolved'; sessionId: string; requestId: string }
  | { type: 'usage'; sessionId: string; messageId: string; model: ModelRef; usage: TokenUsage }
  | { type: 'mcp.changed' }
  | { type: 'catalog.changed' }
  | { type: 'error'; sessionId?: string; message: string };

export interface PromptInput {
  text: string;
  attachments: Attachment[];
  model?: ModelRef;
  agent?: string;
}

/** Per-model aggregate used by the usage dashboard. */
export interface UsageRow {
  engine: EngineId;
  providerId: string;
  modelId: string;
  usage: TokenUsage;
  messages: number;
}

export interface SessionUsage {
  engine: EngineId;
  sessionId: string;
  title: string;
  updatedAt: number;
  usage: TokenUsage;
  messages: number;
  byModel: UsageRow[];
}

export interface UsageSummary {
  since: number;
  total: TokenUsage;
  messages: number;
  byModel: UsageRow[];
  byDay: { day: string; usage: TokenUsage }[];
  sessions: SessionUsage[];
}
