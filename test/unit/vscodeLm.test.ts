import { describe, expect, it } from 'vitest';
import { VscodeLmEngine } from '../../src/engines/vscodeLm/engine';
import type { LmApi } from '../../src/engines/vscodeLm/engine';
import type { McpManager, McpTool } from '../../src/mcp/manager';
import { makeContext, record } from '../helpers/context';

/* A stand-in for the `vscode.lm` API surface the engine uses (GitHub Copilot models in real life). */
class TextPart {
  constructor(public value: string) {}
}
class ToolCallPart {
  constructor(public callId: string, public name: string, public input: object) {}
}
class ToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}
const Message = {
  User: (content: unknown) => ({ role: 'user', content }),
  Assistant: (content: unknown) => ({ role: 'assistant', content }),
};
class TokenSource {
  cancelled = false;
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel() {
    this.cancelled = true;
  }
  dispose() {}
}

interface FakeModel {
  vendor: string;
  id: string;
  name: string;
  family: string;
  maxInputTokens: number;
  requests: { messages: { role: string; content: unknown }[]; options: { tools?: { name: string }[]; justification?: string } }[];
  sendRequest(messages: { role: string; content: unknown }[], options: { tools?: { name: string }[] }): Promise<{ stream: AsyncIterable<unknown> }>;
  countTokens(text: string): Promise<number>;
}

function fakeModel(script: (call: number) => unknown[]): FakeModel {
  const model: FakeModel = {
    vendor: 'copilot',
    id: 'gpt-x',
    name: 'GPT X',
    family: 'gpt',
    maxInputTokens: 128000,
    requests: [],
    async sendRequest(messages, options) {
      model.requests.push({ messages, options });
      const parts = script(model.requests.length);
      return {
        stream: (async function* () {
          for (const p of parts) yield p;
        })(),
      };
    },
    countTokens: async (text) => Math.ceil(text.length / 4),
  };
  return model;
}

function makeEngine(models: FakeModel[], tools: McpTool[] = [], calls: unknown[] = []) {
  const ctx = makeContext({ cwd: '/work/app', settings: { systemPrompt: 'Prefer TypeScript.' } });
  const lm = {
    lm: { selectChatModels: async (sel: { vendor?: string; id?: string }) => models.filter((m) => (!sel.vendor || m.vendor === sel.vendor) && (!sel.id || m.id === sel.id)), onDidChangeChatModels: () => ({ dispose() {} }) },
    LanguageModelChatMessage: Message,
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    CancellationTokenSource: TokenSource,
  } as unknown as LmApi;
  const mcp = {
    onDidChange: () => ({ dispose() {} }),
    sync: async () => undefined,
    list: () => [{ name: 'srv', status: 'connected', enabled: true, canToggle: true }],
    tools: async () => tools,
    call: async (tool: McpTool, args: unknown) => {
      calls.push({ tool: tool.name, args });
      return { text: 'tool says 42', isError: false };
    },
    setEnabled: async () => undefined,
  } as unknown as McpManager;
  return { ctx, engine: new VscodeLmEngine(ctx, lm, mcp) };
}

