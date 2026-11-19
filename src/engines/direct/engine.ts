import type { EngineContext } from '../../core/engine';
import { attachmentsAsText, resolveAttachment } from '../../core/attachments';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { estimateCost } from '../../core/usageLedger';
import type { McpManager, McpTool } from '../../mcp/manager';
import type { EngineCapabilities, McpServerInfo, ModelInfo, ProviderInfo } from '../../shared/types';
import { resolveProvider, secretKeyFor } from './presets';
import type { ProviderConfig } from './presets';
import { fetchModelIds, streamAnthropic, streamOpenAi } from './wire';
import type { WireBlock, WireMessage } from './wire';

const MAX_TOOL_ROUNDS = 30;
const MODEL_CACHE_MS = 10 * 60_000;

export const DEFAULT_SYSTEM_PROMPT =
  'You are a coding assistant running inside the user\'s editor (VS Code). Be concise and precise. ' +
  'Format answers in Markdown and put code in fenced blocks with a language tag. ' +
  'Files the user attached appear inside <attachment name="..."> blocks. ' +
  'If tools are available, use them when they help; otherwise answer from the provided context and say when you are unsure.';

/**
 * Direct BYOK engine: calls OpenAI-compatible or Anthropic APIs with the user's own keys.
 * No opencode required. Tools come from MCP servers configured in the extension settings.
 */
export class DirectEngine extends LocalEngine {
  readonly id = 'direct' as const;
  readonly capabilities: EngineCapabilities = {
    agents: false,
    fork: true,
    share: false,
    undo: false,
    compact: false,
    images: true,
    mcpToggle: true,
    permissions: true,
    providerAuth: false,
    remoteSessions: false,
  };

  private modelCache = new Map<string, { at: number; models: ModelInfo[]; error?: string }>();
  /** Tools the user allowed "always" during this window. */
  private allowed = new Set<string>();

  constructor(ctx: EngineContext, private readonly mcp: McpManager) {
    super(ctx, 'direct');
    mcp.onDidChange(() => this.emit({ type: 'mcp.changed' }));
  }

  private providers(): ReturnType<typeof resolveProvider>[] {
    const raw = this.ctx.config<ProviderConfig[]>('providers', []);
    const seen = new Set<string>();
    return (Array.isArray(raw) ? raw : [])
      .filter((p) => p && typeof p.id === 'string' && p.id && !seen.has(p.id) && seen.add(p.id))
      .map((p) => resolveProvider({ ...p, type: p.type === 'anthropic' ? 'anthropic' : 'openai-compatible' }))
      .filter((p) => p.baseUrl);
  }

