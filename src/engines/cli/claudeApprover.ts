import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { QUESTIONS_SKIPPED, answersByQuestion, parseQuestions } from '../../shared/questions';
import type { PermissionReply, PermissionRequest, QuestionItem } from '../../shared/types';

/**
 * Lets Claude Code ask the user before it acts, although it runs non-interactively.
 *
 * Claude Code's `--permission-prompt-tool` names an MCP tool that it calls whenever a tool
 * needs approval. We give it a tiny stdio MCP server (written to the extension's storage)
 * that forwards each call over HTTP on 127.0.0.1 to this process, where the request is shown
 * in the chat. The answer goes back as `{"behavior":"allow"|"deny", ...}`.
 *
 * Claude Code's own question tool (`AskUserQuestion`) arrives the same way. It is not a
 * permission: the questions are shown in the chat, and the answers go back inside the tool's
 * input (`answers`: question text to answer), which is where the tool reads them from.
 */

/** Claude Code's tool for asking the user clarifying questions. */
export const ASK_TOOL = 'AskUserQuestion';

export const APPROVER_SERVER = 'ochub_approver';
export const APPROVER_TOOL = `mcp__${APPROVER_SERVER}__approve`;

type Ask = (request: Omit<PermissionRequest, 'id' | 'sessionId'>) => Promise<PermissionReply>;
/** Resolves to one list of answers per question, or `null` when the user skips them. */
type AskQuestions = (questions: QuestionItem[]) => Promise<string[][] | null>;

interface Turn {
  ask: Ask;
  questions: AskQuestions;
  /** Tools the user chose "Always allow" for, in this session. */
  always: Set<string>;
}

export class ClaudeApprover {
  private server: http.Server | undefined;
  private port = 0;
  private turns = new Map<string, Turn>();

  constructor(private readonly storageDir: string) {}

  /** Register a turn; returns the MCP server definition to hand to Claude Code, and a disposer. */
  async open(ask: Ask, always: Set<string>, questions: AskQuestions): Promise<{ server: Record<string, unknown>; close: () => void }> {
    await this.listen();
    const token = randomBytes(24).toString('hex');
    this.turns.set(token, { ask, always, questions });
    const script = await this.writeScript();
    return {
      server: {
        type: 'stdio',
        command: process.execPath,
        args: [script],
        // In VS Code `process.execPath` is Electron; this makes it behave as plain Node.
        env: { ELECTRON_RUN_AS_NODE: '1', OCHUB_APPROVER_URL: `http://127.0.0.1:${this.port}/approve`, OCHUB_APPROVER_TOKEN: token },
      },
      close: () => void this.turns.delete(token),
    };
  }

  dispose(): void {
    this.turns.clear();
    this.server?.close();
    this.server = undefined;
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        server.unref();
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const turn = this.turns.get(String(req.headers['x-ochub-token'] ?? ''));
    if (req.method !== 'POST' || req.url !== '/approve' || !turn) return reply(403, { error: 'forbidden' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return reply(413, { error: 'too large' });
    }
    let body: { tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'bad json' });
    }
    const tool = String(body.tool_name ?? 'tool');
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    if (tool === ASK_TOOL) {
      const questions = parseQuestions(input);
      if (questions.length > 0) {
        const answers = await turn.questions(questions).catch(() => null);
        return reply(200, answers ? { behavior: 'allow', updatedInput: { ...input, answers: answersByQuestion(questions, answers) } } : { behavior: 'deny', message: QUESTIONS_SKIPPED });
      }
    }
    if (turn.always.has(tool)) return reply(200, { behavior: 'allow', updatedInput: input });
    const answer = await turn.ask(describe(tool, input, body.tool_use_id)).catch((): PermissionReply => 'reject');
    if (answer === 'always') turn.always.add(tool);
    reply(200, answer === 'reject' ? { behavior: 'deny', message: 'The user denied this action. Do not retry it; ask the user how to proceed instead.' } : { behavior: 'allow', updatedInput: input });
  }

  private scriptPath: string | undefined;
  private async writeScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath;
    const file = path.join(this.storageDir, 'claude-approver.cjs');
    await fs.mkdir(this.storageDir, { recursive: true });
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    if (current !== APPROVER_SCRIPT) await fs.writeFile(file, APPROVER_SCRIPT, 'utf8');
    this.scriptPath = file;
    return file;
  }
}

/** How a Claude Code tool call is shown in the approval card. */
export function describe(tool: string, input: Record<string, unknown>, callId?: string): Omit<PermissionRequest, 'id' | 'sessionId'> {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const file = s('file_path') ?? s('notebook_path') ?? s('path');
  let title = `Allow ${tool}?`;
  let detail: string | undefined;
  if (tool === 'Bash') {
    title = s('description') ? `Run a command: ${s('description')}` : 'Run a command?';
    detail = s('command');
  } else if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool) && file) {
    title = `${tool === 'Write' ? 'Write' : 'Edit'} ${file}?`;
    detail = s('new_string') ?? s('content') ?? (Array.isArray(input.edits) ? JSON.stringify(input.edits, null, 2) : undefined);
  } else if (tool === 'WebFetch') {
    title = `Fetch ${s('url') ?? 'a web page'}?`;
    detail = s('prompt');
  } else if (tool === 'WebSearch') {
    title = `Search the web for "${s('query') ?? ''}"?`;
  } else if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    title = `Allow ${name ?? tool} (${server} MCP server)?`;
  }
  if (detail === undefined && Object.keys(input).length > 0) detail = JSON.stringify(input, null, 2);
  if (detail && detail.length > 4000) detail = `${detail.slice(0, 4000)}\n…`;
  return { kind: tool.startsWith('mcp__') ? 'mcp' : tool.toLowerCase(), title, detail, callId };
}

/** The stdio MCP server Claude Code starts. Plain CommonJS, no dependencies. */
const APPROVER_SCRIPT = `// Written by OpenCode Hub: forwards Claude Code permission prompts to VS Code.
'use strict';
const http = require('http');
const url = new URL(process.env.OCHUB_APPROVER_URL);
const token = process.env.OCHUB_APPROVER_TOKEN;
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const ask = (args) => new Promise((resolve) => {
  const body = JSON.stringify(args || {});
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-ochub-token': token } }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (data += d));
    res.on('end', () => resolve(res.statusCode === 200 ? data : JSON.stringify({ behavior: 'deny', message: 'VS Code did not answer the permission request.' })));
  });
  req.on('error', () => resolve(JSON.stringify({ behavior: 'deny', message: 'VS Code is not reachable for the permission request.' })));
  req.end(body);
});
const tool = { name: 'approve', description: 'Ask the user in VS Code whether a tool may run.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } };
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ochub-approver', version: '1.0.0' } } });
    else if (msg.method === 'tools/list') out({ jsonrpc: '2.0', id: msg.id, result: { tools: [tool] } });
    else if (msg.method === 'tools/call') ask(msg.params && msg.params.arguments).then((text) => out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }));
    else if (msg.method === 'ping') out({ jsonrpc: '2.0', id: msg.id, result: {} });
    else out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;
