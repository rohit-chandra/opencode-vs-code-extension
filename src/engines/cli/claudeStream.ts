import type { TokenUsage, ToolStatus } from '../../shared/types';

/** The part of `AssistantWriter` the CLI translators need. Kept as an interface so they can be unit-tested. */
export interface TurnSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  breakText(): void;
  tool(callId: string, patch: { tool?: string; status?: ToolStatus; title?: string; input?: unknown; output?: string; error?: string }): void;
  hasTool(callId: string): boolean;
  notice(level: 'info' | 'warn' | 'error', text: string): void;
  setUsage(usage: TokenUsage): void;
  /** One model call finished: the tokens it read plus the tokens it wrote. Optional so test sinks can leave it out. */
  modelCall?(tokens: number): void;
}

/** Token counters of one Anthropic API call, as its stream reports them. */
interface CallUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeInit {
  sessionId?: string;
  model?: string;
  slashCommands?: string[];
  mcpServers?: { name: string; status: string }[];
  version?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Translates Claude Code's `--output-format stream-json` events (one JSON object per line)
 * into assistant-message updates. Format verified against Claude Code 2.1.x:
 *   system/init, stream_event (raw Anthropic stream events when --include-partial-messages),
 *   assistant (one per completed content block), user (tool results), result (usage + cost).
 */
export class ClaudeStreamTranslator {
  init: ClaudeInit = {};
  error: string | undefined;
  private streamed = new Set<string>();
  private currentMessageId: string | undefined;
  private sawText = false;
  private done = false;
  /** Input side (fresh, cached, newly cached) of the model call in progress. */
  private callInput: number | undefined;
  /**
   * `total_cost_usd` of the last result. Claude Code counts it for the whole conversation: a
   * resumed session reports what every turn so far has cost, not only this one.
   */
  costTotal: number | undefined;

  /**
   * @param costBefore What the conversation had cost before this turn (the `costTotal` of
   *   its previous turn), so a resumed session's reply is charged its own cost only.
   */
  constructor(private readonly sink: TurnSink, private readonly costBefore = 0) {}

  get finished(): boolean {
    return this.done;
  }

