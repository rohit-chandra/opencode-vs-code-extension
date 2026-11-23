import type { EngineContext } from '../../core/engine';
import { attachmentsAsText, resolveAttachment } from '../../core/attachments';
import { catalogProviderFor, listPrice } from '../../core/listPrices';
import type { Pricing } from '../../core/listPrices';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import { estimateCost } from '../../core/usageLedger';
import type { McpManager, McpTool } from '../../mcp/manager';
import { toEffortLevels } from '../../shared/effort';
import { ASK_USER_TOOL } from '../../shared/questions';
import { totalTokens } from '../../shared/types';
import type { EffortLevel, EngineCapabilities, McpServerInfo, ModelInfo, ModelRef, ProviderInfo } from '../../shared/types';
import { dropOldestTurns, isContextOverflow, startForBudget } from './context';
import { resolveProvider, secretKeyFor } from './presets';
import type { ProviderConfig } from './presets';
import { fetchModelIds, streamAnthropic, streamOpenAi } from './wire';
import type { StreamResult, ToolSpec, WireBlock, WireMessage } from './wire';

const MAX_TOOL_ROUNDS = 30;

/**
 * Effort levels offered for a provider. A BYOK endpoint does not say which models think, so
 * every model gets the levels its API takes; a model that rejects the setting is sent again
 * without it (see `runTurn`). OpenAI-compatible: `reasoning_effort`. Anthropic: `output_config.effort`.
 */
const OPENAI_EFFORTS = toEffortLevels(['low', 'medium', 'high'])!;
const ANTHROPIC_EFFORTS = toEffortLevels(['low', 'medium', 'high', 'xhigh', 'max'])!;
function effortsFor(type: string): EffortLevel[] {
  return type === 'anthropic' ? ANTHROPIC_EFFORTS : OPENAI_EFFORTS;
}

