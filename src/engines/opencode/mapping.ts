import type { ChatMessage, McpServerInfo, McpStatus, ModelInfo, Part, PermissionRequest, ProviderInfo, QuestionRequest, SessionInfo, SlashCommand, TokenUsage } from '../../shared/types';

/* Loose shapes of the opencode server payloads we consume (see `GET /doc` on a running server). */
export interface OcTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
export interface OcSession {
  id: string;
  title?: string;
  parentID?: string;
  directory?: string;
  share?: { url?: string };
  time?: { created?: number; updated?: number };
}
export interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
  model?: { providerID?: string; modelID?: string };
  agent?: string;
  mode?: string;
  cost?: number;
  tokens?: OcTokens;
  error?: { name?: string; data?: { message?: string } };
  summary?: unknown;
}
export interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  callID?: string;
  state?: { status?: string; title?: string; input?: unknown; output?: string; error?: string; metadata?: Record<string, unknown> };
  mime?: string;
  filename?: string;
  url?: string;
  error?: { name?: string; data?: { message?: string } };
  attempt?: number;
  name?: string;
  description?: string;
  auto?: boolean;
}

export function mapUsage(tokens: OcTokens | undefined, cost: number | undefined): TokenUsage | undefined {
  if (!tokens) return undefined;
  const usage: TokenUsage = {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    cost: cost ?? 0,
  };
  return usage.input || usage.output || usage.reasoning || usage.cacheRead || usage.cacheWrite || usage.cost ? usage : undefined;
}

export function mapSession(s: OcSession): SessionInfo {
  const created = s.time?.created ?? Date.now();
  return {
    id: s.id,
    engine: 'opencode',
    title: cleanTitle(s.title),
    createdAt: created,
    updatedAt: s.time?.updated ?? created,
    parentId: s.parentID,
    shareUrl: s.share?.url,
  };
}

/** opencode names untitled sessions "New session - <ISO date>". */
function cleanTitle(title: string | undefined): string {
  if (!title || /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(title)) return 'New session';
  return title;
}

export function mapPart(p: OcPart): Part | undefined {
  switch (p.type) {
    case 'text':
      if (p.synthetic || p.ignored) return undefined;
      return { id: p.id, type: 'text', text: p.text ?? '' };
    case 'reasoning':
      return { id: p.id, type: 'reasoning', text: p.text ?? '' };
    case 'tool': {
      const st = p.state ?? {};
      const status = st.status === 'completed' ? 'completed' : st.status === 'error' ? 'error' : st.status === 'running' ? 'running' : 'pending';
      return { id: p.id, type: 'tool', tool: p.tool ?? 'tool', callId: p.callID ?? p.id, status, title: st.title, input: st.input, output: typeof st.output === 'string' ? clip(st.output) : undefined, error: st.error };
    }
    case 'file':
      return { id: p.id, type: 'file', filename: p.filename ?? fileNameFromUrl(p.url), mime: p.mime ?? 'application/octet-stream', url: p.url?.startsWith('data:') ? undefined : p.url };
    case 'retry':
      return { id: p.id, type: 'notice', level: 'warn', text: `Retrying (attempt ${p.attempt ?? '?'}): ${p.error?.data?.message ?? 'provider error'}` };
    case 'compaction':
      return { id: p.id, type: 'notice', level: 'info', text: 'Conversation compacted' };
    case 'subtask':
      return { id: p.id, type: 'notice', level: 'info', text: `Subtask: ${p.description ?? ''}`.trim() };
    case 'agent':
      return { id: p.id, type: 'notice', level: 'info', text: `Agent: @${p.name ?? ''}` };
    default:
      // step-start, step-finish, snapshot, patch: bookkeeping only.
      return undefined;
  }
}

const MAX_TOOL_OUTPUT = 20_000;
function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + `\n… (${text.length - MAX_TOOL_OUTPUT} more characters)` : text;
}

function fileNameFromUrl(url: string | undefined): string {
  if (!url || url.startsWith('data:')) return 'attachment';
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'attachment');
  } catch {
    return 'attachment';
  }
}

export function mapMessage(info: OcMessageInfo, parts: OcPart[] = []): ChatMessage {
  const providerId = info.providerID ?? info.model?.providerID;
  const modelId = info.modelID ?? info.model?.modelID;
  return {
    id: info.id,
    sessionId: info.sessionID,
    role: info.role,
    createdAt: info.time?.created ?? Date.now(),
    completedAt: info.time?.completed,
    parts: parts.map(mapPart).filter((p): p is Part => p !== undefined),
    model: providerId && modelId ? { providerId, modelId } : undefined,
    agent: info.agent ?? info.mode,
    usage: info.role === 'assistant' ? mapUsage(info.tokens, info.cost) : undefined,
    error: info.error && info.error.name !== 'MessageAbortedError' ? (info.error.data?.message ?? info.error.name ?? 'Error') : undefined,
  };
}

interface OcModel {
  id: string;
  name?: string;
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  capabilities?: { reasoning?: boolean; toolcall?: boolean; attachment?: boolean; input?: { image?: boolean } };
  // pre-1.x shape
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  status?: string;
}
export interface OcProvider {
  id: string;
  name?: string;
  models?: Record<string, OcModel>;
}

