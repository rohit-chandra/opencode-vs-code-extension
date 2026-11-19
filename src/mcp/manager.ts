import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Emitter } from '../core/emitter';
import type { Logger } from '../core/engine';
import { errorMessage } from '../core/engine';
import type { McpServerInfo } from '../shared/types';
import type { ToolSpec } from '../engines/direct/wire';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpTool extends ToolSpec {
  /** Name exposed to the model: `<server>__<tool>`, sanitised for provider limits. */
  name: string;
  server: string;
  tool: string;
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  status: McpServerInfo['status'];
  error?: string;
  client?: Client;
  tools: McpTool[];
  connecting?: Promise<void>;
  lastAttempt: number;
}

export interface McpHost {
  log: Logger;
  cwd(): string | undefined;
  /** Current `opencodeHub.mcp.servers` setting. */
  readConfig(): Record<string, McpServerConfig>;
  /** Persist the enabled flag of one server. */
  writeEnabled(name: string, enabled: boolean): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_FAILED_MS = 30_000;

/**
 * MCP client used by the engines that have no MCP support of their own (direct BYOK and
 * VS Code LM). Servers come from the `opencodeHub.mcp.servers` setting; each can be
 * toggled, which connects or disconnects it immediately.
 */
export class McpManager {
  private connections = new Map<string, Connection>();
  private emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly host: McpHost) {}

  /** Reconcile live connections with the configuration. Never throws. */
  async sync(): Promise<void> {
    const config = this.host.readConfig();
    for (const [name, conn] of [...this.connections]) {
      const next = config[name];
      if (!next || fingerprint(next) !== conn.fingerprint) {
        await this.disconnect(name);
        this.connections.delete(name);
      }
    }
    const pending: Promise<void>[] = [];
    for (const [name, cfg] of Object.entries(config)) {
      let conn = this.connections.get(name);
      if (!conn) {
        conn = { config: cfg, fingerprint: fingerprint(cfg), status: 'disabled', tools: [], lastAttempt: 0 };
        this.connections.set(name, conn);
      }
      if (cfg.enabled === false) {
        if (conn.status !== 'disabled') {
          await this.disconnect(name);
          conn.status = 'disabled';
          conn.error = undefined;
        }
        continue;
      }
      // Connect servers that were just enabled, and retry failed ones at most every 30 s.
      const retryFailed = conn.status === 'failed' && Date.now() - conn.lastAttempt > RETRY_FAILED_MS;
      if (conn.status === 'disabled' || retryFailed) pending.push(this.connect(name, conn));
      else if (conn.connecting) pending.push(conn.connecting);
    }
    this.emitter.fire();
    await Promise.all(pending);
  }

  private connect(name: string, conn: Connection): Promise<void> {
    conn.connecting ??= (async () => {
      conn.lastAttempt = Date.now();
      conn.status = 'connecting';
      conn.error = undefined;
      try {
        const client = new Client({ name: 'opencode-hub', version: '0.1.0' }, { capabilities: {} });
        await withTimeout(this.open(client, conn.config), CONNECT_TIMEOUT_MS, `MCP server "${name}" did not respond within ${CONNECT_TIMEOUT_MS / 1000}s`);
        const listed = await client.listTools();
        conn.client = client;
        conn.tools = listed.tools.map((t) => ({
          name: exposedName(name, t.name),
          server: name,
          tool: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }));
        conn.status = 'connected';
        client.onclose = () => {
          if (conn.client !== client) return;
          conn.client = undefined;
          conn.tools = [];
          conn.status = 'failed';
          conn.error = 'Connection closed';
          this.emitter.fire();
        };
        this.host.log.info(`MCP server "${name}" connected with ${conn.tools.length} tool(s)`);
      } catch (err) {
        conn.status = 'failed';
        conn.error = errorMessage(err);
        conn.tools = [];
        this.host.log.warn(`MCP server "${name}" failed: ${conn.error}`);
      } finally {
        conn.connecting = undefined;
        this.emitter.fire();
      }
    })();
    return conn.connecting;
  }

  /** Expand `${workspaceFolder}` and `${env:NAME}` like VS Code does in launch and task configs. */
  private expand(value: string): string {
    return value.replace(/\$\{workspaceFolder\}/g, this.host.cwd() ?? '').replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
  }

  private async open(client: Client, raw: McpServerConfig): Promise<void> {
    const mapValues = (o: Record<string, string> | undefined) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, this.expand(String(v))])) : undefined);
    const cfg: McpServerConfig = {
      ...raw,
      command: raw.command ? this.expand(raw.command) : undefined,
      args: raw.args?.map((a) => this.expand(String(a))),
      cwd: raw.cwd ? this.expand(raw.cwd) : undefined,
      url: raw.url ? this.expand(raw.url) : undefined,
      env: mapValues(raw.env),
      headers: mapValues(raw.headers),
    };
    if (cfg.url) {
      const url = new URL(cfg.url);
      const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
      } catch (err) {
        // Older servers only speak the HTTP+SSE transport.
        try {
          await client.connect(new SSEClientTransport(url, { requestInit }));
        } catch {
          throw err;
        }
      }
      return;
    }
    if (!cfg.command) throw new Error('MCP server needs either "command" or "url".');
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
      cwd: cfg.cwd ?? this.host.cwd(),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => this.host.log.debug(`[mcp] ${d.toString().trimEnd()}`));
    await client.connect(transport);
  }

  private async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    await conn.connecting?.catch(() => undefined);
    const client = conn.client;
    conn.client = undefined;
    conn.tools = [];
    await client?.close().catch(() => undefined);
  }

  list(): McpServerInfo[] {
    const config = this.host.readConfig();
    return Object.entries(config)
      .map(([name, cfg]) => {
        const conn = this.connections.get(name);
        const enabled = cfg.enabled !== false;
        return {
          name,
          enabled,
          status: !enabled ? ('disabled' as const) : (conn?.status ?? 'connecting'),
          error: conn?.error,
          toolCount: conn?.status === 'connected' ? conn.tools.length : undefined,
          transport: cfg.url ? ('http' as const) : ('stdio' as const),
          source: 'settings',
          canToggle: true,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.host.writeEnabled(name, enabled);
    await this.sync();
  }

  /** Tools of every connected server. */
  async tools(): Promise<McpTool[]> {
    await this.sync();
    return [...this.connections.values()].flatMap((c) => (c.status === 'connected' ? c.tools : []));
  }

  async call(tool: McpTool, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const conn = this.connections.get(tool.server);
    if (!conn?.client) return { text: `MCP server "${tool.server}" is not connected.`, isError: true };
    const result = await conn.client.callTool({ name: tool.tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: 120_000 });
    const content = (result.content ?? []) as { type: string; text?: string; resource?: { text?: string; uri?: string } }[];
    const text = content
      .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri ?? '') : `[${c.type}]`))
      .join('\n')
      .trim();
    return { text: text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '(no output)'), isError: result.isError === true };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((n) => this.disconnect(n)));
    this.connections.clear();
    this.emitter.dispose();
  }
}

function fingerprint(cfg: McpServerConfig): string {
  const { enabled: _enabled, ...rest } = cfg;
  return JSON.stringify(rest);
}

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function exposedName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${clean(server)}__${clean(tool)}`.slice(0, 64);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
