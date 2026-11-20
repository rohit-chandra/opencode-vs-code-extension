#!/usr/bin/env node
// Deterministic mock LLM server used by the test suites.
// Speaks three wire formats so every engine can be exercised offline:
//   POST /v1/chat/completions   (OpenAI-compatible, streaming + non-streaming)
//   POST /v1/messages           (Anthropic Messages, streaming + non-streaming)
//   POST /v1/responses          (OpenAI Responses, streaming)
//   GET  /v1/models
// Behaviour:
//   - Replies "MOCK[<model>]: <last user text>" split into small chunks.
//   - If the last user text contains `[[tool:NAME {json}]]` and a tool called NAME was
//     offered, it emits a tool call instead; after the tool result it replies
//     "TOOL_RESULT: <result text>". `[[tool!:NAME {json}]]` skips the "was offered" check.
//   - If the last user text contains `[[think]]` it emits reasoning first.
//   - If the last user text contains `[[error]]` it responds with HTTP 500.
//   - If the last user text contains `[[slow]]` the chat-completions stream pauses 150 ms per chunk.
//   - A model whose name contains `-notools` rejects requests that carry tools, and one whose name
//     contains `-noeffort` rejects a reasoning effort, both with HTTP 400.
//   - A model named `<anything>-ctx<N>` has a context window of N tokens (4 characters each):
//     larger requests get HTTP 400 with the provider's usual "too long" error.
import http from 'node:http';

const USAGE = { prompt: 120, completion: 30, cached: 20, reasoning: 5 };

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((c) => c.type === 'text' || c.type === 'input_text').map((c) => c.text).join('\n');
      if (t) return t;
    }
  }
  return '';
}

function lastToolResult(messages) {
  const m = messages[messages.length - 1];
  if (!m) return undefined;
  if (m.role === 'tool') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  if (m.role === 'user' && Array.isArray(m.content)) {
    const tr = m.content.find((c) => c.type === 'tool_result');
    if (tr) return typeof tr.content === 'string' ? tr.content : (tr.content || []).map((c) => c.text ?? '').join('');
  }
  if (m.type === 'function_call_output') return typeof m.output === 'string' ? m.output : JSON.stringify(m.output);
  return undefined;
}

function plan(body, messages, toolNames) {
  const toolResult = lastToolResult(messages);
  if (toolResult !== undefined) return { kind: 'text', text: `TOOL_RESULT: ${toolResult}` };
  const text = lastUserText(messages);
  const m = /\[\[tool(!?):([\w.-]+)\s*(\{.*?\})?\]\]/s.exec(text);
  // `[[tool:...]]` only fires when the tool was offered; `[[tool!:...]]` fires regardless
  // (for clients that defer tool definitions, such as Claude Code's tool search).
  if (m && (m[1] === '!' || toolNames.includes(m[2]))) return { kind: 'tool', name: m[2], args: m[3] || '{}' };
  const isTitle = /title/i.test(JSON.stringify(body.messages?.[0] ?? body.system ?? '').slice(0, 400)) && text.length < 2000 && /generate a (brief |short )?title|title generator/i.test(JSON.stringify(body).slice(0, 3000));
  if (isTitle) return { kind: 'text', text: 'Mock session title' };
  return { kind: 'text', text: `MOCK[${body.model}]: ${text.replace(/\[\[\w+\]\]/g, '').trim()}`, think: text.includes('[[think]]') };
}

/** Tokens over the window of a `-ctx<N>` model, or undefined when the request fits. */
function overflow(body) {
  const m = /-ctx(\d+)$/.exec(String(body.model ?? ''));
  if (!m) return undefined;
  const limit = Number(m[1]);
  const tokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  return tokens > limit ? { tokens, limit } : undefined;
}

