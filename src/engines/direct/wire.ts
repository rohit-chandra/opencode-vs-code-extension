import { readSse } from '../../core/sse';
import type { TokenUsage } from '../../shared/types';

/** Provider-neutral transcript kept per session; converted to each wire format on send. */
export type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; name: string; text: string; isError?: boolean };

export interface WireMessage {
  role: 'user' | 'assistant';
  blocks: WireBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason?: string;
}

export interface StreamHandlers {
  onText(delta: string): void;
  onReasoning(delta: string): void;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model: string;
  system?: string;
  messages: WireMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ OpenAI */

export function toOpenAiMessages(system: string | undefined, messages: WireMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = m.blocks.filter((b): b is Extract<WireBlock, { type: 'tool_call' }> => b.type === 'tool_call');
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
      out.push(msg);
      continue;
    }
    const results = m.blocks.filter((b): b is Extract<WireBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.id, content: r.text });
    const rest = m.blocks.filter((b) => b.type === 'text' || b.type === 'image');
    if (rest.length === 0) continue;
    if (rest.every((b) => b.type === 'text')) {
      out.push({ role: 'user', content: rest.map((b) => (b as { text: string }).text).join('\n\n') });
    } else {
      out.push({
        role: 'user',
        content: rest.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image_url', image_url: { url: `data:${(b as { mime: string }).mime};base64,${(b as { data: string }).data}` } })),
      });
    }
  }
  return out;
}

export function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + '/' + suffix.replace(/^\/+/, '');
}

async function failure(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 600);
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message ?? j?.message ?? j?.error ?? detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    /* not JSON */
  }
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key for this provider (OpenCode Hub: Manage BYOK Providers & API Keys…).' : res.status === 404 ? ' Check the base URL and model name.' : '';
  return new Error(`${what} failed (${res.status}): ${detail || res.statusText}.${hint}`);
}

export async function streamOpenAi(req: ChatRequest, handlers: StreamHandlers): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.system, req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...req.headers };
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;

  const url = joinUrl(req.baseUrl, 'chat/completions');
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
  if (res.status === 400) {
    // A few OpenAI-compatible servers reject `stream_options`; retry once without it.
    const text = await res.text().catch(() => '');
    if (/stream_options/i.test(text)) {
      delete body.stream_options;
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
    } else {
      throw await failure(new Response(text, { status: 400 }), 'Chat request');
    }
  }
  if (!res.ok) throw await failure(res, 'Chat request');

  const result: StreamResult = { text: '', toolCalls: [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const calls = new Map<number, ToolCall>();
  for await (const msg of readSse(res, req.signal)) {
    if (!msg.data || msg.data === '[DONE]') continue;
    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(msg.data) as OpenAiChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'Provider error'));
    if (chunk.usage) result.usage = normalizeOpenAiUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) handlers.onReasoning(reasoning);
    if (typeof delta.content === 'string' && delta.content) {
      result.text += delta.content;
      handlers.onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      let call = calls.get(idx);
      if (!call) {
        call = { id: tc.id ?? `call_${idx}_${Date.now().toString(36)}`, name: '', args: '' };
        calls.set(idx, call);
      }
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
    }
    if (choice.finish_reason) result.stopReason = choice.finish_reason;
  }
  result.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.name);
  return result;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
}
interface OpenAiChunk {
  error?: { message?: string } | string;
  usage?: OpenAiUsage;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
}

export function normalizeOpenAiUsage(u: OpenAiUsage): TokenUsage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached - cacheWrite),
    output: Math.max(0, (u.completion_tokens ?? 0) - reasoning),
    reasoning,
    cacheRead: cached,
    cacheWrite,
    cost: typeof u.cost === 'number' ? u.cost : 0,
  };
}

/* --------------------------------------------------------------- Anthropic */

