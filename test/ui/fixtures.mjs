// View states used by the UI tests. They mirror what the extension host sends to the webview.
const now = Date.now();
const usage = (input, output, extra = {}) => ({ input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...extra });

export const commands = [
  ['new', 'Start a new session'], ['sessions', 'Switch to another session'], ['model', 'Choose the model', '[name]'], ['agent', 'Choose the agent', '[name]'],
  ['engine', 'Switch engine (opencode, BYOK, Claude Code, Codex, Copilot)', '[name]'], ['mcp', 'Show MCP servers and toggle them'], ['usage', 'Show token usage for this session and overall'],
  ['attach', 'Attach files to the next message'], ['compact', 'Summarize the conversation to free up context'], ['undo', 'Revert the last message and its file changes'],
  ['share', 'Create a share link for this session'], ['help', 'List available commands'],
  ['move', 'Dock the chat left, right, or open it as an editor tab', '[left|right|editor]'], ['zoom', 'Make the chat text larger or smaller', '[in|out|reset|120%]'],
].map(([name, description, argumentHint]) => ({ name, description, source: 'builtin', argumentHint }))
  .concat([{ name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted', source: 'engine', argumentHint: '[arguments]' }, { name: 'greet', description: 'Greet someone', source: 'engine', argumentHint: '[arguments]' }]);

export const base = {
  engine: 'opencode',
  engines: [
    { engine: 'opencode', state: 'ready', version: '1.19.6' },
    { engine: 'direct', state: 'ready' },
    { engine: 'claude-code', state: 'ready', version: '2.1.328' },
    { engine: 'codex', state: 'unavailable', detail: 'Codex CLI not found.' },
    { engine: 'vscode-lm', state: 'idle' },
  ],
  capabilities: { agents: true, fork: true, share: true, undo: true, compact: true, images: true, mcpToggle: true, permissions: true, providerAuth: true, remoteSessions: true },
  sessions: [
    { id: 'ses_1', engine: 'opencode', title: 'Refactor the auth middleware', createdAt: now - 3600_000, updatedAt: now - 120_000 },
    { id: 'ses_2', engine: 'opencode', title: 'Why is the CI job flaky?', createdAt: now - 86400_000, updatedAt: now - 5 * 3600_000 },
    { id: 'ses_3', engine: 'opencode', title: 'Write tests for the usage ledger', createdAt: now - 3 * 86400_000, updatedAt: now - 2 * 86400_000 },
  ],
  sessionId: undefined,
  messages: [],
  activity: 'idle',
  activityDetail: undefined,
  providers: [
    { id: 'anthropic', name: 'Anthropic', connected: true, models: [{ providerId: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1000000 }, { providerId: 'anthropic', modelId: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 200000 }] },
    { id: 'openrouter', name: 'OpenRouter', connected: true, models: [{ providerId: 'openrouter', modelId: 'qwen/qwen3-coder', name: 'Qwen3 Coder', contextWindow: 262144 }] },
    { id: 'ollama', name: 'Ollama (local)', connected: true, models: [{ providerId: 'ollama', modelId: 'llama3.3:70b', name: 'llama3.3:70b' }] },
  ],
  model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
  agents: [{ name: 'build', description: 'The default agent.' }, { name: 'plan', description: 'Plan mode. Disallows all edit tools.' }],
  agent: 'build',
  commands,
  mcp: [
    { name: 'github', status: 'connected', enabled: true, canToggle: true, source: 'opencode', toolCount: 26 },
    { name: 'postgres', status: 'disabled', enabled: false, canToggle: true, source: 'opencode' },
    { name: 'sentry', status: 'failed', enabled: true, canToggle: true, source: 'opencode', error: 'Connection closed: spawn sentry-mcp ENOENT' },
    { name: 'linear', status: 'needs_auth', enabled: true, canToggle: true, source: 'opencode' },
  ],
  attachments: [],
  permissions: [],
  questions: [],
  sessionUsage: undefined,
  usage: undefined,
  avatar: { enabled: true, style: 'buddy' },
  zoom: 1,
  trusted: true,
  canRetry: false,
  recentModels: [],
  panel: { name: 'none', nonce: 0 },
  notice: undefined,
  loading: false,
};

const md = `The middleware re-validates the token on every request. Two changes fix it:

1. Cache the decoded claims on \`req.auth\`
2. Skip validation for the health check

\`\`\`ts
export function auth(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/healthz') return next();
  req.auth ??= verify(req.headers.authorization); // cached
  next();
}
\`\`\`

See [src/middleware/auth.ts](src/middleware/auth.ts) and the [Express docs](https://expressjs.com/en/guide/using-middleware.html).

| Route | Before | After |
|---|---|---|
| /api/users | 41 ms | 12 ms |`;

export const conversation = {
  ...base,
  sessionId: 'ses_1',
  messages: [
    { id: 'm1', sessionId: 'ses_1', role: 'user', createdAt: now - 60_000, parts: [{ id: 'p1', type: 'text', text: 'Why is every request so slow after the auth change?' }, { id: 'p1f', type: 'file', filename: 'src/middleware/auth.ts', mime: 'text/plain', url: 'file:///work/app/src/middleware/auth.ts' }] },
    {
      id: 'm2', sessionId: 'ses_1', role: 'assistant', createdAt: now - 59_000, completedAt: now - 40_000, model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }, agent: 'build',
      usage: usage(8240, 612, { cacheRead: 15200, reasoning: 240, cost: 0.0412 }),
      parts: [
        { id: 'p2', type: 'reasoning', text: 'The user changed auth; check where verify() is called.' },
        { id: 'p3', type: 'tool', tool: 'grep', callId: 'c1', status: 'completed', title: 'verify\\(', input: { pattern: 'verify\\(' }, output: 'src/middleware/auth.ts:14\nsrc/routes/users.ts:9' },
        { id: 'p4', type: 'tool', tool: 'bash', callId: 'c2', status: 'error', title: 'npm run bench', input: { command: 'npm run bench' }, error: 'Missing script: "bench"' },
        { id: 'p5', type: 'text', text: md },
      ],
    },
  ],
  sessionUsage: { engine: 'opencode', sessionId: 'ses_1', title: 'Refactor the auth middleware', updatedAt: now, usage: usage(8240, 612, { cacheRead: 15200, reasoning: 240, cost: 0.0412 }), messages: 1, byModel: [{ engine: 'opencode', providerId: 'anthropic', modelId: 'claude-sonnet-5-5', usage: usage(8240, 612, { cacheRead: 15200, reasoning: 240, cost: 0.0412 }), messages: 1 }] },
};

const day = (offset) => {
  const d = new Date(now - offset * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const usageSummary = {
  since: now - 21 * 86400_000,
  total: usage(1_284_000, 96_400, { cacheRead: 3_410_000, cacheWrite: 212_000, reasoning: 41_200, cost: 18.37 }),
  messages: 412,
  byModel: [
    { engine: 'opencode', providerId: 'anthropic', modelId: 'claude-sonnet-5-5', usage: usage(820_000, 61_000, { cacheRead: 2_900_000, cacheWrite: 200_000, reasoning: 30_000, cost: 14.2 }), messages: 240 },
    { engine: 'opencode', providerId: 'anthropic', modelId: 'claude-haiku-5-5', usage: usage(140_000, 9_000, { cacheRead: 300_000, cost: 0.9 }), messages: 61 },
    { engine: 'direct', providerId: 'openrouter', modelId: 'qwen/qwen3-coder', usage: usage(210_000, 18_000, { cacheRead: 150_000, cost: 0.77 }), messages: 58 },
    { engine: 'claude-code', providerId: 'claude-code', modelId: 'claude-sonnet-5-5', usage: usage(74_000, 5_400, { cacheRead: 60_000, cacheWrite: 12_000, cost: 2.5 }), messages: 22 },
    { engine: 'direct', providerId: 'ollama', modelId: 'llama3.3:70b', usage: usage(40_000, 3_000), messages: 31 },
  ],
  byDay: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((o, i) => ({ day: day(o), usage: usage([40, 95, 20, 130, 160, 70, 15, 5, 110, 180, 240, 90, 150, 60][i] * 1000, [4, 9, 2, 11, 13, 6, 1, 1, 9, 14, 21, 8, 12, 5][i] * 1000) })),
  sessions: [
    conversation.sessionUsage,
    { engine: 'opencode', sessionId: 'ses_2', title: 'Why is the CI job flaky?', updatedAt: now - 5 * 3600_000, usage: usage(52_000, 3_100, { cacheRead: 88_000, cost: 0.61 }), messages: 9, byModel: [] },
    { engine: 'direct', sessionId: 'ses_d1', title: 'Regex for semver ranges', updatedAt: now - 86400_000, usage: usage(4_200, 900), messages: 3, byModel: [] },
  ],
};
