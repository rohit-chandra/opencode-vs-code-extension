import type * as vscode from 'vscode';
import type { EngineContext } from '../../core/engine';
import { attachmentsAsText, resolveAttachment } from '../../core/attachments';
import { LocalEngine } from '../../core/localEngine';
import type { Turn } from '../../core/localEngine';
import type { McpManager, McpTool } from '../../mcp/manager';
import { ASK_USER_TOOL } from '../../shared/questions';
import type { EngineCapabilities, McpServerInfo, ProviderInfo } from '../../shared/types';
import { DEFAULT_SYSTEM_PROMPT } from '../direct/engine';
import type { ToolSpec, WireBlock, WireMessage } from '../direct/wire';

/** The slice of the `vscode` module this engine uses; injected so the engine can be tested without VS Code. */
export type LmApi = Pick<typeof vscode, 'lm' | 'LanguageModelChatMessage' | 'LanguageModelTextPart' | 'LanguageModelToolCallPart' | 'LanguageModelToolResultPart' | 'CancellationTokenSource'>;

const MAX_TOOL_ROUNDS = 30;

/**
 * VS Code Language Model engine: uses the models VS Code exposes through `vscode.lm` —
 * GitHub Copilot with the user's subscription, plus models contributed by other extensions.
 * VS Code asks the user for consent the first time an extension uses a model.
 */
export class VscodeLmEngine extends LocalEngine {
  readonly id = 'vscode-lm' as const;
  readonly capabilities: EngineCapabilities = {
    agents: false,
    fork: true,
    share: false,
    undo: false,
    compact: false,
    images: false,
    mcpToggle: true,
    permissions: true,
    providerAuth: false,
    remoteSessions: false,
  };

  private allowed = new Set<string>();
  /** Models that failed when offered the question tool, in this window. */
  private noTools = new Set<string>();

  constructor(ctx: EngineContext, private readonly vs: LmApi, private readonly mcp: McpManager) {
    super(ctx, 'vscode-lm');
    mcp.onDidChange(() => this.emit({ type: 'mcp.changed' }));
    vs.lm.onDidChangeChatModels?.(() => {
      if (this.state.state !== 'ready') this.state = { engine: 'vscode-lm', state: 'idle' };
      this.emit({ type: 'catalog.changed' });
    });
  }

  private async models(): Promise<vscode.LanguageModelChat[]> {
    if (!this.vs.lm?.selectChatModels) return [];
    return [...(await this.vs.lm.selectChatModels({}))];
  }

  protected async checkAvailability(): Promise<{ ok: boolean; detail?: string }> {
    const models = await this.models();
    if (models.length === 0) {
      return { ok: false, detail: 'No VS Code language models found. Install and sign in to GitHub Copilot Chat (or another extension that provides chat models), then restart this engine.' };
    }
    return { ok: true };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const byVendor = new Map<string, ProviderInfo>();
    for (const m of await this.models()) {
      const p = byVendor.get(m.vendor) ?? { id: m.vendor, name: m.vendor === 'copilot' ? 'GitHub Copilot' : m.vendor, connected: true, models: [] };
      if (!p.models.some((x) => x.modelId === m.id)) p.models.push({ providerId: m.vendor, modelId: m.id, name: m.name || m.id, contextWindow: m.maxInputTokens, supportsTools: true });
      byVendor.set(m.vendor, p);
    }
    return [...byVendor.values()];
  }

  override async listMcp(): Promise<McpServerInfo[]> {
    void this.mcp.sync();
    return this.mcp.list();
  }