  private async apiKey(p: ReturnType<typeof resolveProvider>): Promise<string | undefined> {
    const env = this.ctx.env ?? process.env;
    return (await this.ctx.secrets.get(secretKeyFor(p.id))) || p.envKeys.map((k) => env[k]).find(Boolean) || undefined;
  }

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string }> {
    const providers = this.providers();
    if (providers.length === 0) {
      return { ok: false, detail: 'No BYOK provider configured yet. Run "OpenCode Hub: Manage BYOK Providers & API Keys…" (or /providers) to add OpenAI, Anthropic, OpenRouter, Hugging Face, Ollama or any OpenAI-compatible endpoint.' };
    }
    return { ok: true };
  }

  invalidateModels(): void {
    this.modelCache.clear();
    this.state = { engine: 'direct', state: 'idle' };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    return Promise.all(
      this.providers().map(async (p) => {
        const key = await this.apiKey(p);
        const connected = p.keyless || !!key;
        let models: ModelInfo[] = (p.models ?? []).map((id) => ({ providerId: p.id, modelId: id, name: id, pricing: p.pricing?.[id], supportsTools: true }));
        if (models.length === 0 && connected) {
          const cached = this.modelCache.get(p.id);
          if (cached && Date.now() - cached.at < MODEL_CACHE_MS) {
            models = cached.models;
          } else {
            try {
              const ids = await fetchModelIds(p.type, p.baseUrl, key, p.headers);
              models = ids.map((m) => ({ providerId: p.id, modelId: m.id, name: m.name ?? m.id, pricing: p.pricing?.[m.id], supportsTools: true })).sort((a, b) => a.name.localeCompare(b.name));
              this.modelCache.set(p.id, { at: Date.now(), models });
            } catch (err) {
              this.ctx.log.warn(`Could not list models for ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
              this.modelCache.set(p.id, { at: Date.now() - MODEL_CACHE_MS + 30_000, models: [] });
            }
          }
        }
        return { id: p.id, name: p.name, connected, models };
      }),
    );
  }

  override async listMcp(): Promise<McpServerInfo[]> {
    void this.mcp.sync();
    return this.mcp.list();
  }

  override async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    await this.mcp.setEnabled(name, enabled);
  }

  protected async runTurn(turn: Turn): Promise<void> {
    const { session, input, assistant, signal } = turn;
    if (!input.model) throw new Error('Pick a model first (/model).');
    const provider = this.providers().find((p) => p.id === input.model!.providerId);
    if (!provider) throw new Error(`Provider "${input.model.providerId}" is not configured. Use /providers to add it.`);
    const apiKey = await this.apiKey(provider);
    if (!apiKey && !provider.keyless) throw new Error(`No API key stored for ${provider.name}. Use /providers to add one.`);

    const wire = ((session.meta.wire as WireMessage[] | undefined) ??= []);
    const resolved = await Promise.all(input.attachments.map(resolveAttachment));
    const blocks: WireBlock[] = [];
    const text = [input.text, attachmentsAsText(resolved)].filter(Boolean).join('\n\n');
    if (text) blocks.push({ type: 'text', text });
    for (const r of resolved) if (r.image) blocks.push({ type: 'image', mime: r.image.mime, data: r.image.data });
    wire.push({ role: 'user', blocks });

    const tools = await this.mcp.tools().catch(() => [] as McpTool[]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const system = [DEFAULT_SYSTEM_PROMPT, this.ctx.cwd() ? `Workspace folder: ${this.ctx.cwd()}` : '', this.ctx.config<string>('systemPrompt', '')].filter(Boolean).join('\n\n');
    const stream = provider.type === 'anthropic' ? streamAnthropic : streamOpenAi;
    const pricing = provider.pricing?.[input.model.modelId];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await stream(
        { baseUrl: provider.baseUrl, apiKey, headers: provider.headers, model: input.model.modelId, system, messages: wire, tools: tools.length ? tools : undefined, signal },
        { onText: (d) => assistant.text(d), onReasoning: (d) => assistant.reasoning(d) },
      );
      const usage = result.usage;
      assistant.addUsage({ ...usage, cost: usage.cost || estimateCost(usage, pricing) });

      const reply: WireBlock[] = [];
      if (result.text) reply.push({ type: 'text', text: result.text });
      for (const c of result.toolCalls) reply.push({ type: 'tool_call', id: c.id, name: c.name, args: c.args });
      if (reply.length) wire.push({ role: 'assistant', blocks: reply });
      if (result.toolCalls.length === 0) return;

      const results: WireBlock[] = [];
      for (const call of result.toolCalls) {
        const tool = byName.get(call.name);
        const label = tool ? `${tool.server} › ${tool.tool}` : call.name;
        let args: unknown = {};
        try {
          args = call.args ? JSON.parse(call.args) : {};
        } catch {
          /* handled below */
        }
        assistant.tool(call.id, { tool: label, status: 'pending', input: args });
        const done = (textOut: string, isError: boolean) => {
          assistant.tool(call.id, isError ? { status: 'error', error: textOut } : { status: 'completed', output: textOut });
          results.push({ type: 'tool_result', id: call.id, name: call.name, text: textOut, isError });
        };
        if (!tool) {
          done(`Unknown tool "${call.name}".`, true);
          continue;
        }
        if (!this.allowed.has(tool.name)) {
          const reply = await this.askPermission(session.info.id, { kind: 'mcp', title: `Allow ${label}?`, detail: JSON.stringify(args, null, 2), callId: call.id }, signal);
          if (signal.aborted) return;
          if (reply === 'reject') {
            done('The user declined this tool call.', true);
            continue;
          }
          if (reply === 'always') this.allowed.add(tool.name);
        }
        assistant.tool(call.id, { status: 'running' });
        try {
          const r = await this.mcp.call(tool, args, signal);
          done(r.text, r.isError);
        } catch (err) {
          if (signal.aborted) return;
          done(err instanceof Error ? err.message : String(err), true);
        }
      }
      wire.push({ role: 'user', blocks: results });
      assistant.breakText();
    }
    assistant.notice('warn', `Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
  }
}