  handle(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.init = {
            sessionId: ev.session_id as string | undefined,
            model: ev.model as string | undefined,
            slashCommands: Array.isArray(ev.slash_commands) ? (ev.slash_commands as string[]) : undefined,
            mcpServers: Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as { name: string; status: string }[]) : undefined,
            version: ev.claude_code_version as string | undefined,
          };
        } else if (ev.subtype === 'compact_boundary') {
          this.sink.notice('info', 'Conversation compacted');
        }
        return;
      case 'stream_event':
        if (ev.parent_tool_use_id) return; // sub-agent output is summarised by its Task tool
        this.onStreamEvent(ev.event as Record<string, unknown>);
        return;
      case 'assistant':
        this.onAssistant(ev);
        return;
      case 'user':
        this.onUser(ev);
        return;
      case 'result':
        this.onResult(ev);
        return;
      default:
        return;
    }
  }

  private onStreamEvent(e: Record<string, unknown> | undefined): void {
    if (!e) return;
    if (e.type === 'message_start') {
      const message = e.message as { id?: string; usage?: CallUsage } | undefined;
      const id = message?.id;
      this.currentMessageId = id;
      if (id) this.streamed.add(id);
      const u = message?.usage;
      this.callInput = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
    } else if (e.type === 'message_delta') {
      // The end of one model call: what it read plus what it wrote is the context so far.
      const u = e.usage as CallUsage | undefined;
      if (this.callInput !== undefined) {
        const input = u?.input_tokens !== undefined ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : this.callInput;
        this.sink.modelCall?.(Math.max(input, this.callInput) + (u?.output_tokens ?? 0));
        this.callInput = undefined;
      }
    } else if (e.type === 'content_block_start') {
      this.sink.breakText();
    } else if (e.type === 'content_block_delta') {
      const d = e.delta as { type?: string; text?: string; thinking?: string } | undefined;
      if (d?.type === 'text_delta' && d.text) {
        this.sawText = true;
        this.sink.text(d.text);
      } else if (d?.type === 'thinking_delta' && d.thinking) {
        this.sink.reasoning(d.thinking);
      }
    }
  }

  private onAssistant(ev: Record<string, unknown>): void {
    const message = ev.message as { id?: string; model?: string; content?: ContentBlock[] } | undefined;
    if (!message) return;
    const sub = !!ev.parent_tool_use_id;
    if (!sub && message.model && message.model !== '<synthetic>') this.init.model = message.model;
    const wasStreamed = !!message.id && (this.streamed.has(message.id) || message.id === this.currentMessageId);
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use' && block.id) {
        this.sink.tool(block.id, { tool: block.name ?? 'tool', status: 'running', input: block.input, title: toolTitle(block.name, block.input) });
      } else if (!sub && !wasStreamed) {
        if (block.type === 'text' && block.text) {
          this.sawText = true;
          this.sink.text(block.text);
          this.sink.breakText();
        } else if (block.type === 'thinking' && block.thinking) {
          this.sink.reasoning(block.thinking);
          this.sink.breakText();
        }
      }
    }
  }

  private onUser(ev: Record<string, unknown>): void {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id || !this.sink.hasTool(block.tool_use_id)) continue;
      const text = flatten(block.content);
      this.sink.tool(block.tool_use_id, block.is_error ? { status: 'error', error: text } : { status: 'completed', output: text });
    }
  }

  private onResult(ev: Record<string, unknown>): void {
    this.done = true;
    if (typeof ev.session_id === 'string') this.init.sessionId = ev.session_id;
    const u = ev.usage as CallUsage | undefined;
    if (u) {
      // The tokens are this turn's (every model call of it added up); the cost is the conversation's.
      const total = typeof ev.total_cost_usd === 'number' && ev.total_cost_usd >= 0 ? ev.total_cost_usd : undefined;
      this.costTotal = total;
      const cumulative = total !== undefined && this.costBefore > 0 && total >= this.costBefore && coversEarlierTurns(ev.modelUsage, u);
      this.sink.setUsage({
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        reasoning: 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cost: total === undefined ? 0 : cumulative ? total - this.costBefore : total,
      });
    }
    const resultText = typeof ev.result === 'string' ? ev.result : '';
    if (ev.is_error || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
      this.error = resultText || describeSubtype(ev.subtype as string | undefined);
    } else if (!this.sawText && resultText) {
      // Local commands (e.g. /cost) produce only a result, no assistant message.
      this.sink.text(resultText);
    }
  }
}

/**
 * Whether a result's per-model totals reach back before this turn. `modelUsage` is counted
 * for the conversation like the cost, `usage` for the turn alone, so on a resumed session the
 * first holds more tokens than the second. Without `modelUsage` (older CLIs) the cost is
 * taken to be the conversation's, which is how the CLI has reported it.
 */
function coversEarlierTurns(modelUsage: unknown, turn: CallUsage): boolean {
  if (!modelUsage || typeof modelUsage !== 'object') return true;
  let all = 0;
  for (const m of Object.values(modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>)) {
    all += (m?.inputTokens ?? 0) + (m?.outputTokens ?? 0) + (m?.cacheReadInputTokens ?? 0) + (m?.cacheCreationInputTokens ?? 0);
  }
  const own = (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0) + (turn.cache_read_input_tokens ?? 0) + (turn.cache_creation_input_tokens ?? 0);
  return all > own;
}

function describeSubtype(subtype: string | undefined): string {
  if (subtype === 'error_max_turns') return 'Claude Code stopped: maximum number of turns reached.';
  if (subtype === 'error_during_execution') return 'Claude Code reported an error during execution.';
  return `Claude Code ended with: ${subtype ?? 'unknown error'}`;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'content'}]`)).join('\n');
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/** One-line summary of a tool call for the tool card header. */
export function toolTitle(name: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  if (typeof pick !== 'string') return undefined;
  const one = pick.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 119) + '…' : one;
}