describe('VS Code LM engine (Copilot path) with a fake vscode.lm', () => {
  it('is unavailable without models and says how to get them', async () => {
    const { engine, ctx } = makeEngine([]);
    const status = await engine.start();
    expect(status.state).toBe('unavailable');
    expect(status.detail).toMatch(/GitHub Copilot Chat/);
    ctx.cleanup();
  });

  it('lists models grouped by vendor', async () => {
    const { engine, ctx } = makeEngine([fakeModel(() => []), { ...fakeModel(() => []), vendor: 'opencodego', id: 'kimi', name: 'Kimi' }]);
    expect((await engine.start()).state).toBe('ready');
    expect((await engine.listProviders()).map((p) => [p.id, p.name, p.models.map((m) => m.modelId)])).toEqual([
      ['copilot', 'GitHub Copilot', ['gpt-x']],
      ['opencodego', 'opencodego', ['kimi']],
    ]);
    expect(await engine.defaultModel()).toEqual({ providerId: 'copilot', modelId: 'gpt-x' });
    ctx.cleanup();
  });

  it('streams a reply, keeps history and estimates usage with the model tokenizer', async () => {
    const model = fakeModel((n) => [new TextPart(n === 1 ? 'Hello ' : 'Again'), new TextPart(n === 1 ? 'there' : '')]);
    const { engine, ctx } = makeEngine([model]);
    await engine.start();
    const rec = record(engine);
    const session = await engine.createSession();
    const ref = { providerId: 'copilot', modelId: 'gpt-x' };
    await engine.sendPrompt(session.id, { text: 'first question', attachments: [], model: ref });
    await rec.waitIdle(session.id);
    await engine.sendPrompt(session.id, { text: 'second question', attachments: [], model: ref });
    await rec.waitIdle(session.id);

    const messages = rec.messages(session.id);
    expect(messages[1].parts).toMatchObject([{ type: 'text', text: 'Hello there' }]);
    expect(messages[1].usage!.input).toBeGreaterThan(0);
    expect(messages[1].usage!.output).toBe(Math.ceil('Hello there'.length / 4));
    // System instructions go first as a user message (the LM API has no system role), then the history.
    const second = model.requests[1].messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
    expect(String(second[0].content)).toContain('Prefer TypeScript.');
    expect(String(second[0].content)).toContain('Workspace folder: /work/app');
    expect(model.requests[0].options.justification).toMatch(/OpenCode Hub/);
    expect(model.requests[0].options.tools).toBeUndefined();
    ctx.cleanup();
  });

  it('runs MCP tool calls with permission and returns the result to the model', async () => {
    const tool: McpTool = { name: 'srv__lookup', server: 'srv', tool: 'lookup', description: 'Look something up', inputSchema: { type: 'object' } };
    const calls: unknown[] = [];
    const model = fakeModel((n) => (n === 1 ? [new TextPart('Checking. '), new ToolCallPart('call_1', 'srv__lookup', { q: 'answer' })] : [new TextPart('It is 42.')]));
    const { engine, ctx } = makeEngine([model], [tool], calls);
    await engine.start();
    const rec = record(engine);
    const session = await engine.createSession();
    const asked = rec.waitFor('permission.asked');
    await engine.sendPrompt(session.id, { text: 'what is the answer?', attachments: [], model: { providerId: 'copilot', modelId: 'gpt-x' } });
    const { request } = await asked;
    expect(request.title).toBe('Allow srv › lookup?');
    await engine.replyPermission(session.id, request.id, 'once');
    await rec.waitIdle(session.id);

    expect(calls).toEqual([{ tool: 'srv__lookup', args: { q: 'answer' } }]);
    expect(rec.messages(session.id)[1].parts).toMatchObject([
      { type: 'text', text: 'Checking. ' },
      { type: 'tool', tool: 'srv › lookup', status: 'completed', output: 'tool says 42' },
      { type: 'text', text: 'It is 42.' },
    ]);
    expect(model.requests[0].options.tools).toEqual([{ name: 'srv__lookup', description: 'Look something up', inputSchema: { type: 'object' } }]);
    // Second request carries the tool call and its result.
    const followUp = model.requests[1].messages;
    expect(followUp.at(-2)!.content).toEqual([new TextPart('Checking. '), new ToolCallPart('call_1', 'srv__lookup', { q: 'answer' })]);
    expect(followUp.at(-1)!.content).toEqual([new ToolResultPart('call_1', [new TextPart('tool says 42')])]);
    ctx.cleanup();
  });

  it('turns consent and quota errors into clear messages', async () => {
    const model = fakeModel(() => []);
    model.sendRequest = async () => {
      throw Object.assign(new Error('no'), { code: 'NoPermissions' });
    };
    const { engine, ctx } = makeEngine([model]);
    await engine.start();
    const rec = record(engine);
    const session = await engine.createSession();
    await engine.sendPrompt(session.id, { text: 'hi', attachments: [], model: { providerId: 'copilot', modelId: 'gpt-x' } });
    await rec.waitIdle(session.id);
    expect(rec.messages(session.id)[1].error).toMatch(/accept the consent prompt/);
    await engine.sendPrompt(session.id, { text: 'hi', attachments: [], model: { providerId: 'copilot', modelId: 'gone' } });
    await rec.waitIdle(session.id);
    expect(rec.messages(session.id)[3].error).toMatch(/no longer available/);
    ctx.cleanup();
  });
});