function chunks(s, n = 8) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockLlm({ delayMs = 2 } = {}) {
  /** Requests received by this instance (path, auth headers, parsed body). */
  const log = [];
  /** What `GET /models` lists. Tests add and remove ids to play a provider releasing or retiring a model. */
  const models = ['mock-small', 'mock-large'];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/v1/, '');
    if (req.method === 'GET' && p === '/models') {
      log.push({ path: '/models', headers: { authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'] }, body: {} });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })) }));
      return;
    }
    if (req.method === 'GET' && p === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
    const body = await readBody(req);
    log.push({ path: p, headers: { authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'] }, body });
    if (log.length > 200) log.shift();

    // Models that refuse a setting, the way real ones do: HTTP 400 naming the parameter.
    const modelName = String(body.model ?? '');
    const refuse = (message) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } })); };
    if (/-notools/.test(modelName) && body.tools?.length) return refuse(`${modelName} does not support tools`);
    if (/-noeffort/.test(modelName) && (body.reasoning_effort || body.output_config?.effort)) return refuse("Unsupported parameter: 'reasoning_effort' is not supported with this model.");

    // ---------------- OpenAI chat completions ----------------
    if (p === '/chat/completions') {
      const messages = body.messages || [];
      if (lastUserText(messages).includes('[[error]]')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } })); return; }
      const over = overflow(body);
      if (over) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${over.limit} tokens. However, your messages resulted in ${over.tokens} tokens. Please reduce the length of the messages.`, type: 'invalid_request_error', code: 'context_length_exceeded' } })); return; }
      const slow = lastUserText(messages).includes('[[slow]]'); // stream slowly enough to be stopped
      const pl = plan(body, messages, (body.tools || []).map((t) => t.function?.name));
      const usage = { prompt_tokens: USAGE.prompt, completion_tokens: USAGE.completion, total_tokens: USAGE.prompt + USAGE.completion, prompt_tokens_details: { cached_tokens: USAGE.cached }, completion_tokens_details: { reasoning_tokens: pl.think ? USAGE.reasoning : 0 } };
      const id = 'chatcmpl-mock' + Date.now();
      if (!body.stream) {
        const message = pl.kind === 'tool'
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock1', type: 'function', function: { name: pl.name, arguments: pl.args } }] }
          : { role: 'assistant', content: pl.text };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: pl.kind === 'tool' ? 'tool_calls' : 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      send({ role: 'assistant', content: '' });
      if (pl.kind === 'tool') {
        send({ tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: pl.name, arguments: '' } }] });
        for (const c of chunks(pl.args, 6)) { send({ tool_calls: [{ index: 0, function: { arguments: c } }] }); await sleep(slow ? 150 : delayMs); }
        send({}, 'tool_calls');
      } else {
        if (pl.think) for (const c of chunks('Thinking about it...')) { send({ reasoning_content: c }); await sleep(slow ? 150 : delayMs); }
        for (const c of chunks(pl.text)) { send({ content: c }); await sleep(slow ? 150 : delayMs); }
        send({}, 'stop');
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // ---------------- Anthropic messages ----------------
    if (p === '/messages') {
      const messages = body.messages || [];
      if (lastUserText(messages).includes('[[error]]')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } })); return; }
      const over = overflow(body);
      if (over) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${over.tokens} tokens > ${over.limit} maximum` } })); return; }
      const pl = plan(body, messages, (body.tools || []).map((t) => t.name));
      const usage = { input_tokens: USAGE.prompt - USAGE.cached, output_tokens: USAGE.completion, cache_read_input_tokens: USAGE.cached, cache_creation_input_tokens: 0 };
      const id = 'msg_mock' + Date.now();
      if (!body.stream) {
        const content = pl.kind === 'tool' ? [{ type: 'tool_use', id: 'toolu_mock1', name: pl.name, input: JSON.parse(pl.args) }] : [{ type: 'text', text: pl.text }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: pl.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      let idx = 0;
      if (pl.kind === 'tool') {
        ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_mock1', name: pl.name, input: {} } });
        for (const c of chunks(pl.args, 6)) { ev('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: c } }); await sleep(delayMs); }
        ev('content_block_stop', { index: idx });
        ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      } else {
        if (pl.think) {
          ev('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '' } });
          for (const c of chunks('Thinking about it...')) { ev('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: c } }); await sleep(delayMs); }
          ev('content_block_stop', { index: idx });
          idx++;
        }
        ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
        for (const c of chunks(pl.text)) { ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: c } }); await sleep(delayMs); }
        ev('content_block_stop', { index: idx });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      }
      ev('message_stop', {});
      res.end();
      return;
    }

    // ---------------- OpenAI responses ----------------
    if (p === '/responses') {
      const input = Array.isArray(body.input) ? body.input : [{ role: 'user', content: String(body.input ?? '') }];
      const pl = plan(body, input, (body.tools || []).map((t) => t.name));
      const usage = { input_tokens: USAGE.prompt, input_tokens_details: { cached_tokens: USAGE.cached }, output_tokens: USAGE.completion, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: USAGE.prompt + USAGE.completion };
      const id = 'resp_mock' + Date.now();
      const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'in_progress', output: [] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let seq = 0;
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      ev('response.created', { response: base });
      let item;
      if (pl.kind === 'tool') {
        item = { type: 'function_call', id: 'fc_mock1', call_id: 'call_mock1', name: pl.name, arguments: pl.args, status: 'completed' };
        ev('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
        ev('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: pl.args });
        ev('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: pl.args });
        ev('response.output_item.done', { output_index: 0, item });
      } else {
        item = { type: 'message', id: 'msg_mock1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: pl.text, annotations: [] }] };
        ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        ev('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        for (const c of chunks(pl.text)) { ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: c }); await sleep(delayMs); }
        ev('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: pl.text });
        ev('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
        ev('response.output_item.done', { output_index: 0, item });
      }
      ev('response.completed', { response: { ...base, status: 'completed', output: [item], usage } });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown path ' + p } }));
  });
  return {
    server,
    log,
    models,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.env.PORT || process.argv[2] || 0);
  const mock = createMockLlm();
  mock.listen(port).then((p) => console.log(`mock-llm listening on http://127.0.0.1:${p}`));
}