export function toAnthropicMessages(messages: WireMessage[]): unknown[] {
  const out: { role: string; content: unknown[] }[] = [];
  for (const m of messages) {
    const content: unknown[] = [];
    // tool_result blocks must come first in a user turn.
    const ordered = m.role === 'user' ? [...m.blocks.filter((b) => b.type === 'tool_result'), ...m.blocks.filter((b) => b.type !== 'tool_result')] : m.blocks;
    for (const b of ordered) {
      if (b.type === 'text') {
        if (b.text) content.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } });
      else if (b.type === 'tool_call') content.push({ type: 'tool_use', id: b.id, name: b.name, input: safeJson(b.args) });
      else content.push({ type: 'tool_result', tool_use_id: b.id, content: b.text, is_error: b.isError || undefined });
    }
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    // The API requires alternating roles; merge consecutive messages of the same role.
    if (last && last.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function streamAnthropic(req: ChatRequest, handlers: StreamHandlers): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages: toAnthropicMessages(req.messages),
    stream: true,
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...req.headers };
  if (req.apiKey) headers['x-api-key'] = req.apiKey;

  const base = req.baseUrl.replace(/\/+$/, '');
  const res = await fetch(joinUrl(/\/v1$/.test(base) ? base : base + '/v1', 'messages'), { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
  if (!res.ok) throw await failure(res, 'Chat request');

  const result: StreamResult = { text: '', toolCalls: [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const blocks = new Map<number, ToolCall>();
  for await (const msg of readSse(res, req.signal)) {
    if (!msg.data) continue;
    let ev: AnthropicEvent;
    try {
      ev = JSON.parse(msg.data) as AnthropicEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {};
        result.usage.input = u.input_tokens ?? 0;
        result.usage.cacheRead = u.cache_read_input_tokens ?? 0;
        result.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        result.usage.output = u.output_tokens ?? 0;
        break;
      }
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') blocks.set(ev.index ?? 0, { id: ev.content_block.id ?? `toolu_${ev.index}`, name: ev.content_block.name ?? '', args: '' });
        break;
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          result.text += d.text;
          handlers.onText(d.text);
        } else if (d.type === 'thinking_delta' && d.thinking) handlers.onReasoning(d.thinking);
        else if (d.type === 'input_json_delta' && d.partial_json) {
          const b = blocks.get(ev.index ?? 0);
          if (b) b.args += d.partial_json;
        }
        break;
      }
      case 'message_delta':
        if (ev.usage?.output_tokens !== undefined) result.usage.output = ev.usage.output_tokens;
        if (ev.usage?.input_tokens !== undefined) result.usage.input = ev.usage.input_tokens;
        if (ev.usage?.cache_read_input_tokens !== undefined) result.usage.cacheRead = ev.usage.cache_read_input_tokens;
        if (ev.delta?.stop_reason) result.stopReason = ev.delta.stop_reason;
        break;
      case 'error':
        throw new Error(ev.error?.message ?? 'Provider error');
      default:
        break;
    }
  }
  result.toolCalls = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return result;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

/* ------------------------------------------------------------ model lists */

export async function fetchModelIds(type: 'openai-compatible' | 'anthropic', baseUrl: string, apiKey: string | undefined, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<{ id: string; name?: string }[]> {
  const headers: Record<string, string> = { ...extraHeaders };
  let url: string;
  if (type === 'anthropic') {
    const base = baseUrl.replace(/\/+$/, '');
    url = joinUrl(/\/v1$/.test(base) ? base : base + '/v1', 'models?limit=1000');
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  } else {
    url = joinUrl(baseUrl, 'models');
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw await failure(res, 'Listing models');
  const j = (await res.json()) as { data?: { id: string; display_name?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
  const list = j.data ?? j.models?.map((m) => ({ id: m.id ?? m.name ?? '', display_name: undefined, name: m.name })) ?? [];
  return list.filter((m) => m.id).map((m) => ({ id: m.id, name: m.display_name ?? m.name }));
}