export function mapProvider(p: OcProvider, connected: boolean, authMethods?: { type: 'api' | 'oauth'; label: string }[]): ProviderInfo {
  const models: ModelInfo[] = Object.values(p.models ?? {})
    .filter((m) => m.status !== 'deprecated')
    .map((m) => ({
      providerId: p.id,
      modelId: m.id,
      name: m.name || m.id,
      contextWindow: m.limit?.context || undefined,
      supportsImages: m.capabilities?.input?.image ?? m.capabilities?.attachment ?? m.attachment,
      supportsTools: m.capabilities?.toolcall ?? m.tool_call,
      supportsReasoning: m.capabilities?.reasoning ?? m.reasoning,
      pricing: m.cost && (m.cost.input || m.cost.output) ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0, cacheRead: m.cost.cache?.read, cacheWrite: m.cost.cache?.write } : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { id: p.id, name: p.name || p.id, connected, models, authMethods };
}

export function mapMcp(status: Record<string, { status?: string; error?: string }>): McpServerInfo[] {
  const known: McpStatus[] = ['connected', 'disabled', 'failed', 'needs_auth'];
  return Object.entries(status)
    .map(([name, s]) => {
      const st = (known as string[]).includes(s.status ?? '') ? (s.status as McpStatus) : s.status === 'needs_client_registration' ? 'needs_auth' : 'failed';
      return { name, status: st, enabled: st !== 'disabled', error: s.error, canToggle: true, source: 'opencode', transport: 'unknown' as const };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function mapCommand(c: { name: string; description?: string; source?: string; hints?: string[] }): SlashCommand {
  return {
    name: c.name,
    description: c.description ?? '',
    source: c.source === 'mcp' ? 'mcp' : c.source === 'skill' ? 'skill' : 'engine',
    argumentHint: c.hints?.some((h) => h.includes('ARGUMENTS') || /^\$\d/.test(h)) ? '[arguments]' : undefined,
  };
}

export function mapPermission(p: { id: string; sessionID: string; permission?: string; patterns?: string[]; metadata?: Record<string, unknown>; tool?: { callID?: string }; title?: string; type?: string }): PermissionRequest {
  const kind = p.permission ?? p.type ?? 'tool';
  const patterns = (p.patterns ?? []).filter(Boolean);
  const meta = p.metadata ?? {};
  const detail = typeof meta.command === 'string' ? meta.command : typeof meta.filepath === 'string' ? meta.filepath : typeof meta.diff === 'string' ? meta.diff : patterns.join('\n');
  return {
    id: p.id,
    sessionId: p.sessionID,
    kind,
    title: p.title ?? `Allow ${kind}${patterns.length === 1 && patterns[0].length < 60 ? `: ${patterns[0]}` : ''}?`,
    detail: detail ? clipDetail(detail) : undefined,
    callId: p.tool?.callID,
  };
}

function clipDetail(d: string): string {
  return d.length > 4000 ? d.slice(0, 4000) + '\n…' : d;
}

export function mapQuestion(q: { id: string; sessionID: string; questions?: { header?: string; question?: string; options?: { label: string; description?: string }[]; multiple?: boolean }[] }): QuestionRequest {
  return {
    id: q.id,
    sessionId: q.sessionID,
    questions: (q.questions ?? []).map((x) => ({ header: x.header, question: x.question ?? '', options: x.options ?? [], multiple: x.multiple })),
  };
}

/** A model from opencode's newer `GET /api/model` (providers connected through integrations). */
export interface OcApiModel {
  id: string;
  providerID: string;
  name?: string;
  status?: string;
  enabled?: boolean;
  capabilities?: { tools?: boolean; input?: string[] };
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }[];
  limit?: { context?: number };
}

/**
 * Merge the two lists opencode keeps. Since opencode moved sign-ins to "integrations", a
 * provider connected that way (the OpenCode Console account, and logins made with newer
 * CLIs) shows up only in `GET /api/model`, while keys saved the older way (`auth.json`) and
 * providers from `opencode.json` show up only in `GET /config/providers`. The chat needs both.
 */
export function mergeProviderLists(legacy: ProviderInfo[], apiModels: OcApiModel[] | undefined, names: Record<string, string> = {}): ProviderInfo[] {
  const byId = new Map(legacy.map((p) => [p.id, { ...p, models: [...p.models] }]));
  for (const m of apiModels ?? []) {
    if (!m?.id || !m.providerID || m.enabled === false || m.status === 'deprecated') continue;
    let provider = byId.get(m.providerID);
    if (!provider) {
      provider = { id: m.providerID, name: names[m.providerID] || m.providerID, connected: true, models: [] };
      byId.set(m.providerID, provider);
    }
    if (provider.models.some((x) => x.modelId === m.id)) continue;
    const cost = m.cost?.[0];
    provider.models.push({
      providerId: m.providerID,
      modelId: m.id,
      name: m.name || m.id,
      contextWindow: m.limit?.context || undefined,
      supportsImages: m.capabilities?.input?.includes('image'),
      supportsTools: m.capabilities?.tools,
      pricing: cost && (cost.input || cost.output) ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cache?.read, cacheWrite: cost.cache?.write } : undefined,
    });
  }
  return [...byId.values()].map((p) => ({ ...p, models: p.models.sort((a, b) => a.name.localeCompare(b.name)) })).filter((p) => p.models.length > 0);
}