  override async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    await this.mcp.setEnabled(name, enabled);
  }

  private toLmMessages(system: string, wire: WireMessage[]): vscode.LanguageModelChatMessage[] {
    const { LanguageModelChatMessage: Msg, LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result } = this.vs;
    // The LM API has no system role; the convention is to send instructions as the first user message.
    const out: vscode.LanguageModelChatMessage[] = [Msg.User(system)];
    for (const m of wire) {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart)[] = [];
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text) parts.push(new Text(b.text));
        else if (b.type === 'tool_call') parts.push(new Call(b.id, b.name, safeObject(b.args)));
        else if (b.type === 'tool_result') parts.push(new Result(b.id, [new Text(b.text)]));
      }
      if (parts.length === 0) continue;
      out.push(m.role === 'assistant' ? Msg.Assistant(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]) : Msg.User(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[]));
    }
    return out;
  }

  protected async runTurn(turn: Turn): Promise<void> {
    const { session, input, assistant, signal } = turn;
    if (!input.model) throw new Error('Pick a model first (/model).');
    const [model] = await this.vs.lm.selectChatModels({ vendor: input.model.providerId, id: input.model.modelId });
    if (!model) throw new Error(`Model ${input.model.providerId}/${input.model.modelId} is no longer available.`);

    const wire = ((session.meta.wire as WireMessage[] | undefined) ??= []);
    const resolved = await Promise.all(input.attachments.map(resolveAttachment));
    const text = [input.text, attachmentsAsText(resolved)].filter(Boolean).join('\n\n');
    if (resolved.some((r) => r.image)) assistant.notice('warn', 'Images are not supported by this engine and were skipped.');
    wire.push({ role: 'user', blocks: [{ type: 'text', text }] });

    const mcpTools = await this.mcp.tools().catch(() => [] as McpTool[]);
    const byName = new Map(mcpTools.map((t) => [t.name, t]));
    // The model may ask clarifying questions through a tool of ours, unless it turned out not to take tools.
    const modelKey = `${input.model.providerId}/${input.model.modelId}`;
    let askUser = this.offersAskUser() && !this.noTools.has(modelKey);
    const offered = (): ToolSpec[] => (askUser ? [...mcpTools, ASK_USER_TOOL] : mcpTools);
    const system = [DEFAULT_SYSTEM_PROMPT, this.ctx.cwd() ? `Workspace folder: ${this.ctx.cwd()}` : '', this.ctx.config<string>('systemPrompt', '')].filter(Boolean).join('\n\n');

    const cts = new this.vs.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const messages = this.toLmMessages(system, wire);
        let replyText = '';
        const calls: { id: string; name: string; input: object }[] = [];
        for (;;) {
          let received = false;
          try {
            const tools = offered();
            const response = await model.sendRequest(
              messages,
              {
                justification: 'OpenCode Hub sends your chat messages to the model you selected.',
                tools: tools.length ? tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : undefined,
              },
              cts.token,
            );
            for await (const part of response.stream) {
              received = true;
              if (part instanceof this.vs.LanguageModelTextPart) {
                replyText += part.value;
                assistant.text(part.value);
              } else if (part instanceof this.vs.LanguageModelToolCallPart) {
                calls.push({ id: part.callId, name: part.name, input: part.input });
              }
            }
            break;
          } catch (err) {
            // A model that takes no tools fails the request when our question tool is the only one
            // offered: send it again without, and remember that for the model.
            // Consent, quota and "model gone" are about the account, not the tools: those go to the user as they are.
            const code = (err as { code?: string } | null)?.code;
            if (signal.aborted || received || !askUser || mcpTools.length > 0 || code === 'NoPermissions' || code === 'Blocked' || code === 'NotFound') throw err;
            askUser = false;
            this.noTools.add(modelKey);
            this.ctx.log.info(`${modelKey} failed with the question tool offered; trying again without tools (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        // The LM API reports no token usage, so these are estimates from the model's own tokenizer.
        const promptText = wire.map((m) => m.blocks.map((b) => ('text' in b ? b.text : 'args' in b ? b.args : '')).join('\n')).join('\n');
        const [inTok, outTok] = await Promise.all([model.countTokens(system + '\n' + promptText, cts.token).then(Number, () => 0), model.countTokens(replyText || ' ', cts.token).then(Number, () => 0)]);
        assistant.addUsage({ input: inTok, output: outTok });

        const reply: WireBlock[] = [];
        if (replyText) reply.push({ type: 'text', text: replyText });
        for (const c of calls) reply.push({ type: 'tool_call', id: c.id, name: c.name, args: JSON.stringify(c.input ?? {}) });
        if (reply.length) wire.push({ role: 'assistant', blocks: reply });
        if (calls.length === 0) return;

        const results: WireBlock[] = [];
        for (const call of calls) {
          const tool = byName.get(call.name);
          const asking = askUser && call.name === ASK_USER_TOOL.name;
          const label = asking ? 'Question' : tool ? `${tool.server} › ${tool.tool}` : call.name;
          assistant.tool(call.id, { tool: label, status: 'pending', input: call.input });
          const done = (out: string, isError: boolean) => {
            assistant.tool(call.id, isError ? { status: 'error', error: out } : { status: 'completed', output: out });
            results.push({ type: 'tool_result', id: call.id, name: call.name, text: out, isError });
          };
          if (asking) {
            assistant.tool(call.id, { status: 'running' });
            const answered = await this.runAskUser(session.info.id, call.input, signal);
            if (signal.aborted) return;
            done(answered.text, answered.isError);
            continue;
          }
          if (!tool) {
            done(`Unknown tool "${call.name}".`, true);
            continue;
          }
          if (!this.allowed.has(tool.name)) {
            const answer = await this.askPermission(session.info.id, { kind: 'mcp', title: `Allow ${label}?`, detail: JSON.stringify(call.input, null, 2), callId: call.id }, signal);
            if (signal.aborted) return;
            if (answer === 'reject') {
              done('The user declined this tool call.', true);
              continue;
            }
            if (answer === 'always') this.allowed.add(tool.name);
          }
          assistant.tool(call.id, { status: 'running' });
          try {
            const r = await this.mcp.call(tool, call.input, signal);
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
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'NoPermissions') throw new Error('VS Code has not been given permission to use this model. Send the message again and accept the consent prompt.', { cause: err });
      if (code === 'Blocked') throw new Error('The request was blocked (quota or content filter).', { cause: err });
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }
}

function safeObject(json: string): object {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