/** The provider refused the request itself (as opposed to the key, the rate or the server). */
function isRejectedRequest(err: unknown): boolean {
  return /\((400|422)\)/.test(err instanceof Error ? err.message : String(err ?? ''));
}
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
  /** `provider/model` pairs that refused an effort level, or tool definitions, in this window. */
  private noEffort = new Set<string>();
  private noTools = new Set<string>();

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
    this.noEffort.clear();
    this.noTools.clear();
    this.state = { engine: 'direct', state: 'idle' };
  }

  /** A provider's own list of models (`GET /models`), as the picker shows it. */
  private async fetchModels(p: ReturnType<typeof resolveProvider>, key: string | undefined): Promise<ModelInfo[]> {
    const efforts = effortsFor(p.type);
    const ids = await fetchModelIds(p.type, p.baseUrl, key, p.headers);
    return ids.map((m) => ({ providerId: p.id, modelId: m.id, name: m.name ?? m.id, pricing: p.pricing?.[m.id], supportsTools: true, efforts })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Minimum age of a provider's list before `refreshModels` asks the provider again. */
  modelRecheckMs = 10_000;

  /**
   * Ask each provider for its models again, in the background (see `Engine.refreshModels`):
   * a provider adds and retires models without telling anyone. A provider that cannot be
   * reached keeps the list it had.
   */
  refreshModels(): void {
    void (async () => {
      let changed = false;
      await Promise.all(
        this.providers().map(async (p) => {
          // A list written in the settings is the user's; there is nothing to ask.
          if ((p.models ?? []).length > 0) return;
          const cached = this.modelCache.get(p.id);
          // Never listed (listProviders does that), or listed a moment ago.
          if (!cached || Date.now() - cached.at < this.modelRecheckMs) return;
          const key = await this.apiKey(p);
          if (!p.keyless && !key) return;
          try {
            const models = await this.fetchModels(p, key);
            if (models.map((m) => m.modelId).join('\n') !== cached.models.map((m) => m.modelId).join('\n')) changed = true;
            this.modelCache.set(p.id, { at: Date.now(), models });
          } catch (err) {
            this.ctx.log.debug(`Could not refresh the models of ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
      if (changed) this.emit({ type: 'catalog.changed' });
    })();
  }

  async listProviders(): Promise<ProviderInfo[]> {
    return Promise.all(
      this.providers().map(async (p) => {
        const key = await this.apiKey(p);
        const connected = p.keyless || !!key;
        const efforts = effortsFor(p.type);
        let models: ModelInfo[] = (p.models ?? []).map((id) => ({ providerId: p.id, modelId: id, name: id, pricing: p.pricing?.[id], supportsTools: true, efforts }));
        if (models.length === 0 && connected) {
          const cached = this.modelCache.get(p.id);
          if (cached && Date.now() - cached.at < MODEL_CACHE_MS) {
            models = cached.models;
          } else {
            try {
              models = await this.fetchModels(p, key);
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

  /** Prices set in settings win; otherwise the list price of a known provider. Local servers cost nothing. */
  protected override listPricing(model: ModelRef): Pricing | undefined {
    const p = this.providers().find((x) => x.id === model.providerId);
    if (!p || p.keyless) return undefined;
    return p.pricing?.[model.modelId] ?? listPrice(catalogProviderFor(p.baseUrl), model.modelId);
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

    const mcpTools = await this.mcp.tools().catch(() => [] as McpTool[]);
    const byName = new Map(mcpTools.map((t) => [t.name, t]));
    const modelKey = `${provider.id}/${input.model.modelId}`;
    // The model may ask clarifying questions through a tool of ours, unless it turned out not to take tools.
    let askUser = this.offersAskUser() && !this.noTools.has(modelKey);
    const offered = (): ToolSpec[] => (askUser ? [...mcpTools, ASK_USER_TOOL] : mcpTools);
    let effort = input.effort && !this.noEffort.has(modelKey) ? input.effort : undefined;
    const system = [DEFAULT_SYSTEM_PROMPT, this.ctx.cwd() ? `Workspace folder: ${this.ctx.cwd()}` : '', this.ctx.config<string>('systemPrompt', '')].filter(Boolean).join('\n\n');
    const stream = provider.type === 'anthropic' ? streamAnthropic : streamOpenAi;
    const pricing = provider.pricing?.[input.model.modelId];

    // Where sending starts. Older turns stay in the saved conversation and on screen; they are
    // only left out of the request once the model's context window is full.
    let start = Math.min(Math.max(0, Number(session.meta.wireStart) || 0), wire.length - 1);
    let told = false;
    const leftOut = (next: number) => {
      start = next;
      session.meta.wireStart = next;
      if (!told) assistant.notice('info', 'This conversation no longer fits in the model\'s context window, so the oldest messages were left out of the request. Start a new session (/new) for a fresh context.');
      told = true;
    };
    const budget = Math.floor(this.ctx.config<number>('direct.maxContextTokens', 0));
    if (budget > 0) {
      const fit = startForBudget(wire, budget, start);
      if (fit > start) leftOut(fit);
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let result: StreamResult;
      for (;;) {
        try {
          result = await stream(
            { baseUrl: provider.baseUrl, apiKey, headers: provider.headers, model: input.model.modelId, system, messages: start ? wire.slice(start) : wire, tools: offered().length ? offered() : undefined, effort, signal },
            { onText: (d) => assistant.text(d), onReasoning: (d) => assistant.reasoning(d) },
          );
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (!isContextOverflow(err)) {
            // Not every model takes tools or an effort level, and a BYOK endpoint does not say which
            // do. Send the request again without the part it refused, and remember that for the model.
            if (askUser && mcpTools.length === 0 && isRejectedRequest(err) && /tool|function/i.test(message)) {
              askUser = false;
              this.noTools.add(modelKey);
              this.ctx.log.info(`Direct BYOK: ${modelKey} does not take tools, so it cannot ask questions through the chat (${message})`);
              continue;
            }
            if (effort && isRejectedRequest(err)) {
              this.ctx.log.info(`Direct BYOK: ${modelKey} refused effort "${effort}" (${message})`);
              assistant.notice('info', `${input.model.modelId} did not accept the "${effort}" effort level, so this reply uses the model's default.`);
              this.noEffort.add(modelKey);
              effort = undefined;
              continue;
            }
            throw err;
          }
          const next = dropOldestTurns(wire, start);
          if (next === start) throw new Error(`${err instanceof Error ? err.message : String(err)} Your last message (with its attachments and tool results) is larger than the model's context window on its own. Attach less, or pick a model with a larger window.`, { cause: err });
          this.ctx.log.info(`Direct BYOK: context window full for ${input.model.modelId}, leaving out messages before #${next}`);
          leftOut(next);
        }
      }
      const usage = result.usage;
      assistant.addUsage({ ...usage, cost: usage.cost || estimateCost(usage, pricing) });
      assistant.modelCall(totalTokens(usage));

      const reply: WireBlock[] = [];
      if (result.text) reply.push({ type: 'text', text: result.text });
      for (const c of result.toolCalls) reply.push({ type: 'tool_call', id: c.id, name: c.name, args: c.args });
      if (reply.length) wire.push({ role: 'assistant', blocks: reply });
      if (result.toolCalls.length === 0) return;

      const results: WireBlock[] = [];
      for (const call of result.toolCalls) {
        const tool = byName.get(call.name);
        const asking = askUser && call.name === ASK_USER_TOOL.name;
        const label = asking ? 'Question' : tool ? `${tool.server} › ${tool.tool}` : call.name;
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
        if (asking) {
          assistant.tool(call.id, { status: 'running' });
          const answer = await this.runAskUser(session.info.id, args, signal);
          if (signal.aborted) return;
          done(answer.text, answer.isError);
          continue;
        }
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
