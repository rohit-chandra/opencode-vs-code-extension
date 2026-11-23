import type { TurnSink } from './claudeStream';
import { codexTotals, codexTurnUsage } from './usageRepair';
import type { CodexTotals } from './usageRepair';

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: { type: string; text?: string }[]; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
  items?: { text: string; completed: boolean }[];
}

/**
 * Translates `codex exec --json` JSONL events. Format verified against codex-cli 0.170:
 *   thread.started, turn.started, item.started|updated|completed, turn.completed (usage),
 *   turn.failed, error.
 * Codex reports whole items rather than token deltas.
 *
 * The usage of `turn.completed` is the thread's running total, not the turn's: a resumed
 * thread reports every earlier turn again. `before` is what the thread had reached when the
 * turn started, so the reply is given only what it used itself.
 */
export class CodexStreamTranslator {
  threadId: string | undefined;
  error: string | undefined;
  /** The thread's token totals after this turn, as Codex reported them. */
  totals: CodexTotals | undefined;
  private done = false;

  constructor(private readonly sink: TurnSink, private readonly before?: CodexTotals) {}

  get finished(): boolean {
    return this.done;
  }

  handle(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'thread.started':
        this.threadId = ev.thread_id as string | undefined;
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.onItem(ev.item as CodexItem | undefined, ev.type === 'item.completed');
        return;
      case 'turn.completed': {
        this.done = true;
        const u = ev.usage as Parameters<typeof codexTotals>[0] | undefined;
        if (u) {
          this.totals = codexTotals(u);
          this.sink.setUsage(codexTurnUsage(this.totals, this.before));
        }
        return;
      }
      case 'turn.failed':
        this.done = true;
        this.error = (ev.error as { message?: string } | undefined)?.message ?? 'Codex turn failed';
        return;
      case 'error':
        this.error = (ev.message as string | undefined) ?? 'Codex error';
        return;
      default:
        return;
    }
  }

  private onItem(item: CodexItem | undefined, completed: boolean): void {
    if (!item?.id) return;
    const failed = item.status === 'failed' || item.status === 'declined';
    switch (item.type) {
      case 'agent_message':
        if (completed && item.text) {
          this.sink.text(item.text);
          this.sink.breakText();
        }
        return;
      case 'reasoning':
        if (completed && item.text) {
          this.sink.reasoning(item.text);
          this.sink.breakText();
        }
        return;
      case 'command_execution': {
        const ok = completed && !failed && (item.exit_code === 0 || item.exit_code === null || item.exit_code === undefined);
        this.sink.tool(item.id, {
          tool: 'shell',
          title: oneLine(item.command),
          input: { command: item.command },
          status: !completed ? 'running' : ok ? 'completed' : 'error',
          output: completed && ok ? (item.aggregated_output ?? '') : undefined,
          error: completed && !ok ? `${item.aggregated_output ?? ''}\n(exit code ${item.exit_code ?? '?'}${item.status === 'declined' ? ', declined by sandbox policy' : ''})`.trim() : undefined,
        });
        return;
      }
      case 'file_change': {
        const changes = item.changes ?? [];
        this.sink.tool(item.id, {
          tool: 'edit',
          title: changes.map((c) => c.path).join(', ') || undefined,
          input: { changes },
          status: !completed ? 'running' : failed ? 'error' : 'completed',
          output: completed && !failed ? changes.map((c) => `${c.kind} ${c.path}`).join('\n') : undefined,
          error: completed && failed ? 'Patch was not applied.' : undefined,
        });
        return;
      }
      case 'mcp_tool_call': {
        const out = (item.result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n') || (item.result?.structured_content ? JSON.stringify(item.result.structured_content) : '');
        this.sink.tool(item.id, {
          tool: `${item.server ?? 'mcp'} › ${item.tool ?? 'tool'}`,
          input: item.arguments,
          status: !completed ? 'running' : failed || item.error ? 'error' : 'completed',
          output: completed && !failed && !item.error ? out : undefined,
          error: completed && (failed || item.error) ? (item.error?.message ?? 'MCP tool call failed') : undefined,
        });
        return;
      }
      case 'web_search':
        this.sink.tool(item.id, { tool: 'web_search', title: item.query, input: { query: item.query }, status: completed ? 'completed' : 'running', output: completed ? '' : undefined });
        return;
      case 'todo_list':
        this.sink.tool(item.id, {
          tool: 'todo',
          title: `${(item.items ?? []).filter((t) => t.completed).length}/${(item.items ?? []).length} done`,
          status: completed ? 'completed' : 'running',
          output: (item.items ?? []).map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'),
        });
        return;
      case 'error':
        if (completed && item.message) this.sink.notice('warn', item.message);
        return;
      default:
        return;
    }
  }
}

function oneLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}
